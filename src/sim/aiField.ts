import { AI, BUILDINGS, PROFESSIONS } from './config';
import { inBuildingSight } from './fog';
import { isArcher, isFighter, isMilitary, keepOf } from './military';
import type { AiState } from './ai';
import type { Building, PlayerId, Point, Settler } from './types';
import type { World } from './world';

/**
 * Computer players' direct army control (`field.ts`), through the same commands a human uses
 * (`releaseFighters`, `orderMove`, `orderAttack`, `orderGarrison`, with the AI's own player id):
 * - a strike group is gathered in the field short of its target and attacks together (`stageStrike`,
 *   `updateStrike`) instead of trickling out of several buildings one by one;
 * - hostile field units on or near its land, in its buildings' sight, are met by a field squad
 *   (`defend`);
 * - a scout walks to an enemy castle its buildings cannot see (`sendScout`, `updateScout`);
 * - an enemy's last fighters, left standing when his towers fell, are hunted down (`hunt`);
 * - fighters left standing in the field when nothing needs them go back into garrisons (`sweep`).
 * Its squads are plain ids in the saved `AiState`; a squad leader comes along when one sits in a
 * building the group comes from (`orderMove` then forms the squad round him).
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function alive(w: World, me: PlayerId, ids: readonly number[]): Settler[] {
  const out: Settler[] = [];
  for (const id of ids) {
    const s = w.getSettler(id);
    if (s && !w.dying.has(id) && s.owner === me && isFighter(s) && s.inside === null) out.push(s);
  }
  return out;
}

/**
 * How many fighters `releaseFighters` must let out of `b` so its squad leader comes too (it lets the
 * melee fighters out first, then archers, each by id), or 0 when he is not among its spares.
 */
function leaderCount(w: World, b: Building): number {
  const ready = b.garrison
    .map((id) => w.getSettler(id))
    .filter((s): s is Settler => !!s && !w.dying.has(s.id) && s.inside === b.id && s.opponent === null)
    .sort((p, q) => Number(isArcher(p)) - Number(isArcher(q)) || p.id - q.id);
  const k = ready.findIndex((s) => PROFESSIONS[s.kind].combat?.leads);
  return k >= 0 && k < b.garrison.length - keepOf(b) ? k + 1 : 0;
}

/** Lets `count` fighters out of each building (ascending ids) and returns the ids of those who came out. */
function release(w: World, me: PlayerId, counts: Map<number, number>): number[] {
  const ids: number[] = [];
  for (const [bid, n] of [...counts].sort((a, b) => a[0] - b[0])) {
    const b = w.buildings.get(bid);
    if (!b) continue;
    const before = [...b.garrison];
    if (w.releaseFighters(bid, n, me) === 0) continue;
    const after = new Set(b.garrison);
    for (const id of before) if (!after.has(id)) ids.push(id);
  }
  return ids;
}

/**
 * Starts a staged strike against `target` with the party `World.attack` would send (`send` fighters):
 * they leave their garrisons and gather on the line from the target's door back towards their
 * buildings — on the first tile of their own land at least `AI.stageDistance` from the door, else at
 * that distance. Returns how many came out; 0 = not staged (the party starts too close, or
 * nobody could leave), and the caller attacks from the buildings instead.
 */
