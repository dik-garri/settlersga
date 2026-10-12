import { BUILDINGS } from '../sim/config';
import { sightMask } from '../sim/fog';
import type { Building, BuildingType, PlayerId } from '../sim/types';
import type { World } from '../sim/world';

/**
 * What the local player knows of the buildings under the fog of war (render-side only, never saved,
 * no Pixi or DOM). Other players' buildings are shown as the player last saw them, as in strategy
 * games with a fog of war:
 * - in sight (any footprint tile or the door visible now) — live, and remembered as they look;
 * - out of sight but seen before — frozen as remembered (stage, owner, banner), even when the
 *   building has since grown, changed hands or burnt down (then it is a ghost, `ghostIds`, until the
 *   player looks at the place again);
 * - never seen — not shown at all, explored tile or not.
 * The player's own and allied buildings are always live (allies share sight); they are remembered too,
 * so one lost out of sight stays as it was last seen. With the fog off there is no memory: everything
 * is live (`on` false).
 *
 * `update` (throttled to `MEMORY_EVERY_MS`) walks the buildings once and the records once: O(buildings
 * × footprint) per update, nothing per frame. After a load the memory is seeded with what stands on
 * explored tiles (`seed`); a new game starts empty.
 */

/** How often the memory looks at the world (ms of real time), like the fog's own redraw. */
export const MEMORY_EVERY_MS = 150;

/** What the renderer needs to draw a building's frame (a live `Building` has all of it). */
export interface BuildingLook {
  readonly id: number;
  type: BuildingType;
  x: number;
  y: number;
  w: number;
  h: number;
  door: { x: number; y: number };
  owner: PlayerId;
  done: boolean;
  levelled: boolean;
  /** Construction progress, 0…1 (`World.buildProgress`). */
  progress: number;
  /** In use (worker in, garrisoned, or built for worker-less types): roof flag and banner. */
  occupied: boolean;
}

/** A remembered building. */
export interface Remembered extends BuildingLook {
  /** Whether the player saw it at the last update (then it is drawn live). */
  inSight: boolean;
}

/**
 * Whether a finished building is in use: a workplace when its worker has moved in, a military
 * building while garrisoned (the castle always), anything else once built.
 */
export function occupied(b: Building): boolean {
  if (!b.done) return false;
  const def = BUILDINGS[b.type];
  if (def.worker) return b.workerId !== null;
  if (def.garrison) return b.garrison.length > 0 || !!def.garrison.claimsWhenEmpty;
  return true;
}

/** Copies what is drawn of a live building into `out` (no allocation when `out` is given). */
export function lookOf(w: World, b: Building, out?: BuildingLook): BuildingLook {
  const o = (out ?? { id: b.id, door: { x: 0, y: 0 } }) as { -readonly [K in keyof BuildingLook]: BuildingLook[K] };
  o.id = b.id;
  o.type = b.type;
  o.x = b.x;
  o.y = b.y;
  o.w = b.w;
  o.h = b.h;
  o.door.x = b.door.x;
  o.door.y = b.door.y;
  o.owner = b.owner;
  o.done = b.done;
  o.levelled = b.levelled;
  o.progress = w.buildProgress(b);
  o.occupied = occupied(b);
  return o;
}

/** Whether a building's footprint, or its door, covers tile (x, y). */
export function covers(l: Area, x: number, y: number): boolean {
  return (x >= l.x && y >= l.y && x < l.x + l.w && y < l.y + l.h) || (x === l.door.x && y === l.door.y);
}

/** A footprint and its door. */
type Area = Pick<BuildingLook, 'x' | 'y' | 'w' | 'h' | 'door'>;

export class BuildingMemory {
  private readonly records = new Map<number, Remembered>();
  /** Records whose building is gone from the world (demolished, burnt) while out of sight. */
  private readonly ghosts = new Set<number>();
  private lastMs = -Infinity;
  /** Bumped whenever a record is added, dropped or changed (for views that redraw on change). */
  version = 0;
  /** Per update: the player's sight bits and the `seenUntil` layers they cover. */
  private mask = 0;
  private seen: Uint32Array[] = [];

  constructor(
    private readonly world: World,
    /** The player this browser plays (`state.localPlayer`). */
    private readonly me: PlayerId,
    /** False with the fog off: no memory, everything live. */
    readonly on: boolean,
  ) {
    // A loaded game (or one fast-forwarded before the view opened) has a past: what stands on
    // explored tiles is taken as seen. A new game starts with nothing remembered.
    if (on && world.tick > 0) this.seed();
  }

  /** Throttled `refresh`: at most once per `MEMORY_EVERY_MS` of `nowMs`. */
  update(nowMs: number): void {
    if (!this.on || nowMs - this.lastMs < MEMORY_EVERY_MS) return;
    this.lastMs = nowMs;
    this.refresh();
  }

