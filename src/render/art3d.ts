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
  /** Tile (x, y) uses variant (x mod period) + period·(y mod period); textures are seamless. */
  period: number;
  /** Logical size of one diamond frame (as the procedural ground sprites). */
  frame: [number, number];
  kinds: string[];
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
};
/** Buildings rendered with their construction stages. */
export const ART3D_STAGED = Object.keys(ART3D_BUILDINGS);
/**
 * Where the owner's banner pole stands on a 3D military building, from the footprint centre (printed
 * by buildings.py's `note_banner` when it renders); replaces `BANNERS` in `sprites.ts` under `?art=3d`.
 */
export const ART3D_BANNERS: Record<string, { x: number; y: number }> = {
  tower: { x: 3.2, y: -52.1 },
};
/**
 * Goods piles at a door, for every resource: `piles-<res>.png` is a strip of `PILE_MAX` frames, frame
 * k holding k + 1 items (`GOODS` in art/blender/goods.py).
 */
export const ART3D_PILES: readonly Resource[] = RESOURCES;
export const PILE_MAX = 8;
export const PILE = { w: 44, h: 34, ax: 22, ay: 24 };

/** Logical size and anchor of the single-image sprites, matching `build.py`'s `SINGLE` table. */
export const ART3D_SPRITES: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  ...ART3D_BUILDINGS,
  ...Object.fromEntries(
    Object.entries(ART3D_BUILDINGS).flatMap(([type, c]) =>
      Array.from({ length: ART3D_STAGES }, (_, k) => [`${type}-s${k}`, c]),
    ),
  ),
  tree: { w: 84, h: 100, ax: 34, ay: 80 },
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
  await Promise.all(ground.kinds.map(async (k) => images.set(`ground-${k}`, await loadImage(`${base}ground-${k}.png`))));
  const wares = (await (await fetch(`${base}wares.json`)).json()) as WaresMeta;
  const strips = [...ART3D_PILES.map((r) => `piles-${r}`), 'wares'];
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
