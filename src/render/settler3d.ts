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
import { ACTION_IDS, ACTIONS, HAT_STYLES, TOOLS, type ActionId, type HatStyle, type Outfit, type ToolShape } from './animConfig';

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
  /**
   * `hold:<tool>` (walk frames, then standing) and `work:<action>`: [dir][frame] → [full, tint] frame
   * ids; work frames add a third, the arm-over-hat layer (−1 when the arms stay below the head).
   */
  groups: Record<string, number[][][]>;
  /** Hat style → [dir] frame id (−1: none). */
  hats: Record<string, number[]>;
  /**
   * Groups whose head is not where it is standing (a bent torso, `BEND` in figures.py): [dir][frame]
   * → where the head is, relative to standing (logical px); the hat layer moves with it.
   */
  heads?: Record<string, [number, number][][]>;
  /** [dir][walk frame or standing]: goods in hand, relative to the anchor (logical px). */
  carryAt: [number, number][][];
  /** [dir]: goods in hand are behind the figure. */
  carryBehind: boolean[];
  /** Rank badge height above the anchor. */
  rankY: number;
}

/**
 * One frame: the full sprite, its tintable part (null when the pose shows none) and, for work poses,
 * the arms and tool where they pass in front of the head, drawn above the hat (null when they don't).
 */
export interface Frame3d {
  full: Texture;
  tint: Texture | null;
  over: Texture | null;
  /** Where the hat goes, relative to a standing figure's (logical px; [0, 0] unless the body bends). */
  hatAt: readonly [number, number];
}

const UPRIGHT: readonly [number, number] = [0, 0];

/** The pose groups of one look: plain clothes, or an outfit (only the tools and actions it has). */
export interface Look3d {
  /** [tool][dir][walk frame 0..walk-1, then standing]. */
  hold: Partial<Record<ToolShape, Frame3d[][]>>;
  /** [action][dir][work frame]. */
  work: Partial<Record<ActionId, Frame3d[][]>>;
}

export interface Settler3d {
  /** [tool][dir][walk frame 0..walk-1, then standing]. */
  hold: Record<ToolShape, Frame3d[][]>;
  /** [action][dir][work frame]. */
  work: Record<ActionId, Frame3d[][]>;
  /** Outfits (`hold:<tool>@<outfit>` groups): armour, shields, quivers worn by fighters. */
  outfits: Partial<Record<Outfit, Look3d>>;
  /** [hat][dir], null for bare heads. */
  hats: Record<HatStyle, (Texture | null)[]>;
  carryAt: [number, number][][];
  carryBehind: boolean[];
  rankY: number;
  /** An image and rectangle (page pixels) of a frame, for HTML portraits. */
  portrait(tool: ToolShape, dir: number, outfit?: Outfit): { page: HTMLImageElement; rect: [number, number, number, number] };
}

/** Frames of a hold pose in a look (an outfit's own, else the plain one). */
export function holdFrames(s3d: Settler3d, tool: ToolShape, outfit: Outfit | undefined): Frame3d[][] {
  return (outfit && s3d.outfits[outfit]?.hold[tool]) || s3d.hold[tool];
}

/** Frames of a work action in a look (an outfit's own, else the plain one). */
export function workFrames(s3d: Settler3d, action: ActionId, outfit: Outfit | undefined): Frame3d[][] {
  return (outfit && s3d.outfits[outfit]?.work[action]) || s3d.work[action];
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
    const heads = meta.heads?.[key];
    return g.map((row, d) =>
      row.map(([full, tint, over], f) => ({ full: tex(full)!, tint: tex(tint), over: tex(over ?? -1), hatAt: heads?.[d][f] ?? UPRIGHT })),
    );
  };
  const hold = Object.fromEntries(TOOLS.map((t) => [t, group(`hold:${t}`)])) as Record<ToolShape, Frame3d[][]>;
  // An action whose pose group is not rendered (yet) shows its tool held still.
  const work = Object.fromEntries(
    ACTION_IDS.filter((a) => a !== 'idle').map((a) => [
      a,
      meta.groups[`work:${a}`] ? group(`work:${a}`) : hold[ACTIONS[a].tool].map((row) => Array.from({ length: 4 }, () => row[meta.walk])),
    ]),
  ) as Record<ActionId, Frame3d[][]>;
  // Idling at work: standing empty-handed.
  work.idle = hold.none.map((row) => Array.from({ length: 4 }, () => row[meta.walk]));
  // Outfit groups: `hold:<tool>@<outfit>` / `work:<action>@<outfit>`; idling at work in an outfit is
  // standing with its tool.
  const outfits: Partial<Record<Outfit, Look3d>> = {};
  for (const key of Object.keys(meta.groups)) {
    const m = /^(hold|work):(\w+)@(\w+)$/.exec(key);
    if (!m) continue;
    const look = (outfits[m[3] as Outfit] ??= { hold: {}, work: {} });
    if (m[1] === 'hold') look.hold[m[2] as ToolShape] = group(key);
    else look.work[m[2] as ActionId] = group(key);
  }
  for (const look of Object.values(outfits)) {
    const stand = Object.values(look.hold)[0];
    if (stand) look.work.idle = stand.map((row) => Array.from({ length: 4 }, () => row[meta.walk]));
  }
  const hats = Object.fromEntries(
    HAT_STYLES.map((s) => [s, (meta.hats[s] ?? []).map((k) => tex(k))]),
  ) as Record<HatStyle, (Texture | null)[]>;
  return {
    hold,
    work,
    outfits,
    hats,
    carryAt: meta.carryAt,
    carryBehind: meta.carryBehind,
    rankY: meta.rankY,
    portrait(tool, dir, outfit) {
      const g = (outfit && meta.groups[`hold:${tool}@${outfit}`]) || meta.groups[`hold:${tool}`];
      const [page, x, y, w, h] = meta.frames[g[dir][meta.walk][0]];
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
