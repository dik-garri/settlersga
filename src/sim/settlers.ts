import { isReachable } from './buildings';
import { claimChanged } from './territory';
import { dropGoods, liftGoods, releaseGoods } from './ground';
import {
  BUILD_TICKS_PER_UNIT,
  BUILDER_STALL_TICKS,
  DIG_EVERY,
  BUILDINGS,
  buildersOf,
  HANDLE_TICKS,
  hpOf,
  OUTPUT_CAP,
  PATH_FAIL_BACKOFF,
  PROFESSIONS,
  SETTLER_SPEED,
  totalCost,
  UNREACHABLE_TICKS,
  TERRAIN,
} from './config';
import { clearStrokes, diggersWanted, leaveSite, levelStep } from './digging';
import { engageTick } from './field';
import { assaultTick, healTick, joinTick, releaseJoin, soldierIdle } from './military';
import { canPlant, findGatherTarget, findPlotFor, harvest, isGatherTarget, plant, type Target } from './nature';
import { findPath } from './pathfinding';
import { sameRegion } from './regions';
import { pathSpeed, wearTile } from './paths';
import { restIdle } from './idle';
import { donkeyAbort, donkeyIdle, loadTick, marketOrdered, releaseLoad, unloadTick } from './trade';
import { claimTick, geologistIdle, pioneerIdle, prospectTick, skipErrandTile, specialistPostIdle, stealTick, thiefIdle } from './specialists';
import { chaseTick } from './intruders';
import { fleeing } from './flee';
import { findGame, huntTick, releaseHunt } from './hunting';
import { RESOURCES, Terrain, type Building, type Point, type Resource, type Settler, type Task } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

type GotoTarget = { x: number; y: number; adj?: boolean };

/** Runs one tick of the settler's task queue, or its profession's idle behaviour when the queue is empty. */
/**
 * Whether a finished non-warehouse building still takes `res` as input: a market only for goods it
 * has an order for — a delivery that arrives after the order was cancelled goes on its output pile,
 * so carriers take it back to a warehouse instead of it sitting there for good.
 */
function wantedAt(b: Building, res: Resource): boolean {
  return !BUILDINGS[b.type].market || marketOrdered(b, res);
}

