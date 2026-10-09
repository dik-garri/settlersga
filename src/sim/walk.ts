import { OWN_LAND_WALK, PROFESSIONS } from './config';
import { landAt } from './land';
import { findPath, pathStats } from './pathfinding';
import type { Point, Settler } from './types';
import type { World } from './world';

/**
 * Routes for settlers, with Settlers 4's rule for workers (`OWN_LAND_WALK`): a carrier, builder,
 * digger, worker or hunter going from one tile of a piece of his land to another (`land.ts`) walks on
 * that piece only, never cutting across foreign or neutral land in between (S4's `CWalkingWorker`).
 *
 * Where S4 cannot get him anywhere else at all, we let him: a route to another piece (a carrier moved
 * to a piece with work, `relocate`), from or to a tile off his land (a stranded settler fleeing, a
 * tree or a deer just beyond the border), or one the piece itself does not hold (it is 8-connected
 * land, but water, rock or forest may cut it on our grid) is the plain A* route. Cost: the plain
 * search first; only when its route leaves his land, a second one bound to it, at most
 * `OWN_LAND_WALK.budget` + `perTile` × distance nodes (a failure counts in `pathStats.landFallbacks`).
 */
export function route(w: World, s: Settler, sx: number, sy: number, tx: number, ty: number, adj = false): Point[] | null {
  const m = w.map;
  const plain = findPath(m, sx, sy, tx, ty, adj);
  // The plain route is the land-bound one too when it never leaves his land (the usual case: then
  // it is a shortest route on the land as well), so a second search is needed only when it does.
  if (!plain || !OWN_LAND_WALK.behaviors.includes(PROFESSIONS[s.kind].behavior)) return plain;
  if (plain.every((p) => m.owner[m.idx(p.x, p.y)] === s.owner)) return plain;
  const piece = landAt(w, { x: sx, y: sy }, s.owner);
  if (piece === 0 || landAt(w, { x: tx, y: ty }, s.owner) !== piece) return plain;
  const d = Math.max(Math.abs(tx - sx), Math.abs(ty - sy));
  const budget = OWN_LAND_WALK.budget + OWN_LAND_WALK.perTile * d;
  const onLand = findPath(m, sx, sy, tx, ty, adj, true, { owner: m.owner, player: s.owner, budget });
  if (onLand) return onLand;
  pathStats.landFallbacks++;
  return plain;
}
