/**
 * Computer players.
 *
 * Rules: an AI plays only through the same `World` commands a human uses (`placeBuilding`,
 * `sendGeologist`, `attack`, `demolish`, `setShare`, all with its own player id) and only reads what
 * its player can see:
 * - ore under a mountain counts only once its own geologist has prospected it;
 * - enemy buildings exist for it only where its fog is explored (`isExplored` on the door tile), and
 *   it counts their defenders only while they are in its buildings' sight (`inBuildingSight`) —
 *   otherwise it guesses from the building type; resources beyond its border count only on
 *   explored tiles;
 * - with no enemy building known yet it pushes its towers towards foreign land in sight, else
 *   towards unexplored land and the map center (the map size is public).
 * It reads only fog state that is saved or derived from saved state (explored bits, building sight),
 * never settlers' passing sight, so a loaded game makes the same decisions. It has no RNG of its own
 * (ties are broken by tile index), so games stay deterministic, and its state (`AiState`) is plain
 * data saved with the world.
 *
 * Cost: an AI thinks every `AI.thinkEvery` ticks (staggered per player). A think looks at its own
 * buildings and, when it wants to build, scores the tiles of its own territory (sampled more sparsely
 * on large territories) and tries `canPlace` on the best `AI.placeTries` spots only.
 */
import { attackStrength } from './strength';
import { available, centerOf, claimsTerritory, doorOf, oreLeft, waitingFor } from './buildings';
import {
  AI,
  AI_PLAN,
  ATTACK_RANGE,
  BUILD_MAX_SLOPE,
  SOLDIER_LEVELS,
  BUILDINGS,
  costOf,
  totalCost,
  gatheredBy,
  oreOf,
  PROFESSIONS,
  type BuildingDef,
} from './config';
import { inBuildingSight, visionRadius } from './fog';
import { FIGHTERS, isFighter, isMilitary, keepOf } from './military';
import { hasGatherTargetNear, isGatherTarget } from './nature';
import { RESOURCES, Terrain, type Building, type BuildingType, type PlayerId, type Point, type Resource } from './types';
import type { World } from './world';

/** Per computer player; saved with the world. */
export interface AiState {
  player: PlayerId;
  nextThink: number;
  lastAttack: number;
  /** Building type (or 'frontier') → tick before which the AI does not look for a spot again. */
  blockedUntil: Partial<Record<BuildingType | 'frontier' | 'decor', number>>;
  /** Ore it wants a mine for but knows no deposit of: towers then favour mountains, geologists go out. */
  wantOre: Resource | null;
  /** Its weapon shares have been set (once, through `setShare`). */
  sharesSet: boolean;
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
    wantOre: null,
    sharesSet: false,
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
  if (!ai.sharesSet) {
    for (const [res, weight] of Object.entries(AI.weaponShares) as [Resource, number][]) w.setShare(res, weight, me);
    w.setRecruitLevel(AI.recruitLevel, me);
    ai.sharesSet = true;
  }

  for (const b of own) {
    // A worked-out mine only ties up a miner and his food.
    if (b.done && BUILDINGS[b.type].mine && oreLeft(w, b) === 0 && w.demolish(b.id, me)) ai.stats.demolished++;
    // Likewise a gatherer of something that does not grow back once nothing is left in range:
    // the plan then rebuilds it where there is some.
    const gather = gatheredBy(b.type);
    if (b.done && gather && AI.exhaustible.includes(gather.res) && !hasGatherTargetNear(w, b, gather) && w.demolish(b.id, me)) {
      ai.stats.demolished++;
    }
  }
  const attacked = attackIfStrong(w, ai);

  const sites = own.filter((b) => !b.done);
  if (sites.length >= AI.maxOpenSites) return;
  const ctx = new Context(w, me, own, ai.wantOre);

