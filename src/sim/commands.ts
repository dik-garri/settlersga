/**
 * The command layer (roadmap phase 6, step 1): every change a player — human, computer or a mission
 * script — makes to the world is a `Command`, a plain-JSON record (ids, coordinates, numbers,
 * strings) applied by `World.apply`. Lockstep network play is to exchange exactly these records, and
 * a game can be replayed from its seed, its setup and the log of applied commands (`replay.ts`).
 *
 * Each kind has one entry in `SPECS`: how to check its fields (a command from the network is
 * untrusted data), what it returns when refused, and what it does. A command that fails the checks
 * — a malformed field, an unknown player — is refused without touching the world; one that passes
 * runs its handler, which refuses stale or foreign targets itself (a building that is gone, another
 * player's building) the same way on every machine. The mapped types make the table exhaustive: a
 * new kind without its checks or its handler is a compile error.
 */
import { createAi } from './ai';
import { addBuilding, doorOf } from './buildings';
import { BUILDINGS, OUTPUT_SHARES, PROFESSIONS, SITE } from './config';
import { levelTarget, needsDigger, needsLevelling } from './digging';
import {
  ENDLESS,
  moveTransport,
  orderRecruits,
  orderTool,
  orderWorkers,
  reduceRecruits,
  setAccepts,
  setCarrierReserve,
  setDistribution,
  type TransportMove,
} from './economy';
import { orderAttack, orderGarrison, orderHold, orderMove, releaseFighters } from './field';
import { dropGoods } from './ground';
import { landOf } from './land';
import { attack, changeGarrison, fillGarrison, withdrawGarrison } from './military';
import { findPath } from './pathfinding';
import { abort } from './settlers';
import {
  dismissSpecialist,
  dismissUnits,
  holdSpecialists,
  orderSpecialists,
  sendGeologist,
  sendPioneer,
  sendSaboteur,
  sendThief,
} from './specialists';
import { setStopped } from './stop';
import { RESOURCES, type Building, type BuildingType, type PlayerId, type Point, type Resource, type SettlerKind } from './types';
import { setWorkArea } from './workArea';
import type { World } from './world';

/** The arguments of every command kind (besides `kind` and `player`). */
export interface CommandArgs {
  /** Lay out a construction site (footprint top-left corner). */
  placeBuilding: { type: BuildingType; x: number; y: number };
  /** Tear a building or site down. */
  demolish: { id: number };
  /** Serve this building first (hard for sites, `SITE`). */
  setPriority: { id: number; on: boolean };
  /** Stop or restart a workplace, warehouse, market or site (`stop.ts`). */
  setStopped: { id: number; on: boolean };
  /** Whether a warehouse takes in a good. */
  setAccepts: { id: number; res: Resource; on: boolean };
  /** Move a work area's centre, or back to the door with null (`workArea.ts`). */
  setWorkArea: { id: number; at: Point | null };
  /** A market's route to another market of the player, or none. */
  setTradeRoute: { id: number; to: number | null };
  /** Send `count` more of a good along a market's route (`ENDLESS`, 0 cancels). */
  orderTrade: { id: number; res: Resource; count: number };
  /** How many builders, diggers or specialists (`ORDERABLE`) to have in all. */
  orderWorkers: { prof: SettlerKind; count: number };
  /** An idle specialist of the kind turns back into a carrier. */
  dismissSpecialist: { prof: SettlerKind };
  /** Carriers kept free (`CARRIER_RESERVE`). */
  setCarrierReserve: { count: number };
  /** Move a good in the transport priority. */
  moveTransport: { res: Resource; how: TransportMove };
  /** Queue tools at the toolsmiths (`ENDLESS`, 0 clears). */
  orderTool: { res: Resource; count: number };
  /** Weight of a consumer type in the distribution of a good. */
  setDistribution: { res: Resource; type: BuildingType; weight: number };
  /** Weight of a share-controlled output (`OUTPUT_SHARES`). */
  setShare: { res: Resource; weight: number };
  /** More recruits of a fighting profession at a level (`ENDLESS`, 0 clears). */
  orderRecruits: { prof: SettlerKind; level: number; count: number };
  /** Fewer recruits ordered. */
  reduceRecruits: { prof: SettlerKind; level: number; count: number };
  /** A military building calls fighters in for every slot. */
  fillGarrison: { id: number };
  /** One fighter of a kind more or fewer wished in a military building. */
  changeGarrison: { id: number; archer: boolean; delta: number };
  /** A military building keeps one fighter, the rest step out. */
  withdrawGarrison: { id: number };
  /** Spare fighters of a military building step out as field units. */
  releaseFighters: { id: number; count: number };
  /** Spare fighters in range attack an enemy military building. */
  attack: { target: number; count: number };
  /** Field units move to a point in formation. */
  orderMove: { ids: number[]; x: number; y: number };
  /** Field units hold where they stand. */
  orderHold: { ids: number[] };
  /** Field units attack an enemy military building. */
  orderAttack: { ids: number[]; target: number };
  /** Fighters go into a garrison (null: the nearest with room). */
  orderGarrison: { ids: number[]; target: number | null };
  /** The nearest free geologist examines the mountain round a point. */
  sendGeologist: { x: number; y: number };
  /** The nearest free pioneer claims land round a point. */
  sendPioneer: { x: number; y: number };
  /** An idle thief robs a foreign building. */
  sendThief: { target: number };
  /** An idle saboteur attacks an enemy building (network games only). */
  sendSaboteur: { target: number };
  /** Selected specialists act at a point (on a building), or just walk there. */
  orderSpecialists: { ids: number[]; x: number; y: number; target: number | null; walkOnly: boolean };
  /** Selected specialists stop and wait where they stand. */
  holdSpecialists: { ids: number[] };
  /** Selected specialists on own land turn back into carriers. */
  dismissUnits: { ids: number[] };
  /** Scenario/host command (missions): goods laid on the ground by the player's home. */
  grant: { res: Resource; n: number };
  /**
   * Network command (Settlers 4's `SetPlayerControl` + `ActivatePlayerAI`): the computer takes over
   * the player, whose human left the game. Given by every machine at the turn the host announced.
   */
  aiTakeover: Record<never, never>;
}