export function updateSettler(w: World, s: Settler): void {
  s.working = false;
  // An opponent that died or let go no longer holds this settler (a pinned intruder whose pursuer fell).
  if (s.opponent !== null) {
    const o = w.getSettler(s.opponent);
    if (!o || w.dying.has(o.id)) s.opponent = null;
  }
  const task = s.tasks[0];
  // A defender called out to a duel stands and fights (and a pinned intruder stands); the attacker's
  // `assault`, `engage` or `chase` task resolves it.
  if (s.opponent !== null && task?.t !== 'assault' && task?.t !== 'engage' && task?.t !== 'chase') {
    s.working = true;
    return;
  }
  if (!task) {
    idle(w, s);
    return;
  }
  s.idleTicks = 0;
  if (s.stroll !== null) {
    // A job arrived mid-stroll (`idle.ts`): the path was the stroll's.
    s.stroll = null;
    s.path = [];
  }
  s.chatWith = null;

  switch (task.t) {
    case 'goto': {
      s.inside = null;
      if (s.path.length === 0) {
        if (atGoal(s, task)) {
          s.tasks.shift();
          return;
        }
        const p = findPath(w.map, Math.round(s.x), Math.round(s.y), task.x, task.y, task.adj);
        if (!p) return routeFailed(w, s);
        if (p.length === 0) {
          s.tasks.shift();
          return;
        }
        s.path = p;
      }
      move(w, s, task);
      return;
    }
    case 'enter':
      s.inside = task.b;
      s.tasks.shift();
      return;
    case 'wait':
      if (--task.n <= 0) s.tasks.shift();
      return;
    case 'pickup': {
      const b = w.buildings.get(task.b);
      if (!b || b.output[task.res] <= 0) return abort(w, s);
      b.output[task.res]--;
      b.outReserved[task.res]--;
      s.carrying = task.res;
      s.tasks.shift();
      s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
      return;
    }
    case 'lift': {
      if (!liftGoods(w, w.map.idx(task.x, task.y), task.res)) return abort(w, s);
      s.carrying = task.res;
      s.tasks.shift();
      s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
      return;
    }
    case 'drop': {
      const b = w.buildings.get(task.b);
      if (!b) return abort(w, s);
      if (!b.done) b.delivered[task.res]++;
      else if (BUILDINGS[b.type].storage || !wantedAt(b, task.res)) b.output[task.res]++;
      else b.input[task.res]++;
      b.inbound[task.res]--;
      s.carrying = null;
      s.tasks.shift();
      s.tasks.unshift({ t: 'wait', n: HANDLE_TICKS });
      return;
    }
    case 'store': {
      const b = w.buildings.get(task.b);
      if (!b) return abort(w, s);
      b.output[task.res]++;
      w.stats.produced[task.res]++;
      s.carrying = null;
      s.tasks.shift();
      return;
    }
    case 'gather': {
      const i = w.map.idx(task.x, task.y);
      if (!isGatherTarget(w, task.res, i, s.owner)) return abort(w, s);
      s.working = true;
      if (--task.n > 0) return;
      harvest(w, task.res, i);
      w.reservedTargets.delete(i);
      s.carrying = task.res;
      s.tasks.shift();
      return;
    }
    case 'plant': {
      const i = w.map.idx(task.x, task.y);
      s.working = true;
      if (--task.n > 0) return;
      // Checked once, at the moment the planting would occupy the tile.
      if (!canPlant(w, task.what, task.x, task.y, s.owner, true)) return abort(w, s);
      plant(w, task.what, i);
      w.reservedPlots.delete(i);
      s.tasks.shift();
      return;
    }
    case 'retool':
      s.kind = task.kind;
      s.hp = hpOf(task.kind);
      s.home = null;
      s.carrying = null;
      s.errand = task.errand ? { ...task.errand } : null;
      s.tasks.shift();
      return;
    case 'join':
      return joinTick(w, s, task);
    case 'hunt':
      return huntTick(w, s, task);
    case 'chase':
      return chaseTick(w, s, task);
    case 'assault':
      return assaultTick(w, s, task);
    case 'engage':
      return engageTick(w, s, task);
    case 'heal':
      return healTick(w, s, task);
    case 'claim':
      return claimTick(w, s, task);
    case 'steal':
      return stealTick(w, s, task);
    case 'load':
      if (!loadTick(w, s, task)) abort(w, s);
      return;
    case 'unload':
      if (!unloadTick(w, s, task)) abort(w, s);
      return;
    case 'prospect':
      return prospectTick(w, s, task);
    case 'dig': {
      const b = w.buildings.get(task.b);
      if (!b || b.done || b.levelled) {
        if (b) leaveSite(b, s.id);
        s.tasks.shift();
        return;
      }
      s.working = true;
      if (++task.n < DIG_EVERY) return;
      task.n = 0;
      // Flatten a sloped site first, then clear it.
      if (b.levelTo >= 0 && !levelStep(w.map, b)) return;
      // Several diggers share the clearing strokes; whoever makes the last one ends it for all.
      if (++b.dug >= clearStrokes(b)) {
        b.levelled = true;
        leaveSite(b, s.id);
        s.tasks.shift();
      }
      return;
    }
    case 'build': {
      const b = w.buildings.get(task.b);
      if (!b || b.done) {
        s.tasks.shift();
        return;
      }
      if (hasBuildWork(b)) {
        b.progress++;
        s.working = true;
        task.stall = 0;
      } else if (++task.stall > BUILDER_STALL_TICKS && otherSiteWithWork(w, s, b)) {
        // Nothing to build with here, but another site is ready: go there instead.
        leaveSite(b, s.id);
        s.tasks.shift();
        return;
      }
      if (b.progress >= totalCost(b.type) * BUILD_TICKS_PER_UNIT) {
        // The others at the site find it done on their next tick and leave.
        b.done = true;
        b.builderIds = [];
        // A finished warehouse now serves its piece of land (`land.ts` caches by this version).
        if (BUILDINGS[b.type].storage) w.buildingsVersion++;
        s.tasks.shift();
        // A worker-less territory building (castle-like) claims land as soon as it stands.
        if (BUILDINGS[b.type].territory && !BUILDINGS[b.type].worker) claimChanged(w, b);
      }
      return;
    }
    case 'become': {
      const b = w.buildings.get(task.b);
      if (!b) return abort(w, s);
      s.kind = task.kind;
      s.home = b.id;
      s.inside = b.id;
      s.carrying = null; // the tool, if the profession needs one
      b.workerId = s.id;
      b.workerRequested = false;
      s.tasks.shift();
      if (BUILDINGS[b.type].territory) claimChanged(w, b);
      return;
    }
  }
}