  // Scouting: foreign land in sight but no enemy building known — a lookout tower at that border
  // sees much further than a tower (whose land stops at the other's border).
  if (ctx.scoutingBorder) {
    const lookout = LOOKOUTS.find((t) => own.filter((b) => b.type === t).length < AI.maxLookouts && ctx.affordable(t));
    if (lookout && (ai.blockedUntil[lookout] ?? -Infinity) <= w.tick) {
      if (tryPlace(ctx, ai, lookout)) return;
      ai.blockedUntil[lookout] = w.tick + RETRY_TICKS;
    }
  }

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
  // Only the first mine of the plan that cannot be placed decides what geologists look for: later
  // failures (gold, stone…) must not overwrite a more urgent need such as coal for weapons.
  let sought = false;
  for (const step of AI_PLAN) {
    if (count(step.type) >= step.count) continue;
    if (step.after && !prerequisiteMet(w, me, own, step.after)) continue;
    if ((ai.blockedUntil[step.type] ?? -Infinity) > w.tick) {
      // Waiting to retry a mine whose ore it is already looking for keeps that search first.
      const waiting = BUILDINGS[step.type].mine;
      if (waiting && ai.wantOre === waiting.res) sought = true;
      continue;
    }
    if (!ctx.affordable(step.type) || !ctx.staffable(step.type, count(step.type) === 0)) {
      // A mine of a material it is short of (no producer left) is looked for even before it can pay.
      const mine = BUILDINGS[step.type].mine;
      if (mine && ctx.short.includes(mine.res) && !sought && !ctx.knowsOre(step.type)) {
        sought = true;
        ai.wantOre = mine.res;
        prospect(ctx, ai);
      }
      continue;
    }
    if (BUILDINGS[step.type].garrison && !ctx.canMan(step.type)) continue;
    const mine = BUILDINGS[step.type].mine;
    if (tryPlace(ctx, ai, step.type)) {
      if (mine && ai.wantOre === mine.res) ai.wantOre = null;
      return;
    }
    if (mine && !sought) {
      // No known deposit: look for one (geologist) and lean the next towers towards mountains.
      sought = true;
      ai.wantOre = mine.res;
      prospect(ctx, ai);
    }
    ai.blockedUntil[step.type] = w.tick + RETRY_TICKS;
  }

  // Spare materials go into eyecatchers: they raise its settlement value and so its army's strength
  // on foreign land (`strength.ts`), one per `AI.decorEvery` buildings.
  const decor = own.filter((b) => BUILDINGS[b.type].eyecatcher).length;
  if (decor * AI.decorEvery < own.length && (ai.blockedUntil.decor ?? -Infinity) <= w.tick) {
    const spare = (Object.entries(AI.decorSpare) as [Resource, number][]).every(([r, n]) => available(w, me, r) >= n);
    const type = spare ? EYECATCHERS.find((t) => ctx.affordable(t)) : undefined;
    if (type) {
      if (tryPlace(ctx, ai, type)) return;
      ai.blockedUntil.decor = w.tick + RETRY_TICKS;
    }
  }

  // Army ready but no enemy in reach: push military buildings towards the nearest enemy.
  // Only when every military building is manned and the new one can be manned too.
  // Short of ore (`wantOre`), it expands towards mountains even with an enemy in reach: saving
  // soldiers for an attack is pointless when no new ones can be made (e.g. coal worked out).
  const soldiers = w.settlers.filter((s) => s.owner === me && isFighter(s)).length;
  const military = own.filter((b) => isMilitary(b));
  if (
    !attacked &&
    (ai.wantOre !== null || !enemyInReach(w, me, military)) &&
    (ai.blockedUntil.frontier ?? -Infinity) <= w.tick &&
    soldiers >= AI.frontierSoldiers &&
    military.length < AI.maxMilitary &&
    military.every((b) => b.done && b.garrison.length > 0)
  ) {
    // The largest military building it can pay for and man: more spare fighters at the front. Short
    // of a material (stone), the cheapest in it: every unit goes into reaching new deposits.
    const cheapFirst = (a: BuildingType, b: BuildingType) =>
      ctx.short.reduce((n, r) => n + costOf(a)[r] - costOf(b)[r], 0);
    const order = ctx.short.length > 0 ? [...FRONTIER].sort(cheapFirst) : FRONTIER;
    const type = order.find((t) => ctx.canMan(t) && ctx.affordable(t));
    if (type) {
      ctx.frontier = true;
      if (!tryPlace(ctx, ai, type)) ai.blockedUntil.frontier = w.tick + RETRY_TICKS;
    }
  }
}

/**
 * A known enemy military building lies within attack range of one of its own: new outposts would
 * only thin out the soldiers it gathers for the attack.
 */
