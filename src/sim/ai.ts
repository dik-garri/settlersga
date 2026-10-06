/**
 * Computer players.
 *
 * Rules: an AI plays only through the same `World` commands a human uses (`placeBuilding`,
 * `sendGeologist`, `attack`, `demolish`, all with its own player id) and only reads what a player
 * can see — in particular, ore under a mountain counts only once the AI's own geologist has
 * prospected it. It has no RNG of its own (ties are broken by tile index), so games stay
 * deterministic, and its state (`AiState`) is plain data saved with the world.
 *
 * Cost: an AI thinks every `AI.thinkEvery` ticks (staggered per player). A think looks at its own
 * buildings and, when it wants to build, scores the tiles of its own territory (sampled more sparsely
 * on large territories) and tries `canPlace` on the best `AI.placeTries` spots only.
 */
import { available, centerOf, claimsTerritory, doorOf, oreLeft, waitingFor } from './buildings';
import {
  AI,
  AI_PLAN,
  BUILD_MAX_SLOPE,
  BUILDINGS,
  costOf,
  gatheredBy,
  oreOf,
  PROFESSIONS,
  type BuildingDef,
} from './config';
import { isMilitary } from './military';
import { isGatherTarget } from './nature';
import { RESOURCES, Terrain, type Building, type BuildingType, type PlayerId, type Point } from './types';
import type { World } from './world';

/** Per computer player; saved with the world. */
export interface AiState {
  player: PlayerId;
  nextThink: number;
  lastAttack: number;
  /** Building type (or 'frontier') → tick before which the AI does not look for a spot again. */
  blockedUntil: Partial<Record<BuildingType | 'frontier', number>>;
  stats: { placed: number; attacks: number; soldiersSent: number; geologists: number; demolished: number };
}

export function createAi(player: PlayerId): AiState {
  return {
    player,
    // Stagger the players so their thinks do not all land on the same tick.
    nextThink: player * 7,
    // Finite so it survives a JSON save.
    lastAttack: -AI.attackCooldown,
    blockedUntil: {},
    stats: { placed: 0, attacks: 0, soldiersSent: 0, geologists: 0, demolished: 0 },
  };
}

/** Called every tick by `World.step`; each AI acts only on its think ticks. */
export function updateAi(w: World): void {
  for (const ai of w.ai) {
    if (w.tick < ai.nextThink) continue;
    ai.nextThink = w.tick + AI.thinkEvery;
    if (!w.isDefeated(ai.player)) think(w, ai);
  }
}

/** Retry a type with no spot after this many ticks (territory or resources may have changed). */
const RETRY_TICKS = 600;
const HOUSES: readonly BuildingType[] = ['house_small', 'house_medium', 'house_large'];

function think(w: World, ai: AiState): void {
  const me = ai.player;
  const own = [...w.buildings.values()].filter((b) => b.owner === me);

  for (const b of own) {
    // A worked-out mine only ties up a miner and his food.
    if (b.done && BUILDINGS[b.type].mine && oreLeft(w, b) === 0 && w.demolish(b.id, me)) ai.stats.demolished++;
  }
  const attacked = attackIfStrong(w, ai);

  const sites = own.filter((b) => !b.done);
  if (sites.length >= AI.maxOpenSites) return;
  const ctx = new Context(w, me, own);

  // Keep enough idle carriers: they staff new workplaces, carry goods and become soldiers.
  // Houses release their people over time, so settlers still to come count as available.
  const idle = w.settlers.filter((s) => s.owner === me && s.kind === 'carrier' && s.tasks.length === 0).length;
  const coming = own.reduce((n, b) => n + (BUILDINGS[b.type].residence?.capacity ?? 0) - b.spawned, 0);
  if (idle + coming < AI.minIdleCarriers) {
    const houses = own.filter((b) => BUILDINGS[b.type].residence).length;
    const order = houses < 2 ? HOUSES : [...HOUSES].reverse();
    for (const type of order) {
      if (ctx.affordable(type) && tryPlace(ctx, ai, type)) return;
    }
  }

  const count = (t: BuildingType) => own.filter((b) => b.type === t).length;
  for (const step of AI_PLAN) {
    if (count(step.type) >= step.count) continue;
    if (step.after && !own.some((b) => b.type === step.after && b.done)) continue;
    if ((ai.blockedUntil[step.type] ?? -Infinity) > w.tick) continue;
    if (!ctx.affordable(step.type) || !ctx.staffable(step.type, count(step.type) === 0)) continue;
    if (BUILDINGS[step.type].garrison && !ctx.canMan(step.type)) continue;
    if (tryPlace(ctx, ai, step.type)) return;
    if (BUILDINGS[step.type].mine) prospect(ctx, ai);
    ai.blockedUntil[step.type] = w.tick + RETRY_TICKS;
  }

  // Army ready but no enemy in reach: push military buildings towards the nearest enemy.
  // Only when every military building is manned and the new one can be manned too.
  const soldiers = w.settlers.filter((s) => s.owner === me && s.kind === 'soldier').length;
  const military = own.filter((b) => isMilitary(b));
  if (
    !attacked &&
    FRONTIER &&
    (ai.blockedUntil.frontier ?? -Infinity) <= w.tick &&
    soldiers >= AI.frontierSoldiers &&
    military.length < AI.maxMilitary &&
    military.every((b) => b.done && b.garrison.length > 0) &&
    ctx.canMan(FRONTIER) &&
    ctx.affordable(FRONTIER)
  ) {
    ctx.frontier = true;
    if (!tryPlace(ctx, ai, FRONTIER)) ai.blockedUntil.frontier = w.tick + RETRY_TICKS;
  }
}

