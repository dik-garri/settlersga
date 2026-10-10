/**
 * Pre-rendered 3D sprites (the Blender pipeline in `art/blender`, output in `public/art/3d`). A pilot:
 * with `?art=3d` they replace the procedural woodcutter, sawmill, stonecutter, tower and large house
 * (with construction stages), tree, stone deposit, wares, door piles and every settler.
 * Every sprite keeps the anchor convention of the sprite it replaces, so the renderer is unchanged
 * except for settlers, whose pre-rendered frames (`settler3d.ts`) replace the layered figure. Animal
 * sheets (`animal-<kind>.png`, see `animalArt.ts`) are loaded here too.
 */
import { ANIMAL_KINDS } from '../sim/config';
import { UNIT_ANIMALS } from './animalArt';
import { RESOURCES, type Resource } from '../sim/types';
import { buildSettler3d, type Settler3d, type SettlersMeta } from './settler3d';

/** `ground.json` written by `art/textures/ground.py`. */
export interface GroundMeta {
  /** Logical size of one diamond frame (as the procedural ground sprites). */
  frame: [number, number];
  /**
   * Textured ground kinds and their period: tile (x, y) uses variant (x mod p) + p·(y mod p) of
   * `ground-<kind>.png`; textures are seamless.
   */
  kinds: Record<string, number>;
  /** Field decals per crop kind: `fields-<kind>.png`, a strip of that many stages (1…n; grain: sown … ripe, then stubble). */
  fields?: Record<string, number>;
  /** Worn-path decals: `path-<level>.png` for levels 1…levels, each a strip of `variants` frames. */
  paths?: { levels: number; variants: number };
}

/** `wares.json` written by `art/blender/goods.py`: the strip of single carried wares. */
export interface WaresMeta {
  /** Logical w, h and anchor of one frame. */
  frame: [number, number, number, number];
  /** Resource of each frame, in order. */
  order: string[];
}

/**
 * `icons.json` written by `art/blender/goods.py`: the menu icons of every resource, one `size`²
 * square each, `columns` a row of `icons.png`, in `order`.
 */
export interface IconsMeta {
  size: number;
  columns: number;
  order: string[];
}

/**
 * `signs.json` written by `art/blender/signs.py`: the geologist's signs, one `frame` each in
 * `signs.png` — per board variant the empty board, then every ore of `ores` with 1…`levels` symbols
 * (`signFrame`).
 */
export interface SignsMeta {
  frame: [number, number, number, number];
  variants: number;
  levels: number;
  ores: string[];
}

/** Board variants of the geologist's signs (`VARIANTS` in signs.py; the classic painter has as many). */
export const SIGN_VARIANTS = 2;
/** Most symbols on a sign (`LEVELS` in signs.py; `signLevel` in the sim gives 1…3). */
export const SIGN_LEVELS = 3;

/** Frame of the sign with `level` symbols of `ore` (null: the empty board) on board `variant`. */
export function signFrame(meta: SignsMeta, variant: number, ore: string | null, level: number): number {
  const per = 1 + meta.ores.length * meta.levels;
  const k = ore === null ? -1 : meta.ores.indexOf(ore);
  return variant * per + (k < 0 ? 0 : 1 + k * meta.levels + Math.min(meta.levels, Math.max(1, level)) - 1);
}

export interface Art3d {
  images: Map<string, HTMLImageElement>;
  /** Settler and soldier figures (`settlers.json` + pages). */
  settlers: Settler3d;
  ground: GroundMeta;
  wares: WaresMeta;
  /** Menu icons (`icons.png`, in `images` as `icons`); optional: without them the UI uses `wares`. */
  icons?: IconsMeta;
  /** Geologist's signs (`signs.png`, in `images` as `signs`); optional: without them the classic painter. */
  signs?: SignsMeta;
}

/** Frames of the 3D mill sails over a quarter turn (`SAIL_FRAMES` in buildings.py); same canvas as the mill. */
export const MILL_SAIL_FRAMES = 12;

