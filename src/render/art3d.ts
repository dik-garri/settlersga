/**
 * Pre-rendered 3D sprites (the Blender pipeline in `art/blender`, output in `public/art/3d`). A pilot:
 * with `?art=3d` they replace the procedural woodcutter, tree, stone deposit, log and the carrier.
 * Every sprite keeps the anchor convention of the sprite it replaces, so the renderer is unchanged
 * except for the carrier, whose 8-direction sheet replaces the layered figure.
 */

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

export interface Art3d {
  images: Map<string, HTMLImageElement>;
  carrier: CarrierSheetMeta;
}

/** Logical size and anchor of the single-image sprites, matching `build.py`'s `SINGLE` table. */
export const ART3D_SPRITES: Record<string, { w: number; h: number; ax: number; ay: number }> = {
  woodcutter: { w: 150, h: 140, ax: 75, ay: 100 },
  tree: { w: 80, h: 96, ax: 32, ay: 78 },
  deposit0: { w: 56, h: 44, ax: 28, ay: 34 },
  deposit1: { w: 56, h: 44, ax: 28, ay: 34 },
  deposit2: { w: 56, h: 44, ax: 28, ay: 34 },
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
  const names = [...Object.keys(ART3D_SPRITES), 'carrier'];
  const images = new Map<string, HTMLImageElement>();
  await Promise.all(names.map(async (n) => images.set(n, await loadImage(`${base}${n}.png`))));
  const carrier = (await (await fetch(`${base}carrier.json`)).json()) as CarrierSheetMeta;
  return { images, carrier };
}