function enemyInReach(w: World, me: PlayerId, military: Building[]): boolean {
  const own = military.filter((b) => b.done).map((b) => centerOf(b));
  return knownEnemies(w, me).some(({ b }) => {
    if (!b.done || !isMilitary(b)) return false;
    const c = centerOf(b);
    return own.some((o) => Math.hypot(o.x - c.x, o.y - c.y) <= ATTACK_RANGE);
  });
}

/** Buildings with a sight of their own (lookout towers), for scouting. */
/** Eyecatchers, the costliest first: the most settlement value per placement. */
const EYECATCHERS = (Object.keys(BUILDINGS) as BuildingType[])
  .filter((t) => BUILDINGS[t].eyecatcher && BUILDINGS[t].playerBuildable)
  .sort((a, b) => totalCost(b) - totalCost(a));
const LOOKOUTS = (Object.keys(BUILDINGS) as BuildingType[]).filter((t) => BUILDINGS[t].vision && BUILDINGS[t].playerBuildable);

/** Military buildings the AI pushes its border with, largest garrison first. */
const FRONTIER = (Object.keys(BUILDINGS) as BuildingType[])
  .filter((t) => BUILDINGS[t].garrison && BUILDINGS[t].playerBuildable && BUILDINGS[t].territory)
  .sort((a, b) => BUILDINGS[b].garrison!.capacity - BUILDINGS[a].garrison!.capacity);

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
    // Walkable only: a tile under a mine would make the geologist's errand fail every time.
    if (w.map.terrain[i] !== Terrain.Mountain || !w.map.isWalkable(x, y) || w.isProspected(x, y, me)) continue;
    const d = Math.hypot(x - castle.x, y - castle.y);
    if (d < bestD) {
      best = { x, y };
      bestD = d;
    }
  }
  if (best && w.sendGeologist(best.x, best.y, me)) ai.stats.geologists++;
}

/**
 * Enemy buildings this player knows of: their door tile is explored. Military ones come with the
 * defenders it can count — the real number while in sight of its buildings, otherwise a guess
 * (`AI.unseenGarrison` of the capacity).
 */
export function knownEnemies(w: World, me: PlayerId): { b: Building; defenders: number }[] {
  const out: { b: Building; defenders: number }[] = [];
  for (const b of w.buildings.values()) {
    if (w.allied(b.owner, me) || w.isDefeated(b.owner) || !w.isExplored(b.door.x, b.door.y, me)) continue;
    const g = BUILDINGS[b.type].garrison;
    const seen = inBuildingSight(w, w.map.idx(b.door.x, b.door.y), me);
    out.push({ b, defenders: !g ? 0 : seen ? b.garrison.length : Math.ceil(g.capacity * AI.unseenGarrison) });
  }
  return out;
}

/**
 * Sends every spare soldier in range against the known enemy military building it most clearly
 * outnumbers. True if it attacked (or is still cooling down from an attack).
 */
