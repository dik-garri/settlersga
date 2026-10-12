import { CHUNK } from '../sim/map';
import { pathLevel } from '../sim/paths';
import type { PlayerId } from '../sim/types';
import type { World } from '../sim/world';
import { MEMORY_EVERY_MS, Sight } from './memory';

/**
 * What the local player knows of the map's tiles under the fog of war (render-side only, never saved,
 * no Pixi or DOM), the tile counterpart of `BuildingMemory`: land owners (territory and borders),
 * trees, stone deposits, fields, goods on the ground and worn paths are drawn — on the map and the
 * minimap — as the player last saw them. A tile in sight shows what is there; one out of sight keeps
 * what was there when it was last in sight, so a tower built in the dark does not move its owner's
 * border on the player's screen, a forest felled there still stands, and nothing is seen growing.
 *
 * The renderer and the minimap read the layers of a `TileView` instead of `map.*`. With the fog off
 * (`on` false) the view is the map itself: its arrays, `map.chunkVersion` and `World.territoryVersion`.
 *
 * Cost (`update`, every frame): a look at every chunk's `map.chunkVersion` and, for chunks that
 * changed, their tiles once — a changed tile in sight is copied, one out of sight is put on the stale
 * list; a full pass over the owners only when `World.territoryVersion` moved (land changes no chunk
 * version), as the renderer's territory layer already does; every `MEMORY_EVERY_MS` the stale list is
 * checked against the sight (a tile whose change the player now sees is copied, silently: `silent`).
 * Nothing scales with the area in sight. The memory starts as a copy of the map: what is unexplored is
 * hidden anyway and is copied again the moment it is explored; after a load the player thus knows how
 * the explored land looks at the time of the load (as `BuildingMemory.seed`).
 */

/** The tile layers the renderer and the minimap draw, as the local player knows them. */
export interface TileView {
  readonly owner: Uint8Array;
  readonly tree: Uint8Array;
  readonly stone: Uint8Array;
  readonly crop: Uint8Array;
  readonly cropKind: Uint8Array;
  readonly goods: Uint8Array;
  readonly goodsAmount: Uint8Array;
  readonly wear: Uint8Array;
  /** Per chunk: bumped when any of the layers above changed on one of its tiles (except `owner`). */
  readonly chunkVersion: Uint32Array;
  /** Bumped when `owner` changed anywhere. */
  readonly ownerVersion: number;
  /**
   * Whether the tile's last change was learnt only when it came into sight (it happened in the dark):
   * no fall, no sound — the tree is simply gone.
   */
  silent(i: number): boolean;
}

/** The layers copied tile by tile (`owner` is handled with them, but versioned on its own). */
const LAYERS = ['owner', 'tree', 'stone', 'crop', 'cropKind', 'goods', 'goodsAmount', 'wear'] as const;

export class TileMemory implements TileView {
  readonly owner: Uint8Array;
  readonly tree: Uint8Array;
  readonly stone: Uint8Array;
  readonly crop: Uint8Array;
  readonly cropKind: Uint8Array;
  readonly goods: Uint8Array;
  readonly goodsAmount: Uint8Array;
  readonly wear: Uint8Array;
  readonly chunkVersion: Uint32Array;
  private ownerV = 0;
  /** `map.chunkVersion` per chunk when its tiles were last compared. */
  private readonly mapSeen: Uint32Array;
  private territorySeen: number;
  /** Tiles that differ from the map but were out of sight (`staleFlag` keeps the list free of repeats). */
  private stale: number[] = [];
  private readonly staleFlag: Uint8Array;
  private readonly silentFlag: Uint8Array;
  private readonly sight: Sight;
  private lastMs = -Infinity;
  /** Work of the last updates, for measuring (tiles compared). */
  readonly stats = { compared: 0, copied: 0, stale: 0 };

