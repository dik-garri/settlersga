/**
 * Pre-rendered 3D sprites (the Blender pipeline in `art/blender`, output in `public/art/3d`). A pilot:
 * with `?art=3d` they replace the procedural woodcutter, tree, stone deposit, log and the carrier.
 * Every sprite keeps the anchor convention of the sprite it replaces, so the renderer is unchanged
 * except for the carrier, whose 8-direction sheet replaces the layered figure. Animal sheets
 * (`animal-<kind>.png`, see `animalArt.ts`) are loaded here too.
 */
import { ANIMAL_KINDS } from '../sim/config';

/** `carrier.json` written by `art/blender/build.py`. */
export interface CarrierSheetMeta {
  /** Logical cell size and anchor (the sheet itself is at the atlas resolution, 2×). */
  cell: [number, number];
  anchor: [number, number];
  columns: number;
  /** Walk frames; column `walk` is standing. */
  walk: number;
  /** First column of the carrying poses (same layout). */
  carryColumn: number;
  /** [dir][frame]: where goods in hand go, relative to the anchor. */
  carryAt: [number, number][][];
  /** [dir]: goods in hand are hidden behind the figure. */
  carryBehind: boolean[];
}

/** `ground.json` written by `art/textures/ground.py`. */
export interface GroundMeta {
  /** Tile (x, y) uses variant (x mod period) + period·(y mod period); textures are seamless. */
  period: number;
  /** Logical size of one diamond frame (as the procedural ground sprites). */
  frame: [number, number];
  kinds: string[];
}

export interface Art3d {
  images: Map<string, HTMLImageElement>;
  carrier: CarrierSheetMeta;
  ground: GroundMeta;
}

/** Construction stages rendered per building (`STAGES` in build.py): 0 stakes … 3 roof half on. */
export const ART3D_STAGES = 4;
/** Buildings rendered with their construction stages. */
export const ART3D_STAGED = ['woodcutter'];
/** Goods piles at a door: one sprite per count up to `PILE_MAX` (`build_pile` in build.py). */
export const ART3D_PILES = ['log', 'plank', 'stone'];
export const PILE_MAX = 8;
const PILE = { w: 44, h: 34, ax: 22, ay: 24 };

const WOODCUTTER = { w: 150, h: 140, ax: 75, ay: 100 };

/** Logical size and anchor of the single-image sprites, matching `build.py`'s `SINGLE` table. */
export const ART3D_SPRITES: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  woodcutter: WOODCUTTER,
  ...Object.fromEntries(Array.from({ length: ART3D_STAGES }, (_, k) => [`woodcutter-s${k}`, WOODCUTTER])),
  ...Object.fromEntries(
    ART3D_PILES.flatMap((res) => Array.from({ length: PILE_MAX }, (_, k) => [`pile-${res}-${k + 1}`, PILE])),
  ),
  tree: { w: 84, h: 100, ax: 34, ay: 80 },
  deposit0: { w: 64, h: 72, ax: 30, ay: 58 },
  deposit1: { w: 64, h: 72, ax: 30, ay: 58 },
  deposit2: { w: 64, h: 72, ax: 30, ay: 58 },
  log: { w: 16, h: 10, ax: 8, ay: 5 },
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
  const names = [...Object.keys(ART3D_SPRITES), 'carrier', ...ANIMAL_KINDS.map((k) => `animal-${k}`)];
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(names.map(async (n) => images.set(n, await loadImage(`${base}${n}.png`))));
  const carrier = (await (await fetch(`${base}carrier.json`)).json()) as CarrierSheetMeta;
  const ground = (await (await fetch(`${base}ground.json`)).json()) as GroundMeta;
  await Promise.all(ground.kinds.map(async (k) => images.set(`ground-${k}`, await loadImage(`${base}ground-${k}.png`))));
  return { images, carrier, ground };
}
