import { tip } from './tooltip';

/** Small DOM helpers shared by the HUD modules. */

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/**
 * A button that runs `onclick` and drops focus (so keyboard shortcuts keep working). `help` is its
 * hover help (`tooltip.ts`); a button showing only a sign («+1», «∞», «⤒») also gets it as its
 * accessible name.
 */
export function button(text: string, help: string, onclick: () => void, cls = ''): HTMLButtonElement {
  const b = el('button', cls, text);
  if (help) {
    tip(b, help);
    if (!/\p{L}/u.test(text)) b.setAttribute('aria-label', help);
  }
  b.onclick = () => {
    onclick();
    b.blur();
  };
  return b;
}

/** A "key: value" table. */
export function rowsTable(rows: [string, string][]): HTMLDListElement {
  const table = el('dl');
  for (const [k, v] of rows) table.append(el('dt', '', k), el('dd', '', v));
  return table;
}

/** A view shown in the side panel's content area. */
export interface View {
  readonly el: HTMLElement;
  /** Called on the HUD's throttle while the view is shown. */
  update(nowMs: number): void;
}
