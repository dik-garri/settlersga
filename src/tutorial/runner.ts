import { available } from '../sim/buildings';
import { packsOf } from '../sim/trade';
import type { Point, Resource } from '../sim/types';
import { World, type WorldOptions } from '../sim/world';
import type { Key } from '../ui/i18n';
import type { Locks } from '../ui/locks';
import type { UiTarget } from '../ui/uiTarget';
import { anchorResolver } from './anchors';
import { check, snapshot } from './conditions';
import { locksFor } from './locks';
import type { Anchor, Condition, GuideMark, MissionDef, MissionId, ParamSpec, Probe, Snapshot, StepDef, UiProbe } from './types';

/**
 * The tutorial's step automaton (docs/TUTORIAL.md §3.3), free of the DOM: it reads the world only
 * through public queries and changes it only with commands (`World.grant` for a step's goods and the
 * mission's top-ups), so the simulation knows nothing of it. `update` runs after the world's ticks
 * (at least every few ticks): it tops up, checks the current step — steps whose condition already
 * holds are passed at once, but never past one waiting for «Next» —, latches the goals, decides the
 * end and times the hint. `model` is what the goals panel, the highlights and the map arrows show.
 * Its whole state is plain data (`MissionProgress`), kept in the save slot's description.
 */

/** Everything the runner keeps: saved with the game (`SlotMeta.mission`) and restored on load. */
export interface MissionProgress {
  id: MissionId;
  player: number;
  /** Index of the current step (= steps.length once all are passed). */
  step: number;
  acked: boolean;
  hint: boolean;
  /** Goals met so far (latched). */
  goals: boolean[];
  /** Fixed anchors resolved so far (`anchors.ts`). */
  anchors: Record<string, Point | null>;
  /** The scenario's building names (`World.tags`, which the world does not save); absent in old saves. */
  tags?: Record<string, number>;
  start: Snapshot;
  stepStart: Snapshot;
  stepUi: { camera: Point; zoom: number; jumps: number };
  finished: 'won' | 'lost' | null;
}

/** What the views show. */
export interface TutorialModel {
  def: MissionDef;
  index: number;
  count: number;
  step: StepDef | null;
  waitsAck: boolean;
  hint: boolean;
  goals: { text: Key; params?: Record<string, ParamSpec>; done: boolean }[];
  ui: readonly UiTarget[];
  marks: GuideMark[];
  locks: Locks;
  finished: 'won' | 'lost' | null;
  /** Game ticks since the mission began. */
  ticks: number;
  /** Changes whenever the step, a goal, the hint or the end changes (views redraw then). */
  version: number;
}

/** The mission's world: its map, players and scenario start. */
export function missionWorld(def: MissionDef): World {
  const opts: WorldOptions = {
    size: def.world.size,
    players: def.world.players,
    ai: def.world.ai ?? [],
    start: def.world.start,
    starts: def.world.starts,
    scenario: def.scenario,
  };
  return new World(def.world.seed, opts);
}

/**
 * Units of a good the player has to hand for top-ups: available (`available`: ground, piles, stock)
 * plus what his carriers and donkeys hold, so goods on their way are not granted twice.
 */
export function onHand(w: World, player: number, res: Resource): number {
  let n = available(w, player, res);
  for (const s of w.settlers) {
    if (s.owner !== player || w.dying.has(s.id)) continue;
    for (const p of packsOf(s)) if (p.res === res) n += p.n;
  }
  return n;
}

/** Whether the condition waits for «Next» (Space). */
export function waitsForAck(c: Condition): boolean {
  return c.k === 'ack' || ((c.k === 'all' || c.k === 'any') && c.of.some(waitsForAck));
}

/** Every anchor a mission names (markers, rings, cameras, conditions), for the tests. */
export function anchorsOf(def: MissionDef): Anchor[] {
  const out: Anchor[] = [];
  const cond = (c: Condition): void => {
    if ('near' in c && c.near) out.push(c.near);
    if ('at' in c && c.at) out.push(c.at);
    if (c.k === 'setting' && 'near' in c.is && c.is.near) out.push(c.is.near);
    if (c.k === 'all' || c.k === 'any') c.of.forEach(cond);
  };
  for (const s of def.steps) {
    if (s.camera) out.push(s.camera);
    out.push(...(s.marker ?? []));
    if (s.ring) out.push(s.ring.at);
    cond(s.done);
  }
  for (const o of def.objectives) cond(o.done);
  return out;
}

export class TutorialRunner {
  private p: MissionProgress;
  private version = 0;
  /** Where the camera should go (entering a step with `camera`); taken by the view. */
  private camera: Point | null = null;

  private constructor(
    readonly def: MissionDef,
    progress: MissionProgress,
  ) {
    this.p = progress;
  }

  /** Starts the mission in `world` (at step `from`: the goods of the steps before it are granted). */
  static start(def: MissionDef, world: World, ui: UiProbe, opts: { player?: number; from?: number } = {}): TutorialRunner {
    const player = opts.player ?? 1;
    const start = snapshot(world, player);
    const r = new TutorialRunner(def, {
      id: def.id,
      player,
      step: 0,
      acked: false,
      hint: false,
      goals: def.objectives.map(() => false),
      anchors: {},
      tags: Object.fromEntries(world.tags),
      start,
      stepStart: start,
      stepUi: { camera: { ...ui.camera }, zoom: ui.zoom, jumps: ui.jumps },
      finished: null,
    });
    const from = Math.max(0, Math.min(opts.from ?? 0, def.steps.length - 1));
    for (let k = 0; k < from; k++) for (const g of def.steps[k].grant ?? []) world.issue({ kind: 'grant', player, res: g.res, n: g.n });
    r.enter(from, world, ui);
    return r;
  }