/** What each kind returns: success, how many obeyed, or the new site. */
export interface CommandResults {
  placeBuilding: Building | null;
  demolish: boolean;
  setPriority: boolean;
  setStopped: boolean;
  setAccepts: boolean;
  setWorkArea: boolean;
  setTradeRoute: boolean;
  orderTrade: boolean;
  orderWorkers: boolean;
  dismissSpecialist: boolean;
  setCarrierReserve: boolean;
  moveTransport: boolean;
  orderTool: boolean;
  setDistribution: boolean;
  setShare: boolean;
  orderRecruits: boolean;
  reduceRecruits: boolean;
  fillGarrison: boolean;
  changeGarrison: boolean;
  withdrawGarrison: boolean;
  releaseFighters: number;
  attack: number;
  orderMove: number;
  orderHold: number;
  orderAttack: number;
  orderGarrison: number;
  sendGeologist: boolean;
  sendPioneer: boolean;
  sendThief: boolean;
  sendSaboteur: boolean;
  orderSpecialists: number;
  holdSpecialists: number;
  dismissUnits: number;
  grant: boolean;
  aiTakeover: boolean;
}

export type CommandKind = keyof CommandArgs;

/** What every command carries: who gives it, and (when scheduled) the tick and order it applies in. */
export interface CommandHead<K extends CommandKind = CommandKind> {
  kind: K;
  player: PlayerId;
  /** Scheduled commands: applied once the world has run this many ticks (`World.schedule`). */
  tick?: number;
  /** Scheduled commands: order among one player's commands of one tick (given by `schedule` if absent). */
  seq?: number;
}

export type CommandOf<K extends CommandKind> = CommandHead<K> & CommandArgs[K];
/** Any command: a discriminated union over `kind`. */
export type Command = { [K in CommandKind]: CommandOf<K> }[CommandKind];
export type CommandResult<K extends CommandKind> = CommandResults[K];

/**
 * An applied command as the log keeps it (`World.commandLog`): the world's tick when it was applied
 * and whether a computer player gave it while thinking inside `step()` (`ai`) — every other command
 * is applied between two ticks, i.e. before the step that follows tick `tick`.
 */
