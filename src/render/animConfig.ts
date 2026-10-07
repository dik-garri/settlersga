/**
 * Render-side animation and sound data. Kept out of the sim config: none of this affects the game,
 * only how it looks and sounds. A new profession needs one `SETTLER_STYLES` entry (or uses the
 * default); a new kind of work one `ACTIONS` entry.
 */
import type { BuildingType, PlantKind, Resource, SettlerKind } from '../sim/types';

/** Tools a settler can hold; each has a walking pose and the work actions that use it. */
export const TOOLS = ['none', 'axe', 'hammer', 'pick', 'shovel', 'scythe', 'rod', 'bucket', 'sword', 'bow', 'carry'] as const;
export type ToolShape = (typeof TOOLS)[number];

export type HatStyle = 'cap' | 'straw' | 'helmet' | 'hood' | 'chef' | 'bare';
export const HAT_STYLES: readonly HatStyle[] = ['cap', 'straw', 'helmet', 'hood', 'chef', 'bare'];

/** Synthesised sound effects (see `audio/sounds.ts`). */
export type SoundId =
  | 'chop'
  | 'hammer'
  | 'pick'
  | 'dig'
  | 'reap'
  | 'saw'
  | 'splash'
  | 'clash'
  | 'hit'
  | 'twang'
  | 'complete'
  | 'click'
  | 'fall'
  | 'hiss';

export interface ActionDef {
  tool: ToolShape;
  /** Near-arm angle per frame, in turns of π: 0 hanging down, 0.5 straight forward, 1 straight up. */
  arm: readonly [number, number, number, number];
  /** Bow string pull per frame (0..1), only for the bow. */
  pull?: readonly [number, number, number, number];
  loopMs: number;
  /** Sound played when the loop reaches `soundFrame` on screen. */
  sound?: SoundId;
  soundFrame?: number;
}

export const ACTIONS = {
  idle: { tool: 'none', arm: [0.05, 0.05, 0.05, 0.05], loopMs: 1600 },
  chop: { tool: 'axe', arm: [0.95, 0.62, 0.2, 0.1], loopMs: 720, sound: 'chop', soundFrame: 2 },
  hammer: { tool: 'hammer', arm: [0.82, 0.5, 0.16, 0.34], loopMs: 520, sound: 'hammer', soundFrame: 2 },
  mine: { tool: 'pick', arm: [0.98, 0.6, 0.18, 0.3], loopMs: 780, sound: 'pick', soundFrame: 2 },
  dig: { tool: 'shovel', arm: [0.34, 0.14, 0.02, 0.22], loopMs: 820, sound: 'dig', soundFrame: 2 },
  reap: { tool: 'scythe', arm: [0.46, 0.3, 0.12, 0.28], loopMs: 900, sound: 'reap', soundFrame: 2 },
  sow: { tool: 'none', arm: [0.12, 0.38, 0.56, 0.3], loopMs: 1100 },
  fish: { tool: 'rod', arm: [0.6, 0.66, 0.58, 0.64], loopMs: 1500 },
  draw: { tool: 'bucket', arm: [0.06, 0.2, 0.38, 0.2], loopMs: 900, sound: 'splash', soundFrame: 2 },
  sword: { tool: 'sword', arm: [0.88, 0.45, 0.14, 0.5], loopMs: 600 },
  shoot: { tool: 'bow', arm: [0.5, 0.5, 0.5, 0.5], pull: [0, 0.5, 1, 0], loopMs: 800 },
} satisfies Record<string, ActionDef>;
export type ActionId = keyof typeof ACTIONS;
export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];

export interface SettlerStyle {
  /** Tunic and hat colours (the layers are painted grey and tinted). Fighters use their player colour. */
  tunic: string;
  hat: string;
  hatStyle: HatStyle;
  /** What the settler does while `working`. */
  work: ActionId;
  /** Tool held while walking or standing. */
  holds: ToolShape;
  /** Fighting profession: tunic in the owner's colour. */
  fighter?: boolean;
}

const DEFAULT_STYLE: SettlerStyle = { tunic: '#7a6a58', hat: '#5a4636', hatStyle: 'cap', work: 'idle', holds: 'none' };