function atGoal(s: Settler, task: GotoTarget): boolean {
  const dx = Math.abs(s.x - task.x);
  const dy = Math.abs(s.y - task.y);
  return task.adj ? Math.max(dx, dy) === 1 : dx === 0 && dy === 0;
}

/** Walks along `s.path` for one tick; `onBlocked` runs when no new route around an obstacle exists. */
export function move(w: World, s: Settler, task: GotoTarget, onBlocked?: () => void): void {
  // `left` is this tick's walking budget in tiles of normal ground; a step into slower terrain
  // (`TERRAIN[t].speed`, as charged by A*) uses it up faster.
  const prof = PROFESSIONS[s.kind];
  let left = SETTLER_SPEED * (prof.speed ?? 1);
  while (left > 0 && s.path.length > 0) {
    const t = s.path[0];
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy);
    const ti = w.map.idx(t.x, t.y);
    // Worn paths and roads (`paths.ts`) speed carriers and donkeys up.
    const speed = TERRAIN[w.map.terrain[ti] as Terrain].speed * (prof.roads ? pathSpeed(w.map, ti) : 1);
    const reach = left * speed;
    if (d > reach) {
      s.x += (dx / d) * reach;
      s.y += (dy / d) * reach;
      return;
    }
    s.x = t.x;
    s.y = t.y;
    left -= d / speed;
    s.path.shift();
    wearTile(w, ti);
    const next = s.path[0];
    if (next && !w.map.isWalkable(next.x, next.y)) {
      // Something grew or was built in the way — find a new route.
      const p = findPath(w.map, s.x, s.y, task.x, task.y, task.adj);
      if (!p) return onBlocked ? onBlocked() : routeFailed(w, s);
      s.path = p;
    }
  }
}

/** Where the k-th builder or digger of a site stands: the door, then free tiles along the front wall. */
const SITE_SPOTS: readonly [number, number][] = [
  [0, 0],
  [-1, 0],
  [1, 0],
  [0, 1],
  [-1, 1],
  [1, 1],
];

function siteSpot(w: World, b: Building, k: number): Point {
  const m = w.map;
  const door = m.idx(b.door.x, b.door.y);
  let n = 0;
  for (const [dx, dy] of SITE_SPOTS) {
    const x = b.door.x + dx;
    const y = b.door.y + dy;
    // Only tiles one can walk to from the door, so the spot never makes the site look unreachable.
    if (!m.isWalkable(x, y) || !sameRegion(m, door, m.idx(x, y))) continue;
    if (n++ === k % SITE_SPOTS.length) return { x, y };
  }
  return b.door;
}

/** Material delivered to the site but not yet built in. */
function hasBuildWork(b: Building): boolean {
  const delivered = RESOURCES.reduce((sum, r) => sum + b.delivered[r], 0);
  return b.progress < delivered * BUILD_TICKS_PER_UNIT;
}

function otherSiteWithWork(w: World, s: Settler, current: Building): boolean {
  for (const b of w.buildings.values()) {
    if (b !== current && b.owner === s.owner && !b.done && b.builderIds.length < buildersOf(b.type) && hasBuildWork(b)) return true;
  }
  return false;
}

/**
 * No route to the current goal: the building the job was heading for is skipped for a while,
 * the settler backs off instead of searching again every tick.
 */
function routeFailed(w: World, s: Settler): void {
  // A geologist or pioneer skips a tile he cannot reach and carries on with the rest of his errand.
  const next = s.tasks[1];
  if (next?.t === 'prospect' || next?.t === 'claim') {
    skipErrandTile(w, s, next.x, next.y);
    s.tasks.splice(0, 2);
    s.path = [];
    return;
  }
  const target = s.tasks.find((t) => 'b' in t);
  const b = target && 'b' in target ? w.buildings.get(target.b) : undefined;
  if (b) b.unreachableUntil = w.tick + UNREACHABLE_TICKS;
  abort(w, s);
  if (s.tasks.length === 0) s.tasks = [{ t: 'wait', n: PATH_FAIL_BACKOFF }];
}

