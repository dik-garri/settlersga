import type { AnimalKind } from '../sim/config';
import type { SettlerKind } from '../sim/types';
import { MIRRORED, PAINTED_ANGLE, PAINTED_DIR } from './anim';

/**
 * Animal sprites: a sheet per kind of 8 directions (`DIRS` order) × `ANIMAL_COLUMNS` frames — walk
 * 0..3, standing, grazing (head down). With `?art=3d` they come pre-rendered from Blender
 * (`art/blender/animals.py`, cells must match `ANIMAL_CELLS`); otherwise these painters draw a
 * simple side view.
 */
export const ANIMAL_WALK = 4;
export const ANIMAL_STAND = 4;
export const ANIMAL_GRAZE = 5;
export const ANIMAL_COLUMNS = 6;

/** Logical cell size and anchor (feet) per kind; `animals.py` renders the same. */
export const ANIMAL_CELLS: Record<AnimalKind, { w: number; h: number; ax: number; ay: number }> = {
  deer: { w: 48, h: 48, ax: 24, ay: 38 },
  donkey: { w: 48, h: 44, ax: 24, ay: 34 },
  duck: { w: 22, h: 18, ax: 11, ay: 13 },
  chicken: { w: 22, h: 22, ax: 11, ay: 17 },
};

/**
 * Drawn size per kind relative to its cell, so animals keep Settlers 4 proportions next to the (scaled)
 * settlers and buildings: deer and donkeys come up to about a settler's shoulder, poultry to his knee.
 */
export const ANIMAL_SCALE: Record<AnimalKind, number> = { deer: 1.1, donkey: 1.0, duck: 0.62, chicken: 0.58 };

/** Tiles walked per full walk cycle (drives the walk frame, so feet do not slide). */
export const ANIMAL_STRIDE: Record<AnimalKind, number> = { deer: 0.9, donkey: 0.7, duck: 0.35, chicken: 0.35 };

/** Settler kinds drawn as an animal instead of a figure (`AnimalLayer.syncUnit`): the pack donkey. */
export const UNIT_ANIMALS: Partial<Record<SettlerKind, AnimalKind>> = { donkey: 'donkey' };

/** Pack saddle frame size and anchor (bottom centre), and how high above a pack animal's feet it sits. */
export const PACK = { w: 30, h: 16, ax: 15, ay: 13, back: 15 };

/** A pack saddle: a blanket over the back with a wicker pannier hanging on either side. */
export function paintPack(ctx: CanvasRenderingContext2D): void {
  ctx.translate(PACK.ax, PACK.ay);
  ctx.fillStyle = '#7a2e22';
  ctx.beginPath();
  ctx.ellipse(0, -3, 9, 3.2, 0, 0, Math.PI * 2);
  ctx.fill();
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#a77a3e';
    ctx.beginPath();
    ctx.roundRect(side * 9 - 4.5, -5, 9, 8, 2.5);
    ctx.fill();
    ctx.strokeStyle = '#6b4a22';
    ctx.lineWidth = 0.8;
    for (let k = 0; k < 3; k++) {
      ctx.beginPath();
      ctx.moveTo(side * 9 - 4, -3 + k * 2.4);
      ctx.lineTo(side * 9 + 4, -3 + k * 2.4);
      ctx.stroke();
    }
  }
}

interface Look {
  body: string;
  belly: string;
  dark: string;
  /** Body length and height, leg length, neck rise, head size (logical px). */
  len: number;
  tall: number;
  leg: number;
  neck: number;
  head: number;
}

const LOOKS: Record<AnimalKind, Look> = {
  deer: { body: '#a8683a', belly: '#e2c7a2', dark: '#4a2c16', len: 22, tall: 10, leg: 12, neck: 10, head: 6 },
  donkey: { body: '#8d8a86', belly: '#d8d4cc', dark: '#3e3c3a', len: 22, tall: 11, leg: 9, neck: 7, head: 7 },
  duck: { body: '#f4f1e8', belly: '#ffffff', dark: '#e2a12a', len: 10, tall: 6, leg: 0, neck: 4, head: 4 },
  chicken: { body: '#b5562b', belly: '#e9c79a', dark: '#c8301e', len: 9, tall: 7, leg: 4, neck: 4, head: 3.5 },
};