/** Scale of the 3D settler figures on screen: rendered large for detail, shown at S4 proportions (a settler about a third as tall as a small house). */
export const SETTLER_3D_SCALE = 0.72;
/**
 * Scale of goods in a 3D settler's hands, inside the figure: it undoes SETTLER_3D_SCALE, so a carried
 * ware is exactly as big on screen as one ware lying in a pile (both are rendered at the same scale).
 */
export const CARRIED_WARE_3D_SCALE = 1 / SETTLER_3D_SCALE;

/** Construction stages rendered per building (`STAGES` in build.py): 0 stakes … 3 roof half on. */
export const ART3D_STAGES = 4;
/**
 * 3D buildings and their canvases (the same as `BUILDING_CANVAS` for the type, as `SINGLE` in
 * build.py); each comes with its construction stages.
 */
export const ART3D_BUILDINGS: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  woodcutter: { w: 150, h: 140, ax: 75, ay: 100 },
  sawmill: { w: 150, h: 140, ax: 75, ay: 100 },
  stonecutter: { w: 150, h: 140, ax: 75, ay: 100 },
  tower: { w: 150, h: 210, ax: 75, ay: 170 },
  house_large: { w: 220, h: 190, ax: 110, ay: 135 },
  house_medium: { w: 150, h: 140, ax: 75, ay: 100 },
  house_small: { w: 150, h: 140, ax: 75, ay: 100 },
  coalmine: { w: 150, h: 140, ax: 75, ay: 100 },
  stonemine: { w: 150, h: 140, ax: 75, ay: 100 },
  ironmine: { w: 150, h: 140, ax: 75, ay: 100 },
  goldmine: { w: 150, h: 140, ax: 75, ay: 100 },
  ironsmelter: { w: 150, h: 140, ax: 75, ay: 100 },
  goldsmelter: { w: 150, h: 140, ax: 75, ay: 100 },
  weaponsmith: { w: 150, h: 140, ax: 75, ay: 100 },
  barracks: { w: 220, h: 190, ax: 110, ay: 135 },
  toolsmith: { w: 150, h: 140, ax: 75, ay: 100 },
  pigfarm: { w: 220, h: 190, ax: 110, ay: 135 },
  forester: { w: 150, h: 140, ax: 75, ay: 100 },
  market: { w: 150, h: 140, ax: 75, ay: 100 },
  donkeyranch: { w: 220, h: 190, ax: 110, ay: 135 },
  fisher: { w: 150, h: 140, ax: 75, ay: 100 },
  fountain: { w: 150, h: 140, ax: 75, ay: 100 },
  flowerbed: { w: 80, h: 120, ax: 40, ay: 92 },
  column: { w: 80, h: 120, ax: 40, ay: 92 },
  statue: { w: 80, h: 120, ax: 40, ay: 92 },
  obelisk: { w: 80, h: 120, ax: 40, ay: 92 },
  farm: { w: 220, h: 190, ax: 110, ay: 135 },
  mill: { w: 150, h: 210, ax: 75, ay: 165 },
  bakery: { w: 150, h: 140, ax: 75, ay: 100 },
  waterworks: { w: 150, h: 140, ax: 75, ay: 100 },
  warehouse: { w: 150, h: 140, ax: 75, ay: 100 },
  fortress: { w: 320, h: 290, ax: 160, ay: 200 },
  bigtower: { w: 170, h: 240, ax: 85, ay: 190 },
  lookout: { w: 150, h: 210, ax: 75, ay: 170 },
  infirmary: { w: 150, h: 140, ax: 75, ay: 100 },
  hunter: { w: 150, h: 140, ax: 75, ay: 100 },
  slaughterhouse: { w: 150, h: 140, ax: 75, ay: 100 },
};
/** Buildings rendered with their construction stages. */
export const ART3D_STAGED = Object.keys(ART3D_BUILDINGS);
/**
 * Where the owner's banner pole stands on a 3D military building, from the footprint centre (printed
 * by buildings.py's `note_banner` when it renders); replaces `BANNERS` in `sprites.ts` under `?art=3d`.
 */
