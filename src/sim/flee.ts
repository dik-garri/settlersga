/**
 * Stranded settlers, as Settlers 4's `CFleeRole` (`ISettlerRole::SetFree`): a free carrier, builder
 * or digger (`FLEE.behaviors`) standing on land that is not his owner's or an ally's — his workplace
 * burnt on land a conquest took, or the border moved away from him — walks towards the nearest land of
 * his own within `FLEE.seek`, or else to a random spot within `FLEE.wander`, a leg at a time with a
 * pause between legs. Back on own land he is an ordinary settler again; after `FLEE.legs` legs without
 * reaching it he dies (`killSettler`, so the renderer shows his death). Fighters keep their own
 * behaviour (they look for a garrison), as in S4.
 *
 * Every settler of a defeated player flees the same way, fighters and donkeys too: he has no land
 * left to reach, so he wanders for a few legs and dies.
 *
 * The state is one saved counter on the settler (`Settler.fled`); randomness comes from
 * `World.idleRng`, the stream idle settlers already use, so the economy's own RNG is untouched. Cost:
 * a spiral search of at most `FLEE.seek`² tiles per leg, for stranded settlers only.
 */
import { FLEE, PROFESSIONS } from './config';
import { killSettler } from './military';
import { sameRegion } from './regions';
import { randInt } from './rng';
import type { Point, Settler } from './types';
import type { World } from './world';

/** Offsets within `FLEE.seek`, nearest first (ties in a fixed order). */
const SPIRAL: readonly [number, number][] = (() => {
  const r = FLEE.seek;
  const out: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.hypot(dx, dy) <= r) out.push([dx, dy]);
  return out.sort((a, b) => Math.hypot(a[0], a[1]) - Math.hypot(b[0], b[1]) || a[1] - b[1] || a[0] - b[0]);
})();

/** Whether the settler stands on land of his own or an ally's. */
function onOwnLand(w: World, s: Settler): boolean {
  const x = Math.round(s.x);
  const y = Math.round(s.y);
  if (!w.map.inBounds(x, y)) return false;
  const o = w.map.owner[w.map.idx(x, y)];
  return o !== 0 && w.allied(o, s.owner);
}

/**
 * Called first in a settler's idle behaviour: true if he is stranded (or his player is out) and this
 * took care of him — the next leg queued, or his end.
 */
export function fleeing(w: World, s: Settler): boolean {
  const out = w.isDefeated(s.owner);
  if (!out) {
    if (!FLEE.behaviors.includes(PROFESSIONS[s.kind].behavior)) return false;
    if (s.inside !== null || onOwnLand(w, s)) {
      if (s.fled !== undefined) delete s.fled;
      return false;
    }
  }
  s.fled = (s.fled ?? 0) + 1;
  if (s.fled > FLEE.legs) {
    killSettler(w, s);
    return true;
  }
  s.inside = null;
  s.post = null;
  s.idleAt = null;
  s.stroll = null;
  s.chatWith = null;
  const to = (!out && nearestOwnLand(w, s)) || wanderSpot(w, s);
  const [lo, hi] = FLEE.pause;
  s.tasks = [{ t: 'wait', n: lo + randInt(w.idleRng, hi - lo + 1) }];
  if (to) s.tasks.push({ t: 'goto', x: to.x, y: to.y });
  return true;
}

/** The nearest tile of the settler's own land within `FLEE.seek` he can walk to, or null. */
function nearestOwnLand(w: World, s: Settler): Point | null {
  const m = w.map;
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  if (!m.inBounds(sx, sy)) return null;
  const from = m.idx(sx, sy);
  for (const [dx, dy] of SPIRAL) {
    const x = sx + dx;
    const y = sy + dy;
    if (!m.inBounds(x, y) || m.owner[m.idx(x, y)] !== s.owner || !m.isWalkable(x, y)) continue;
    if (m.isWalkable(sx, sy) && !sameRegion(m, from, m.idx(x, y))) continue;
    return { x, y };
  }
  return null;
}

/** A random spot within `FLEE.wander` he can walk to (a few tries), or null to stand a while. */
function wanderSpot(w: World, s: Settler): Point | null {
  const m = w.map;
  const r = FLEE.wander;
  const sx = Math.round(s.x);
  const sy = Math.round(s.y);
  const from = m.inBounds(sx, sy) && m.isWalkable(sx, sy) ? m.idx(sx, sy) : -1;
  for (let k = 0; k < 6; k++) {
    const x = sx + randInt(w.idleRng, 2 * r + 1) - r;
    const y = sy + randInt(w.idleRng, 2 * r + 1) - r;
    if (m.isWalkable(x, y) && (from < 0 || sameRegion(m, from, m.idx(x, y)))) return { x, y };
  }
  return null;
}