/**
 * Procedural fallback: a side view (painted facing right, mirrored for directions facing left),
 * foreshortened for directions towards or away from the camera.
 */
export function paintAnimal(ctx: CanvasRenderingContext2D, kind: AnimalKind, dir: number, frame: number): void {
  const c = ANIMAL_CELLS[kind];
  const L = LOOKS[kind];
  const angle = PAINTED_ANGLE[PAINTED_DIR[dir]];
  const fore = Math.max(0.45, Math.abs(Math.cos(angle)));
  ctx.translate(c.ax, c.ay);
  if (MIRRORED[dir]) ctx.scale(-1, 1);
  // Shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(0, 0, (L.len / 2) * fore + 2, 2.5, 0, 0, Math.PI * 2);
  ctx.fill();
  const graze = frame === ANIMAL_GRAZE;
  const swing = frame < ANIMAL_WALK ? [3, 0, -3, 0][frame] : 0;
  const bodyY = -L.leg - L.tall / 2;
  const half = (L.len / 2) * fore;
  // Legs (two pairs, swinging opposite).
  ctx.strokeStyle = L.dark;
  ctx.lineWidth = kind === 'deer' || kind === 'donkey' ? 2 : 1.2;
  if (L.leg > 0) {
    for (const [x, s] of [
      [-half * 0.7, swing],
      [-half * 0.55, -swing],
      [half * 0.55, -swing],
      [half * 0.7, swing],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x, bodyY + L.tall / 3);
      ctx.lineTo(x + s * fore, -0.5);
      ctx.stroke();
    }
  }
  // Body.
  ctx.fillStyle = L.body;
  ctx.beginPath();
  ctx.ellipse(0, bodyY, half + 1, L.tall / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = L.belly;
  ctx.beginPath();
  ctx.ellipse(0, bodyY + L.tall * 0.22, half * 0.75, L.tall * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();
  // Neck and head.
  const hx = half + L.head * 0.4;
  const hy = graze ? -L.head * 0.6 : bodyY - L.neck;
  ctx.strokeStyle = L.body;
  ctx.lineWidth = L.head * 0.8;
  ctx.beginPath();
  ctx.moveTo(half * 0.6, bodyY);
  ctx.lineTo(hx, hy);
  ctx.stroke();
  ctx.fillStyle = L.body;
  ctx.beginPath();
  ctx.ellipse(hx + L.head * 0.3, hy, L.head * 0.75, L.head * 0.5, graze ? 0.9 : 0.25, 0, Math.PI * 2);
  ctx.fill();
  if (kind === 'deer') {
    // Antlers.
    ctx.strokeStyle = '#e8dcc0';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(hx, hy - 2);
    ctx.lineTo(hx - 3, hy - 9);
    ctx.moveTo(hx - 1.5, hy - 5.5);
    ctx.lineTo(hx + 1, hy - 8);
    ctx.stroke();
  } else if (kind === 'donkey') {
    ctx.fillStyle = L.dark;
    ctx.beginPath();
    ctx.ellipse(hx - 1, hy - 4.5, 1, 3.5, -0.3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Beak or bill, and the chicken's comb.
    ctx.fillStyle = kind === 'duck' ? '#f0a020' : '#e8b030';
    ctx.beginPath();
    ctx.moveTo(hx + L.head, hy - 0.5);
    ctx.lineTo(hx + L.head + 3, hy + 0.3);
    ctx.lineTo(hx + L.head, hy + 1);
    ctx.fill();
    if (kind === 'chicken') {
      ctx.fillStyle = L.dark;
      ctx.fillRect(hx - 0.5, hy - L.head - 1, 2.5, 2);
    }
  }
  // Eye.
  ctx.fillStyle = '#111';
  ctx.fillRect(hx + L.head * 0.35, hy - 1, 1, 1);
}