export const ART3D_BANNERS: Record<string, { x: number; y: number }> = {
  tower: { x: 3.2, y: -40.0 },
  fortress: { x: 17.1, y: -98.0 },
  bigtower: { x: 4.6, y: -41.7 },
};
/**
 * A place where one of a military building's garrison is drawn: feet in sprite pixels from the
 * footprint centre and the direction (`DIRS` index) he faces while nothing happens; `window` for a
 * swordsman looking out of a window in the stone (he keeps to that side), and how high above his feet
 * whatever stands before him ends, in screen px (the figure is cut off below that line: the classic
 * art's parapets and sills, the 3D windows' sills — `note_posts` prints it).
 */
export interface GarrisonPost {
  x: number;
  y: number;
  dir: number;
  window?: boolean;
  cut?: number;
}
/**
 * Where a military building's garrison is seen, as in Settlers 4: the archers on the top behind the
 * parapet (`ranged`, one post per archer slot), the swordsmen at windows in the stone (`melee`); the
 * rest of a garrison (the fortress's fifth archer has a post, its swordsmen four windows) stays out of
 * sight.
 */
export interface GarrisonPosts {
  ranged: readonly GarrisonPost[];
  melee: readonly GarrisonPost[];
}
/**
 * Garrison posts on the 3D military buildings (printed by buildings.py's `note_posts`; the archers'
 * model offsets are `TOWER_POSTS` etc. there, the windows `garrison_window`). The parts of the model
 * before them — the walls round the windows, the near rails or merlons — are drawn again over the
 * figures (`<type>-front.png`, registered as `front:<type>`; the windows are holes in it). The lookout
 * has no garrison: its watchman works inside, as in Settlers 4.
 */
export const ART3D_POSTS: Record<string, GarrisonPosts> = {
  tower: {
    ranged: [
      { x: -12.8, y: -36.2, dir: 3 },
      { x: 19.2, y: -36.2, dir: 1 },
    ],
    melee: [{ x: 18.9, y: 13.4, dir: 1, window: true, cut: 15.7 }],
  },
  bigtower: {
    ranged: [
      { x: -21.0, y: -33.7, dir: 3 },
      { x: 23.8, y: -33.7, dir: 1 },
      { x: 1.4, y: -26.7, dir: 2 },
    ],
    melee: [
      { x: -45.2, y: 4.0, dir: 3, window: true, cut: 15.7 },
      { x: -15.1, y: 19.0, dir: 3, window: true, cut: 15.6 },
      { x: 32.7, y: 14.1, dir: 1, window: true, cut: 15.7 },
    ],
  },
  fortress: {
    ranged: [
      { x: 42.7, y: -76.0, dir: 2 },
      { x: -8.5, y: -78.1, dir: 3 },
      { x: 46.9, y: -97.3, dir: 1 },
      { x: -6.4, y: -100.5, dir: 3 },
      { x: 67.0, y: -85.2, dir: 1 },
    ],
    melee: [
      { x: -25.4, y: -33.4, dir: 3, window: true, cut: 12.0 },
      { x: -3.2, y: -22.3, dir: 3, window: true, cut: 12.0 },
      { x: 51.0, y: -29.1, dir: 1, window: true, cut: 12.1 },
      { x: 68.1, y: -37.7, dir: 1, window: true, cut: 12.0 },
    ],
  },
};
/**
 * Live-effect anchors of 3D buildings, from the sprite anchor (printed by buildings.py's `note_fx`
 * while rendering): chimney mouths for smoke and the mill's sail hub. Under `?art=3d` they replace
 * the procedural painters' `buildingFxAnchors` for these types.
 */
