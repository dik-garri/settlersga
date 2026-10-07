/**
 * Pre-rendered 3D sprites (the Blender pipeline in `art/blender`, output in `public/art/3d`). A pilot:
 * with `?art=3d` they replace the procedural woodcutter, sawmill, stonecutter, tower and large house
 * (with construction stages), tree, stone deposit, wares, door piles and every settler.
 * Every sprite keeps the anchor convention of the sprite it replaces, so the renderer is unchanged
 * except for settlers, whose pre-rendered frames (`settler3d.ts`) replace the layered figure. Animal
 * sheets (`animal-<kind>.png`, see `animalArt.ts`) are loaded here too.
 */
import { ANIMAL_KINDS } from '../sim/config';
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
  /** Field decals per crop kind: `fields-<kind>.png`, a strip of that many growth stages (1…n). */
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

export interface Art3d {
  images: Map<string, HTMLImageElement>;
  /** Settler and soldier figures (`settlers.json` + pages). */
  settlers: Settler3d;
  ground: GroundMeta;
  wares: WaresMeta;
}

/** Frames of the 3D mill sails over a quarter turn (`SAIL_FRAMES` in buildings.py); same canvas as the mill. */
export const MILL_SAIL_FRAMES = 12;

/** Scale of the 3D settler figures on screen: rendered large for detail, shown at S4 proportions (a settler about a third as tall as a small house). */
export const SETTLER_3D_SCALE = 0.72;

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
  barracks: { w: 150, h: 140, ax: 75, ay: 100 },
  toolsmith: { w: 150, h: 140, ax: 75, ay: 100 },
  pigfarm: { w: 150, h: 140, ax: 75, ay: 100 },
  forester: { w: 150, h: 140, ax: 75, ay: 100 },
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
  castle: { w: 220, h: 250, ax: 110, ay: 190 },
  fortress: { w: 230, h: 260, ax: 115, ay: 195 },
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
  tower: { x: 3.2, y: -49.8 },
  castle: { x: 1.6, y: -101.7 },
  fortress: { x: 12.8, y: -67.9 },
  bigtower: { x: 4.2, y: -58.0 },
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
  // Animal sheets are optional: a kind without one falls back to the procedural painter.
  await Promise.all(
    ANIMAL_KINDS.map((k) =>
      loadImage(`${base}animal-${k}.png`).then(
        (img) => images.set(`animal-${k}`, img),
        () => undefined,
      ),
    ),
  );
  return { images, settlers, ground, wares };
}
