import { TICKS_PER_SECOND } from '../sim/config';
import { el } from './dom';
import { gameTime, type SaveSlots, type SlotMeta } from './saves';

/**
 * The list of save slots, as on Settlers 4's load and save screens: name, date, map, players and game
 * time per slot. `load` mode loads a slot; `save` mode offers a name field for a new slot and
 * overwrites existing ones. Both can delete (with a confirmation in place).
 */
export interface SavesSpec {
  mode: 'load' | 'save';
  slots: SaveSlots;
  onLoad?: (meta: SlotMeta) => void;
  /** Save under `name`, into `id` to overwrite; resolves to whether it worked. */
  onSave?: (name: string, id?: string) => Promise<boolean>;
  /** A suggested name for a new save. */
  suggest?: string;
}

const when = (ms: number) =>
  ms > 0
    ? new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';

export function savesPanel(spec: SavesSpec): HTMLElement {
  const box = el('div', 'saves');
  const status = el('p', 'saves-status');
  const render = () => {
    box.innerHTML = '';
    if (spec.mode === 'save') {
      const form = el('form', 'save-new');
      const name = el('input');
      name.type = 'text';
      name.maxLength = 40;
      name.value = spec.suggest ?? 'Сохранение';
      name.setAttribute('aria-label', 'Название сохранения');
      const go = el('button', 'menu-small active', 'Сохранить');
      go.type = 'submit';
      form.onsubmit = (e) => {
        e.preventDefault();
        void save(name.value.trim() || 'Сохранение');
      };
      form.append(name, go);
      box.append(form);
      queueMicrotask(() => name.select());
    }
    const list = spec.slots.list();
    if (list.length === 0) box.append(el('p', 'muted', 'Сохранений нет.'));
    const table = el('div', 'save-list');
    for (const m of list) table.append(rowOf(m));
    box.append(table, status);
  };
  const save = async (name: string, id?: string) => {
    status.textContent = 'Сохраняю…';
    const ok = await spec.onSave!(name, id);
    render();
    status.textContent = ok ? 'Игра сохранена' : 'Не удалось сохранить: хранилище браузера недоступно или заполнено — удалите старые сохранения';
  };
  const rowOf = (m: SlotMeta) => {
    const row = el('div', `save-row${m.auto ? ' auto' : ''}`);
    const info = el('div', 'save-info');
    info.append(
      el('b', '', m.name),
      el('span', '', `${when(m.savedAt)} · карта ${m.size}×${m.size} · игроков ${m.players} · время ${gameTime(m.tick, TICKS_PER_SECOND)}`),
    );
    const actions = el('div', 'save-actions');
    if (spec.mode === 'load') {
      const load = el('button', 'menu-small active', 'Загрузить');
      load.onclick = () => spec.onLoad?.(m);
      actions.append(load);
      // A double click on the row loads it too.
      row.ondblclick = () => spec.onLoad?.(m);
    } else if (!m.auto && m.id !== 'v1') {
      const over = el('button', 'menu-small', 'Перезаписать');
      over.onclick = () => void save(m.name, m.id);
      actions.append(over);
    }
    const del = el('button', 'menu-small danger', 'Удалить');
    del.onclick = () => {
      if (del.dataset.sure) {
        spec.slots.remove(m.id);
        render();
        return;
      }
      del.dataset.sure = '1';
      del.textContent = 'Точно удалить?';
    };
    del.onblur = () => {
      delete del.dataset.sure;
      del.textContent = 'Удалить';
    };
    actions.append(del);
    row.append(info, actions);
    return row;
  };
  render();
  return box;
}