export function stageStrike(w: World, ai: AiState, target: Building, send: number): number {
  const me = ai.player;
  const party = w.attackerComposition(target.id, send, me);
  const counts = new Map<number, number>();
  for (const s of party) if (s.inside !== null) counts.set(s.inside, (counts.get(s.inside) ?? 0) + 1);
  if (counts.size === 0) return 0;
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (const [bid, k] of counts) {
    const d = w.buildings.get(bid)!.door;
    sx += d.x * k;
    sy += d.y * k;
    n += k;
  }
  const from = { x: sx / n, y: sy / n };
  const t = target.door;
  const far = dist(from, t);
  if (far < AI.stageDistance + AI.stageMinWalk) return 0;
  // A squad leader in one of those buildings leads the group (one is enough).
  for (const bid of [...counts.keys()].sort((a, b) => a - b)) {
    const need = leaderCount(w, w.buildings.get(bid)!);
    if (need > 0) {
      counts.set(bid, Math.max(counts.get(bid)!, need));
      break;
    }
  }
  // On its own land if the line back towards its buildings reaches it (out there the enemy meets the
  // group at home strength), else `AI.stageDistance` short of the door.
  const m = w.map;
  const at = (d: number) => ({
    x: Math.min(m.w - 1, Math.max(0, Math.round(t.x + ((from.x - t.x) / far) * d))),
    y: Math.min(m.h - 1, Math.max(0, Math.round(t.y + ((from.y - t.y) / far) * d))),
  });
  let { x, y } = at(AI.stageDistance);
  for (let d = AI.stageDistance; d < far - 1; d++) {
    const p = at(d);
    const i = m.idx(p.x, p.y);
    if (m.owner[i] === me && m.isWalkable(p.x, p.y)) {
      ({ x, y } = p);
      break;
    }
  }
  const ids = release(w, me, counts);
  if (ids.length === 0) return 0;
  if (w.orderMove(ids, x, y, me) === 0) {
    // No room to gather there: straight at the target.
    w.orderAttack(ids, target.id, me);
    return ids.length;
  }
  ai.strike = { target: target.id, ids, until: w.tick + AI.stageTimeout };
  ai.stats.staged = (ai.stats.staged ?? 0) + 1;
  return ids.length;
}

/**
 * A strike group being gathered: once `AI.stageArrived` of it stands at its posts (or the time is
 * up) it attacks together; a target that is gone or no longer hostile sends it back into garrisons.
 * True while it is still gathering (no other attack meanwhile).
 */
export function updateStrike(w: World, ai: AiState): boolean {
  const st = ai.strike;
  if (!st) return false;
  const me = ai.player;
  const group = alive(w, me, st.ids);
  const target = w.buildings.get(st.target);
  const valid = !!target && target.done && isMilitary(target) && !w.allied(target.owner, me) && !w.isDefeated(target.owner);
  if (!valid || group.length === 0) {
    w.orderGarrison(group.map((s) => s.id), null, me);
    ai.strike = undefined;
    return false;
  }
  const there = group.filter((s) => s.post && s.tasks.length === 0 && dist(s, s.post) <= 1.5).length;
  if (there < group.length * AI.stageArrived && w.tick < st.until) {
    st.ids = group.map((s) => s.id);
    return true;
  }
  w.orderAttack(group.map((s) => s.id), st.target, me);
  ai.strike = undefined;
  return false;
}

/** A hostile field unit stands on its land or within `margin` tiles of it. */
function nearOwnLand(w: World, x: number, y: number, me: PlayerId, margin: number): boolean {
  const m = w.map;
  for (let dy = -margin; dy <= margin; dy++) {
    for (let dx = -margin; dx <= margin; dx++) {
      if (m.inBounds(x + dx, y + dy) && m.owner[m.idx(x + dx, y + dy)] === me) return true;
    }
  }
  return false;
}

/**
 * Meets hostile field units near its land with a field squad of `AI.defendRatio` times their number
 * from its military buildings within `AI.defendRange` (spares only: each keeps its `keep`); only if
 * it can field at least as many as they are — otherwise its fighters defend from their walls. When
 * none are left in sight the squad goes back into garrisons.
 */
