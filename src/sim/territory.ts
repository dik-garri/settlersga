import { BUILDINGS, TERRITORY } from './config';
import { centerOf, claimsTerritory } from './buildings';
import type { Building, PlayerId, Point } from './types';
import type { World } from './world';

/**
 * Who owns the land, as Settlers 4's `CWorldManager::SetOwner` decides it. `map.owner` is real,
 * saved state, not a picture rebuilt from the buildings: land stays its owner's when the tower that
 * claimed it goes (demolished, burnt, conquered, left empty). Every claiming building
 * (`claimsTerritory`) gives each tile of its disc an influence of `TERRITORY.influence −
 * TERRITORY.perTile × distance` (S4: 50 − distance in its tiles; ours are ≈ 3 of them), summed per
 * player up to `TERRITORY.cap`. A tile changes hands only when it is nobody's or its owner has no
 * influence on it any more; then the player with the greatest influence takes it (ties: the lower
 * player id). So a new tower does not take foreign land a foreign tower still covers ("the border runs
 * between the towers"), and a conquered one takes only what its former owner covers no more. A
 * building whose tile changes hands burns (S4 destroys it, `CBuildingMgr::DestroyBuilding`), except
 * that a claiming building always keeps its own footprint and door (S4 gives its own tile the top
 * influence). Pioneers' land (`specialists.ts`) has no influence, so a tower always takes it.
 *
 * Work is local: whenever a building starts or stops claiming, changes owner or goes (`claimChanged`),
 * only the tiles of its disc are settled again, against the claiming buildings whose discs reach them.
 */

interface Claimer {
  c: Point;
  r: number;
  owner: PlayerId;
}

/** Influence of a claiming building at distance `d` of its centre (inside its disc: always ≥ 1). */
function influence(d: number): number {
  return Math.max(1, TERRITORY.influence - TERRITORY.perTile * d);
}

/** Claiming buildings whose disc reaches within `r` of (cx, cy). */
function claimersNear(w: World, cx: number, cy: number, r: number): Claimer[] {
  const out: Claimer[] = [];
  for (const b of w.buildings.values()) {
    const rb = BUILDINGS[b.type].territory;
    if (!rb || !claimsTerritory(b)) continue;
    const c = centerOf(b);
    if (Math.hypot(c.x - cx, c.y - cy) <= r + rb) out.push({ c, r: rb, owner: b.owner });
  }
  return out;
}

/** Scratch per-player influence sums, indexed by player id. */
let sums = new Float64Array(9);

/**
 * Settles the ownership of every tile within `r` of (cx, cy) (S4 `SetOwner`, see above). Bumps
 * `territoryVersion` if anything changed and burns buildings standing on land that changed hands.
 */
export function settleTerritory(w: World, cx: number, cy: number, r: number): void {
  const m = w.map;
  const claimers = claimersNear(w, cx, cy, r);
  if (sums.length < w.players.length + 1) sums = new Float64Array(w.players.length + 1);
  const lost = new Set<number>();
  let changed = false;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(m.h - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(m.w - 1, Math.ceil(cx + r)); x++) {
      if (Math.hypot(x - cx, y - cy) > r) continue;
      sums.fill(0);
      for (const cl of claimers) {
        const d = Math.hypot(x - cl.c.x, y - cl.c.y);
        if (d <= cl.r) sums[cl.owner] = Math.min(TERRITORY.cap, sums[cl.owner] + influence(d));
      }
      let best = 0;
      for (let p = 1; p < sums.length; p++) if (sums[p] > sums[best]) best = p;
      if (best === 0) continue; // nobody's influence: the tile stays whose it is
      const i = m.idx(x, y);
      const cur = m.owner[i];
      if (cur === best || (cur !== 0 && sums[cur] > 0)) continue;
      m.owner[i] = best;
      changed = true;
      const id = m.building[i] || m.door[i];
      if (id > 0) lost.add(id);
    }
  }
  // A claiming building keeps its own footprint and door, whatever covers them.
  for (const b of w.buildings.values()) {
    if (!BUILDINGS[b.type].territory || !claimsTerritory(b)) continue;
    const c = centerOf(b);
    if (Math.hypot(c.x - cx, c.y - cy) > r + Math.max(b.w, b.h) + 1) continue;
    for (const i of tilesOf(w, b)) {
      if (m.owner[i] === b.owner) continue;
      m.owner[i] = b.owner;
      changed = true;
    }
  }
  if (changed) w.territoryVersion++;
  for (const id of [...lost].sort((a, b) => a - b)) {
    const o = w.buildings.get(id);
    if (o && onLostLand(w, o)) w.removeBuilding(o, 'burn');
  }
}

/** Footprint and door tiles of a building. */
function tilesOf(w: World, b: Building): number[] {
  const m = w.map;
  const out: number[] = [];
  for (let dy = 0; dy < b.h; dy++) for (let dx = 0; dx < b.w; dx++) out.push(m.idx(b.x + dx, b.y + dy));
  out.push(m.idx(b.door.x, b.door.y));
  return out;
}

/** A tile of its footprint or its door belongs to another player now. */
function onLostLand(w: World, b: Building): boolean {
  return tilesOf(w, b).some((i) => w.map.owner[i] !== b.owner);
}

/**
 * A building started or stopped claiming land, changed owner or is gone (call it after removing it):
 * settles its disc again.
 */
export function claimChanged(w: World, b: Building): void {
  const r = BUILDINGS[b.type].territory;
  if (!r) return;
  const c = centerOf(b);
  settleTerritory(w, c.x, c.y, r);
}

/** Settles the disc of every claiming building, in id order (a new world, the dev showcase, tests). */
export function recomputeTerritory(w: World): void {
  for (const b of [...w.buildings.values()]) if (w.buildings.has(b.id) && claimsTerritory(b)) claimChanged(w, b);
  w.territoryVersion++;
}

/** A defeated player's land goes back to nobody (an O(map) pass, once per defeat). */
export function clearLand(w: World, player: PlayerId): void {
  const owner = w.map.owner;
  let changed = false;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] !== player) continue;
    owner[i] = 0;
    changed = true;
  }
  if (changed) w.territoryVersion++;
}