function attackIfStrong(w: World, ai: AiState): boolean {
  if (w.tick - ai.lastAttack < AI.attackCooldown) return true;
  const me = ai.player;
  // No rush: the early game is for building up.
  if (w.tick < AI.peaceTicks) return false;
  let target: Building | null = null;
  let send = 0;
  let bestMargin = -Infinity;
  for (const { b, defenders } of knownEnemies(w, me)) {
    if (!b.done || !isMilitary(b)) continue;
    // Own fighters' strength (ranks and professions known) against what it can see of the target:
    // the defenders it counts and the kind of building (its defense bonus).
    const ready = w.attackerComposition(b.id, Infinity, me);
    // Only swordsmen take a building: a party without one could only kill, never conquer.
    if (!ready.some((s) => PROFESSIONS[s.kind].combat?.captures)) continue;
    // Its fighters fight there at its attack strength (its own settlement value, which it knows);
    // the defenders' strength it cannot know, so it assumes the base 100 %.
    const power =
      (ready.reduce((n, s) => n + SOLDIER_LEVELS[s.level].damage * (PROFESSIONS[s.kind].combat?.melee ?? 1), 0) *
        attackStrength(w, me)) /
      100;
    const defense = defenders * (BUILDINGS[b.type].garrison!.defense ?? 1);
    if (ready.length < AI.minAttackers || power < AI.attackRatio * defense + 1) continue;
    // Prefer the castle (it ends the game), then the largest margin.
    const margin = power - AI.attackRatio * defense + (w.castleOf(b.owner) === b ? 100 : 0);
    if (margin > bestMargin) {
      bestMargin = margin;
      target = b;
      send = ready.length;
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
  /** Reserved materials (`AI.reserve`) nothing of its own produces any more: towers lean towards them. */
  readonly short: Resource[];
  private readonly castle: Point;
  /**
   * Centers of the enemy buildings it knows of (fog), or else foreign land its buildings see;
   * empty = it must still find the enemy.
   */
  private readonly enemies: Point[];
  /** It knows no enemy building but sees foreign land (`enemies` are then points of that land). */
  readonly scoutingBorder: boolean;

  constructor(
    readonly w: World,
    readonly me: PlayerId,
    readonly own: Building[],
    readonly wantOre: Resource | null = null,
  ) {
    this.castle = centerOf(w.castleOf(me));
    const known = knownEnemies(w, me);
    this.enemies = known.length > 0 ? known.map((e) => centerOf(e.b)) : this.foreignLandInSight();
    this.scoutingBorder = known.length === 0 && this.enemies.length > 0;
    this.tiles = this.territory();
    this.short = (Object.keys(AI.reserve) as Resource[]).filter((r) => !this.producing(r));
  }

  /** Some own staffed building still produces `res` (a gatherer with targets, a mine with ore, a workshop). */
  private producing(res: Resource): boolean {
    return this.own.some((b) => {
      if (!b.done || b.workerId === null) return false;
      const gather = gatheredBy(b.type);
      if (gather?.res === res) return hasGatherTargetNear(this.w, b, gather);
      const def = BUILDINGS[b.type];
      if (def.mine?.res === res) return oreLeft(this.w, b) > 0;
      return (def.recipe?.outputs[res] ?? 0) > 0;
    });
  }

  /** Its geologists have found ore for this mine within its territory. */
  knowsOre(type: BuildingType): boolean {
    const mine = BUILDINGS[type].mine;
    if (!mine) return false;
    const m = this.w.map;
    return this.tiles.some((i) => oreOf(m.ore[i]) === mine.res && m.oreAmount[i] > 0 && this.w.isProspected(i % m.w, Math.floor(i / m.w), this.me));
  }

  /** Another player's land in sight of its military buildings (sampled every third tile). */
  private foreignLandInSight(): Point[] {
    const { w, me } = this;
    const m = w.map;
    const seen = new Set<number>();
    for (const b of this.own) {
      if (!b.done || !isMilitary(b)) continue;
      const c = centerOf(b);
      const r = visionRadius(b.type);
      for (let y = Math.floor((c.y - r) / 3) * 3; y <= c.y + r; y += 3) {
        for (let x = Math.floor((c.x - r) / 3) * 3; x <= c.x + r; x += 3) {
          if (!m.inBounds(x, y)) continue;
          const i = m.idx(x, y);
          const o = m.owner[i];
          if (o !== 0 && !w.allied(o, me) && !w.isDefeated(o) && inBuildingSight(w, i, me)) seen.add(i);
        }
      }
    }
    return [...seen].sort((a, b) => a - b).map((i) => ({ x: i % m.w, y: Math.floor(i / m.w) }));
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

  /**
   * Enough unpromised materials for this building on top of what open sites still need — and, for a
   * material it is `short` of, on top of `AI.reserve` unless the building produces that material or
   * pushes the border (a military building with land), which is how it finds new deposits.
   */
  affordable(type: BuildingType): boolean {
    const cost = costOf(type);
    const def = BUILDINGS[type];
    return RESOURCES.every((r) => {
      if (cost[r] === 0) return true;
      let committed = 0;
      for (const b of this.own) if (!b.done) committed += Math.max(0, costOf(b.type)[r] - b.delivered[r] - b.inbound[r]);
      const produces = gatheredBy(type)?.res === r || def.mine?.res === r || (def.recipe?.outputs[r] ?? 0) > 0;
      const pushes = !!(def.garrison && def.territory);
      const keep = !this.short.includes(r) || produces ? 0 : pushes ? (AI.reserveFloor[r] ?? 0) : (AI.reserve[r] ?? 0);
      return available(this.w, this.me, r) - committed - keep >= cost[r];
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
   * A new military building needs at least one fighter to claim land: a spare one from any military
   * building (beyond what each keeps; empty outposts are manned from the nearest spares) or a recruit
   * with a weapon. Only build one if every still-empty military building gets its first one too and
   * `AI.homeGuard` spares remain.
   */
  canMan(type: BuildingType): boolean {
    if (!BUILDINGS[type].garrison) return true;
    const military = this.own.filter((b) => b.done && isMilitary(b));
    const empty = military.filter((b) => b.garrison.length === 0).length;
    const spare = military.reduce((n, b) => n + Math.max(0, b.garrison.length - keepOf(b)), 0);
    // Weapons only turn into fighters through a barracks.
    const trains = this.own.some((b) => b.done && BUILDINGS[b.type].barracks);
    const weapons = !trains ? 0 : FIGHTERS.reduce((n, k) => n + available(this.w, this.me, PROFESSIONS[k].tool!), 0);
    return spare + weapons - empty - 1 >= AI.homeGuard;
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

    if (def.vision) {
      // Lookout: as close to the foreign land it sees as possible.
      if (this.enemies.length === 0) return null;
      return -Math.min(...this.enemies.map((e) => Math.hypot(e.x - cx, e.y - cy)));
    }

    if (def.garrison && def.territory) {
      // Towers: push the border outwards, towards enemies and unclaimed resources, apart from each other.
      const nearestOwnMilitary = Math.min(
        ...this.own.filter((b) => isMilitary(b)).map((b) => Math.hypot(centerOf(b).x - cx, centerOf(b).y - cy)),
      );
      if (nearestOwnMilitary < def.territory * 0.5) return null;
      const reach = def.territory;
      if (this.enemies.length === 0) {
        // Enemy not found yet: scout — towers towards unexplored land, leaning towards the map
        // center (starts lie around it, so that is where the others are; the map size is public).
        const unknown = this.unexplored(cx, cy, reach + 3);
        const toCenter = Math.hypot(cx - m.w / 2, cy - m.h / 2);
        if (this.frontier) return unknown + fromCastle * 0.2 - toCenter * AI.scoutCenter;
        return fromCastle + unknown * 0.1 + this.unclaimedResources(cx, cy, reach) * 0.15 - toCenter * AI.scoutCenter * 0.3;
      }
      const enemy = Math.min(...this.enemies.map((e) => Math.hypot(e.x - cx, e.y - cy)));
      if (this.frontier) return -enemy;
      return fromCastle - enemy * 0.4 + this.unclaimedResources(cx, cy, reach) * 0.15;
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

  /**
   * Explored trees, stone, water and mountain not owned by anyone, which a tower here would bring in.
   * Mountains weigh more while it wants ore it has not found (`wantOre`), and unexplored land is
   * worth a look then too.
   */
  private unclaimedResources(cx: number, cy: number, r: number): number {
    const { w, me } = this;
    const m = w.map;
    const mountain = this.wantOre ? 4 : 1;
    // Out of stone (say): deposits of it weigh four times as much.
    const deposit = this.short.includes('stone') ? 4 : 1;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        if (!m.inBounds(x, y) || Math.hypot(x - cx, y - cy) > r) continue;
        const i = m.idx(x, y);
        if (m.owner[i] !== 0) continue;
        if (!w.isExplored(x, y, me)) {
          if (this.wantOre) n += 0.25;
          continue;
        }
        if (m.terrain[i] === Terrain.Mountain) n += mountain;
        else if (m.stone[i]) n += deposit;
        else if (m.tree[i] || m.terrain[i] === Terrain.Water) n++;
      }
    }
    return n;
  }

  /** Tiles around (cx, cy) the player has never seen (sampled every other tile). */
  private unexplored(cx: number, cy: number, r: number): number {
    const { w, me } = this;
    let n = 0;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y += 2) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x += 2) {
        if (w.map.inBounds(x, y) && Math.hypot(x - cx, y - cy) <= r && !w.isExplored(x, y, me)) n++;
      }
    }
    return n;
  }
}

/**
 * A plan step's prerequisite stands — or, for a mine, its ore is in stock: Settlers 4 mines dig a
 * deposit out fast (one food buys up to ten attempts), so a small deposit may be worked out and the
 * mine demolished before the smelter that needs its ore was built.
 */
function prerequisiteMet(w: World, me: PlayerId, own: Building[], after: BuildingType): boolean {
  if (own.some((b) => b.type === after && b.done)) return true;
  const mine = BUILDINGS[after].mine;
  return !!mine && available(w, me, mine.res) > 0;
}
