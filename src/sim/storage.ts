import { BUILDINGS, type StorageDef } from './config';
import { RESOURCES, type Building, type Resource } from './types';

/**
 * Warehouse capacity (`BuildingDef.storage`, a `StorageDef`). A warehouse stacks its goods on `piles`
 * piles of up to `perPile` units of one good each — a good may fill several piles — and/or holds at
 * most `units` units in all; a def with neither limit holds any amount.
 *
 * Goods count from the moment a carrier is sent with them (`inbound`), so carriers never all head for
 * one warehouse and a delivery always finds room on arrival. Where nothing has room, surplus waits at
 * its producer (whose full pile pauses it, as with `RESOURCE_INFO.storeLimit`); only goods already in a
 * carrier's hands may be put down beyond the limit (`carryBack`), so nothing is lost.
 */

/** Units of `res` lying in the warehouse or on their way there. */
const held = (b: Building, res: Resource) => Math.max(0, b.output[res] + b.inbound[res]);

/** Piles the goods (held and inbound) take: per good, full piles plus one started. */
export function pilesUsed(b: Building, def: StorageDef): number {
  const per = def.perPile ?? Infinity;
  let used = 0;
  for (const r of RESOURCES) {
    const n = held(b, r);
    if (n > 0) used += Math.ceil(n / per);
  }
  return used;
}

/** Units held and inbound in all. */
export function unitsHeld(b: Building): number {
  let n = 0;
  for (const r of RESOURCES) n += held(b, r);
  return n;
}

/** Whether the warehouse type has any limit. */
export function isLimited(def: StorageDef | undefined): def is StorageDef {
  return !!def && (def.piles !== undefined || def.units !== undefined);
}

/** Units the building's whole stock may reach (Infinity without a limit). */
export function capacityOf(def: StorageDef | undefined): number {
  if (!isLimited(def)) return Infinity;
  const byPiles = def.piles !== undefined ? def.piles * (def.perPile ?? Infinity) : Infinity;
  return Math.min(byPiles, def.units ?? Infinity);
}

/**
 * Units of `res` the warehouse can still be sent: what fits on its started pile of that good and on
 * its free piles, and within its total. Infinity for an unlimited one; 0 for a non-warehouse.
 */
export function storageRoom(b: Building, res: Resource): number {
  const def = BUILDINGS[b.type].storage;
  if (!def) return 0;
  if (!isLimited(def)) return Infinity;
  let room = Infinity;
  if (def.piles !== undefined) {
    const per = def.perPile ?? Infinity;
    const n = held(b, res);
    const started = per === Infinity || n === 0 ? 0 : Math.ceil(n / per) * per - n;
    room = Math.max(0, def.piles - pilesUsed(b, def)) * per + started;
  }
  if (def.units !== undefined) room = Math.min(room, def.units - unitsHeld(b));
  return Math.max(0, room);
}

/** How full the warehouse is, for the building window: units and piles used against the limits. */
export function storageFill(b: Building): { units: number; capacity: number; piles?: number; maxPiles?: number } {
  const def = BUILDINGS[b.type].storage;
  let units = 0;
  for (const r of RESOURCES) units += Math.max(0, b.output[r]);
  const fill: { units: number; capacity: number; piles?: number; maxPiles?: number } = { units, capacity: capacityOf(def) };
  if (def?.piles !== undefined) {
    const per = def.perPile ?? Infinity;
    let piles = 0;
    for (const r of RESOURCES) if (b.output[r] > 0) piles += Math.ceil(b.output[r] / per);
    fill.piles = piles;
    fill.maxPiles = def.piles;
  }
  return fill;
}
