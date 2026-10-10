import { PLAYER_COLORS } from '../render/sprites';
import { AI_LEVEL_IDS, START_CONDITIONS, type StartLevel } from '../sim/config';
import { t } from './i18n';
import { startName } from './names';
import { el } from './dom';
import {
  activeSlots,
  levelName,
  MAP_SIZES,
  MAX_SLOTS,
  RACES,
  raceName,
  slotKindName,
  setupProblem,
  sizeHint,
  type GameSetup,
  type SlotKind,
} from './setup';

/** How the network lobby (`lobbyView.ts`) uses the form. */
export interface SetupFormOptions {
  /** A joined player only looks: every control is off but its own slot's team. */
  readOnly?: boolean;
  /** This browser's slot in the lobby: its team can be changed even read-only. */
  ownSlot?: number;
  /** Instead of the «who plays» choice, a plain label for this slot (a player sits there; the host). */
  who?: (slot: number) => string | null;
  /** The own slot's team was changed (a joined player asks the host). */
  onTeam?: (team: number) => void;
}

/**
 * The game setup screen's form (`GameSetup`), the same for a single game and the network lobby:
 * map size, seed, start goods and fog on the left, one row per player slot (colour, who plays it,
 * race, team, the computer's difficulty) on the right. Edits `setup` in place and calls `changed`
 * with the reason it cannot start (or null).
 */
export function setupForm(setup: GameSetup, changed: (problem: string | null) => void, opts: SetupFormOptions = {}): HTMLElement {
  const ro = !!opts.readOnly;
  const box = el('div', 'setup');
  const select = <T extends string | number>(
    options: [T, string][],
    value: T,
    set: (v: T) => void,
    disabled = false,
    unavailable: (v: T) => boolean = () => false,
  ) => {
    const s = el('select');
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = String(v);
      o.disabled = unavailable(v);
      s.append(o);
    }
    s.value = String(value);
    s.disabled = disabled || ro;
    s.onchange = () => {
      const v = options.find(([o]) => String(o) === s.value)![0];
      set(v);
      render();
    };
    return s;
  };
  const field = (parent: HTMLElement, label: string, control: HTMLElement) => {
    const r = el('label', 'set-row');
    r.append(el('span', 'set-name', label), control);
    parent.append(r);
  };

  const render = () => {
    box.innerHTML = '';
    const map = el('div', 'setup-map');
    map.append(el('h4', '', t('setup.map')));
    field(
      map,
      t('setup.size'),
      select(MAP_SIZES.map((n): [number, string] => [n, `${n} × ${n}`]), setup.size, (v) => (setup.size = v)),
    );
    const seed = el('input');
    seed.type = 'number';
    seed.min = '0';
    seed.placeholder = t('setup.seedRandom');
    seed.value = setup.seed === null ? '' : String(setup.seed);
    seed.disabled = ro;
    seed.oninput = () => {
      const v = Number(seed.value);
      setup.seed = seed.value.trim() === '' || !Number.isInteger(v) || v < 0 ? null : v;
    };
    const dice = el('button', 'menu-small', t('setup.dice'));
    dice.type = 'button';
    dice.disabled = ro;
    dice.title = t('setup.diceTip');
    dice.onclick = () => {
      setup.seed = Math.floor(Math.random() * 1e9);
      seed.value = String(setup.seed);
    };
    const seedBox = el('span', 'seed-box');
    seedBox.append(seed, dice);
    field(map, t('setup.seed'), seedBox);
    field(
      map,
      t('setup.start'),
      select(
        (Object.keys(START_CONDITIONS) as StartLevel[]).map((k): [StartLevel, string] => [k, startName(k)]),
        setup.start,
        (v) => (setup.start = v),
      ),
    );
    const fog = el('input');
    fog.type = 'checkbox';
    fog.checked = setup.fog;
    fog.disabled = ro;
    fog.onchange = () => (setup.fog = fog.checked);
    field(map, t('setup.fog'), fog);
    map.append(el('p', 'muted', t('setup.seedNote')));
    const fits = sizeHint(activeSlots(setup).length);
    map.append(el('p', 'muted', t('setup.sizeHint', { n: activeSlots(setup).length, size: `${fits} × ${fits}` })));

    const players = el('div', 'setup-players');
    players.append(el('h4', '', t('setup.players')));
    const table = el('div', 'slot-table');
    for (const h of ['', t('setup.col.who'), t('setup.col.race'), t('setup.col.team'), t('setup.col.level')]) table.append(el('span', 'slot-head', h));
    const active = activeSlots(setup);
    setup.slots.forEach((slot, k) => {
      // Player colours follow the order of the slots that take part, as the game assigns them.
      const n = active.indexOf(slot);
      const swatch = el('span', 'slot-color');
      swatch.style.background = n >= 0 ? PLAYER_COLORS[n % PLAYER_COLORS.length] : 'transparent';
      swatch.textContent = n >= 0 ? String(n + 1) : '';
      const kinds: SlotKind[] =
        k === 0 ? ['human'] : setup.mode === 'network' ? ['ai', 'remote', 'closed'] : ['ai', 'closed'];
      const off = slot.kind === 'closed';
      const label = opts.who?.(k) ?? null;
      const team = select(
        Array.from({ length: MAX_SLOTS }, (_, t): [number, string] => [t + 1, `${t + 1}`]),
        slot.team,
        (v) => {
          slot.team = v;
          if (k === opts.ownSlot) opts.onTeam?.(v);
        },
        off,
      );
      // A joined player may still choose its own team (the host decides the rest).
      if (ro && k === opts.ownSlot) team.disabled = false;
      table.append(
        swatch,
        label !== null
          ? el('span', 'slot-who', label)
          : select(
              kinds.map((v): [SlotKind, string] => [v, k === 0 ? t('common.you') : slotKindName(v)]),
              slot.kind,
              (v) => (slot.kind = v),
              k === 0,
            ),
        select(
          RACES.map((r): [string, string] => [r.id, r.ready ? raceName(r.id) : t('setup.raceSoon', { name: raceName(r.id) })]),
          slot.race,
          (v) => (slot.race = v as typeof slot.race),
          off,
          (v) => !RACES.find((r) => r.id === v)?.ready,
        ),
        team,
        slot.kind === 'ai'
          ? select(
              AI_LEVEL_IDS.map((l): [string, string] => [l, levelName(l)]),
              slot.level,
              (v) => (slot.level = v as typeof slot.level),
            )
          : el('span', 'muted', '—'),
      );
    });
    players.append(
      table,
      el('p', 'muted', t('setup.teamsNote')),
    );
    box.append(map, players);
    changed(setupProblem(setup));
  };
  render();
  return box;
}