/** The military building the AI pushes its border with (the first buildable one with a garrison). */
const FRONTIER = (Object.keys(BUILDINGS) as BuildingType[]).find(
  (t) => BUILDINGS[t].garrison && BUILDINGS[t].playerBuildable && BUILDINGS[t].territory,
);

function tryPlace(ctx: Context, ai: AiState, type: BuildingType): boolean {
  const spot = ctx.bestSpot(type);
  if (!spot) return false;
  ai.stats.placed++;
  return true;
}

/** No known ore for a wanted mine: send a geologist to the nearest unexplored mountain we own. */
function prospect(ctx: Context, ai: AiState): void {
  const { w, me } = ctx;
  if (w.settlers.some((s) => s.owner === me && s.kind === 'geologist')) return;
  const castle = centerOf(w.castleOf(me));
  let best: Point | null = null;
  let bestD = Infinity;
  for (const i of ctx.tiles) {
    const x = i % w.map.w;
    const y = Math.floor(i / w.map.w);
    if (w.map.terrain[i] !== Terrain.Mountain || w.isProspected(x, y, me)) continue;
    const d = Math.hypot(x - castle.x, y - castle.y);
    if (d < bestD) {
      best = { x, y };
      bestD = d;
    }
  }
  if (best && w.sendGeologist(best.x, best.y, me)) ai.stats.geologists++;
}

/**
 * Sends every spare soldier in range against the enemy military building it most clearly outnumbers.
 * True if it attacked (or is still cooling down from an attack).
 */
function attackIfStrong(w: World, ai: AiState): boolean {
  if (w.tick - ai.lastAttack < AI.attackCooldown) return true;
  const me = ai.player;
  // No rush: the early game is for building up.
  if (w.tick < AI.peaceTicks) return false;
  let target: Building | null = null;
  let send = 0;
  let bestMargin = -Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner === me || !b.done || !isMilitary(b) || w.isDefeated(b.owner)) continue;
    const ready = w.availableAttackers(b.id, me);
    const defenders = b.garrison.length;
    if (ready < AI.minAttackers || ready < AI.attackRatio * defenders + 1) continue;
    // Prefer the castle (it ends the game), then the largest margin.
    const margin = ready - AI.attackRatio * defenders + (w.castleOf(b.owner) === b ? 100 : 0);
    if (margin > bestMargin) {
      bestMargin = margin;
      target = b;
      send = ready;
    }
  }
  if (!target) return false;
  const sent = w.attack(target.id, send, me);
  if (sent === 0) return false;
  ai.lastAttack = w.tick;
  ai.stats.attacks++;
  ai.stats.soldiersSent += sent;
  return true;
}

/** Everything a single think needs about the AI's own side, computed once. */
class Context {
  /** Own territory tiles, sampled every `stride` tiles on large territories. */
  readonly tiles: number[];
  /** Military buildings go as close to the nearest enemy as possible (instead of claiming resources). */
  frontier = false;
  private readonly castle: Point;
  private readonly enemyCastles: Point[];

  constructor(
    readonly w: World,
    readonly me: PlayerId,
    readonly own: Building[],
  ) {
    this.castle = centerOf(w.castleOf(me));
    this.enemyCastles = w.players
      .filter((p) => p.id !== me && !w.isDefeated(p.id))
      .map((p) => centerOf(w.castleOf(p.id)));
    this.tiles = this.territory();
  }

