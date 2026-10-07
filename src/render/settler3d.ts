/**
 * Pre-rendered 3D settlers (`?art=3d`, `art/blender/figures.py`): every profession and soldier as
 * frames of one stocky figure in 8 directions, grouped by pose — holding a tool while walking (4
 * frames) and standing (1), per tool shape, and working (4 frames) per action. Each frame has a full
 * colour sprite and a "tint" sprite (the tunic and shield face, white) that the renderer colours
 * per profession or player; hats are a third layer per hat style and direction.
 *
 * Frames are trimmed and packed into a few pages by the Blender script (`settlers.json`); textures
 * are made once here, so the per-frame update only indexes arrays.
 */
import { ImageSource, Rectangle, Texture, type Sprite } from 'pixi.js';
import { ACTION_IDS, HAT_STYLES, TOOLS, type ActionId, type HatStyle, type ToolShape } from './animConfig';

/** `settlers.json` written by `art/blender/figures.py`. */
export interface SettlersMeta {
  cell: [number, number];
  anchor: [number, number];
  /** Pixels per logical pixel in the pages. */
  resolution: number;
  walk: number;
  pages: string[];
  /** [page, x, y, w, h, anchorX, anchorY] in page pixels. */
  frames: [number, number, number, number, number, number, number][];
  /** `hold:<tool>` (walk frames, then standing) and `work:<action>`: [dir][frame] → [full, tint] frame ids. */
  groups: Record<string, [number, number][][]>;
  /** Hat style → [dir] frame id (−1: none). */
  hats: Record<string, number[]>;
  /** [dir][walk frame or standing]: goods in hand, relative to the anchor (logical px). */
  carryAt: [number, number][][];
  /** [dir]: goods in hand are behind the figure. */
  carryBehind: boolean[];
  /** Rank badge height above the anchor. */
  rankY: number;
}

/** One frame: the full sprite and its tintable part (null when the pose shows none). */
export interface Frame3d {
  full: Texture;
  tint: Texture | null;
}

export interface Settler3d {
  /** [tool][dir][walk frame 0..walk-1, then standing]. */
  hold: Record<ToolShape, Frame3d[][]>;
  /** [action][dir][work frame]. */
  work: Record<ActionId, Frame3d[][]>;
  /** [hat][dir], null for bare heads. */
  hats: Record<HatStyle, (Texture | null)[]>;
  carryAt: [number, number][][];
  carryBehind: boolean[];
  rankY: number;
  /** An image and rectangle (page pixels) of a frame, for HTML portraits. */
  portrait(tool: ToolShape, dir: number): { page: HTMLImageElement; rect: [number, number, number, number] };
}

export function buildSettler3d(meta: SettlersMeta, pages: HTMLImageElement[]): Settler3d {
  const r = meta.resolution;
  const sources = pages.map((img) => new ImageSource({ resource: img, resolution: r }));
  const textures = meta.frames.map(([page, x, y, w, h, ax, ay]) => {
    const t = new Texture({
      source: sources[page],
      frame: new Rectangle(x / r, y / r, w / r, h / r),
      defaultAnchor: { x: ax / w, y: ay / h },
    });
    return t;
  });
  const tex = (k: number) => (k >= 0 ? textures[k] : null);
  const group = (key: string): Frame3d[][] => {
    const g = meta.groups[key];
    if (!g) throw new Error(`settlers.json has no group ${key}`);
    return g.map((row) => row.map(([full, tint]) => ({ full: tex(full)!, tint: tex(tint) })));
  };
  const hold = Object.fromEntries(TOOLS.map((t) => [t, group(`hold:${t}`)])) as Record<ToolShape, Frame3d[][]>;
  const work = Object.fromEntries(ACTION_IDS.filter((a) => a !== 'idle').map((a) => [a, group(`work:${a}`)])) as Record<
    ActionId,
    Frame3d[][]
  >;
  // Idling at work: standing empty-handed.
  work.idle = hold.none.map((row) => Array.from({ length: 4 }, () => row[meta.walk]));
  const hats = Object.fromEntries(
    HAT_STYLES.map((s) => [s, (meta.hats[s] ?? []).map((k) => tex(k))]),
  ) as Record<HatStyle, (Texture | null)[]>;
  return {
    hold,
    work,
    hats,
    carryAt: meta.carryAt,
    carryBehind: meta.carryBehind,
    rankY: meta.rankY,
    portrait(tool, dir) {
      const [page, x, y, w, h] = meta.frames[meta.groups[`hold:${tool}`][dir][meta.walk][0]];
      return { page: pages[page], rect: [x, y, w, h] };
    },
  };
}

/** Swaps a sprite's texture and, as Pixi only reads it at construction, its anchor. */
export function setFrame(sprite: Sprite, t: Texture): void {
  if (sprite.texture === t) return;
  sprite.texture = t;
  sprite.anchor.copyFrom(t.defaultAnchor!);
}