/**
 * Cancels the settler's job and releases every reservation it still holds. Goods in hand are put
 * down on the ground where he stands (`carryBack`), as in Settlers 4.
 */
export function abort(w: World, s: Settler): void {
  for (const task of s.tasks) {
    const b = 'b' in task ? w.buildings.get(task.b) : undefined;
    switch (task.t) {
      case 'pickup':
        if (b) b.outReserved[task.res]--;
        break;
      case 'lift':
        releaseGoods(w, w.map.idx(task.x, task.y));
        break;
      case 'drop':
        if (b) b.inbound[task.res]--;
        break;
      case 'gather':
        w.reservedTargets.delete(w.map.idx(task.x, task.y));
        break;
      case 'plant':
        w.reservedPlots.delete(w.map.idx(task.x, task.y));
        break;
      case 'build':
      case 'dig':
        if (b) leaveSite(b, s.id);
        break;
      case 'become':
        if (b) b.workerRequested = false;
        break;
      case 'join':
        if (b) releaseJoin(b, task);
        break;
      case 'hunt':
        releaseHunt(w, task);
        break;
      case 'load':
        releaseLoad(w, task);
        break;
      case 'chase': {
        // Let the pinned intruder go.
        const e = w.getSettler(task.s);
        if (e && e.opponent === s.id) e.opponent = null;
        if (s.opponent === task.s) s.opponent = null;
        break;
      }
    }
  }
  s.tasks = [];
  s.path = [];
  if (PROFESSIONS[s.kind].behavior === 'donkey') return donkeyAbort(w, s);
  const res = s.carrying;
  if (res) carryBack(w, s, res);
}

/**
 * The good in the settler's hands is put down on the ground at his feet (or as near as there is
 * room, `ground.ts`): Settlers 4 drops a carrier's load where his job ended, and a dismissed
 * specialist's tool falls next to him (`CSettler::ChangeType`). Carriers take it up again like any
 * pile: for a site or workshop that wants it, or for a warehouse that takes it in.
 */
export function carryBack(w: World, s: Settler, res: Resource): void {
  s.carrying = null;
  dropGoods(w, s, res, 1);
}

function goHome(s: Settler, b: Building): void {
  s.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'enter', b: b.id },
  ];
}

function startGathering(w: World, s: Settler, home: Building): boolean {
  const def = PROFESSIONS[s.kind].gather!;
  if (home.output[def.res] >= OUTPUT_CAP) return false;
  const target = findGatherTarget(w, s, home, def);
  if (!target) return false;
  w.reservedTargets.add(w.map.idx(target.x, target.y));
  setOuting(s, home, target, { t: 'gather', x: target.x, y: target.y, n: def.workTicks, res: def.res }, def.restTicks);
  s.tasks.splice(3, 0, { t: 'store', b: home.id, res: def.res });
  return true;
}

function startPlanting(w: World, s: Settler, home: Building): boolean {
  const def = PROFESSIONS[s.kind].plant!;
  const plot = findPlotFor(w, s, home, def);
  if (!plot) return false;
  w.reservedPlots.add(w.map.idx(plot.x, plot.y));
  setOuting(s, home, plot, { t: 'plant', x: plot.x, y: plot.y, n: def.workTicks, what: def.what }, def.restTicks);
  return true;
}

/** Walk to the target (path already found), do the work, come back inside and rest. */
function setOuting(s: Settler, home: Building, target: Target, work: Task, rest: number): void {
  s.path = target.path;
  s.tasks = [
    { t: 'goto', x: target.x, y: target.y, adj: true },
    work,
    { t: 'goto', x: home.door.x, y: home.door.y },
    { t: 'enter', b: home.id },
    { t: 'wait', n: rest },
  ];
}

