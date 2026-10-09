import { BUILDINGS } from './config';
import { maxHp } from './combat';
import { outdoorFighters } from './field';
import type { Building, Point, Settler, Task } from './types';
import type { World } from './world';
import { workCentre } from './workArea';

/**
 * The infirmary, as Settlers 4's healer's hut (`CSimpleBuildingRole::LogicUpdate`, the
 * `BUILDING_HEALERHUT` branch; docs/S4-AUDIT.md item 17): it works only while its healer
 * (`BuildingDef.worker`) is inside. Every `infirmary.scanEvery` ticks it looks for a wounded fighter of
 * its owner or an ally standing idle in the open — free or a field unit at his post, never one in a
 * building, walking somewhere on an order or fighting — within `infirmary.radius` of its work centre
 * (`workArea.ts`, movable like a gatherer's), and calls the most wounded one to its door
 * (`Building.patient`, one at a time; S4: «zum Flaggen»). There the `heal` task gives him
 * `infirmary.heal` hit points every `infirmary.every` ticks while the healer is in, until he is whole;
 * then he goes back to whatever he did (a field unit to his post). Nobody heals anywhere else.
 *
 * Cost: one pass over the outdoor fighters (cached per tick) per infirmary every `scanEvery` ticks.
 */

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

/** The infirmary's healer is at work (inside). */
function healerIn(w: World, b: Building): boolean {
  const h = w.getSettler(b.workerId);
  return !!h && h.inside === b.id && !w.dying.has(h.id);
}

/** A fighter the infirmary may call: wounded, outdoors, homeless, not fighting, idle or waiting at his post. */
export function mayBeCalled(w: World, b: Building, s: Settler): boolean {
  if (s.inside !== null || s.home !== null || s.opponent !== null || w.dying.has(s.id)) return false;
  if (!w.allied(s.owner, b.owner) || s.hp >= maxHp(s)) return false;
  return s.tasks.every((t) => t.t === 'wait' || (t.t === 'goto' && !!s.post));
}

/** Per tick for a finished infirmary: call the next patient (`BuildingDef.infirmary`). */
export function updateInfirmary(w: World, b: Building): void {
  const inf = BUILDINGS[b.type].infirmary;
  if (!inf || !b.done || b.stopped) return;
  if (b.patient !== undefined) {
    // The patient died, was given another order or went elsewhere: the bed is free again.
    const p = w.getSettler(b.patient);
    if (!p || w.dying.has(p.id) || !p.tasks.some((t) => t.t === 'heal' && t.b === b.id)) delete b.patient;
    else return;
  }
  if ((w.tick + b.id) % inf.scanEvery !== 0 || !healerIn(w, b)) return;
  const at = workCentre(b);
  let best: Settler | undefined;
  for (const s of outdoorFighters(w)) {
    if (dist(s, at) > inf.radius || !mayBeCalled(w, b, s)) continue;
    const share = s.hp / maxHp(s);
    if (best && (share > best.hp / maxHp(best) || (share === best.hp / maxHp(best) && s.id > best.id))) continue;
    best = s;
  }
  if (!best) return;
  b.patient = best.id;
  best.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'heal', b: b.id, n: 0 },
  ];
}

/**
 * `heal` task: the patient stands at the infirmary's door; while its healer is inside he regains
 * `infirmary.heal` hit points every `infirmary.every` ticks, until whole.
 */
export function healTick(w: World, s: Settler, task: Extract<Task, { t: 'heal' }>): void {
  const b = w.buildings.get(task.b);
  const inf = b ? BUILDINGS[b.type].infirmary : undefined;
  if (!b || !inf || !b.done || !w.allied(b.owner, s.owner) || s.hp >= maxHp(s)) {
    if (b?.patient === s.id) delete b.patient;
    s.tasks.shift();
    return;
  }
  if (!healerIn(w, b)) return;
  s.working = true;
  if (++task.n < inf.every) return;
  task.n = 0;
  s.hp = Math.min(maxHp(s), s.hp + inf.heal);
}

/** `abort` of a `heal` task: the infirmary may call someone else. */
export function releaseHeal(w: World, s: Settler, task: Extract<Task, { t: 'heal' }>): void {
  const b = w.buildings.get(task.b);
  if (b?.patient === s.id) delete b.patient;
}
