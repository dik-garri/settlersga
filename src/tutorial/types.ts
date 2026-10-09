import type { StartLevel } from '../sim/config';
import type { ScenarioDef } from '../sim/scenario';
import type { BuildingType, PlayerId, Point, Resource, SettlerKind } from '../sim/types';
import type { World } from '../sim/world';
import type { Key } from '../ui/i18n';
import type { CommandId, Locks, MenuId } from '../ui/locks';
import type { UiTarget } from '../ui/uiTarget';

/**
 * The tutorial's data format (docs/TUTORIAL.md §3.2): a mission is plain data — its map, a scenario
 * start, the interface it opens, goals and a chain of steps with conditions. Conditions, anchors,
 * settings checks and interface checks are tagged unions whose kinds each have one entry in a table
 * (`CONDITIONS`, `ANCHORS`, `SETTINGS`, `UI_CHECKS`), so a new kind is a table entry and the compiler
 * demands it. Texts are dictionary keys (`Key`), checked by the compiler too.
 */

export type MissionId = 'forest' | 'logistics' | 'bread' | 'metal' | 'trade' | 'battle';

/** What fills a `{name}` placeholder in a step's text: a name looked up in the language, a number or a key. */
export type ParamSpec = { building: BuildingType } | { res: Resource } | { prof: SettlerKind } | { n: number } | { label: Key };

export interface MissionDef {
  id: MissionId;
  /** Dictionary keys of the title, the menu summary and the debrief («what you learnt»: lines split by \n). */
  title: Key;
  summary: Key;
  debrief: Key;
  world: { seed: number; size: number; players: number; ai?: PlayerId[]; start: StartLevel; fog: boolean };
  scenario?: ScenarioDef;
  /** What this mission opens (later missions inherit it; see `locksFor`). */
  unlock: Partial<Locks>;
  objectives: { text: Key; done: Condition; params?: Record<string, ParamSpec> }[];
  steps: StepDef[];
  /** The mission is won once every step is passed, every goal is met and this holds (default: true). */
  won?: Condition;
  /** Default: the player is defeated. */
  lost?: Condition;
  /** Settlers 4's top-ups (`Goods.AddPileEx`): whenever `res` falls below `below`, it is raised to `to`. */
  refill?: { res: Resource; below: number; to: number }[];
  /** Rough length in game minutes (the menu shows it; the test's budget is half as much again). */
  minutes: number;
  /** Not playable yet (shown in the menu as «coming»): its steps come in a later pass. */
  soon?: boolean;
}

export interface StepDef {
  id: string;
  /** The instruction and the explanation (the two parts of Settlers 4's tutorial window). */
  text: Key;
  more?: Key;
  params?: Record<string, ParamSpec>;
  /** Offered after this many game seconds in the step (or at once with the «Hint» button). */
  hint?: { text: Key; after: number };
  /** Highlight chain: the first element of it on the page that is not yet in use lights up. */
  ui?: UiTarget[];
  /** Where the camera goes on entering the step and with «Show». */
  camera?: Anchor;
  /** Arrows on the map, and a ring round an area. */
  marker?: Anchor[];
  ring?: { at: Anchor; r: number };
  done: Condition;
  /** Opened from this step on. */
  unlock?: Partial<Locks>;
  /** Goods laid down by the home when the step begins (`World.grant`). */
  grant?: { res: Resource; n: number }[];
}

/** A building state for `building` conditions. */
export type BuildState = 'site' | 'done' | 'any';

export type Condition =
  /** «Next» or Space. */
  | { k: 'ack' }
  /** Game seconds since the step began. */
  | { k: 'after'; s: number }
  | { k: 'building'; type: BuildingType; state?: BuildState; min?: number; near?: Anchor; r?: number; owner?: 'me' | 'enemy' }
  /** Units available to the player (`available`: ground and buildings); `relative` = above the mission's start. */
  | { k: 'stock'; res: Resource; min: number; relative?: boolean }
  /** Units in the player's warehouses of `type` together. */
  | { k: 'stockAt'; type: BuildingType; res: Resource; min: number }
  /** Units of `res` produced since the mission began (`stats.produced`: every player's, fine for one). */
  | { k: 'produced'; res: Resource; min: number }
  /** The player's settlers of a kind (fighters, strikers): at least `min`, at most `max`, optionally near a point. */
  | { k: 'units'; kind: SettlerKind | 'fighter' | 'striker'; min?: number; max?: number; relative?: boolean; near?: Anchor; r?: number }
  | { k: 'garrison'; type: BuildingType; min: number }
  | { k: 'setting'; is: SettingCheck }
  | { k: 'ui'; is: UiCheck }
  | { k: 'explored'; at: Anchor }
  | { k: 'prospected'; at: Anchor; r: number; min: number }
  /** Tiles of land gained since the mission began. */
  | { k: 'claimed'; min: number }
  | { k: 'captured'; min: number }
  | { k: 'outcome'; is: 'won' | 'lost' }
  | { k: 'all'; of: Condition[] }
  | { k: 'any'; of: Condition[] };