  /** A mission loaded from a save, continuing where it was. */
  static restore(def: MissionDef, progress: MissionProgress): TutorialRunner {
    return new TutorialRunner(def, structuredClone(progress));
  }

  serialize(): MissionProgress {
    return structuredClone(this.p);
  }

  get finished(): 'won' | 'lost' | null {
    return this.p.finished;
  }

  get stepIndex(): number {
    return this.p.step;
  }

  private get current(): StepDef | null {
    return this.def.steps[this.p.step] ?? null;
  }

  private probe(world: World, ui: UiProbe): Probe {
    return {
      world,
      player: this.p.player,
      ui,
      anchor: anchorResolver(world, this.p.player, this.p.anchors, this.p.tags),
      start: this.p.start,
      step: this.p.stepStart,
      stepUi: this.p.stepUi,
      acked: this.p.acked,
    };
  }

  private enter(k: number, world: World, ui: UiProbe): void {
    this.p.step = k;
    this.p.acked = false;
    this.p.hint = false;
    this.p.stepStart = snapshot(world, this.p.player, false);
    this.p.stepUi = { camera: { ...ui.camera }, zoom: ui.zoom, jumps: ui.jumps };
    this.version++;
    const step = this.current;
    if (!step) return;
    for (const g of step.grant ?? []) world.issue({ kind: 'grant', player: this.p.player, res: g.res, n: g.n });
    const resolve = anchorResolver(world, this.p.player, this.p.anchors, this.p.tags);
    this.camera = step.camera ? resolve(step.camera) : null;
  }

  /** After the world's ticks: top-ups, step, goals, end, hint. */
  update(world: World, ui: UiProbe): void {
    if (this.p.finished) return;
    for (const r of this.def.refill ?? []) {
      const have = onHand(world, this.p.player, r.res);
      if (have < r.below) world.issue({ kind: 'grant', player: this.p.player, res: r.res, n: r.to - have });
    }
    // Steps already done on entering are passed at once; an «ack» step always waits.
    for (let guard = 0; guard <= this.def.steps.length; guard++) {
      const step = this.current;
      if (!step || !check(step.done, this.probe(world, ui))) break;
      this.enter(this.p.step + 1, world, ui);
    }
    const probe = this.probe(world, ui);
    this.def.objectives.forEach((o, k) => {
      if (!this.p.goals[k] && check(o.done, probe)) {
        this.p.goals[k] = true;
        this.version++;
      }
    });
    const step = this.current;
    if (step?.hint && !this.p.hint && world.tick - this.p.stepStart.tick >= step.hint.after * 10) this.showHint();
    if (check(this.def.lost ?? { k: 'outcome', is: 'lost' }, probe)) this.finish('lost');
    else if (!step && this.p.goals.every(Boolean) && (!this.def.won || check(this.def.won, probe))) this.finish('won');
  }

  private finish(how: 'won' | 'lost'): void {
    this.p.finished = how;
    this.version++;
  }

  /** «Next» or Space: true if the step was waiting for it (it passes on the next update). */
  ack(): boolean {
    const step = this.current;
    if (!step || this.p.finished || !waitsForAck(step.done) || this.p.acked) return false;
    this.p.acked = true;
    this.version++;
    return true;
  }

  showHint(): void {
    if (this.p.hint || !this.current?.hint) return;
    this.p.hint = true;
    this.version++;
  }

  /** «Show»: where the camera should go for the current step (its camera, else its first marker). */
  show(world: World): Point | null {
    const step = this.current;
    if (!step) return null;
    const resolve = anchorResolver(world, this.p.player, this.p.anchors, this.p.tags);
    const at = step.camera ?? step.marker?.[0] ?? step.ring?.at;
    return at ? resolve(at) : null;
  }

  /** The camera target of the step just entered, once. */
  takeCamera(): Point | null {
    const c = this.camera;
    this.camera = null;
    return c;
  }

  model(world: World): TutorialModel {
    const step = this.current;
    const resolve = anchorResolver(world, this.p.player, this.p.anchors, this.p.tags);
    const marks: GuideMark[] = [];
    if (step && !this.p.finished) {
      for (const a of step.marker ?? []) {
        const q = resolve(a);
        if (q) marks.push({ x: q.x, y: q.y });
      }
      if (step.ring) {
        const q = resolve(step.ring.at);
        if (q) marks.push({ x: q.x, y: q.y, ring: step.ring.r });
      }
    }
    return {
      def: this.def,
      index: this.p.step,
      count: this.def.steps.length,
      step,
      waitsAck: !!step && waitsForAck(step.done) && !this.p.acked,
      hint: this.p.hint,
      goals: this.def.objectives.map((o, k) => ({ text: o.text, params: o.params, done: this.p.goals[k] })),
      ui: step && !this.p.finished ? (step.ui ?? []) : [],
      marks,
      locks: locksFor(this.def, Math.min(this.p.step, this.def.steps.length - 1)),
      finished: this.p.finished,
      ticks: world.tick - this.p.start.tick,
      version: this.version,
    };
  }
}
