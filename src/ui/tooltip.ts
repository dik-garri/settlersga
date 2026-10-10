import { wareIcon } from '../render/atlas';
import { resLower, resName } from './names';
import type { TipContent, TipPart } from './tips';

/**
 * The HUD's hover help (Settlers 4 explained every button of its side panel when the pointer rested
 * on it): one parchment card, `#hud-tip`, shown beside the side panel after a short rest of the
 * pointer, at once when the pointer moves on from one tip to the next, on keyboard focus too
 * (`:focus-visible`, with `aria-describedby`), and on touch after a long press. It never covers the
 * element it explains (it sits right of the panel, or below/above anything outside it) and stays on
 * screen; leaving, a click, a scroll or Esc hides it.
 *
 * `tip(el, content)` gives an element its help: a line of text, a card (`Tip`, built from the game
 * data in `tips.ts`), or a function that builds one when shown (so it follows locks, language and
 * state). It replaces `title` attributes: there is one system for the whole panel.
 */

export type TipSource = TipContent | (() => TipContent | null);

/** Pointer rest before a tip shows (ms); moving on from a visible tip shows the next at once. */
const SHOW_DELAY = 420;
/** A tip hidden less than this long ago counts as still showing for the next one (ms). */
const CHAIN_MS = 300;
/** Long press on touch screens (ms). */
const PRESS_MS = 550;
const GAP = 10;
const MARGIN = 8;
const ID = 'hud-tip';

const sources = new WeakMap<Element, TipSource>();

/** Gives `el` hover help (null removes it); a visible tip of `el` is redrawn. Returns `el`. */
export function tip<T extends HTMLElement>(el: T, content: TipSource | null): T {
  if (content === null || content === '') {
    sources.delete(el);
    delete el.dataset.tip;
  } else {
    sources.set(el, content);
    el.dataset.tip = '';
    el.removeAttribute('title');
    install();
  }
  if (current === el) {
    if (content) show(el);
    else hide();
  }
  return el;
}

/** Hides the tip (a view is going away). */
export function hideTip(): void {
  hide();
}

let installed = false;
let box: HTMLElement | null = null;
let current: HTMLElement | null = null;
let pending: HTMLElement | null = null;
let timer = 0;
let watch = 0;
let hiddenAt = -Infinity;
/** The element clicked last: no tip for it again until the pointer leaves it. */
let muted: HTMLElement | null = null;
let press: { el: HTMLElement; x: number; y: number } | null = null;
let swallowClick = false;

function tipTarget(node: EventTarget | null): HTMLElement | null {
  let e = node instanceof Element ? node : null;
  while (e) {
    if (e instanceof HTMLElement && sources.has(e)) return e;
    e = e.parentElement;
  }
  return null;
}