const STYLES: Partial<Record<SettlerKind, Partial<SettlerStyle>>> = {
  carrier: { tunic: '#3f6fb5', hat: '#6b4423', hatStyle: 'cap' },
  builder: { tunic: '#d08a2c', hat: '#c23b2b', hatStyle: 'cap', work: 'hammer', holds: 'hammer' },
  digger: { tunic: '#8a6a3c', hat: '#5a4636', hatStyle: 'straw', work: 'dig', holds: 'shovel' },
  // Trainee on his way from the barracks to a garrison, still in plain clothes.
  recruit: { tunic: '#8a7f6a', hat: '#5a4636' },
  woodcutter: { tunic: '#3d7d3a', hat: '#2e4d22', hatStyle: 'hood', work: 'chop', holds: 'axe' },
  forester: { tunic: '#7a9a3a', hat: '#5a4020', hatStyle: 'straw', work: 'dig', holds: 'shovel' },
  stonecutter: { tunic: '#7d7f86', hat: '#4a3b2c', hatStyle: 'cap', work: 'mine', holds: 'pick' },
  miner: { tunic: '#555b66', hat: '#d9b44a', hatStyle: 'helmet', work: 'mine', holds: 'pick' },
  geologist: { tunic: '#7a5c3a', hat: '#3b2b1a', hatStyle: 'straw', work: 'hammer', holds: 'hammer' },
  waterman: { tunic: '#4a90c2', hat: '#e0d6c0', hatStyle: 'cap', work: 'draw', holds: 'bucket' },
  fisher: { tunic: '#2f6f8f', hat: '#c9b27a', hatStyle: 'straw', work: 'fish', holds: 'rod' },
  farmer: { tunic: '#c9a44a', hat: '#e3c76a', hatStyle: 'straw', work: 'reap', holds: 'scythe' },
  sawmiller: { tunic: '#8b5a2b', hat: '#d9c9a3', hatStyle: 'cap' },
  miller: { tunic: '#e8e4da', hat: '#9a8f80', hatStyle: 'cap' },
  baker: { tunic: '#f0ece2', hat: '#ffffff', hatStyle: 'chef' },
  pigfarmer: { tunic: '#8a6d4b', hat: '#5a4636', hatStyle: 'hood' },
  butcher: { tunic: '#b83c3c', hat: '#e8e4da', hatStyle: 'cap' },
  smelter: { tunic: '#6e4a33', hat: '#3b2b1a', hatStyle: 'hood' },
  toolsmith: { tunic: '#5a5048', hat: '#8c4a3a', hatStyle: 'cap', work: 'hammer', holds: 'hammer' },
  weaponsmith: { tunic: '#4a4f55', hat: '#8c4a3a', hatStyle: 'cap', work: 'hammer', holds: 'hammer' },
  soldier: { hat: '#9aa0a6', hatStyle: 'helmet', work: 'sword', holds: 'sword', fighter: true },
  archer: { hat: '#4f6b3a', hatStyle: 'hood', work: 'shoot', holds: 'bow', fighter: true },
};

/** Work done on a planting or gathering task overrides the profession's default `work`. */
export const PLANT_ACTION: Record<PlantKind, ActionId> = { tree: 'dig', grain: 'sow' };
export const GATHER_ACTION: Partial<Record<Resource, ActionId>> = {
  log: 'chop',
  stone: 'mine',
  water: 'draw',
  fish: 'fish',
  grain: 'reap',
};

const resolved = new Map<string, SettlerStyle>();

/** Look of a profession, falling back to a neutral villager for professions without an entry. */
export function styleOf(kind: SettlerKind): SettlerStyle {
  let s = resolved.get(kind);
  if (!s) {
    s = { ...DEFAULT_STYLE, ...STYLES[kind] };
    resolved.set(kind, s);
  }
  return s;
}

/**
 * Building effects. Positions come from the sprites (chimneys, furnaces, oven, mill hub); this
 * table only says when they run. Residences smoke whenever they stand; workshops while working.
 */
export interface BuildingFx {
  smoke?: 'always' | 'working';
  /** Pulsing fire glow while working. */
  glow?: boolean;
  /** Mill sails spin while working, idle slowly otherwise. */
  sails?: boolean;
  /** Ambient loop near the building while working. */
  sound?: SoundId;
}

export const BUILDING_FX: Partial<Record<BuildingType, BuildingFx>> = {
  bakery: { smoke: 'working', glow: true },
  toolsmith: { smoke: 'working', sound: 'hammer' },
  weaponsmith: { smoke: 'working', sound: 'hammer' },
  ironsmelter: { smoke: 'working', glow: true, sound: 'hiss' },
  goldsmelter: { smoke: 'working', glow: true, sound: 'hiss' },
  sawmill: { sound: 'saw' },
  mill: { sails: true },
};

/** A workshop counts as working this long after its recipe timer last moved. */
export const WORKING_GRACE_MS = 1500;