  private territory(): number[] {
    const { w, me } = this;
    const m = w.map;
    const seen = new Set<number>();
    for (const b of this.own) {
      const r = BUILDINGS[b.type].territory;
      if (!r || !claimsTerritory(b)) continue;
      const c = centerOf(b);
      for (let y = Math.floor(c.y - r); y <= Math.ceil(c.y + r); y++) {
        for (let x = Math.floor(c.x - r); x <= Math.ceil(c.x + r); x++) {
          if (m.inBounds(x, y) && m.owner[m.idx(x, y)] === me) seen.add(m.idx(x, y));
        }
      }
    }
    const all = [...seen].sort((a, b) => a - b);
    const stride = all.length > 4000 ? 3 : all.length > 2000 ? 2 : 1;
    return stride === 1 ? all : all.filter((i) => (i % m.w) % stride === 0 && Math.floor(i / m.w) % stride === 0);
  }

  /** Enough unpromised materials for this building on top of what open sites still need. */
  affordable(type: BuildingType): boolean {
    const cost = costOf(type);
    return RESOURCES.every((r) => {
      if (cost[r] === 0) return true;
      let committed = 0;
      for (const b of this.own) if (!b.done) committed += Math.max(0, costOf(b.type)[r] - b.delivered[r] - b.inbound[r]);
      return available(this.w, this.me, r) - committed >= cost[r];
    });
  }

  /**
   * Its worker's tool is in stock (or a toolsmith exists to make one). The last `AI.keepTools` units
   * are only for the first building of a type, so e.g. the first coal mine is never left without a
   * pickaxe because a second stonecutter took it — which would starve the toolsmith of coal for good.
   */
  staffable(type: BuildingType, first: boolean): boolean {
    const worker = BUILDINGS[type].worker;
    const tool = worker ? PROFESSIONS[worker].tool : undefined;
    if (!tool) return true;
    const spare = available(this.w, this.me, tool) - waitingFor(this.w, this.me, tool);
    if (spare > (first ? 0 : AI.keepTools)) return true;
    return this.own.some((b) => b.done && b.workerId !== null && BUILDINGS[b.type].recipe?.outputChoice?.includes(tool));
  }

  /**
   * A new military building needs at least one soldier to claim land, taken from the castle's reserve
   * or recruited with a sword. Only build one if that leaves the castle `AI.homeGuard` soldiers after
   * every still-empty military building got its first one too.
   */
  canMan(type: BuildingType): boolean {
    if (!BUILDINGS[type].garrison) return true;
    const castle = this.w.castleOf(this.me);
    const empty = this.own.filter((b) => b !== castle && isMilitary(b) && b.garrison.length === 0).length;
    const swords = available(this.w, this.me, PROFESSIONS.soldier.tool!);
    return castle.garrison.length + swords - empty - 1 >= AI.homeGuard;
  }