export interface CommandRecord {
  tick: number;
  ai?: true;
  cmd: Command;
}

// ------------------------------------------------------------------ field checks

type Check = (v: unknown) => boolean;

const isInt: Check = (v) => typeof v === 'number' && Number.isSafeInteger(v);
const isNum: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const isBool: Check = (v) => typeof v === 'boolean';
const isRes: Check = (v) => typeof v === 'string' && (RESOURCES as readonly string[]).includes(v);
const isType: Check = (v) => typeof v === 'string' && Object.hasOwn(BUILDINGS, v);
const isProf: Check = (v) => typeof v === 'string' && Object.hasOwn(PROFESSIONS, v);
const isMove: Check = (v) => v === 'up' || v === 'down' || v === 'top' || v === 'bottom';
const isIdOrNull: Check = (v) => v === null || isInt(v);
const isPointOrNull: Check = (v) =>
  v === null || (typeof v === 'object' && !Array.isArray(v) && isNum((v as Point).x) && isNum((v as Point).y));
/** Most units one order may name (S4 selects at most 100; the AI's squads stay far below this). */
export const MAX_ORDER_IDS = 5000;
const isIds: Check = (v) => Array.isArray(v) && v.length <= MAX_ORDER_IDS && v.every(isInt);

// ------------------------------------------------------------------ handlers

interface Spec<K extends CommandKind> {
  fields: { [F in keyof CommandArgs[K]]-?: Check };
  /** The result of a refused command. */
  refused: CommandResults[K];
  run: (w: World, c: CommandOf<K>) => CommandResults[K];
  /**
   * What the interface is told when the order is sent ahead instead of applied (lockstep network
   * play: it applies a few ticks later on every machine): a quick check that it may well succeed.
   * Default: success, or for a count the units named (`ids`, `count`).
   */
  ahead?: (w: World, c: CommandOf<K>) => IssueResult<K>;
}