export function defend(w: World, ai: AiState, own: Building[]): void {
  const me = ai.player;
  const m = w.map;
  const threats: Settler[] = [];
  for (const s of w.settlers) {
    if (!s.post || s.inside !== null || s.owner === me || w.allied(s.owner, me) || !isFighter(s) || w.dying.has(s.id)) continue;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (!m.inBounds(x, y) || !inBuildingSight(w, m.idx(x, y), me)) continue;
    if (nearOwnLand(w, x, y, me, AI.defendMargin)) threats.push(s);
  }
  const squad = ai.defense ? alive(w, me, ai.defense.ids) : [];
  if (threats.length === 0) {
    if (ai.defense) w.orderGarrison(squad.map((s) => s.id), null, me);
    ai.defense = undefined;
    return;
  }
  const c = {
    x: Math.round(threats.reduce((n, s) => n + s.x, 0) / threats.length),
    y: Math.round(threats.reduce((n, s) => n + s.y, 0) / threats.length),
  };
  const need = Math.ceil(threats.length * AI.defendRatio);
  let ids = squad.map((s) => s.id);
  if (ids.length < need) {
    const sources = own
      .filter((b) => b.done && isMilitary(b) && BUILDINGS[b.type].garrison && dist(b.door, c) <= AI.defendRange)
      .sort((a, b) => dist(a.door, c) - dist(b.door, c) || a.id - b.id);
    const spare = sources.reduce((n, b) => n + Math.max(0, b.garrison.length - keepOf(b)), 0);
    // Too few to match them in the open: stay behind the walls.
    if (ids.length === 0 && spare < threats.length) return;
    const counts = new Map<number, number>();
    let want = need - ids.length;
    for (const b of sources) {
      if (want <= 0) break;
      const k = Math.min(want, Math.max(0, b.garrison.length - keepOf(b)));
      if (k > 0) counts.set(b.id, k);
      want -= k;
    }
    const out = release(w, me, counts);
    if (out.length > 0 && ids.length === 0) ai.stats.defended = (ai.stats.defended ?? 0) + 1;
    if (out.length === 0 && ai.defense && dist(ai.defense, c) <= 2) return; // nobody new, in place already
    ids = [...ids, ...out];
  } else if (ai.defense && dist(ai.defense, c) <= 2) return; // in place already
  if (ids.length === 0) return;
  w.orderMove(ids, c.x, c.y, me);
  ai.defense = { ids, x: c.x, y: c.y };
}

/**
 * Hunts an enemy's last fighters (`DEFEAT.fighters`: he is out only when they are gone): his fighters
 * seen outdoors in its buildings' sight, when it knows no military building of his (explored doors
 * only, as `knownEnemies`) — stragglers left standing when his towers fell; field units near its land
 * are left to `defend`. A field squad of `AI.huntRatio` times their number (at least `AI.huntMin`) of
 * spares from its military buildings nearest them — only if its spares at least match them — is sent
 * to the nearest one; field units engage what they meet (`field.ts`). Back into garrisons when none
 * are left in sight. Public commands only (`releaseFighters`, `orderMove`, `orderGarrison`).
 */
