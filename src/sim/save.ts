import type { AiState } from './ai';
import type { Animal } from './animals';
import type { Command } from './commands';
import type { GameResult, GameRules } from './modes';
import { TRANSPORT_PRIORITY } from './config';
import { GameMap } from './map';
import { RESOURCES, type Building, type PlayerId, type Resource, type Settler } from './types';
import type { Player, World } from './world';

/** Bump when the save layout changes incompatibly. */
export const SAVE_VERSION = 33;
/**
 * The previous version, still loaded (`upgradeFrom32`): its goods had a pig (`RESOURCES` index 8) and,
 * in the latest of them, a sheep after the armour; its buildings a pig farm and its people pig farmers.
 */
export const PIG_SAVE_VERSION = 32;

const MAP_LAYERS = [
  'terrain',
  'tree',
  'stone',
  'crop',
  'cropKind',
  'growth',
  'fish',
  'ore',
  'oreAmount',
  'prospected',
  'explored',
  'wear',
  'owner',
  'goods',
  'goodsAmount',
  'goodsReserved',
  'building',
  'door',
  'height',
] as const;
type MapLayer = (typeof MAP_LAYERS)[number];
/** Layers added later: saved always, loaded when present (older saves simply have none). */
const LATER_LAYERS = ['signAt', 'signBy'] as const;
type LaterLayer = (typeof LATER_LAYERS)[number];
/** Every map layer a save holds (`stateChecksum` hashes the same ones). */
export const SAVED_LAYERS = [...MAP_LAYERS, ...LATER_LAYERS] as const;

/** Plain-JSON snapshot of the whole simulation. */
export interface SaveData {
  version: number;
  tick: number;
  nextId: number;
  rngState: number;
  territoryVersion: number;
  stats: World['stats'];
  players: Player[];
  map: { w: number; h: number } & Record<MapLayer, string> & Partial<Record<LaterLayer, string>>;
  buildings: Building[];
  settlers: Settler[];
  reservedTargets: number[];
  reservedPlots: number[];
  ai: AiState[];
  defeated: PlayerId[];
  animals: Animal[];
  nextAnimalId: number;
  animalRngState: number;
  idleRngState: number;
  /** Commands scheduled for a later tick (`World.schedule`); absent in older saves. */
  commands?: Command[];
  /** `World.nextCommandSeq`; absent in older saves. */
  commandSeq?: number;
  /** `World.rules` (victory mode, economic goods, saboteurs); absent = conquest (older saves too). */
  rules?: GameRules;
  /** `World.result` (an economic victory); absent while undecided. */
  result?: GameResult;
}

