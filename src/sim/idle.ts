import { BUILDINGS, IDLE, IDLE_GO_HOME_TICKS, TERRAIN } from './config';
import { findPath } from './pathfinding';
import { randInt } from './rng';
import { move } from './settlers';
import { Terrain, type Building, type Point, type Settler } from './types';
import type { World } from './world';

/**
 * Idle crowds, as in Settlers 4: a free settler (a carrier without a job, a builder or digger
 * without a site) does not vanish into a warehouse. After `IDLE_GO_HOME_TICKS` it walks to the
 * nearest warehouse, castle or house that does not already have `IDLE.groupSize` idle settlers
 * about it, and hangs about outside: every `IDLE.strollEvery` ticks it strolls to another spot
 * within `IDLE.radius` of the door, or goes to stand next to another idle settler of the group to
 * chat (`chatWith`, mutual; the renderer turns them to face each other).
 *
 * The settler keeps an empty task queue the whole time, so the dispatcher (which takes the nearest
 * idle carrier wherever it stands) and everything else that counts idle settlers see it as free; the
 * stroll lives in `stroll` + `path`, and `updateSettler` drops both the moment a task arrives.
 * Settlers never block tiles, so crowds need no connectivity checks; spots exclude door tiles and
 * water. All randomness comes from `World.idleRng`, a stream of its own.
 */
export function restIdle(w: World, s: Settler): void {
  if (s.idleTicks <= IDLE_GO_HOME_TICKS) return;
  if (s.inside !== null) {
    // Spawned in a house or left in a building: step out of the door.
    s.inside = null;
    s.strollIn = 0;
  }
  // A new idle spell (or the gathering place is gone): pick where to hang about.
  if (s.idleTicks === IDLE_GO_HOME_TICKS + 1 || !validAnchor(w, s, s.idleAt)) {
    s.idleAt = chooseAnchor(w, s);
    s.stroll = null;
    s.path = [];
    s.strollIn = 0;
  }
  const anchor = s.idleAt !== null ? w.buildings.get(s.idleAt) : undefined;
  if (!anchor) return;

  if (s.stroll) {
    walk(w, s);
    return;
  }
  if (--s.strollIn > 0) return;
  s.strollIn = IDLE.strollEvery[0] + randInt(w.idleRng, IDLE.strollEvery[1] - IDLE.strollEvery[0] + 1);
  const target = strollTarget(w, s, anchor);
  if (!target) return;
  const p = findPath(w.map, Math.round(s.x), Math.round(s.y), target.x, target.y);
  if (!p) return;
  s.stroll = target;
  s.path = p;
}

/** The chat partner, if the pair still stands together idle. */
export function chatPartner(w: World, s: Settler): Settler | undefined {
  if (s.chatWith === null || s.tasks.length > 0) return undefined;
  const o = w.settlerById.get(s.chatWith);
  if (!o || o.tasks.length > 0 || o.chatWith !== s.id || o.inside !== null) return undefined;
  return o;
}

function walk(w: World, s: Settler): void {
  const t = s.stroll!;
  if (s.path.length === 0) {
    if (s.x === t.x && s.y === t.y) {
      s.stroll = null;
      return;
    }
    const p = findPath(w.map, Math.round(s.x), Math.round(s.y), t.x, t.y);
    if (!p) {
      s.stroll = null;
      return;
    }
    s.path = p;
  }
  move(w, s, t, () => {
    // Something was built or grew in the way: give this stroll up.
    s.stroll = null;
    s.path = [];
  });
  if (s.stroll && s.path.length === 0) s.stroll = null;
}

function gathers(b: Building): boolean {
  const def = BUILDINGS[b.type];
  return b.done && IDLE.gatherAt.some((k) => (k === 'storage' ? !!def.storage : !!def.residence));
}

function validAnchor(w: World, s: Settler, id: number | null): boolean {
  if (id === null) return false;
  const b = w.buildings.get(id);
  return !!b && b.owner === s.owner && gathers(b);
}

function idleAround(w: World, s: Settler, b: Building): number {
  let n = 0;
  for (const o of w.settlers) {
    if (o !== s && o.owner === s.owner && o.idleAt === b.id && o.tasks.length === 0) n++;
  }
  return n;
}

/** Nearest gathering building, preferring those whose group is not full yet. */
function chooseAnchor(w: World, s: Settler): number | null {
  let best: Building | undefined;
  let bestScore = Infinity;
  for (const b of w.buildings.values()) {
    if (b.owner !== s.owner || !gathers(b)) continue;
    const d = Math.hypot(s.x - b.door.x, s.y - b.door.y);
    // Cheap test first: a farther building cannot beat the best even with room.
    if (d >= bestScore) continue;
    const score = d + (idleAround(w, s, b) >= IDLE.groupSize ? 1000 : 0);
    if (score < bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return best ? best.id : null;
}

function standable(w: World, s: Settler, x: number, y: number): boolean {
  const m = w.map;
  if (!m.inBounds(x, y) || !m.isWalkable(x, y)) return false;
  const i = m.idx(x, y);
  return m.door[i] === 0 && m.owner[i] === s.owner && !TERRAIN[m.terrain[i] as Terrain].water;
}

const NEIGHBOURS: [number, number][] = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [-1, -1],
  [1, -1],
  [-1, 1],
];

function strollTarget(w: World, s: Settler, anchor: Building): Point | null {
  const rng = w.idleRng;
  const r = IDLE.radius;
  // Leaving a chat: the partner is free to find someone else.
  const old = chatPartner(w, s);
  if (old) old.chatWith = null;
  s.chatWith = null;
  if (rng() < IDLE.chatChance) {
    const partner = w.settlers.find(
      (o) =>
        o !== s &&
        o.owner === s.owner &&
        o.idleAt === anchor.id &&
        o.tasks.length === 0 &&
        o.inside === null &&
        o.stroll === null &&
        !chatPartner(w, o) &&
        Math.hypot(o.x - anchor.door.x, o.y - anchor.door.y) <= r + 1,
    );
    if (partner) {
      const start = randInt(rng, NEIGHBOURS.length);
      for (let k = 0; k < NEIGHBOURS.length; k++) {
        const [dx, dy] = NEIGHBOURS[(start + k) % NEIGHBOURS.length];
        const x = Math.round(partner.x) + dx;
        const y = Math.round(partner.y) + dy;
        if (!standable(w, s, x, y)) continue;
        s.chatWith = partner.id;
        partner.chatWith = s.id;
        return { x, y };
      }
    }
  }
  for (let k = 0; k < IDLE.tries; k++) {
    const x = anchor.door.x + randInt(rng, 2 * r + 1) - r;
    const y = anchor.door.y + randInt(rng, 2 * r + 1) - r;
    if ((x !== Math.round(s.x) || y !== Math.round(s.y)) && standable(w, s, x, y)) return { x, y };
  }
  return null;
}