export const ART3D_FX: Record<string, { smoke?: [number, number][]; glow?: [number, number][]; hub?: [number, number] }> = {
  farm: { smoke: [[10.2, -72.4]] },
  mill: { hub: [1.6, -63.2] },
  bakery: { smoke: [[33.6, -68.6]], glow: [[-36.5, 6.9]] },
  ironsmelter: { smoke: [[11.2, -42.6]], glow: [[-9.9, 9.9]] },
  goldsmelter: { smoke: [[20.5, -37.2]], glow: [[0.2, 10.4]] },
  weaponsmith: { smoke: [[11.8, -49.7]], glow: [[-0.6, 7.1]] },
  toolsmith: { smoke: [[-7.4, -60.9]], glow: [[-15.7, -19.9]] },
};
/** Storage yards drawn as open platforms whose stock lies on them (`syncPile`). */
export const ART3D_YARDS = ['warehouse'];
/**
 * Goods piles at a door, for every resource: `piles-<res>.png` is a strip of `PILE_MAX` frames, frame
 * k holding k + 1 items (`GOODS` in art/blender/goods.py).
 */
export const ART3D_PILES: readonly Resource[] = RESOURCES;
export const PILE_MAX = 8;
export const PILE = { w: 44, h: 34, ax: 22, ay: 24 };
/**
 * Goods lying loose on bare ground (`ground.ts` stacks): `stacks-<res>.png`, a strip of `PILE_MAX`
 * frames of `STACK` on a small patch of trodden earth (`render_stacks` in goods.py). Optional per
 * resource: without its strip a stack is drawn as a door pile.
 */
export const STACK = { w: 56, h: 40, ax: 28, ay: 26 };
/**
 * Burnt ruins per footprint size (`ruins.py`): `ruin<n>` on the canvas of an n×n building, centred on
 * the footprint centre like a building.
 */
export const ART3D_RUINS: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  ruin1: { w: 80, h: 120, ax: 40, ay: 92 },
  ruin2: { w: 150, h: 140, ax: 75, ay: 100 },
  ruin3: { w: 220, h: 190, ax: 110, ay: 135 },
  ruin4: { w: 320, h: 290, ax: 160, ay: 200 },
};

/** Tree variants (`TREES` in art/blender/nature.py): 0–2 conifers, 3–5 broadleaf trees. */
export const ART3D_TREES = 6;
const TREE = { w: 84, h: 104, ax: 34, ay: 84 };
/** Decorative ground props scattered on grass (`PROPS` in nature.py), render-only. */
export const ART3D_PROPS = [
  'prop-tuft0',
  'prop-tuft1',
  'prop-flowers0',
  'prop-flowers1',
  'prop-flowers2',
  'prop-mushrooms',
  'prop-stones',
] as const;
const PROP = { w: 32, h: 28, ax: 16, ay: 20 };
/**
 * Mountain rocks (`ROCKS` in art/blender/rocks.py): `rock-<size><v>`, registered as `rock:<size>:<v>`
 * and placed by `rockLayout` (rocks.ts) — loose stones on slopes, boulders and 2×2 outcrops on peaks.
 * The anchor is the rock's centre on the ground (an outcrop's footprint centre).
 */
export const ART3D_ROCKS: Record<'small' | 'medium' | 'large', { count: number; w: number; h: number; ax: number; ay: number }> = {
  small: { count: 4, w: 52, h: 36, ax: 24, ay: 22 },
  medium: { count: 3, w: 88, h: 72, ax: 40, ay: 48 },
  large: { count: 4, w: 192, h: 150, ax: 90, ay: 104 },
};
/** Field decal and worn-path decal frames (`fields`, `paths` in art/textures/ground.py). */
export const FIELD_FRAME = { w: 66, h: 40, ax: 33, ay: 24 };
export const PATH_FRAME = { w: 80, h: 44, ax: 40, ay: 22 };

