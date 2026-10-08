import { isReachable, nearestStorage, recomputeTerritory } from './buildings';
import {
  BUILD_TICKS_PER_UNIT,
  BUILDER_STALL_TICKS,
  DIG_EVERY,
  BUILDINGS,
  HANDLE_TICKS,
  OUTPUT_CAP,
  PATH_FAIL_BACKOFF,
  PROFESSIONS,
  SETTLER_SPEED,
  totalCost,
  UNREACHABLE_TICKS,
  TERRAIN,
} from './config';
import { clearStrokes, levelStep } from './digging';
import { engageTick } from './field';
import { assaultTick, healTick, joinTick, releaseJoin, soldierIdle } from './military';
import { canPlant, findGatherTarget, findPlotFor, harvest, isGatherTarget, plant, type Target } from './nature';
import { findPath } from './pathfinding';
import { pathSpeed, wearTile } from './paths';
import { restIdle } from './idle';
import { claimTick, pioneerIdle, stealTick, thiefIdle, thiefWatch } from './specialists';
import { findGame, huntTick, releaseHunt } from './hunting';
import { RESOURCES, Terrain, type Building, type Point, type Settler, type Task } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

type GotoTarget = { x: number; y: number; adj?: boolean };

/** Runs one tick of the settler's task queue, or its profession's idle behaviour when the queue is empty. */
export function updateSettler(w: World, s: Settler): void {
  s.working = false;
  if (s.kind === 'thief') {
    thiefWatch(w, s);
    if (w.dying.has(s.id)) return; // caught
  }
  const task = s.tasks[0];
  // A defender called out to a duel stands and fights; the attacker's `assault` task resolves it.
  if (s.opponent !== null && task?.t !== 'assault' && task?.t !== 'engage') {
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
    case 'drop': {
      const b = w.buildings.get(task.b);
      if (!b) return abort(w, s);
      if (!b.done) b.delivered[task.res]++;
      else if (BUILDINGS[b.type].storage) b.output[task.res]++;
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
      s.hp = PROFESSIONS[task.kind].hp ?? 0;
      s.home = null;
      s.carrying = null;
      s.tasks.shift();
      return;
    case 'join':
      return joinTick(w, s, task);
    case 'hunt':
      return huntTick(w, s, task);
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
    case 'prospect': {
      s.working = true;
      if (--task.n > 0) return;
      const i = w.map.idx(task.x, task.y);
      const bit = 1 << (s.owner - 1);
      if (!(w.map.prospected[i] & bit)) {
        w.map.prospected[i] |= bit;
        w.map.touch(i);
        w.stats.prospected++;
      }
      s.tasks.shift();
      return;
    }
    case 'dig': {
      const b = w.buildings.get(task.b);
      if (!b || b.done || b.levelled) {
        if (b && b.diggerId === s.id) b.diggerId = null;
        s.tasks.shift();
        return;
      }
      s.working = true;
      if (++task.n < DIG_EVERY) return;
      task.n = 0;
      // Flatten a sloped site first, then clear it.
      if (b.levelTo >= 0 && !levelStep(w.map, b)) return;
      if (++b.dug >= clearStrokes(b)) {
        b.levelled = true;
        b.diggerId = null;
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
        b.builderId = null;
        s.tasks.shift();
        return;
      }
      if (b.progress >= totalCost(b.type) * BUILD_TICKS_PER_UNIT) {
        b.done = true;
        b.builderId = null;
        s.tasks.shift();
        // A worker-less territory building (castle-like) claims land as soon as it stands.
        if (BUILDINGS[b.type].territory && !BUILDINGS[b.type].worker) recomputeTerritory(w);
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
      if (BUILDINGS[b.type].territory) recomputeTerritory(w);
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
  let left = SETTLER_SPEED;
  while (left > 0 && s.path.length > 0) {
    const t = s.path[0];
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy);
    const ti = w.map.idx(t.x, t.y);
    // Worn paths and roads (`paths.ts`) speed walking up.
    const speed = TERRAIN[w.map.terrain[ti] as Terrain].speed * pathSpeed(w.map, ti);
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

/** Material delivered to the site but not yet built in. */
function hasBuildWork(b: Building): boolean {
  const delivered = RESOURCES.reduce((sum, r) => sum + b.delivered[r], 0);
  return b.progress < delivered * BUILD_TICKS_PER_UNIT;
}

function otherSiteWithWork(w: World, s: Settler, current: Building): boolean {
  for (const b of w.buildings.values()) {
    if (b !== current && b.owner === s.owner && !b.done && b.builderId === null && hasBuildWork(b)) return true;
  }
  return false;
}

/**
 * No route to the current goal: the building the job was heading for is skipped for a while,
 * the settler backs off instead of searching again every tick.
 */
function routeFailed(w: World, s: Settler): void {
  // A geologist skips a tile he cannot reach and carries on with the rest of his errand.
  if (s.tasks[1]?.t === 'prospect') {
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
 * Cancels the settler's job and releases every reservation it still holds.
 * Goods in hand go back to the nearest warehouse; they are lost only if that trip fails too.
 */
export function abort(w: World, s: Settler): void {
  const returning = s.tasks.some((t) => t.t === 'drop' && t.back);
  for (const task of s.tasks) {
    const b = 'b' in task ? w.buildings.get(task.b) : undefined;
    switch (task.t) {
      case 'pickup':
        if (b) b.outReserved[task.res]--;
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
        if (b && b.builderId === s.id) b.builderId = null;
        break;
      case 'dig':
        if (b && b.diggerId === s.id) b.diggerId = null;
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
    }
  }
  s.tasks = [];
  s.path = [];
  const res = s.carrying;
  if (!res) return;
  const store = returning ? undefined : (nearestStorage(w, s.owner, s, res) ?? nearestStorage(w, s.owner, s));
  if (store) {
    store.inbound[res]++;
    s.tasks = [
      { t: 'goto', x: store.door.x, y: store.door.y },
      { t: 'drop', b: store.id, res, back: true },
    ];
  } else {
    w.stats.lost[res]++;
    s.carrying = null;
  }
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
  const prof = PROFESSIONS[s.kind];
  const home = s.home !== null ? w.buildings.get(s.home) : undefined;

  switch (prof.behavior) {
    case 'carrier':
      // Work comes from the logistics dispatcher; meanwhile hang about with the others outside.
      restIdle(w, s);
      return;

    case 'pioneer':
      return pioneerIdle(w, s);

    case 'thief':
      return thiefIdle(w, s);

    case 'builder': {
      // Prefer sites that have material waiting, then the nearest.
      let best: Building | undefined;
      let bestScore = Infinity;
      for (const b of w.buildings.values()) {
        if (b.owner !== s.owner || b.done || !b.levelled || b.builderId !== null || !isReachable(w, b)) continue;
        const score = dist(s, b.door) + (hasBuildWork(b) ? 0 : 1000) - (b.priority ? 2000 : 0);
        if (score < bestScore) {
          best = b;
          bestScore = score;
        }
      }
      if (best) {
        best.builderId = s.id;
        s.tasks = [
          { t: 'goto', x: best.door.x, y: best.door.y },
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
        if (b.owner !== s.owner || b.done || b.levelled || b.diggerId !== null || !isReachable(w, b)) continue;
        const score = dist(s, b.door) - (b.priority ? 2000 : 0);
        if (score < bestScore) {
          best = b;
          bestScore = score;
        }
      }
      if (best) {
        best.diggerId = s.id;
        s.tasks = [
          { t: 'goto', x: best.door.x, y: best.door.y },
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
      if (!home) return;
      if (s.inside !== home.id) return goHome(s, home);
      // Farmers harvest first and only sow when nothing is ripe.
      if (prof.gather && startGathering(w, s, home)) return;
      if (prof.plant && startPlanting(w, s, home)) return;
      s.tasks = [{ t: 'wait', n: 20 }];
      return;
    }

    case 'workshop':
    case 'garrison':
      if (home && s.inside !== home.id) goHome(s, home);
      return;

    case 'prospect': {
      // Errand finished (or aborted): back to carrying; the tool goes back to a warehouse.
      s.kind = 'carrier';
      const tool = s.carrying;
      const store = tool ? nearestStorage(w, s.owner, s) : undefined;
      if (tool && store) {
        store.inbound[tool]++;
        s.tasks = [
          { t: 'goto', x: store.door.x, y: store.door.y },
          { t: 'drop', b: store.id, res: tool, back: true },
        ];
      } else if (tool) {
        w.stats.lost[tool]++;
        s.carrying = null;
      }
      return;
    }

    case 'hunt': {
      if (!home) return;
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