  /** Looks at the world now: remembers what is in sight, forgets ghosts whose place is in sight. */
  refresh(): void {
    if (!this.on) return;
    const w = this.world;
    this.prepareSight();
    for (const b of w.buildings.values()) {
      const rec = this.records.get(b.id);
      if (w.allied(b.owner, this.me) || this.areaVisible(b)) this.remember(b, rec);
      else if (rec && rec.inSight) {
        rec.inSight = false;
        this.version++;
      }
    }
    for (const rec of this.records.values()) {
      if (w.buildings.has(rec.id)) continue;
      // Gone from the world: a ghost while out of sight, forgotten once its place is seen again.
      if (this.areaVisible(rec)) {
        this.records.delete(rec.id);
        this.ghosts.delete(rec.id);
        this.version++;
      } else if (!this.ghosts.has(rec.id)) {
        this.ghosts.add(rec.id);
        rec.inSight = false;
        this.version++;
      }
    }
  }

  /** After a load: every building on an explored tile (or the player's or an ally's) is known as it stands. */
  seed(): void {
    const w = this.world;
    for (const b of w.buildings.values()) {
      if (w.allied(b.owner, this.me) || this.areaExplored(b)) this.remember(b, this.records.get(b.id));
    }
    this.refresh();
  }

  /** Whether a live building is drawn as it is now (own, allied, in sight, or no fog). */
  live(b: Building): boolean {
    if (!this.on || this.world.allied(b.owner, this.me)) return true;
    return this.records.get(b.id)?.inSight ?? false;
  }

  /** Whether the building with this id may be shown live (a building window, a selection). */
  liveId(id: number): boolean {
    const b = this.world.buildings.get(id);
    return b !== undefined && this.live(b);
  }

  /** Whether a live building is drawn at all: live, or frozen as remembered. */
  shows(b: Building): boolean {
    return this.live(b) || this.records.has(b.id);
  }

  /** The remembered look of a building (frozen or ghost), if the player knows it. */
  get(id: number): Remembered | undefined {
    return this.records.get(id);
  }

  /** Ids of remembered buildings that are gone from the world. */
  ghostIds(): ReadonlySet<number> {
    return this.ghosts;
  }

  /**
   * Every building the player sees or remembers, once: live ones as they are, the others as
   * remembered. With the fog off, every building.
   */
  forEachShown(fn: (l: BuildingLook | Building, live: boolean) => void): void {
    for (const b of this.world.buildings.values()) {
      if (this.live(b)) fn(b, true);
      else {
        const rec = this.records.get(b.id);
        if (rec) fn(rec, false);
      }
    }
    for (const id of this.ghosts) {
      const rec = this.records.get(id);
      if (rec) fn(rec, false);
    }
  }

  /**
   * The building the player knows of at tile (x, y): `look` is what it knows (the live building when
   * live), `building` the live building behind it when it still stands (undefined for a ghost).
   */
  at(x: number, y: number): { look: BuildingLook | Building; building: Building | undefined; live: boolean } | undefined {
    const w = this.world;
    const b = w.buildingAt(x, y);
    if (b && this.live(b)) return { look: b, building: b, live: true };
    if (b) {
      const rec = this.records.get(b.id);
      if (rec) return { look: rec, building: b, live: false };
    }
    for (const id of this.ghosts) {
      const rec = this.records.get(id);
      if (rec && covers(rec, x, y)) return { look: rec, building: undefined, live: false };
    }
    return undefined;
  }

  private remember(b: Building, rec: Remembered | undefined): void {
    if (!rec) {
      rec = lookOf(this.world, b) as Remembered;
      rec.inSight = true;
      this.records.set(b.id, rec);
      this.version++;
      return;
    }
    const { type, owner, done, levelled, progress, occupied: occ, inSight } = rec;
    lookOf(this.world, b, rec);
    rec.inSight = true;
    if (
      !inSight ||
      type !== rec.type ||
      owner !== rec.owner ||
      done !== rec.done ||
      levelled !== rec.levelled ||
      progress !== rec.progress ||
      occ !== rec.occupied
    ) {
      this.version++;
    }
  }

  private prepareSight(): void {
    const f = this.world.fog;
    this.mask = sightMask(this.world, this.me);
    this.seen.length = 0;
    for (let k = 0; k < f.seenUntil.length; k++) if (this.mask & (1 << k)) this.seen.push(f.seenUntil[k]);
  }

  /** `World.isVisible` for tile index i, with the player's sight prepared once per update. */
  private visible(i: number): boolean {
    if ((this.world.fog.vision[i] ?? 0) & this.mask) return true;
    const tick = this.world.tick;
    for (const s of this.seen) if (s[i] >= tick) return true;
    return false;
  }

  /** Any footprint tile or the door in sight now. */
  private areaVisible(l: Area): boolean {
    return this.anyTile(l, false);
  }

  /** Any footprint tile or the door explored. */
  private areaExplored(l: Area): boolean {
    this.mask = sightMask(this.world, this.me);
    return this.anyTile(l, true);
  }

  private anyTile(l: Area, explored: boolean): boolean {
    const m = this.world.map;
    const test = (i: number) => (explored ? (m.explored[i] & this.mask) !== 0 : this.visible(i));
    if (m.inBounds(l.door.x, l.door.y) && test(m.idx(l.door.x, l.door.y))) return true;
    for (let y = Math.max(0, l.y); y < Math.min(m.h, l.y + l.h); y++) {
      for (let x = Math.max(0, l.x); x < Math.min(m.w, l.x + l.w); x++) if (test(y * m.w + x)) return true;
    }
    return false;
  }
}