export const SPECS: { [K in CommandKind]: Spec<K> } = {
  placeBuilding: {
    fields: { type: isType, x: isInt, y: isInt },
    refused: null,
    run: (w, c) => placeBuilding(w, c.type, c.x, c.y, c.player),
    ahead: (w, c) => !!BUILDINGS[c.type].playerBuildable && w.canPlace(c.type, c.x, c.y, c.player),
  },
  demolish: { fields: { id: isInt }, refused: false, run: (w, c) => demolish(w, c.id, c.player) },
  setPriority: { fields: { id: isInt, on: isBool }, refused: false, run: (w, c) => setPriority(w, c.id, c.on, c.player) },
  setStopped: { fields: { id: isInt, on: isBool }, refused: false, run: (w, c) => setStopped(w, c.id, c.on, c.player) },
  setAccepts: { fields: { id: isInt, res: isRes, on: isBool }, refused: false, run: (w, c) => setAccepts(w, c.player, c.id, c.res, c.on) },
  setWorkArea: {
    fields: { id: isInt, at: isPointOrNull },
    refused: false,
    run: (w, c) => setWorkArea(w, c.id, c.at && { x: c.at.x, y: c.at.y }, c.player),
  },
  setTradeRoute: { fields: { id: isInt, to: isIdOrNull }, refused: false, run: (w, c) => setTradeRoute(w, c.id, c.to, c.player) },
  orderTrade: { fields: { id: isInt, res: isRes, count: isNum }, refused: false, run: (w, c) => orderTrade(w, c.id, c.res, c.count, c.player) },
  orderWorkers: { fields: { prof: isProf, count: isNum }, refused: false, run: (w, c) => orderWorkers(w, c.player, c.prof, c.count) },
  dismissSpecialist: { fields: { prof: isProf }, refused: false, run: (w, c) => dismissSpecialist(w, c.prof, c.player) },
  setCarrierReserve: { fields: { count: isNum }, refused: false, run: (w, c) => setCarrierReserve(w, c.player, c.count) },
  moveTransport: { fields: { res: isRes, how: isMove }, refused: false, run: (w, c) => moveTransport(w, c.player, c.res, c.how) },
  orderTool: { fields: { res: isRes, count: isNum }, refused: false, run: (w, c) => orderTool(w, c.player, c.res, c.count) },
  setDistribution: {
    fields: { res: isRes, type: isType, weight: isNum },
    refused: false,
    run: (w, c) => setDistribution(w, c.player, c.res, c.type, c.weight),
  },
  setShare: { fields: { res: isRes, weight: isNum }, refused: false, run: (w, c) => setShare(w, c.res, c.weight, c.player) },
  orderRecruits: {
    fields: { prof: isProf, level: isInt, count: isNum },
    refused: false,
    run: (w, c) => orderRecruits(w, c.player, c.prof, c.level, c.count),
  },
  reduceRecruits: {
    fields: { prof: isProf, level: isInt, count: isNum },
    refused: false,
    run: (w, c) => reduceRecruits(w, c.player, c.prof, c.level, c.count),
  },
  fillGarrison: { fields: { id: isInt }, refused: false, run: (w, c) => fillGarrison(w, c.id, c.player) },
  changeGarrison: {
    fields: { id: isInt, archer: isBool, delta: isInt },
    refused: false,
    run: (w, c) => changeGarrison(w, c.id, c.archer, c.delta, c.player),
  },
  withdrawGarrison: { fields: { id: isInt }, refused: false, run: (w, c) => withdrawGarrison(w, c.id, c.player) },
  releaseFighters: { fields: { id: isInt, count: isNum }, refused: 0, run: (w, c) => releaseFighters(w, c.id, c.count, c.player) },
  attack: { fields: { target: isInt, count: isNum }, refused: 0, run: (w, c) => attack(w, c.target, c.count, c.player) },
  orderMove: { fields: { ids: isIds, x: isInt, y: isInt }, refused: 0, run: (w, c) => orderMove(w, c.ids, c.x, c.y, c.player) },
  orderHold: { fields: { ids: isIds }, refused: 0, run: (w, c) => orderHold(w, c.ids, c.player) },
  orderAttack: { fields: { ids: isIds, target: isInt }, refused: 0, run: (w, c) => orderAttack(w, c.ids, c.target, c.player) },
  orderGarrison: { fields: { ids: isIds, target: isIdOrNull }, refused: 0, run: (w, c) => orderGarrison(w, c.ids, c.target, c.player) },
  sendGeologist: { fields: { x: isInt, y: isInt }, refused: false, run: (w, c) => sendGeologist(w, c.x, c.y, c.player) },
  sendPioneer: { fields: { x: isInt, y: isInt }, refused: false, run: (w, c) => sendPioneer(w, c.x, c.y, c.player) },
  sendThief: { fields: { target: isInt }, refused: false, run: (w, c) => sendThief(w, c.target, c.player) },
  sendSaboteur: { fields: { target: isInt }, refused: false, run: (w, c) => sendSaboteur(w, c.target, c.player) },
  orderSpecialists: {
    fields: { ids: isIds, x: isInt, y: isInt, target: isIdOrNull, walkOnly: isBool },
    refused: 0,
    run: (w, c) => orderSpecialists(w, c.ids, c.x, c.y, c.target, c.player, c.walkOnly),
  },
  holdSpecialists: { fields: { ids: isIds }, refused: 0, run: (w, c) => holdSpecialists(w, c.ids, c.player) },
  dismissUnits: { fields: { ids: isIds }, refused: 0, run: (w, c) => dismissUnits(w, c.ids, c.player) },
  grant: { fields: { res: isRes, n: isNum }, refused: false, run: (w, c) => grant(w, c.res, c.n, c.player) },
  aiTakeover: { fields: {}, refused: false, run: (w, c) => aiTakeover(w, c.player) },
};

/**
 * Kinds a player's batch from the network may not carry: the scenario's `grant` and the takeover,
 * which every machine gives itself at the turn the host announces (`net/match.ts`).
 */
export const LOCAL_ONLY: ReadonlySet<CommandKind> = new Set<CommandKind>(['grant', 'aiTakeover']);

/**
 * What `World.issue` returns to the interface: a count for the kinds that count (units that obeyed),
 * else whether it worked (`placeBuilding`'s new site is not handed out: sent ahead over the network
 * it does not exist yet).
 */