  /** Places the building on the best-scored legal spot; null if none. */
  bestSpot(type: BuildingType): Building | null {
    const { w, me } = this;
    const def = BUILDINGS[type];
    const scored: { i: number; score: number }[] = [];
    for (const i of this.tiles) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      if (!this.fits(def, x, y)) continue;
      const score = this.score(def, type, x, y);
      if (score !== null) scored.push({ i, score });
    }
    scored.sort((a, b) => b.score - a.score || a.i - b.i);
    for (const { i } of scored.slice(0, AI.placeTries)) {
      const x = i % w.map.w;
      const y = Math.floor(i / w.map.w);
      if (!w.canPlace(type, x, y, me)) continue;
      const b = w.placeBuilding(type, x, y, me);
      if (b) return b;
    }
    return null;
  }

  /**
   * Cheap part of `canPlace` (free own ground of the right terrain, level enough, walkable own door),
   * so the costly connectivity check is only spent on plausible spots.
   */
  private fits(def: BuildingDef, x: number, y: number): boolean {
    const m = this.w.map;
    const ground = def.terrain === 'mountain' ? Terrain.Mountain : Terrain.Grass;
    for (let dy = 0; dy < def.h; dy++) {
      for (let dx = 0; dx < def.w; dx++) {
        if (!m.isBuildable(x + dx, y + dy, ground) || m.owner[m.idx(x + dx, y + dy)] !== this.me) return false;
      }
    }
    const door = doorOf(x, y, def.w, def.h);
    if (!m.isWalkable(door.x, door.y) || m.owner[m.idx(door.x, door.y)] !== this.me) return false;
    return def.terrain === 'mountain' || m.heightRange(x, y, x + def.w - 1, y + def.h) <= BUILD_MAX_SLOPE;
  }

  /** Desirability of a building with its top tile at (x, y); null = pointless here. */
  private score(def: BuildingDef, type: BuildingType, x: number, y: number): number | null {
    const { w } = this;
    const m = w.map;
    const cx = x + (def.w - 1) / 2;
    const cy = y + (def.h - 1) / 2;
    const fromCastle = Math.hypot(cx - this.castle.x, cy - this.castle.y);
    if (def.terrain === 'mountain' && m.terrain[m.idx(x, y)] !== Terrain.Mountain) return null;

    if (def.mine) {
      // Only ore our geologists have found counts.
      let ore = 0;
      const r = def.mine.radius;
      for (let ty = Math.floor(cy - r); ty <= Math.ceil(cy + r); ty++) {
        for (let tx = Math.floor(cx - r); tx <= Math.ceil(cx + r); tx++) {
          if (!m.inBounds(tx, ty) || Math.hypot(tx - cx, ty - cy) > r || !w.isProspected(tx, ty, this.me)) continue;
          const i = m.idx(tx, ty);
          if (oreOf(m.ore[i]) === def.mine.res) ore += m.oreAmount[i];
        }
      }
      return ore > 0 ? ore - fromCastle * 0.5 : null;
    }

    if (def.garrison && def.territory) {
      // Towers: push the border outwards, towards enemies and unclaimed resources, apart from each other.
      const nearestOwnMilitary = Math.min(
        ...this.own.filter((b) => isMilitary(b)).map((b) => Math.hypot(centerOf(b).x - cx, centerOf(b).y - cy)),
      );
      if (nearestOwnMilitary < def.territory * 0.5) return null;
      const enemy = this.enemyCastles.length
        ? Math.min(...this.enemyCastles.map((e) => Math.hypot(e.x - cx, e.y - cy)))
        : 0;
      if (this.frontier) return -enemy;
      return fromCastle - enemy * 0.4 + this.unclaimedResources(cx, cy, def.territory) * 0.15;
    }

    const worker = def.worker ? PROFESSIONS[def.worker] : undefined;
    const gather = gatheredBy(type);
    if (gather && worker?.behavior === 'gather') {
      const n = this.countTargets(gather.res, cx, cy, gather.radius);
      return n >= 3 ? n * 2 - fromCastle * 0.3 : null;
    }
    if (worker?.behavior === 'farm') {
      const free = this.freeGrass(cx, cy, worker.plant!.radius);
      return free >= 12 ? free - fromCastle * 0.5 : null;
    }
    if (worker?.behavior === 'plant') {
      // Foresters next to woodcutters.
      const cutters = this.own.filter((b) => gatheredBy(b.type)?.res === 'log');
      if (cutters.length === 0) return null;
      const d = Math.min(...cutters.map((b) => Math.hypot(centerOf(b).x - cx, centerOf(b).y - cy)));
      return d <= worker.plant!.radius ? this.freeGrass(cx, cy, worker.plant!.radius) - d * 2 : null;
    }
    // Workshops, houses, storage: keep the base compact.
    return -fromCastle;
  }

  private countTargets(res: (typeof RESOURCES)[number], cx: number, cy: number, r: number): number {
    const m = this.w.map;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (m.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r && isGatherTarget(this.w, res, m.idx(x, y), this.me)) n++;
      }
    }
    return n;
  }

  private freeGrass(cx: number, cy: number, r: number): number {
    const m = this.w.map;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (Math.hypot(x - cx, y - cy) > r || !m.isBuildable(x, y) || m.owner[m.idx(x, y)] !== this.me) continue;
        n++;
      }
    }
    return n;
  }

  /** Trees, stone, water and mountain not owned by anyone, which a tower here would bring in. */
  private unclaimedResources(cx: number, cy: number, r: number): number {
    const m = this.w.map;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!m.inBounds(x, y) || Math.hypot(x - cx, y - cy) > r) continue;
        const i = m.idx(x, y);
        if (m.owner[i] !== 0) continue;
        if (m.tree[i] || m.stone[i] || m.terrain[i] === Terrain.Mountain || m.terrain[i] === Terrain.Water) n++;
      }
    }
    return n;
  }
}