export function hunt(w: World, ai: AiState, own: Building[]): void {
  const me = ai.player;
  const m = w.map;
  const holding = new Set<PlayerId>();
  for (const b of w.buildings.values()) {
    if (b.owner === me || !isMilitary(b) || w.allied(b.owner, me) || !w.isExplored(b.door.x, b.door.y, me)) continue;
    holding.add(b.owner);
  }
  const prey: Settler[] = [];
  for (const s of w.settlers) {
    if (s.inside !== null || w.allied(s.owner, me) || holding.has(s.owner) || w.isDefeated(s.owner)) continue;
    if (!isFighter(s) || w.dying.has(s.id)) continue;
    const x = Math.round(s.x);
    const y = Math.round(s.y);
    if (!m.inBounds(x, y) || !inBuildingSight(w, m.idx(x, y), me)) continue;
    // Field units near its land are `defend`'s.
    if (s.post && nearOwnLand(w, x, y, me, AI.defendMargin)) continue;
    prey.push(s);
  }
  const squad = ai.hunt ? alive(w, me, ai.hunt.ids) : [];
  if (prey.length === 0) {
    if (ai.hunt) w.orderGarrison(squad.map((s) => s.id), null, me);
    ai.hunt = undefined;
    return;
  }
  const from: Point = squad.length > 0 ? squad[0] : w.homeOf(me);
  let goal = prey[0];
  for (const s of prey) if (dist(s, from) < dist(goal, from) || (dist(s, from) === dist(goal, from) && s.id < goal.id)) goal = s;
  const at = { x: Math.round(goal.x), y: Math.round(goal.y) };
  const need = Math.max(AI.huntMin, Math.ceil(prey.length * AI.huntRatio));
  let ids = squad.map((s) => s.id);
  if (ids.length < need) {
    const sources = own
      .filter((b) => b.done && isMilitary(b) && b.garrison.length > keepOf(b))
      .sort((a, b) => dist(a.door, at) - dist(b.door, at) || a.id - b.id);
    // Too few to outnumber them: not yet.
    const spare = sources.reduce((n, b) => n + b.garrison.length - keepOf(b), 0);
    if (ids.length + spare < prey.length) return;
    const counts = new Map<number, number>();
    let want = need - ids.length;
    for (const b of sources) {
      if (want <= 0) break;
      const k = Math.min(want, b.garrison.length - keepOf(b));
      counts.set(b.id, k);
      want -= k;
    }
    const out = release(w, me, counts);
    if (out.length > 0 && ids.length === 0) ai.stats.hunts = (ai.stats.hunts ?? 0) + 1;
    ids = [...ids, ...out];
  } else if (ai.hunt && dist(ai.hunt, at) <= 2) return; // on its way there already
  if (ids.length === 0) return;
  w.orderMove(ids, at.x, at.y, me);
  ai.hunt = { ids, x: at.x, y: at.y };
}

/**
 * Sends one spare fighter (above `keepOf`) of the military building nearest `goal` there as a field
 * unit: a scout. What he sees is explored for good, so a castle forest, water or swamp keeps out of
 * its buildings' sight is still found. True if one went.
 */
export function sendScout(w: World, ai: AiState, own: Building[], goal: Point): boolean {
  const me = ai.player;
  const source = own
    .filter((b) => b.done && isMilitary(b) && b.garrison.length > keepOf(b))
    .sort((a, b) => dist(a.door, goal) - dist(b.door, goal) || a.id - b.id)[0];
  if (!source) return false;
  const ids = release(w, me, new Map([[source.id, 1]]));
  if (ids.length === 0) return false;
  if (w.orderMove(ids, Math.round(goal.x), Math.round(goal.y), me) === 0) {
    w.orderGarrison(ids, null, me);
    return false;
  }
  ai.scout = { id: ids[0], until: w.tick + AI.scoutTimeout };
  return true;
}

/**
 * A scout out: kept in the field while `needed` (no enemy castle known yet) and his time lasts, then
 * sent back into a garrison. True while he is still out.
 */
export function updateScout(w: World, ai: AiState, needed: boolean): boolean {
  const sc = ai.scout;
  if (!sc) return false;
  const [s] = alive(w, ai.player, [sc.id]);
  if (s && needed && w.tick < sc.until) return true;
  if (s) w.orderGarrison([s.id], null, ai.player);
  ai.scout = undefined;
  return false;
}

/** Own fighters idle in the field that no strike, squad or scout of the AI holds go back into garrisons. */
export function sweep(w: World, ai: AiState): void {
  const me = ai.player;
  const held = new Set([
    ...(ai.strike?.ids ?? []),
    ...(ai.defense?.ids ?? []),
    ...(ai.hunt?.ids ?? []),
    ...(ai.scout ? [ai.scout.id] : []),
  ]);
  const stray: number[] = [];
  for (const s of w.settlers) {
    if (s.owner !== me || !s.post || s.inside !== null || s.tasks.length > 0 || s.opponent !== null) continue;
    if (!isFighter(s) || held.has(s.id) || w.dying.has(s.id)) continue;
    stray.push(s.id);
  }
  if (stray.length > 0) w.orderGarrison(stray, null, me);
}
