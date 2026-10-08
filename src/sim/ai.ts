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
import { claimable, robbable } from './specialists';
import { FIGHTERS, isFighter, isMilitary, keepOf } from './military';
import { hasGatherTargetNear, isGatherTarget } from './nature';
import { RESOURCES, Terrain, type Building, type BuildingType, type PlayerId, type Point, type Resource } from './types';
import { startPositions, type World } from './world';

/** Per computer player; saved with the world. */
export interface AiState {
  player: PlayerId;
  nextThink: number;
  lastAttack: number;
  /** Building type (or 'frontier') → tick before which the AI does not look for a spot again. */
  blockedUntil: Partial<Record<BuildingType | 'frontier' | 'decor' | 'room' | 'siege' | 'siegeLookout', number>>;
  /** Ore it wants a mine for but knows no deposit of: towers then favour mountains, geologists go out. */
  wantOre: Resource | null;
  /** Its weapon shares have been set (once, through `setShare`). */
  sharesSet: boolean;
  /** Tick until which it is short of room (a wanted building found no spot): it pushes its border harder. */
  crampedUntil: number;
  /** Tick of its next pioneer/thief decision. */
  nextSpecialists: number;
  /** The building its last attack went for (0 = none): taken by now, it follows up sooner. */
  lastTarget?: number;
  stats: {
    placed: number;
    attacks: number;
    soldiersSent: number;
    geologists: number;
    demolished: number;
    pioneers: number;
    thieves: number;
  };
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
    crampedUntil: 0,
    nextSpecialists: AI.specialistEvery + player * 13,
    stats: { placed: 0, attacks: 0, soldiersSent: 0, geologists: 0, demolished: 0, pioneers: 0, thieves: 0 },
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
  if (w.tick >= (ai.nextSpecialists ?? 0)) {
    ai.nextSpecialists = w.tick + AI.specialistEvery;
    useSpecialists(w, ai, own);
  }

  const sites = own.filter((b) => !b.done);
  if (sites.length >= AI.maxOpenSites) return;
  const ctx = new Context(w, me, own, ai.wantOre);
  if (siege(ctx, ai)) return;

  // Scouting: foreign land in sight but no enemy building known — a lookout tower at that border
  // sees much further than a tower (whose land stops at the other's border).
  // Only lookouts near that land count against the limit: one put up earlier, further back, must not
  // keep it from building one where it matters (at most twice the limit in all).
  if (ctx.scoutingBorder) {
    const lookout = LOOKOUTS.find((t) => {
      const mine = own.filter((b) => b.type === t);
      const useful = mine.filter((b) => ctx.nearEnemies(centerOf(b), visionRadius(t))).length;
      return useful < AI.maxLookouts && mine.length < AI.maxLookouts * 2 && ctx.affordable(t);
    });
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
    // A workshop, house or barracks with nowhere to go: its land is full, so it must grow — and a
    // building it cannot do without (the barracks: no new fighters, so no growth) gets room made.
    if (!mine && !gatheredBy(step.type) && !BUILDINGS[step.type].garrison) {
      ai.crampedUntil = w.tick + AI.crampedTicks;
      if (AI.makeRoomFor.includes(step.type) && makeRoom(w, ai, own, step.type)) return;
    }
    ai.blockedUntil[step.type] = w.tick + RETRY_TICKS;
  }