function encode(a: Uint8Array | Uint16Array | Int32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function decodeInto(text: string, target: Uint8Array | Uint16Array | Int32Array): void {
  const bin = atob(text);
  const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  if (bin.length !== bytes.length) throw new Error('corrupt save: map layer size mismatch');
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
}

export function saveWorld(w: World): SaveData {
  const map = { w: w.map.w, h: w.map.h } as SaveData['map'];
  for (const layer of SAVED_LAYERS) map[layer] = encode(w.map[layer]);
  return structuredClone({
    version: SAVE_VERSION,
    tick: w.tick,
    nextId: w.nextId,
    rngState: w.rng.state,
    territoryVersion: w.territoryVersion,
    stats: w.stats,
    players: w.players,
    map,
    // Map iteration is in id order, which `restoreWorld` reproduces.
    buildings: [...w.buildings.values()],
    settlers: w.settlers,
    reservedTargets: [...w.reservedTargets],
    reservedPlots: [...w.reservedPlots],
    ai: w.ai,
    defeated: w.defeated,
    animals: w.animals,
    nextAnimalId: w.nextAnimalId,
    animalRngState: w.animalRng.state,
    idleRngState: w.idleRng.state,
    commands: w.pendingCommands,
    commandSeq: w.nextCommandSeq,
    rules: w.rules,
    result: w.result,
  });
}

export function mapFromSave(data: SaveData): GameMap {
  if (data.version !== SAVE_VERSION && data.version !== PIG_SAVE_VERSION) {
    throw new Error(`unsupported save version ${data.version}, expected ${SAVE_VERSION}`);
  }
  const map = new GameMap(data.map.w, data.map.h);
  for (const layer of MAP_LAYERS) decodeInto(data.map[layer], map[layer]);
  for (const layer of LATER_LAYERS) {
    const text = data.map[layer];
    if (text !== undefined) decodeInto(text, map[layer]);
  }
  if (data.version === PIG_SAVE_VERSION) recodeGoods(map.goods, PIG_GOODS);
  return map;
}

/**
 * Version 32's goods, by their index in its `RESOURCES` (goods on the ground are saved as index + 1):
 * the pig at 8, and — in saves written after the Romans got their sheep farm — the sheep last.
 */
const PIG_GOODS: readonly string[] = [
  'log', 'plank', 'stone', 'water', 'fish', 'grain', 'flour', 'bread', 'pig', 'meat', 'coal', 'ironore',
  'goldore', 'iron', 'gold', 'axe', 'saw', 'pickaxe', 'shovel', 'scythe', 'rod', 'hammer', 'sword', 'bow',
  'armor', 'sheep',
];
/**
 * Ids version 32 knew and this one does not: the pig farm became the sheep farm (the same 3×3 animal
 * ranch with the same recipe), its pig farmer a shepherd, its pigs sheep (the slaughterhouse takes them).
 */
const RENAMED: Readonly<Record<string, string>> = { pig: 'sheep', pigfarm: 'sheepfarm', pigfarmer: 'shepherd' };
/** Keys whose numbers are settings (distribution weights, AI retry ticks): on a clash the larger stays. */
const SETTING_KEYS: ReadonlySet<string> = new Set(['distribution', 'blockedUntil']);

/** Rewrites the ground's goods codes (index + 1) from an older list of goods, through `RENAMED`. */
function recodeGoods(goods: Uint8Array, old: readonly string[]): void {
  const code = old.map((name) => RESOURCES.indexOf((RENAMED[name] ?? name) as Resource) + 1);
  for (let i = 0; i < goods.length; i++) if (goods[i] > 0) goods[i] = code[goods[i] - 1];
}

/** Puts `value` under `key` of `o`, together with what is there: counts add up, settings keep the larger. */
function mergeInto(o: Record<string, unknown>, key: string, value: unknown, setting: boolean): void {
  const had = o[key];
  if (had === undefined) o[key] = value;
  else if (typeof had === 'number' && typeof value === 'number') o[key] = setting ? Math.max(had, value) : had + value;
  else if (had && value && typeof had === 'object' && typeof value === 'object' && !Array.isArray(had)) {
    for (const [k, v] of Object.entries(value)) mergeInto(had as Record<string, unknown>, k, v, setting);
  }
}

/**
 * Brings a version-32 save up to this one, in place (the ground's goods: `mapFromSave`): every id of
 * `RENAMED` is replaced wherever it stands — building types, professions, goods in hands, in tasks,
 * orders and pending commands, and as a key: stocks, a market's orders, distribution and tally,
 * statistics —; a pig and a sheep under one key are added up (a setting keeps the larger), and a list
 * that came to name a good twice keeps the first (the transport priority had both). Every transport
 * list then names every good (missing ones at its end, in `TRANSPORT_PRIORITY`'s order).
 */
export function upgradeFrom32(data: SaveData): void {
  const fix = (v: unknown, setting: boolean): unknown => {
    if (typeof v === 'string') return RENAMED[v] ?? v;
    if (Array.isArray(v)) {
      const out = v.map((x) => fix(x, setting));
      const renamed = out.some((x, i) => x !== v[i]);
      return renamed && out.every((x) => typeof x === 'string') ? [...new Set(out)] : out;
    }
    if (v === null || typeof v !== 'object') return v;
    const o = v as Record<string, unknown>;
    const fixed: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) {
      const inner = setting || SETTING_KEYS.has(k);
      mergeInto(fixed, RENAMED[k] ?? k, fix(x, inner), inner);
    }
    for (const k of Object.keys(o)) delete o[k];
    return Object.assign(o, fixed);
  };
  const all = data as unknown as Record<string, unknown>;
  for (const key of Object.keys(all)) if (key !== 'map') all[key] = fix(all[key], false);
  for (const p of data.players) {
    const list = p.economy?.transport;
    if (!list) continue;
    for (const r of TRANSPORT_PRIORITY) if (!list.includes(r)) list.push(r);
  }
  data.version = SAVE_VERSION;
}

/** Copies everything except the map (built by `mapFromSave`) from the save into a fresh world. */
export function restoreWorld(w: World, raw: SaveData): void {
  const data = structuredClone(raw);
  if (data.version === PIG_SAVE_VERSION) upgradeFrom32(data);
  w.tick = data.tick;
  w.nextId = data.nextId;
  w.rng.state = data.rngState;
  w.territoryVersion = data.territoryVersion;
  Object.assign(w.stats, data.stats);
  w.players.push(...data.players);
  for (const b of [...data.buildings].sort((a, b) => a.id - b.id)) w.buildings.set(b.id, b);
  for (const s of data.settlers) {
    w.settlers.push(s);
    w.settlerById.set(s.id, s);
  }
  for (const i of data.reservedTargets) w.reservedTargets.add(i);
  for (const i of data.reservedPlots) w.reservedPlots.add(i);
  w.ai.push(...data.ai);
  w.defeated.push(...data.defeated);
  w.animals.push(...data.animals);
  w.nextAnimalId = data.nextAnimalId;
  w.animalRng.state = data.animalRngState;
  w.idleRng.state = data.idleRngState;
  w.pendingCommands.push(...(data.commands ?? []));
  w.nextCommandSeq = data.commandSeq ?? 0;
  w.rules = data.rules;
  w.result = data.result;
}
