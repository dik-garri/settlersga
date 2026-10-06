import { GameMap } from './map';
import type { Building, Settler } from './types';
import type { Player, World } from './world';

/** Bump when the save layout changes incompatibly. */
export const SAVE_VERSION = 3;

const MAP_LAYERS = [
  'terrain',
  'tree',
  'stone',
  'crop',
  'fish',
  'ore',
  'oreAmount',
  'prospected',
  'owner',
  'building',
  'door',
] as const;
type MapLayer = (typeof MAP_LAYERS)[number];

/** Plain-JSON snapshot of the whole simulation. */
export interface SaveData {
  version: number;
  tick: number;
  nextId: number;
  rngState: number;
  territoryVersion: number;
  stats: World['stats'];
  players: Player[];
  map: { w: number; h: number } & Record<MapLayer, string>;
  buildings: Building[];
  settlers: Settler[];
  reservedTargets: number[];
  reservedPlots: number[];
}

function encode(a: Uint8Array | Int32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function decodeInto(text: string, target: Uint8Array | Int32Array): void {
  const bin = atob(text);
  const bytes = new Uint8Array(target.buffer, target.byteOffset, target.byteLength);
  if (bin.length !== bytes.length) throw new Error('corrupt save: map layer size mismatch');
  for (let i = 0; i < bytes.length; i++) bytes[i] = bin.charCodeAt(i);
}

export function saveWorld(w: World): SaveData {
  const map = { w: w.map.w, h: w.map.h } as SaveData['map'];
  for (const layer of MAP_LAYERS) map[layer] = encode(w.map[layer]);
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
  });
}

export function mapFromSave(data: SaveData): GameMap {
  if (data.version !== SAVE_VERSION) {
    throw new Error(`unsupported save version ${data.version}, expected ${SAVE_VERSION}`);
  }
  const map = new GameMap(data.map.w, data.map.h);
  for (const layer of MAP_LAYERS) decodeInto(data.map[layer], map[layer]);
  return map;
}

/** Copies everything except the map (built by `mapFromSave`) from the save into a fresh world. */
export function restoreWorld(w: World, raw: SaveData): void {
  const data = structuredClone(raw);
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
}