  // Spare materials go into eyecatchers: they raise its settlement value and so its army's strength
  // on foreign land (`strength.ts`), one per `AI.decorEvery` buildings.
  const decor = own.filter((b) => BUILDINGS[b.type].eyecatcher).length;
  // Not while cramped: an eyecatcher takes the room a workshop or tower needs.
  const roomy = w.tick >= (ai.crampedUntil ?? 0);
  if (roomy && decor * AI.decorEvery < own.length && (ai.blockedUntil.decor ?? -Infinity) <= w.tick) {
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
  // Cramped (no room for a wanted building) it grows with any fighter it can spare; without a known
  // enemy it keeps the number of outposts down — they go towards the other starts, not everywhere.
  const cramped = w.tick < (ai.crampedUntil ?? 0);
  const garrisoned = military.filter((b) => BUILDINGS[b.type].garrison).length;
  if (
    !attacked &&
    (ai.wantOre !== null || cramped || !enemyInReach(w, me, military)) &&
    (ai.blockedUntil.frontier ?? -Infinity) <= w.tick &&
    (soldiers >= AI.frontierSoldiers || cramped) &&
    military.length < AI.maxMilitary &&
    // The cap grows slowly, so an enemy further away than its first outposts reach is still found.
    // Foreign land in sight already shows where the enemy is: no cap then, outposts push into contact.
    (ctx.knowsEnemy ||
      ctx.scoutingBorder ||
      cramped ||
      garrisoned < AI.maxScoutOutposts + Math.floor(w.tick / AI.scoutOutpostEvery)) &&
    military.every((b) => b.done && (b.garrison.length > 0 || !BUILDINGS[b.type].garrison))
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
  // The border band is a preference: with no room in the core, a workshop may still go there —
  // houses and eyecatchers may not (more of them can wait until the border has moved out).
  let spot = ctx.bestSpot(type);
  const yields = !BUILDINGS[type].residence && !BUILDINGS[type].eyecatcher;
  if (!spot && ctx.reserveBand && yields) {
    ctx.reserveBand = false;
    spot = ctx.bestSpot(type);
    ctx.reserveBand = true;
  }
  if (!spot) return false;
  ai.stats.placed++;
  return true;
}

/** No known ore for a wanted mine: send a geologist to the nearest unexplored mountain we own. */
/**
 * No room anywhere for a building it cannot do without (`AI.makeRoomFor`): demolishes the least
 * valuable building at least as large — an eyecatcher, else a second (or later) workshop of a type
 * it has several of — so the next think can place it there. One demolition per `RETRY_TICKS`.
 */
function makeRoom(w: World, ai: AiState, own: Building[], type: BuildingType): boolean {
  if ((ai.blockedUntil.room ?? -Infinity) > w.tick) return false;
  ai.blockedUntil.room = w.tick + RETRY_TICKS;
  const need = BUILDINGS[type];
  const count = (t: BuildingType) => own.filter((b) => b.type === t).length;
  let victim: Building | null = null;
  let worst = Infinity;
  for (const b of own) {
    const def = BUILDINGS[b.type];
    if (!b.done || def.w < need.w || def.h < need.h || def.garrison || def.storage || def.mine || def.residence) continue;
    const value = def.eyecatcher ? 0 : count(b.type) > 1 && def.recipe ? 1 : Infinity;
    // Ties: the newest (highest id) first.
    if (value < worst || (value === worst && victim && b.id > victim.id)) {
      worst = value;
      victim = b;
    }
  }
  if (!victim || worst === Infinity) return false;
  const victimType = victim.type;
  if (!w.demolish(victim.id, ai.player)) return false;
  ai.stats.demolished++;
  // The plan would rebuild the demolished type on the freed spot first: hold it back for a while.
  ai.blockedUntil[victimType] = w.tick + RETRY_TICKS * 4;
  // Retry the wanted building right away on the next think.
  delete ai.blockedUntil[type];
  return true;
}

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
 * The castle of each enemy it knows, by owner: the building that ends the game, so the target its
 * attacks work towards and its siege buildings gather around.
 */
function knownCastles(w: World, me: PlayerId): Map<PlayerId, Building> {
  const out = new Map<PlayerId, Building>();
  for (const { b } of knownEnemies(w, me)) {
    if (b.done && w.castleOf(b.owner) === b) out.set(b.owner, b);
  }
  return out;
}

/**
 * Sends every spare soldier in range against the best known enemy military building: one it clearly
 * outnumbers (party strength against what it can see of the defence), preferring the castle, then
 * targets that bring it closer to an enemy castle (its siege buildings are staged there), then ones
 * the enemy cannot easily retake from neighbouring buildings. After a capture it follows up sooner
 * (`AI.followUpCooldown`). True if it attacked (or is still cooling down from an attack).
 */
function attackIfStrong(w: World, ai: AiState): boolean {
  const me = ai.player;
  const last = ai.lastTarget ? w.buildings.get(ai.lastTarget) : undefined;
  const pressing = !!last && last.owner === me;
  if (w.tick - ai.lastAttack < (pressing ? AI.followUpCooldown : AI.attackCooldown)) return true;
  // No rush: the early game is for building up.
  if (w.tick < AI.peaceTicks) return false;
  const known = knownEnemies(w, me);
  const castles = knownCastles(w, me);
  // Where each enemy's castle is (or presumably is): attacks work towards it.
  const goals = new Map<PlayerId, Point>();
  for (const g of siegeGoals(w, me)) goals.set(g.owner, g);
  // Its fighters fight on foreign land at its attack strength (its own settlement value, which it
  // knows); the defenders' strength it cannot know, so it assumes the base 100 %. Strength scales both
  // the chance to land a blow and its damage (`blow`), so it counts squared.
  const field = (attackStrength(w, me) / 100) ** 2;
  let target: Building | null = null;
  let send = 0;
  let bestScore = -Infinity;
  for (const { b, defenders } of known) {
    if (!b.done || !isMilitary(b)) continue;
    const ready = w.attackerComposition(b.id, Infinity, me);
    // Only swordsmen take a building: a party without one could only kill, never conquer.
    if (!ready.some((s) => PROFESSIONS[s.kind].combat?.captures)) continue;
    const power =
      ready.reduce((n, s) => n + SOLDIER_LEVELS[s.level].damage * (PROFESSIONS[s.kind].combat?.melee ?? 1), 0) * field;
    const defense = defenders * (BUILDINGS[b.type].garrison!.defense ?? 1);
    if (ready.length < AI.minAttackers || power < AI.attackRatio * defense + 1) continue;
    const c = centerOf(b);
    const goal = goals.get(b.owner);
    let score = power - AI.attackRatio * defense;
    if (castles.get(b.owner) === b) score += 100;
    else if (goal) score -= Math.hypot(goal.x - c.x, goal.y - c.y) * AI.depthWeight;
    // Neighbours of the same owner it knows of: they will send fighters to retake it.
    const helpers = known.filter(
      (e) =>
        e.b !== b &&
        e.b.owner === b.owner &&
        isMilitary(e.b) &&
        Math.hypot(centerOf(e.b).x - c.x, centerOf(e.b).y - c.y) <= ATTACK_RANGE,
    ).length;
    score -= helpers * AI.reinforceWeight;
    if (score > bestScore) {
      bestScore = score;
      target = b;
      send = ready.length;
    }
  }
  if (!target) return false;
  const sent = w.attack(target.id, send, me);
  if (sent === 0) return false;
  ai.lastAttack = w.tick;
  ai.lastTarget = target.id;
  ai.stats.attacks++;
  ai.stats.soldiersSent += sent;
  return true;
}

/**
 * Where it besieges each enemy it knows of: that enemy's castle once explored, else the castle's
 * presumed place — the start position (public, like the map size) nearest to the enemy buildings it
 * knows. The siege then pushes towards it until the castle comes into sight.
 */
function siegeGoals(w: World, me: PlayerId): (Point & { seen: boolean; owner: PlayerId })[] {
  const known = knownEnemies(w, me);
  const castles = knownCastles(w, me);
  const starts = startPositions(w.map.w, w.players.length);
  const owners = [...new Set(known.map((e) => e.b.owner))].sort((a, b) => a - b);
  const goals: (Point & { seen: boolean; owner: PlayerId })[] = [];
  for (const o of owners) {
    const castle = castles.get(o);
    if (castle) {
      goals.push({ ...centerOf(castle), seen: true, owner: o });
      continue;
    }
    const theirs = known.filter((e) => e.b.owner === o).map((e) => centerOf(e.b));
    let best: Point | null = null;
    let bestD = Infinity;
    for (const st of starts) {
      const d = Math.min(...theirs.map((t) => Math.hypot(t.x - st.x, t.y - st.y)));
      if (d < bestD) {
        bestD = d;
        best = st;
      }
    }
    if (best) goals.push({ ...best, seen: false, owner: o });
  }
  return goals;
}

/**
 * Siege: too few of its military buildings stand within `ATTACK_RANGE` of an enemy castle (known, or
 * presumed — `siegeGoals`) for a strike force big enough to gather there (only fighters of buildings
 * in range join an attack). Puts up the largest military building it can pay for and man as near
 * that castle as its land allows — within `ATTACK_RANGE − AI.siegeMargin` if it can, else just closer
 * than any it has, which pushes its land (and sight) on towards it — even with enemies in reach and
 * beyond `AI.maxMilitary`. True if it placed one.
 */
function siege(ctx: Context, ai: AiState): boolean {
  const { w, me } = ctx;
  if (w.tick < AI.peaceTicks || (ai.blockedUntil.siege ?? -Infinity) > w.tick) return false;
  const military = ctx.own.filter((b) => isMilitary(b));
  // Bounded: a siege whose new land keeps being taken by closer enemy buildings must not build forever.
  if (military.length === 0 || military.length >= AI.maxMilitary + AI.siegeExtra) return false;
  let goal: (Point & { seen: boolean; owner: PlayerId }) | null = null;
  let closest = Infinity;
  for (const c of siegeGoals(w, me)) {
    const dist = (b: Building) => Math.hypot(centerOf(b).x - c.x, centerOf(b).y - c.y);
    // A castle in sight needs a strike force staged round it; one still unseen needs sight first, so
    // the siege keeps pushing until the castle is explored (buildings see little beyond their land).
    if (c.seen && military.filter((b) => dist(b) <= ATTACK_RANGE).length >= AI.siegeBuildings) continue;
    const d = Math.min(...military.map(dist));
    if (d < closest) {
      closest = d;
      goal = c;
    }
  }
  if (!goal) return false;
  // How close its land already comes to the goal: a new building must bring it closer.
  const m = w.map;
  const land = Math.min(...ctx.tiles.map((i) => Math.hypot((i % m.w) - goal.x, Math.floor(i / m.w) - goal.y)));
  // A castle not yet in sight: a lookout as near it as its land allows sees furthest, cheaply.
  if (!goal.seen && (ai.blockedUntil.siegeLookout ?? -Infinity) <= w.tick) {
    const lookout = LOOKOUTS.find((t) => ctx.affordable(t));
    if (lookout) {
      ctx.siege = { ...goal, reach: land + 3, land };
      const placed = tryPlace(ctx, ai, lookout);
      ctx.siege = null;
      if (placed) return true;
      ai.blockedUntil.siegeLookout = w.tick + RETRY_TICKS;
    }
  }
  const type = FRONTIER.find((t) => ctx.canMan(t) && ctx.affordable(t));
  if (!type) return false;
  // Within striking range of a seen castle if it can; otherwise any spot whose land reaches closer.
  ctx.siege = { ...goal, reach: goal.seen ? ATTACK_RANGE - AI.siegeMargin : -1, land };
  const placed = tryPlace(ctx, ai, type);
  ctx.siege = null;
  if (!placed) ai.blockedUntil.siege = w.tick + RETRY_TICKS;
  return placed;
}

/** Everything a single think needs about the AI's own side, computed once. */
class Context {
  /** Own territory tiles, sampled every `stride` tiles on large territories. */
  readonly tiles: number[];
  /** Military buildings go as close to the nearest enemy as possible (instead of claiming resources). */
  frontier = false;
  /**
   * Siege: a military building goes within `reach` of this enemy castle (as close as possible), or
   * else where its land would reach closer to it than its land does now (`land`, tiles); a lookout
   * goes within `reach`.
   */
  siege: (Point & { reach: number; land: number }) | null = null;
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
  /**
   * It knows no enemy and sees no foreign land: `enemies` are then the other start positions it has
   * not explored (where the others began — public, like the map size), so scouting has a direction.
   */
  readonly scoutingStarts: boolean;
  /** It knows an enemy building. */
  readonly knowsEnemy: boolean;
  /** Own tiles within `AI.borderReserve` steps of the border: kept for military buildings. */
  private readonly band: Set<number>;
  /** Whether workshops and houses keep off the band (cleared for a retry when nothing else fits). */
  reserveBand = true;

  constructor(
    readonly w: World,
    readonly me: PlayerId,
    readonly own: Building[],
    readonly wantOre: Resource | null = null,
  ) {
    this.castle = centerOf(w.castleOf(me));
    const known = knownEnemies(w, me);
    this.knowsEnemy = known.length > 0;
    this.enemies = known.length > 0 ? known.map((e) => centerOf(e.b)) : this.foreignLandInSight();
    this.scoutingBorder = known.length === 0 && this.enemies.length > 0;
    this.scoutingStarts = false;
    if (this.enemies.length === 0) {
      this.enemies = unexploredStarts(w, me);
      this.scoutingStarts = this.enemies.length > 0;
    }
    this.tiles = this.territory();
    this.band = this.borderBand();
    this.short = (Object.keys(AI.reserve) as Resource[]).filter((r) => !this.producing(r));
  }

  /** Some enemy point (known building, foreign land in sight, or a start it scouts for) within `r` of `p`. */
  nearEnemies(p: Point, r: number): boolean {
    return this.enemies.some((e) => Math.hypot(e.x - p.x, e.y - p.y) <= r);
  }

  /** Own tiles within `AI.borderReserve` 4-steps of a tile that is not its own. */
  private borderBand(): Set<number> {
    const m = this.w.map;
    const band = new Set<number>();
    const r = AI.borderReserve;
    if (r <= 0) return band;
    for (const i of this.tiles) {
      const x = i % m.w;
      const y = Math.floor(i / m.w);
      search: for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.abs(dx) + Math.abs(dy) > r) continue;
          if (!m.inBounds(x + dx, y + dy) || m.owner[m.idx(x + dx, y + dy)] !== this.me) {
            band.add(i);
            break search;
          }
        }
      }
    }
    return band;
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