function idle(w: World, s: Settler): void {
  s.idleTicks++;
  // Stranded on foreign land, or the player is out: wander off (and die), as in Settlers 4.
  if (fleeing(w, s)) return;
  const prof = PROFESSIONS[s.kind];
  const home = s.home !== null ? w.buildings.get(s.home) : undefined;

  switch (prof.behavior) {
    case 'carrier':
      // Work comes from the logistics dispatcher; meanwhile hang about with the others outside.
      restIdle(w, s);
      return;

    case 'pioneer':
      if (specialistPostIdle(s)) return;
      return pioneerIdle(w, s);

    case 'thief':
      if (specialistPostIdle(s)) return;
      return thiefIdle(w, s);

    case 'donkey':
      return donkeyIdle(w, s);

    case 'builder': {
      // Prefer sites that have material waiting, then the nearest.
      let best: Building | undefined;
      let bestScore = Infinity;
      for (const b of w.buildings.values()) {
        if (b.owner !== s.owner || b.done || !b.levelled || b.builderIds.length >= buildersOf(b.type) || !isReachable(w, b)) continue;
        // As in Settlers 4 several builders share a site (`buildersOf`); a site nobody builds yet
        // goes first among equals, so builders spread over the sites that have material.
        const score = dist(s, b.door) + (hasBuildWork(b) ? 0 : 1000) - (b.priority ? 2000 : 0) + b.builderIds.length * 4;
        if (score < bestScore) {
          best = b;
          bestScore = score;
        }
      }
      if (best) {
        const spot = siteSpot(w, best, best.builderIds.length);
        best.builderIds.push(s.id);
        s.tasks = [
          { t: 'goto', x: spot.x, y: spot.y },
          { t: 'build', b: best.id, stall: 0 },
        ];
      } else {
        restIdle(w, s);
      }
      return;
    }

    case 'digger': {
      // Nearest sloped site nobody is levelling yet (priority first), otherwise rest like a builder.
      let best: Building | undefined;
      let bestScore = Infinity;
      for (const b of w.buildings.values()) {
        if (b.owner !== s.owner || b.done || b.levelled || !isReachable(w, b)) continue;
        // Several diggers share a site while it has work for them (`diggersWanted`, Settlers 4).
        if (b.diggerIds.length >= diggersWanted(w.map, b)) continue;
        const score = dist(s, b.door) - (b.priority ? 2000 : 0) + b.diggerIds.length * 4;
        if (score < bestScore) {
          best = b;
          bestScore = score;
        }
      }
      if (best) {
        const spot = siteSpot(w, best, best.diggerIds.length);
        best.diggerIds.push(s.id);
        s.tasks = [
          { t: 'goto', x: spot.x, y: spot.y },
          { t: 'dig', b: best.id, n: 0 },
        ];
      } else {
        restIdle(w, s);
      }
      return;
    }

    case 'gather':
    case 'plant':
    case 'farm': {
      // A ready-made worker (`START_CONDITIONS.workers`) waits with the others for a workplace.
      if (!home) return restIdle(w, s);
      if (s.inside !== home.id) return goHome(s, home);
      // Farmers harvest first and only sow when nothing is ripe.
      if (prof.gather && startGathering(w, s, home)) return;
      if (prof.plant && startPlanting(w, s, home)) return;
      s.tasks = [{ t: 'wait', n: 20 }];
      return;
    }

    case 'workshop':
    case 'garrison':
      if (!home) return restIdle(w, s);
      if (s.inside !== home.id) goHome(s, home);
      return;

    case 'prospect':
      // Sent somewhere without an errand: wait there (direct control).
      if (specialistPostIdle(s)) return;
      return geologistIdle(w, s);

    case 'hunt': {
      if (!home) return restIdle(w, s);
      if (s.inside !== home.id) return goHome(s, home);
      const def = prof.hunt!;
      const prey = findGame(w, s, home, def.radius);
      if (!prey) {
        s.tasks = [{ t: 'wait', n: 40 }];
        return;
      }
      prey.animal.hunter = s.id;
      s.path = prey.path;
      s.tasks = [
        { t: 'goto', x: prey.x, y: prey.y, adj: true },
        { t: 'hunt', a: prey.animal.id, n: def.workTicks, chase: 0, res: prey.res },
        { t: 'goto', x: home.door.x, y: home.door.y },
        { t: 'store', b: home.id, res: prey.res },
        { t: 'enter', b: home.id },
        { t: 'wait', n: def.restTicks },
      ];
      return;
    }

    case 'soldier':
      soldierIdle(w, s);
      return;
  }
}