/** Logical size and anchor of the single-image sprites, matching `build.py`'s `SINGLE` table. */
export const ART3D_SPRITES: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  ...ART3D_BUILDINGS,
  ...Object.fromEntries(
    Object.entries(ART3D_BUILDINGS).flatMap(([type, c]) =>
      Array.from({ length: ART3D_STAGES }, (_, k) => [`${type}-s${k}`, c]),
    ),
  ),
  ...Object.fromEntries(Array.from({ length: ART3D_TREES }, (_, k) => [`tree${k}`, TREE])),
  ...Object.fromEntries(ART3D_PROPS.map((name) => [name, PROP])),
  ...Object.fromEntries(
    Object.entries(ART3D_ROCKS).flatMap(([size, { count, ...c }]) =>
      Array.from({ length: count }, (_, k) => [`rock-${size}${k}`, c]),
    ),
  ),
  ...ART3D_RUINS,
  deposit0: { w: 64, h: 72, ax: 30, ay: 58 },
  deposit1: { w: 64, h: 72, ax: 30, ay: 58 },
  deposit2: { w: 64, h: 72, ax: 30, ay: 58 },
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${url}`));
    img.src = url;
  });
}

export async function loadArt3d(): Promise<Art3d> {
  const base = `${import.meta.env.BASE_URL}art/3d/`;
  const names = Object.keys(ART3D_SPRITES);
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(names.map(async (n) => images.set(n, await loadImage(`${base}${n}.png`))));
  const settlersMeta = (await (await fetch(`${base}settlers.json`)).json()) as SettlersMeta;
  const settlerPages = await Promise.all(settlersMeta.pages.map((p) => loadImage(`${base}${p}`)));
  const settlers = buildSettler3d(settlersMeta, settlerPages);
  const ground = (await (await fetch(`${base}ground.json`)).json()) as GroundMeta;
  const groundStrips = [
    ...Object.keys(ground.kinds).map((k) => `ground-${k}`),
    ...Object.keys(ground.fields ?? {}).map((k) => `fields-${k}`),
    ...Array.from({ length: ground.paths?.levels ?? 0 }, (_, k) => `path-${k + 1}`),
  ];
  await Promise.all(groundStrips.map(async (n) => images.set(n, await loadImage(`${base}${n}.png`))));
  const wares = (await (await fetch(`${base}wares.json`)).json()) as WaresMeta;
  const strips = [...ART3D_PILES.map((r) => `piles-${r}`), 'wares', 'millsails'];
  await Promise.all(strips.map(async (n) => images.set(n, await loadImage(`${base}${n}.png`))));
  // Ground stacks are optional per resource (a stack without its strip is drawn as a door pile).
  await Promise.all(
    RESOURCES.map((r) =>
      loadImage(`${base}stacks-${r}.png`).then(
        (img) => images.set(`stacks-${r}`, img),
        () => undefined,
      ),
    ),
  );
  // Animal sheets are optional: a kind without one falls back to the procedural painter.
  await Promise.all(
    ANIMAL_KINDS.map((k) =>
      loadImage(`${base}animal-${k}.png`).then(
        (img) => images.set(`animal-${k}`, img),
        () => undefined,
      ),
    ),
  );
  // Large portraits of the animals that are units (the pack donkey's window), optional as well.
  await Promise.all(
    [...new Set(Object.values(UNIT_ANIMALS))].map((k) =>
      loadImage(`${base}animal-${k}-portrait.png`).then(
        (img) => images.set(`animal-${k}-portrait`, img),
        () => undefined,
      ),
    ),
  );
  // Menu icons are optional too: without them the HTML icons fall back to the carried wares.
  const icons = await fetch(`${base}icons.json`)
    .then((r) => (r.ok ? (r.json() as Promise<IconsMeta>) : undefined))
    .then(async (meta) => {
      if (!meta) return undefined;
      images.set('icons', await loadImage(`${base}icons.png`));
      return meta;
    })
    .catch(() => undefined);
  // The parts of military buildings standing before their garrison (optional: without them the figures
  // on the top are drawn whole).
  await Promise.all(
    Object.keys(ART3D_POSTS).map((t) =>
      loadImage(`${base}${t}-front.png`).then(
        (img) => images.set(`${t}-front`, img),
        () => undefined,
      ),
    ),
  );
  const signs = await fetch(`${base}signs.json`)
    .then((r) => (r.ok ? (r.json() as Promise<SignsMeta>) : undefined))
    .then(async (meta) => {
      if (!meta) return undefined;
      images.set('signs', await loadImage(`${base}signs.png`));
      return meta;
    })
    .catch(() => undefined);
  return { images, settlers, ground, wares, icons, signs };
}