    if (this.siege && (def.vision || (def.garrison && def.territory))) {
      const d = Math.hypot(this.siege.x - cx, this.siege.y - cy);
      if (d <= this.siege.reach) return 1000 - d;
      // Out of reach: worth it only if its land brings the border on towards the goal.
      const claims = d - (def.territory ?? 0);
      return def.territory && claims <= this.siege.land - AI.siegeStep ? -claims : null;
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
      // Scouting for the other starts: a line of towers towards them, not a ring around the castle.
      if (this.scoutingStarts) return fromCastle * 0.3 - enemy + this.unclaimedResources(cx, cy, reach) * 0.1;
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
    // Workshops, houses, storage: keep the base compact, and off the border band (room for towers).
    if (this.reserveBand) {
      for (let dy = 0; dy <= def.h; dy++) {
        for (let dx = 0; dx < def.w; dx++) if (this.band.has(m.idx(x + dx, y + dy))) return null;
      }
    }
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

/**
 * Start positions (public: they follow from the map size and the number of players) it has not
 * explored and that are not its own or an ally's: where the others most likely are.
 */
function unexploredStarts(w: World, me: PlayerId): Point[] {
  const friendly = [...w.buildings.values()].filter((b) => w.allied(b.owner, me)).map((b) => centerOf(b));
  return startPositions(w.map.w, w.players.length).filter((st) => {
    if (friendly.some((f) => Math.hypot(f.x - st.x, f.y - st.y) < 8)) return false;
    return !w.isExplored(st.x, st.y, me);
  });
}

/**
 * Pioneers and thieves, through the public orders and errands only: a pioneer pushes its border into
 * neutral land rich in resources (or towards the starts it scouts for); a thief robs a known enemy
 * store within reach while it has carriers to spare.
 */
function useSpecialists(w: World, ai: AiState, own: Building[]): void {
  const me = ai.player;
  const idle = w.settlers.filter((s) => s.owner === me && s.kind === 'carrier' && s.tasks.length === 0).length;
  const has = (kind: 'pioneer' | 'thief') => w.settlers.some((s) => s.owner === me && s.kind === kind);

  // Pioneer: only with shovels to spare (diggers and foresters need them).
  if (available(w, me, 'shovel') >= AI.pioneerShovels || has('pioneer')) {
    if (!has('pioneer')) w.orderSpecialist('pioneer', 1, me);
    const free = w.settlers.some((s) => s.owner === me && s.kind === 'pioneer' && s.tasks.length === 0 && !s.errand);
    if (free) {
      const spot = pioneerSpot(w, me, own);
      if (spot && w.sendPioneer(spot.x, spot.y, me)) ai.stats.pioneers++;
    }
  }

  // Thief: a known enemy store with goods, close to its land.
  if (idle >= AI.thiefIdle) {
    const castle = centerOf(w.castleOf(me));
    let target: Building | null = null;
    let best = Infinity;
    for (const { b } of knownEnemies(w, me)) {
      if (!BUILDINGS[b.type].storage || !robbable(w, b, me)) continue;
      const d = Math.hypot(b.door.x - castle.x, b.door.y - castle.y);
      if (d <= AI.thiefRange && d < best) {
        best = d;
        target = b;
      }
    }
    if (target) {
      if (!has('thief')) w.orderSpecialist('thief', 1, me);
      if (w.sendThief(target.id, me)) ai.stats.thieves++;
    }
  }
}

/**
 * A neutral spot next to its land worth a pioneer: around its military buildings' edges, the most
 * explored unclaimed resources nearby, leaning towards the starts it still scouts for (bounded sample).
 */
function pioneerSpot(w: World, me: PlayerId, own: Building[]): Point | null {
  const m = w.map;
  const castle = centerOf(w.castleOf(me));
  const targets = knownEnemies(w, me).length === 0 ? unexploredStarts(w, me) : [];
  let best: Point | null = null;
  let bestScore = -Infinity;
  for (const b of own) {
    if (!isMilitary(b) || !b.done) continue;
    const c = centerOf(b);
    const r = (BUILDINGS[b.type].territory ?? 0) + 1;
    for (let a = 0; a < 16; a++) {
      const x = Math.round(c.x + Math.cos((a / 16) * Math.PI * 2) * r);
      const y = Math.round(c.y + Math.sin((a / 16) * Math.PI * 2) * r);
      if (!claimable(w, x, y, me)) continue;
      let value = 0;
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (!m.inBounds(x + dx, y + dy)) continue;
          const i = m.idx(x + dx, y + dy);
          if (m.owner[i] !== 0 || !w.isExplored(x + dx, y + dy, me)) continue;
          if (m.stone[i]) value += 3;
          else if (m.terrain[i] === Terrain.Mountain) value += 2;
          else if (m.tree[i] || m.isBuildable(x + dx, y + dy)) value += 1;
        }
      }
      const toward = targets.length ? -Math.min(...targets.map((t) => Math.hypot(t.x - x, t.y - y))) * 0.5 : 0;
      const score = value + toward - Math.hypot(x - castle.x, y - castle.y) * 0.1;
      if (score > bestScore || (score === bestScore && best && m.idx(x, y) < m.idx(best.x, best.y))) {
        bestScore = score;
        best = { x, y };
      }
    }
  }
  return best;
}
