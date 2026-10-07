import { START_CONDITIONS, type StartLevel } from '../sim/config';

/**
 * «New game» options as in Settlers 4's free game (in the options menu of the side panel): start goods (low / medium / high), map size and
 * the number of computer opponents. The game is set up from URL parameters, so starting one reloads
 * the page with `?start=…&size=…&players=…` and a fresh seed.
 */
export function readStartLevel(params: URLSearchParams): StartLevel {
  const v = params.get('start');
  return v === 'low' || v === 'high' ? v : 'medium';
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function select(label: string, options: [string, string][], value: string): [HTMLLabelElement, HTMLSelectElement] {
  const row = el('label', 'eco-row');
  const s = el('select');
  for (const [v, text] of options) {
    const o = el('option', '', text);
    o.value = v;
    s.append(o);
  }
  s.value = value;
  row.append(el('span', 'eco-name', label), s);
  return [row, s];
}

/** The «Новая игра» form (start level, map size, opponents), shown in the options menu. */
export function newGameForm(params: URLSearchParams): HTMLElement {
  const panel = el('div', 'new-game');
  const [startRow, start] = select(
    'Запас на старте',
    (Object.keys(START_CONDITIONS) as StartLevel[]).map((k) => [k, START_CONDITIONS[k].name]),
    readStartLevel(params),
  );
  const [sizeRow, size] = select(
    'Карта',
    [64, 96, 128, 256].map((n) => [String(n), `${n}×${n}`]),
    params.get('size') ?? '64',
  );
  const [playersRow, players] = select(
    'Соперники',
    [1, 2, 3, 4].map((n) => [String(n), n === 1 ? 'нет' : String(n - 1)]),
    params.get('players') ?? '2',
  );
  const go = el('button', 'wide', 'Начать новую игру');
  go.onclick = () => {
    const p = new URLSearchParams();
    p.set('start', start.value);
    p.set('size', size.value);
    p.set('players', players.value);
    for (const keep of ['art', 'fog']) if (params.has(keep)) p.set(keep, params.get(keep)!);
    location.search = `?${p}`;
  };
  const actions = el('div', 'info-actions');
  actions.append(go);
  panel.append(startRow, sizeRow, playersRow, actions);
  return panel;
}
