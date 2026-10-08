import { PLAYER_COLORS } from '../render/sprites';
import { AI_LEVEL_IDS, START_CONDITIONS, type StartLevel } from '../sim/config';
import { el } from './dom';
import {
  activeSlots,
  levelName,
  MAP_SIZES,
  MAX_SLOTS,
  RACES,
  SLOT_KINDS,
  setupProblem,
  type GameSetup,
  type SlotKind,
} from './setup';

/**
 * The game setup screen's form (`GameSetup`), the same for a single game and the network lobby:
 * map size, seed, start goods and fog on the left, one row per player slot (colour, who plays it,
 * race, team, the computer's difficulty) on the right. Edits `setup` in place and calls `changed`
 * with the reason it cannot start (or null).
 */
export function setupForm(setup: GameSetup, changed: (problem: string | null) => void): HTMLElement {
  const box = el('div', 'setup');
  const select = <T extends string | number>(options: [T, string][], value: T, set: (v: T) => void, disabled = false) => {
    const s = el('select');
    for (const [v, text] of options) {
      const o = el('option', '', text);
      o.value = String(v);
      s.append(o);
    }
    s.value = String(value);
    s.disabled = disabled;
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
    map.append(el('h4', '', 'Карта'));
    field(
      map,
      'Размер',
      select(MAP_SIZES.map((n): [number, string] => [n, `${n} × ${n}`]), setup.size, (v) => (setup.size = v)),
    );
    const seed = el('input');
    seed.type = 'number';
    seed.min = '0';
    seed.placeholder = 'случайная';
    seed.value = setup.seed === null ? '' : String(setup.seed);
    seed.oninput = () => {
      const v = Number(seed.value);
      setup.seed = seed.value.trim() === '' || !Number.isInteger(v) || v < 0 ? null : v;
    };
    const dice = el('button', 'menu-small', 'наугад');
    dice.type = 'button';
    dice.title = 'Случайная карта';
    dice.onclick = () => {
      setup.seed = Math.floor(Math.random() * 1e9);
      seed.value = String(setup.seed);
    };
    const seedBox = el('span', 'seed-box');
    seedBox.append(seed, dice);
    field(map, 'Номер карты', seedBox);
    field(
      map,
      'Запасы на старте',
      select(
        (Object.keys(START_CONDITIONS) as StartLevel[]).map((k): [StartLevel, string] => [k, START_CONDITIONS[k].name]),
        setup.start,
        (v) => (setup.start = v),
      ),
    );
    const fog = el('input');
    fog.type = 'checkbox';
    fog.checked = setup.fog;
    fog.onchange = () => (setup.fog = fog.checked);
    field(map, 'Туман войны', fog);
    map.append(el('p', 'muted', 'Номер карты задаёт её рельеф: с одним номером карта всегда одинакова.'));

    const players = el('div', 'setup-players');
    players.append(el('h4', '', 'Игроки'));
    const table = el('div', 'slot-table');
    for (const h of ['', 'Кто играет', 'Народ', 'Команда', 'Сложность']) table.append(el('span', 'slot-head', h));
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
      table.append(
        swatch,
        select(
          kinds.map((v): [SlotKind, string] => [v, k === 0 ? 'Вы' : SLOT_KINDS[v]]),
          slot.kind,
          (v) => (slot.kind = v),
          k === 0,
        ),
        select(
          RACES.map((r): [string, string] => [r.id, r.ready ? r.name : `${r.name} — в фазе 6`]),
          slot.race,
          (v) => (slot.race = v as typeof slot.race),
          off,
        ),
        select(
          Array.from({ length: MAX_SLOTS }, (_, t): [number, string] => [t + 1, `${t + 1}`]),
          slot.team,
          (v) => (slot.team = v),
          off,
        ),
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
      el('p', 'muted', 'Одна команда — союзники: не воюют друг с другом, видят землю друг друга и побеждают вместе.'),
    );
    box.append(map, players);
    changed(setupProblem(setup));
  };
  render();
  return box;
}