function install(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const el = tipTarget(e.target);
    if (el !== muted) muted = null;
    if (el === current || el === pending) return;
    if (!el || el === muted) {
      hide();
      return;
    }
    schedule(el, current || performance.now() - hiddenAt < CHAIN_MS ? 0 : SHOW_DELAY);
  });
  document.addEventListener('pointerout', (e) => {
    if (!e.relatedTarget) {
      hide();
      muted = null;
    }
  });
  document.addEventListener(
    'pointerdown',
    (e) => {
      const el = tipTarget(e.target);
      hide();
      muted = el;
      if (e.pointerType === 'touch' && el) {
        press = { el, x: e.clientX, y: e.clientY };
        window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (!press) return;
          show(press.el);
          swallowClick = true;
          press = null;
        }, PRESS_MS);
      }
    },
    true,
  );
  document.addEventListener('pointermove', (e) => {
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) cancelPress();
  });
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  // After a long press the finger lifts: that click must not also build or order.
  document.addEventListener(
    'click',
    (e) => {
      if (!swallowClick) return;
      swallowClick = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  document.addEventListener('focusin', (e) => {
    const el = tipTarget(e.target);
    if (el && el === e.target && el.matches(':focus-visible')) schedule(el, 150);
  });
  document.addEventListener('focusout', (e) => {
    if (e.target === current || e.target === pending) hide();
  });
  document.addEventListener('scroll', () => hide(), true);
  document.addEventListener('wheel', () => hide(), { passive: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hide();
  });
  window.addEventListener('blur', () => hide());
}

function cancelPress(): void {
  if (!press) return;
  press = null;
  window.clearTimeout(timer);
}

function schedule(el: HTMLElement, delay: number): void {
  window.clearTimeout(timer);
  pending = el;
  if (delay <= 0) show(el);
  else timer = window.setTimeout(() => show(el), delay);
}

function ensureBox(): HTMLElement {
  if (!box) {
    box = document.createElement('div');
    box.id = ID;
    box.className = 'hud-tip';
    box.setAttribute('role', 'tooltip');
    box.hidden = true;
    document.body.append(box);
  }
  return box;
}

function resolve(src: TipSource | undefined): TipContent | null {
  if (src === undefined) return null;
  return typeof src === 'function' ? src() : src;
}

function partEl(p: TipPart): Node[] {
  if (typeof p === 'string') return [document.createTextNode(p)];
  const icon = wareIcon(p.res, 16);
  icon.classList.add('tip-ware');
  icon.setAttribute('role', 'img');
  icon.setAttribute('aria-label', resName(p.res));
  const out: Node[] = [];
  if (p.n !== undefined) out.push(document.createTextNode(String(p.n)));
  out.push(icon);
  if (p.named) out.push(document.createTextNode(resLower(p.res)));
  return out;
}

function render(content: TipContent, into: HTMLElement): void {
  into.replaceChildren();
  const div = (cls: string, text?: string) => {
    const d = document.createElement('div');
    d.className = cls;
    if (text !== undefined) d.textContent = text;
    return d;
  };
  if (typeof content === 'string') {
    into.append(div('tip-text', content));
    return;
  }
  into.append(div('tip-title', content.title));
  if (content.sub) into.append(div('tip-sub', content.sub));
  for (const line of content.lines) {
    const d = div('tip-line');
    if (line.label) d.append(Object.assign(document.createElement('b'), { textContent: `${line.label}: ` }));
    for (const p of line.parts) d.append(...partEl(p));
    into.append(d);
  }
  if (content.hint) into.append(div('tip-hint', content.hint));
}

function show(el: HTMLElement): void {
  window.clearTimeout(timer);
  pending = null;
  if (!el.isConnected) {
    hide();
    return;
  }
  const content = resolve(sources.get(el));
  if (!content) {
    hide();
    return;
  }
  const b = ensureBox();
  if (current && current !== el) unlink(current);
  render(content, b);
  b.hidden = false;
  place(el, b);
  current = el;
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.includes(ID)) el.setAttribute('aria-describedby', [...ids, ID].join(' '));
  window.clearInterval(watch);
  // A view redrawn under the pointer takes its element away without a pointerout.
  watch = window.setInterval(() => {
    if (current && !current.isConnected) hide();
  }, 250);
}

function unlink(el: HTMLElement): void {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((x) => x && x !== ID);
  if (ids.length > 0) el.setAttribute('aria-describedby', ids.join(' '));
  else el.removeAttribute('aria-describedby');
}

function hide(): void {
  window.clearTimeout(timer);
  window.clearInterval(watch);
  pending = null;
  if (current) {
    unlink(current);
    current = null;
    hiddenAt = performance.now();
  }
  if (box) box.hidden = true;
}

/**
 * Right of the side panel, level with the element (its own panel never hidden); elsewhere below it,
 * or above when there is no room; always kept on screen.
 */
function place(el: HTMLElement, b: HTMLElement): void {
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  b.style.left = '0px';
  b.style.top = '0px';
  const w = b.offsetWidth;
  const h = b.offsetHeight;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  const panel = el.closest('.side')?.getBoundingClientRect();
  let x: number;
  let y: number;
  if (panel && panel.right + GAP + w <= vw - MARGIN) {
    x = panel.right + GAP;
    y = clamp(r.top - 4, MARGIN, vh - h - MARGIN);
  } else if (r.bottom + GAP + h <= vh - MARGIN) {
    x = clamp(r.left, MARGIN, vw - w - MARGIN);
    y = r.bottom + GAP;
  } else if (r.top - GAP - h >= MARGIN) {
    x = clamp(r.left, MARGIN, vw - w - MARGIN);
    y = r.top - GAP - h;
  } else {
    // No room above or below: beside it, whichever side has more room.
    x = vw - r.right > r.left ? Math.min(r.right + GAP, vw - w - MARGIN) : Math.max(MARGIN, r.left - GAP - w);
    y = clamp(r.top, MARGIN, vh - h - MARGIN);
  }
  b.style.left = `${Math.round(x)}px`;
  b.style.top = `${Math.round(y)}px`;
}