export type IssueResult<K extends CommandKind> = CommandResults[K] extends number ? number : boolean;

/** An applied command's result as `issue` gives it. */
export function issueResult<K extends CommandKind>(r: CommandResults[K]): IssueResult<K> {
  return (typeof r === 'number' ? r : r !== null && r !== false) as IssueResult<K>;
}

/** What `issue` tells the interface of a valid command sent ahead (`Spec.ahead`). */
export function aheadResult<K extends CommandKind>(w: World, cmd: CommandOf<K>): IssueResult<K> {
  const spec = SPECS[cmd.kind] as unknown as Spec<K>;
  if (spec.ahead) return spec.ahead(w, cmd);
  if (typeof spec.refused !== 'number') return true as IssueResult<K>;
  const c = cmd as unknown as { ids?: number[]; count?: number };
  return (c.ids ? c.ids.length : typeof c.count === 'number' ? c.count : 1) as IssueResult<K>;
}

export const COMMAND_KINDS = Object.keys(SPECS) as CommandKind[];

/**
 * Whether a command is well-formed for this world: a known kind, an existing player, every field of
 * the right type (`SPECS`), the head's `tick`/`seq` whole numbers if present. Pure.
 */
export function commandValid(w: World, cmd: unknown): cmd is Command {
  if (typeof cmd !== 'object' || cmd === null || Array.isArray(cmd)) return false;
  const c = cmd as Record<string, unknown>;
  if (typeof c.kind !== 'string' || !Object.hasOwn(SPECS, c.kind)) return false;
  if (!isInt(c.player) || (c.player as number) < 1 || (c.player as number) > w.players.length) return false;
  if (c.tick !== undefined && !isInt(c.tick)) return false;
  if (c.seq !== undefined && !isInt(c.seq)) return false;
  const fields = SPECS[c.kind as CommandKind].fields as Record<string, Check>;
  for (const f in fields) if (!fields[f](c[f])) return false;
  return true;
}

/** What a refused command of this kind returns (false, 0 or null; `undefined` for an unknown kind). */
export function refusedResult(cmd: unknown): unknown {
  const kind = (cmd as { kind?: unknown } | null)?.kind;
  return typeof kind === 'string' && Object.hasOwn(SPECS, kind) ? SPECS[kind as CommandKind].refused : undefined;
}

/** Runs a valid command's handler. */
export function runCommand(w: World, cmd: Command): unknown {
  return (SPECS[cmd.kind] as Spec<CommandKind>).run(w, cmd as CommandOf<CommandKind>);
}

/**
 * A copy of a valid command holding only its own fields (the head and `SPECS` fields, arrays and
 * points copied), so the log never shares an array the caller may change later.
 */
export function copyCommand(cmd: Command): Command {
  const out: Record<string, unknown> = { kind: cmd.kind, player: cmd.player };
  if (cmd.tick !== undefined) out.tick = cmd.tick;
  if (cmd.seq !== undefined) out.seq = cmd.seq;
  const src = cmd as unknown as Record<string, unknown>;
  for (const f in SPECS[cmd.kind].fields) {
    const v = src[f];
    out[f] = Array.isArray(v) ? v.slice() : v !== null && typeof v === 'object' ? { ...v } : v;
  }
  return out as unknown as Command;
}

/** Scheduled commands apply in this order: by tick, then player, then sequence. */
export function commandOrder(a: Command, b: Command): number {
  return (a.tick ?? 0) - (b.tick ?? 0) || a.player - b.player || (a.seq ?? 0) - (b.seq ?? 0);
}

// ------------------------------------------------------------------ handlers living here

/** Player command: lay out a construction site (`World.placeBuilding`). */
function placeBuilding(w: World, type: BuildingType, x: number, y: number, player: PlayerId): Building | null {
  if (!BUILDINGS[type].playerBuildable || !w.canPlace(type, x, y, player)) return null;
  const def = BUILDINGS[type];
  const door = doorOf(x, y, def.w, def.h);
  // Reachable from where the player started (unless something now stands there).
  const from = w.homeOf(player);
  if (w.map.isWalkable(from.x, from.y) && !findPath(w.map, from.x, from.y, door.x, door.y)) return null;
  const b = addBuilding(w, type, x, y, player, false);
  if (needsDigger(type)) {
    // Diggers clear every site first (and flatten a sloped one); carriers bring materials once one is on his way.
    b.levelled = false;
    b.levelTo = needsLevelling(w.map, type, x, y) ? levelTarget(w.map, b) : -1;
  }
  return b;
}

