/**
 * Test helpers for a world without a headquarters (Settlers 4): every player starts with a small
 * tower and its goods lying on the ground round it.
 */
import { addBuilding } from '../src/sim/buildings';
import { goodsOn } from '../src/sim/ground';
import { isFighter, killSettler } from '../src/sim/military';
import { RESOURCES, type Building, type PlayerId, type Point, type Resource } from '../src/sim/types';
import type { World } from '../src/sim/world';

/** The player's start tower (the building whose door is `World.homeOf`). */
export function startTower(w: World, p: PlayerId = 1): Building {
  const h = w.homeOf(p);
  return w.buildingAt(h.x, h.y)!;
}

/**
 * Where the old 4×4 castle's footprint began (the start position − 2): tests place buildings at
 * offsets from it, as they did from the castle.
 */
export function base(w: World, p: PlayerId = 1): Point {
  const t = startTower(w, p);
  return { x: t.x - 1, y: t.y - 1 };
}

/** Units of `res` lying on the ground (all players, or only on `owner`'s land). */
export function groundUnits(w: World, res: Resource, owner?: PlayerId): number {
  let n = 0;
  for (const i of w.stacks) {
    if (goodsOn(w, i) === res && (owner === undefined || w.map.owner[i] === owner)) n += w.map.goodsAmount[i];
  }
  return n;
}

/** Units of `res` that exist as goods: in piles, finished buildings' inputs, on the ground and in hands. */
export function goodsInWorld(w: World, res: Resource): number {
  let n = groundUnits(w, res);
  for (const s of w.settlers) if (s.carrying === res) n += s.load ?? 1;
  for (const b of w.buildings.values()) n += b.output[res] + (b.done ? b.input[res] : 0);
  return n;
}

/** Takes every good off the ground (a test that wants to start from a clean stock). */
export function clearGround(w: World): void {
  for (const i of [...w.stacks]) {
    w.map.goods[i] = 0;
    w.map.goodsAmount[i] = 0;
    w.map.goodsReserved[i] = 0;
    w.stacks.delete(i);
    w.map.touch(i);
  }
  w.stackOrder = null;
}

const depots = new WeakMap<World, Map<PlayerId, Building>>();

/**
 * A finished warehouse of the player by its start tower that takes `goods` in (default: every good) —
 * the stock tests used to keep in the castle. Created once per world and player, on the free spot
 * nearest `near` (default: up-left of the start tower).
 */
export function depot(w: World, p: PlayerId = 1, near?: Point, goods: readonly Resource[] = RESOURCES): Building {
  let byPlayer = depots.get(w);
  if (!byPlayer) depots.set(w, (byPlayer = new Map()));
  const known = byPlayer.get(p);
  if (known && w.buildings.get(known.id) === known) return known;
  const t = startTower(w, p);
  const at = near ?? { x: t.x - 4, y: t.y - 3 };
  let best: Point | null = null;
  let bestD = Infinity;
  for (let y = at.y - 12; y <= at.y + 12; y++) {
    for (let x = at.x - 12; x <= at.x + 12; x++) {
      const d = Math.hypot(x - at.x, y - at.y);
      if (d < bestD && w.canPlace('warehouse', x, y, p)) {
        best = { x, y };
        bestD = d;
      }
    }
  }
  if (!best) throw new Error('no room for a test depot');
  const b = addBuilding(w, 'warehouse', best.x, best.y, p, true);
  for (const r of goods) w.setAccepts(b.id, r, true, p);
  byPlayer.set(p, b);
  return b;
}

/**
 * Test setup: the start fighters standing by the start tower (it has no slot for them) are taken out,
 * so garrison room is what the test sets up. Returns how many there were.
 */
export function dismissStandby(w: World, p: PlayerId = 1): number {
  const idle = w.settlers.filter((s) => s.owner === p && isFighter(s) && s.home === null && !w.dying.has(s.id));
  for (const s of idle) killSettler(w, s);
  return idle.length;
}

/**
 * Test setup: `dismissStandby`, then the start tower gives up its swordsman and one archer — one free
 * slot of each kind, one archer left holding it (a player with no occupied military building is out).
 */
export function vacateStart(w: World, p: PlayerId = 1): Building {
  dismissStandby(w, p);
  const t = startTower(w, p);
  for (const kind of ['soldier', 'archer']) {
    const id = t.garrison.find((g) => w.getSettler(g)?.kind === kind);
    if (id !== undefined) killSettler(w, w.getSettler(id)!);
  }
  return t;
}
