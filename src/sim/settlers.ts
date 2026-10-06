import { recomputeTerritory, nearestStorage } from './buildings';
import { BUILD_TICKS_PER_UNIT, BUILDINGS, HANDLE_TICKS, IDLE_GO_HOME_TICKS, OUTPUT_CAP, PROFESSIONS, SETTLER_SPEED, totalCost } from './config';
import { canPlant, findGatherTarget, findPlotFor, harvest, isGatherTarget } from './nature';
import { findPath } from './pathfinding';
import { RESOURCES, type Building, type Point, type Settler } from './types';
import type { World } from './world';

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

type GotoTarget = { x: number; y: number; adj?: boolean };

/** Runs one tick of the settler's task queue, or its profession's idle behaviour when the queue is empty. */
export function updateSettler(w: World, s: Settler): void {
  s.working = false;
  const task = s.tasks[0];
  if (!task) {
    idle(w, s);
    return;
  }
  s.idleTicks = 0;

  switch (task.t) {
    case 'goto': {
      s.inside = null;
      if (s.path.length === 0) {
        if (atGoal(s, task)) {
          s.tasks.shift();
          return;
        }
        const p = findPath(w.map, Math.round(s.x), Math.round(s.y), task.x, task.y, task.adj);
        if (!p) return abort(w, s);
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
      if (!canPlant(w, task.x, task.y, s.owner, true)) return abort(w, s);
      s.working = true;
      if (--task.n > 0) return;
      w.map.tree[i] = 1;
      w.reservedPlots.delete(i);
      w.stats.treesPlanted++;
      s.tasks.shift();
      return;
    }
    case 'build': {
      const b = w.buildings.get(task.b);
      if (!b || b.done) {
        s.tasks.shift();
        return;
      }
      const delivered = RESOURCES.reduce((sum, r) => sum + b.delivered[r], 0);
      if (b.progress < delivered * BUILD_TICKS_PER_UNIT) {
        b.progress++;
        s.working = true;
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

function move(w: World, s: Settler, task: GotoTarget): void {
  let left = SETTLER_SPEED;
  while (left > 0 && s.path.length > 0) {
    const t = s.path[0];
    const dx = t.x - s.x;
    const dy = t.y - s.y;
    const d = Math.hypot(dx, dy);
    if (d > left) {
      s.x += (dx / d) * left;
      s.y += (dy / d) * left;
      return;
    }
    s.x = t.x;
    s.y = t.y;
    left -= d;
    s.path.shift();
    const next = s.path[0];
    if (next && !w.map.isWalkable(next.x, next.y)) {
      // Something grew or was built in the way — find a new route.
      const p = findPath(w.map, s.x, s.y, task.x, task.y, task.adj);
      if (!p) return abort(w, s);
      s.path = p;
    }
  }
}

/** Cancels the settler's job and releases every reservation it still holds. */
export function abort(w: World, s: Settler): void {
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
      case 'become':
        if (b) b.workerRequested = false;
        break;
    }
  }
  s.tasks = [];
  s.path = [];
  s.carrying = null;
}

function goHome(s: Settler, b: Building): void {
  s.tasks = [
    { t: 'goto', x: b.door.x, y: b.door.y },
    { t: 'enter', b: b.id },
  ];
}

/** Settlers without a workplace rest in the nearest warehouse. */
function goToStorage(w: World, s: Settler): void {
  if (s.inside !== null || s.idleTicks <= IDLE_GO_HOME_TICKS) return;
  const store = nearestStorage(w, s.owner, s);
  if (store) goHome(s, store);
}

function idle(w: World, s: Settler): void {
  s.idleTicks++;
  const prof = PROFESSIONS[s.kind];
  const home = s.home !== null ? w.buildings.get(s.home) : undefined;

  switch (prof.behavior) {
    case 'carrier':
      // Work comes from the logistics dispatcher.
      goToStorage(w, s);
      return;

    case 'builder': {
      let best: Building | undefined;
      for (const b of w.buildings.values()) {
        if (b.owner !== s.owner || b.done || b.builderId !== null) continue;
        if (!best || dist(s, b.door) < dist(s, best.door)) best = b;
      }
      if (best) {
        best.builderId = s.id;
        s.tasks = [
          { t: 'goto', x: best.door.x, y: best.door.y },
          { t: 'build', b: best.id },
        ];
      } else {
        goToStorage(w, s);
      }
      return;
    }

    case 'gather': {
      const def = prof.gather!;
      if (!home) return;
      if (s.inside !== home.id) return goHome(s, home);
      if (home.output[def.res] >= OUTPUT_CAP) return;
      const target = findGatherTarget(w, s, home, def);
      if (!target) {
        s.tasks = [{ t: 'wait', n: 20 }];
        return;
      }
      w.reservedTargets.add(w.map.idx(target.x, target.y));
      s.path = target.path;
      s.tasks = [
        { t: 'goto', x: target.x, y: target.y, adj: true },
        { t: 'gather', x: target.x, y: target.y, n: def.workTicks, res: def.res },
        { t: 'goto', x: home.door.x, y: home.door.y },
        { t: 'store', b: home.id, res: def.res },
        { t: 'enter', b: home.id },
        { t: 'wait', n: def.restTicks },
      ];
      return;
    }

    case 'plant': {
      const def = prof.plant!;
      if (!home) return;
      if (s.inside !== home.id) return goHome(s, home);
      const plot = findPlotFor(w, s, home, def);
      if (!plot) {
        s.tasks = [{ t: 'wait', n: 40 }];
        return;
      }
      w.reservedPlots.add(w.map.idx(plot.x, plot.y));
      s.path = plot.path;
      s.tasks = [
        { t: 'goto', x: plot.x, y: plot.y, adj: true },
        { t: 'plant', x: plot.x, y: plot.y, n: def.workTicks },
        { t: 'goto', x: home.door.x, y: home.door.y },
        { t: 'enter', b: home.id },
        { t: 'wait', n: def.restTicks },
      ];
      return;
    }

    case 'workshop':
    case 'garrison':
      if (home && s.inside !== home.id) goHome(s, home);
      return;
  }
}
