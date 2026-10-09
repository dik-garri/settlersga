/**
 * Stopping a building or a site, as in Settlers 4 (`IBuildingRole::Switch`, `CBuildingSiteRole::Switch`,
 * network command 5003, entity flag 4096; the S4ModApi's `ToggleBuildingHalt`):
 * - a stopped workplace (workshop, gatherer, mine, farm, ranch, barracks) finishes the cycle it is in
 *   and starts no new one (`updateBuilding`; a gatherer, farmer, forester or hunter stays in, `idle`
 *   in settlers.ts; a barracks pauses its training); its demand is 0 and, once idle, the goods
 *   in its input piles are offered to others like any pile (`CDeliverPileRole::SubjectStopped`:
 *   `offered`, `takeOffered`) — for sites and workshops that want them, else for a warehouse;
 * - a stopped site sends its builders and diggers away (`leaveSite`), is skipped when they look for
 *   work, asks for no material (`CEcoSector::CleanUpBuildingNeed`) and offers what lies at it, not yet
 *   built in (`CBuildingSitePileRole::SubjectStopped`);
 * - a stopped warehouse takes nothing in (`CStorageBuildingRole::Switch` unregisters it as storage)
 *   but still gives out its stock; a stopped market sends no donkeys and takes no orders' goods in.
 * Carriers on their way to bring it something drop the job (S4 notifies them that their target died:
 * the good is put down on the ground, `abort`); a warehouse's carriers turn to another warehouse.
 * Houses keep releasing their people (S4's residence ignores the flag); military buildings have no
 * such command.
 */
import { BUILDINGS } from './config';
import { redirectDeliveries } from './economy';
import { sitePile } from './logistics';
import { abort } from './settlers';
import { RESOURCES, type Building, type PlayerId, type Resource } from './types';
import type { World } from './world';

/** Whether the player may stop this building: any site, a workplace, a warehouse or a market. */
export function canStop(b: Building): boolean {
  const def = BUILDINGS[b.type];
  if (!def.playerBuildable) return false;
  return !b.done || def.worker !== null || !!def.storage || !!def.market;
}

/** Player command: stop (`on`) or restart a building or site. */
export function setStopped(w: World, id: number, on: boolean, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !canStop(b)) return false;
  if (!!b.stopped === on) return true;
  if (!on) {
    // Restarted: what still lies at it is its own again (S4's `SubjectStarted`); carriers already on
    // their way to take some of it find it gone and drop that job (`takeOffered`).
    delete b.stopped;
    return true;
  }
  b.stopped = true;
  const def = BUILDINGS[b.type];
  if (def.storage) {
    for (const r of RESOURCES) if (b.inbound[r] > 0) redirectDeliveries(w, b, r);
  }
  // Builders and diggers leave; carriers bringing goods and donkeys coming to load drop the job (a
  // warehouse's carriers were turned to another one above, or else finish: stored rather than lost).
  const drops = !def.storage;
  for (const s of w.settlers) {
    if (s.owner !== player || w.dying.has(s.id)) continue;
    const hit = s.tasks.some(
      (t) => 'b' in t && t.b === id && (t.t === 'build' || t.t === 'dig' || t.t === 'load' || (drops && t.t === 'drop')),
    );
    if (hit) abort(w, s);
  }
  b.builderIds = [];
  b.diggerIds = [];
  return true;
}

/**
 * Units of `res` at the building a carrier may come for: its output pile, plus — while it is stopped
 * and between cycles — its input piles (a market's minus what donkeys are coming to load) or, for a
 * site, the material lying at it, not yet built in. Minus what is already promised (`outReserved`).
 */
export function offered(b: Building, res: Resource): number {
  return b.output[res] + stoppedPile(b, res) - b.outReserved[res];
}

/** What a stopped building offers besides its output pile. */
function stoppedPile(b: Building, res: Resource): number {
  if (!b.stopped) return 0;
  if (!b.done) return sitePile(b, res);
  const def = BUILDINGS[b.type];
  if (def.storage) return 0;
  // A workshop finishes the cycle it is in first; a barracks' training just pauses.
  if (b.timer > 0 && !def.barracks) return 0;
  return Math.max(0, b.input[res] - (b.trade?.loading[res] ?? 0));
}

/** A carrier at the door takes one unit of `res` (the output pile first); false if none is there. */
export function takeOffered(b: Building, res: Resource): boolean {
  if (b.output[res] > 0) {
    b.output[res]--;
    return true;
  }
  if (stoppedPile(b, res) <= 0) return false;
  // A site's material goes back to "not delivered": it is needed again once the site restarts.
  if (!b.done) b.delivered[res]--;
  else b.input[res]--;
  return true;
}