export type ConditionKind = Condition['k'];

/** Settings the player made (`Player.economy`, building switches). */
export type SettingCheck =
  /** Some own warehouse takes in every one of these goods. */
  | { s: 'accepts'; res: Resource[] }
  /** Some own building (a site with `site`) has priority. */
  | { s: 'priority'; site?: boolean }
  /** Some own building of the type is stopped (or, with `on: false`, none is). */
  | { s: 'stopped'; type: BuildingType; on: boolean }
  /** The good stands first in the transport priority. */
  | { s: 'transportTop'; res: Resource }
  /** The carrier reserve differs from the default. */
  | { s: 'reserve' }
  /** A building of the type has a moved work area. */
  | { s: 'workAt'; type: BuildingType }
  /** At least `min` of the tool ordered (or endless). */
  | { s: 'toolOrder'; res: Resource; min: number }
  /** A distribution weight of the good was set. */
  | { s: 'distribution'; res: Resource }
  /** A market of the player has a route and an order for the good. */
  | { s: 'tradeRoute'; res: Resource };

export type SettingKind = SettingCheck['s'];

/** Interface facts (`UiProbe`). */
export type UiCheck =
  | { u: 'cameraMoved'; tiles: number }
  | { u: 'zoomChanged' }
  | { u: 'menuOpen'; menu: MenuId }
  | { u: 'selected'; type: BuildingType }
  | { u: 'placing'; what: BuildingType | CommandId }
  | { u: 'selectedUnits'; min: number }
  | { u: 'group'; n: number }
  | { u: 'jumpedToMessage' }
  | { u: 'speed'; min: number };

export type UiCheckKind = UiCheck['u'];

/**
 * A place on the map named by what is there rather than by coordinates (docs/TUTORIAL.md §2.1), so
 * missions survive changes of the map generator.
 */
export type Anchor =
  | { a: 'home' }
  | { a: 'enemyHome'; player?: PlayerId }
  /** `START_GUARANTEES`: a mountain (or one of its lobes), a quarry (its nearest stone), the grove or the pond. */
  | { a: 'guarantee'; mountain?: number; lobe?: number; quarry?: number; grove?: true; pond?: true }
  /** The best place for a building near another anchor (`prefer`: what its work area should hold). */
  | { a: 'spot'; type: BuildingType; near: Anchor; prefer?: Prefer; within?: number }
  | { a: 'nearest'; terrain: 'water' | 'meadow' | 'forest'; from: Anchor }
  /** A building of the player's (or an enemy's, or a scenario's by tag); re-found on every check. */
  | { a: 'building'; type: BuildingType; owner: 'me' | 'enemy' | 'scenario'; tag?: string }
  /** A pile of goods on the ground nearest another anchor; re-found on every check. */
  | { a: 'pile'; res: Resource; near: Anchor }
  | { a: 'between'; from: Anchor; to: Anchor; t: number }
  | { a: 'offset'; from: Anchor; dx: number; dy: number };

export type AnchorKind = Anchor['a'];
export type Prefer = 'forest' | 'stone' | 'water' | 'meadow' | 'border';

/** What the interface tells the conditions (the browser fills it from `GameState`, the tests by hand). */
export interface UiProbe {
  /** The open main menu, or null while a building's or settler's window replaces it. */
  menu: MenuId | null;
  selected: number | null;
  selectedUnits: number;
  /** Units stored under each control group (index 1–9). */
  groups: number[];
  /** The tile at the centre of the view, and the zoom. */
  camera: Point;
  zoom: number;
  placing: string | null;
  speed: number;
  paused: boolean;
  /** Space or a click took the camera to a message this many times (counts up). */
  jumps: number;
}

/** Counts taken when the mission (or a step) begins, for relative conditions. */
export interface Snapshot {
  tick: number;
  stock: Partial<Record<Resource, number>>;
  produced: Partial<Record<Resource, number>>;
  fighters: number;
  land: number;
}

/** What conditions look at. */
export interface Probe {
  world: World;
  player: PlayerId;
  ui: UiProbe;
  /** Resolves an anchor (cached for fixed ones). */
  anchor: (a: Anchor) => Point | null;
  start: Snapshot;
  step: Snapshot;
  /** The interface as it was when the step began (camera moved since, zoom changed since). */
  stepUi: { camera: Point; zoom: number; jumps: number };
  acked: boolean;
}

export type { GuideMark } from '../render/guide';
