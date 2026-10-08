import type { Animal } from './animals';
import { ANIMALS, OUTPUT_CAP, PROFESSIONS, type AnimalDef } from './config';
import { findPath } from './pathfinding';
import type { Building, Point, Resource, Settler, Task } from './types';
import type { World } from './world';
import { abort } from './settlers';
import { workCentre } from './workArea';

/**
 * Hunting (as in Settlers 4): a hunter from his lodge stalks the nearest unclaimed game animal
 * (`AnimalDef.game`) within his radius, closes in, aims and shoots once in range, and carries the
 * meat home. The animal is reserved while hunted (`Animal.hunter`, released by `abort`); it keeps
 * moving, so the hunter closes in again up to `HuntDef.chases` times.
 */

export interface Prey {
  animal: Animal;
  res: Resource;
  /** Walkable tile next to the animal and the route to it from the hunter. */
  x: number;
  y: number;
  path: Point[];
}

/** The nearest reachable unclaimed game within `radius` of the lodge whose meat fits its pile. */
export function findGame(w: World, s: Settler, home: Building, radius: number): Prey | null {
  const c = workCentre(home);
  let best: Animal | null = null;
  let bestD = Infinity;
  for (const a of w.animals) {
    const def: AnimalDef = ANIMALS[a.kind];
    const game = def.game;
    if (!game || a.hunter != null || home.output[game] >= OUTPUT_CAP) continue;
    const d = Math.hypot(a.x - c.x, a.y - c.y);
    if (d > radius || d >= bestD) continue;
    best = a;
    bestD = d;
  }
  if (!best) return null;
  const x = Math.round(best.x);
  const y = Math.round(best.y);
  const path = findPath(w.map, Math.round(s.x), Math.round(s.y), x, y, true);
  if (!path) return null;
  const def: AnimalDef = ANIMALS[best.kind];
  return { animal: best, res: def.game!, x, y, path };
}

export function huntTick(w: World, s: Settler, task: Extract<Task, { t: 'hunt' }>): void {
  const a = w.animals.find((x) => x.id === task.a);
  if (!a || a.hunter !== s.id) return abort(w, s);
  const def = PROFESSIONS[s.kind].hunt;
  if (!def) return abort(w, s);
  if (Math.hypot(a.x - s.x, a.y - s.y) > def.range) {
    // The game walked off: close in again, a few times at most.
    if (++task.chase > def.chases) return abort(w, s);
    s.tasks.unshift({ t: 'goto', x: Math.round(a.x), y: Math.round(a.y), adj: true });
    return;
  }
  s.working = true;
  if (--task.n > 0) return;
  w.animals.splice(w.animals.indexOf(a), 1);
  s.carrying = task.res;
  s.tasks.shift();
}

/** `abort` of a hunt: the animal is free for other hunters again. */
export function releaseHunt(w: World, task: Extract<Task, { t: 'hunt' }>): void {
  const a = w.animals.find((x) => x.id === task.a);
  if (a) a.hunter = null;
}