  constructor(
    private readonly world: World,
    me: PlayerId,
    /** False with the fog off: no memory, the view is the map. */
    readonly on: boolean,
  ) {
    const m = world.map;
    this.sight = new Sight(world, me);
    this.mapSeen = Uint32Array.from(m.chunkVersion);
    this.territorySeen = world.territoryVersion;
    if (!on) {
      // The map's own arrays: nothing is copied, nothing differs.
      this.owner = m.owner;
      this.tree = m.tree;
      this.stone = m.stone;
      this.crop = m.crop;
      this.cropKind = m.cropKind;
      this.goods = m.goods;
      this.goodsAmount = m.goodsAmount;
      this.wear = m.wear;
      this.chunkVersion = m.chunkVersion;
      this.staleFlag = new Uint8Array(0);
      this.silentFlag = new Uint8Array(0);
      return;
    }
    this.owner = m.owner.slice();
    this.tree = m.tree.slice();
    this.stone = m.stone.slice();
    this.crop = m.crop.slice();
    this.cropKind = m.cropKind.slice();
    this.goods = m.goods.slice();
    this.goodsAmount = m.goodsAmount.slice();
    this.wear = m.wear.slice();
    this.chunkVersion = new Uint32Array(m.chunkVersion.length);
    this.staleFlag = new Uint8Array(m.w * m.h);
    this.silentFlag = new Uint8Array(m.w * m.h);
  }

  get ownerVersion(): number {
    return this.on ? this.ownerV : this.world.territoryVersion;
  }

  silent(i: number): boolean {
    return this.on && this.silentFlag[i] === 1;
  }

  /** Tiles waiting out of sight with a change the player has not seen. */
  get staleCount(): number {
    return this.stale.length;
  }

  /**
   * Every frame: changed chunks and land at once (so what happens in sight shows without delay), the
   * stale tiles at most every `MEMORY_EVERY_MS` (`force`: now).
   */
  update(nowMs: number, force = false): void {
    if (!this.on) return;
    const w = this.world;
    const m = w.map;
    this.sight.prepare();
    for (let c = 0; c < this.mapSeen.length; c++) {
      if (m.chunkVersion[c] === this.mapSeen[c]) continue;
      this.mapSeen[c] = m.chunkVersion[c];
      const x0 = (c % m.chunksX) * CHUNK;
      const y0 = Math.floor(c / m.chunksX) * CHUNK;
      const x1 = Math.min(m.w, x0 + CHUNK);
      const y1 = Math.min(m.h, y0 + CHUNK);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) this.look(y * m.w + x);
    }
    if (w.territoryVersion !== this.territorySeen) {
      this.territorySeen = w.territoryVersion;
      const own = m.owner;
      const mine = this.owner;
      for (let i = 0; i < own.length; i++) if (own[i] !== mine[i]) this.look(i);
    }
    if (!force && nowMs - this.lastMs < MEMORY_EVERY_MS) return;
    this.lastMs = nowMs;
    let k = 0;
    const list = this.stale;
    for (let j = 0; j < list.length; j++) {
      const i = list[j];
      if (!this.differs(i)) this.staleFlag[i] = 0;
      else if (this.sight.visible(i)) this.copy(i, true);
      else list[k++] = i;
    }
    list.length = k;
    this.stats.stale = k;
  }

  /** A tile that may have changed: copied when in sight, else remembered as stale. */
  private look(i: number): void {
    this.stats.compared++;
    if (!this.differs(i)) return;
    if (this.sight.visible(i)) this.copy(i, this.staleFlag[i] === 1);
    else if (this.staleFlag[i] === 0) {
      this.staleFlag[i] = 1;
      this.stale.push(i);
    }
  }

  /** Whether the map shows on tile i something other than what the player remembers. */
  private differs(i: number): boolean {
    const m = this.world.map;
    return (
      m.owner[i] !== this.owner[i] ||
      m.tree[i] !== this.tree[i] ||
      m.stone[i] !== this.stone[i] ||
      m.crop[i] !== this.crop[i] ||
      (m.crop[i] !== 0 && m.cropKind[i] !== this.cropKind[i]) ||
      m.goods[i] !== this.goods[i] ||
      m.goodsAmount[i] !== this.goodsAmount[i] ||
      // Wear itself moves with every step; only its drawn level counts.
      pathLevel(m.wear[i]) !== pathLevel(this.wear[i])
    );
  }

  /** Takes tile i in as it is now; `silent` when the change happened out of the player's sight. */
  private copy(i: number, silent: boolean): void {
    const m = this.world.map;
    this.stats.copied++;
    let things = false;
    for (const layer of LAYERS) {
      const from = m[layer][i];
      if (from === this[layer][i]) continue;
      this[layer][i] = from;
      if (layer === 'owner') this.ownerV++;
      else things = true;
    }
    if (things) this.chunkVersion[m.chunkOf(i % m.w, Math.floor(i / m.w))]++;
    this.staleFlag[i] = 0;
    this.silentFlag[i] = silent ? 1 : 0;
  }
}
