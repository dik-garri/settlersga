import { BUILDINGS, type Category } from '../sim/config';
import type { BuildingType } from '../sim/types';

/**
 * Interface locks (the tutorial's, Settlers 4's `DisableControls`, made gentler): what the player may
 * open while a mission runs. They act on the interface only — the build menu greys out tabs and
 * buildings that are not open yet, main menus that are not open do not open — and never on the
 * simulation. Pure data and functions (no DOM).
 */

/** The side panel's main menus (`Hud`). */
export type MenuId = 'build' | 'goods' | 'settlers' | 'stats' | 'army' | 'options';
export const MENU_IDS: readonly MenuId[] = ['build', 'goods', 'settlers', 'stats', 'army', 'options'];

/** Errands aimed at the map from the settlers menu. */
export type CommandId = 'geologist' | 'pioneer' | 'thief' | 'saboteur';

/** What is open (everything else is locked). */
export interface Locks {
  buildings: BuildingType[];
  menus: MenuId[];
  commands: CommandId[];
}

export const noLocksOpen = (): Locks => ({ buildings: [], menus: [], commands: [] });

/** `a` with everything `b` opens added (no duplicates, order kept). */
export function openMore(a: Locks, b: Partial<Locks> | undefined): Locks {
  if (!b) return a;
  const add = <T>(x: T[], y: T[] | undefined) => [...x, ...(y ?? []).filter((v) => !x.includes(v))];
  return { buildings: add(a.buildings, b.buildings), menus: add(a.menus, b.menus), commands: add(a.commands, b.commands) };
}

/** Null locks = nothing locked (a normal game). */
export const buildingOpen = (l: Locks | null, type: BuildingType): boolean => !l || l.buildings.includes(type);

/** A build-menu tab is open while any of its buildings is. */
export const tabOpen = (l: Locks | null, category: Category): boolean =>
  !l || l.buildings.some((t) => BUILDINGS[t].category === category);

/** The options menu (save, load, speed, the game menu) is never locked. */
export const menuOpen = (l: Locks | null, m: MenuId): boolean => !l || m === 'options' || l.menus.includes(m);

export const commandOpen = (l: Locks | null, c: CommandId): boolean => !l || l.commands.includes(c);
