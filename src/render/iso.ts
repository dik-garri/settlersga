export const TILE_W = 64;
export const TILE_H = 32;
export const HALF_W = TILE_W / 2;
export const HALF_H = TILE_H / 2;

/** Tile coordinates (tile centers are integers) → world pixels. */
export function toScreen(x: number, y: number): { x: number; y: number } {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

/** World pixels → fractional tile coordinates. */
export function toTile(sx: number, sy: number): { x: number; y: number } {
  const a = sx / HALF_W;
  const b = sy / HALF_H;
  return { x: (a + b) / 2, y: (b - a) / 2 };
}

/** Painter's order: larger x + y is closer to the viewer. */
export function depthOf(x: number, y: number): number {
  return x + y;
}