/** Player command: tear down one of the player's buildings (`World.demolish`). */
function demolish(w: World, id: number, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player || !BUILDINGS[b.type].playerBuildable) return false;
  w.removeBuilding(b, 'demolish');
  return true;
}

/** Player command: serve this building first (`World.setPriority`). */
function setPriority(w: World, id: number, on: boolean, player: PlayerId): boolean {
  const b = w.buildings.get(id);
  if (!b || b.owner !== player) return false;
  if (on && !b.priority && !b.done) {
    const piece = landOf(w, b);
    let n = 0;
    for (const o of w.buildings.values()) if (o.owner === player && o.priority && !o.done && landOf(w, o) === piece) n++;
    if (n >= SITE.maxPriority) return false;
  }
  b.priority = on;
  return true;
}

/** Player command: a share-controlled output's weight (`World.setShare`). */
function setShare(w: World, res: Resource, weight: number, player: PlayerId): boolean {
  const p = w.players.find((q) => q.id === player);
  if (!p || OUTPUT_SHARES[res] === undefined || !Number.isFinite(weight)) return false;
  p.shares = { ...p.shares, [res]: Math.max(0, Math.min(100, Math.round(weight))) };
  return true;
}

/** Player command: a market's route (`World.setTradeRoute`). */
function setTradeRoute(w: World, id: number, to: number | null, player: PlayerId): boolean {
  const m = w.buildings.get(id);
  if (!m || m.owner !== player || !BUILDINGS[m.type].market) return false;
  if (to !== null) {
    const t = w.buildings.get(to);
    if (!t || t.id === id || t.owner !== player || !BUILDINGS[t.type].market) return false;
  }
  m.trade ??= { to: null, orders: {}, loading: {} };
  m.trade.to = to;
  return true;
}

/** Player command: a market's order of a good (`World.orderTrade`). */
function orderTrade(w: World, id: number, res: Resource, count: number, player: PlayerId): boolean {
  const m = w.buildings.get(id);
  if (!m || m.owner !== player || !BUILDINGS[m.type].market || !RESOURCES.includes(res)) return false;
  m.trade ??= { to: null, orders: {}, loading: {} };
  const now = m.trade.orders[res] ?? 0;
  if (count === ENDLESS || count === 0) {
    if (count === 0) {
      delete m.trade.orders[res];
      // Carriers already bringing the good turn back (their load returns to a warehouse) —
      // otherwise it would keep arriving and sit on the market with nothing to take it away.
      for (const s of w.settlers) {
        if (s.owner === player && s.tasks.some((t) => t.t === 'drop' && t.b === id && t.res === res)) abort(w, s);
      }
      // What waits for a donkey goes on the output pile, so carriers take it back to a warehouse.
      const spare = m.input[res] - (m.trade.loading[res] ?? 0);
      if (spare > 0) {
        m.input[res] -= spare;
        m.output[res] += spare;
      }
    } else m.trade.orders[res] = ENDLESS;
  } else if (count > 0 && now !== ENDLESS) {
    m.trade.orders[res] = now + count;
  }
  return true;
}

/**
 * Network command: the computer plays the player from now on (a fresh `AiState` of medium level, as
 * Settlers 4 hands a departed player's seat to its AI). Refused for a computer player already and
 * for a defeated one (S4 activates the AI only for a player still alive).
 */
function aiTakeover(w: World, player: PlayerId): boolean {
  if (w.ai.some((a) => a.player === player) || w.isDefeated(player)) return false;
  w.ai.push(createAi(player, 'medium'));
  return true;
}

/** Scenario command: goods by the player's home (`World.grant`). */
function grant(w: World, res: Resource, n: number, player: PlayerId): boolean {
  const p = w.players[player - 1];
  if (!p || n <= 0 || !RESOURCES.includes(res)) return false;
  dropGoods(w, p.home, res, Math.floor(n));
  return true;
}
