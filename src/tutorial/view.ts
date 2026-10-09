import { TICKS_PER_SECOND } from '../sim/config';
import type { Point } from '../sim/types';
import type { World } from '../sim/world';
import { el } from '../ui/dom';
import { LANG_EVENT, lower, t, type Key, type Params } from '../ui/i18n';
import { buildingName, profName, resLower } from '../ui/names';
import { gameTime } from '../ui/saves';
import type { GameState } from '../ui/state';
import type { UiTarget } from '../ui/uiTarget';
import type { GuideMark } from '../render/guide';
import { MISSIONS } from './missions';
import { markDone } from './progress';
import type { MissionProgress, TutorialModel, TutorialRunner } from './runner';
import type { ModifierKey, ParamSpec, UiProbe } from './types';

/**
 * The tutorial's face in the browser (docs/TUTORIAL.md §3.5–3.7): the goals panel over the game view
 * (mission, step text and explanation, «Next» / «Show» / «Hint», the goals with ticks, collapsible),
 * the highlight chain on the interface (`.tut-glow` and a pointer on the first `data-ui` element of
 * the step's chain that is on the page and not yet in use), the map marks (handed to the renderer),
 * the interface locks (`GameState.locks`) and the debrief at the end. It drives the `TutorialRunner`
 * from the game loop and redraws only when the runner's model changes.
 */

export interface TutorialHooks {
  state: GameState;
  /** Moves the camera to a tile. */
  jump: (x: number, y: number) => void;
  /** The marks on the map (`GameRenderer.setGuide`). */
  marks: (marks: GuideMark[]) => void;
  /** Starts another mission (the next one, or this one again). */
  startMission: (id: string) => void;
  /** Back to the main menu. */
  toMenu: () => void;
}

/** Whether the keyboard is a Mac's (its Ctrl is ⌘, its Alt ⌥). */
function onMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Modifier names on a Mac keyboard. */
const MAC_KEYS: Record<ModifierKey, Key> = { ctrl: 'key.ctrlMac', alt: 'key.altMac', shift: 'key.shift' };

/** A step's `{name}` placeholders filled in the current language. */
export function textOf(key: Key, params?: Record<string, ParamSpec>): string {
  const out: Params = {};
  for (const [name, spec] of Object.entries(params ?? {})) {
    if ('building' in spec) out[name] = buildingName(spec.building);
    else if ('res' in spec) out[name] = resLower(spec.res);
    else if ('prof' in spec) out[name] = lower(profName(spec.prof));
    else if ('n' in spec) out[name] = spec.n;
    else if ('key' in spec) out[name] = t(onMac() ? MAC_KEYS[spec.key] : (`key.${spec.key}` as const));
    else out[name] = t(spec.label);
  }
  return t(key, out);
}

/** Targets that are always somewhere on the page; a missing one means a mark was lost in a change. */
const ALWAYS_THERE = /^(menu|build|speed)\.|^hud\.ticker$|^minimap$/;
/** How long a missing target may be missing before the console hears of it. */
const MISSING_MS = 3000;

const visible = (e: HTMLElement): boolean => e.isConnected && e.getClientRects().length > 0;

export class TutorialView {
  readonly el = el('section', 'goals');
  private readonly debrief = el('div', 'panel end-screen tut-debrief');
  private readonly pointer = el('div', 'tut-pointer');
  private glowing: HTMLElement | null = null;
  private drawn = -1;
  private collapsed = false;
  private lastUpdate = 0;
  private marksKey = '';
  private missingSince = 0;
  private warned = '';
  private ended = false;
  private debriefShown = false;

  constructor(
    private readonly runner: TutorialRunner,
    private readonly world: World,
    root: HTMLElement,
    private readonly hooks: TutorialHooks,
  ) {
    this.el.setAttribute('aria-live', 'polite');
    this.debrief.hidden = true;
    this.pointer.hidden = true;
    root.append(this.el, this.debrief, this.pointer);
    // Another language chosen in the settings: everything is drawn again in it.
    window.addEventListener(LANG_EVENT, () => {
      this.drawn = -1;
      this.lastUpdate = 0;
    });
  }

  /** The progress to keep in a save slot (null once the player left the mission for free play). */
  progress(): MissionProgress | null {
    return this.ended ? null : this.runner.serialize();
  }

  /** After the world's ticks (at least every few ticks): the runner checks its conditions. */
  tick(ui: UiProbe): void {
    if (this.ended) return;
    this.runner.update(this.world, ui);
    const cam = this.runner.takeCamera();
    if (cam) this.hooks.jump(cam.x, cam.y);
  }

  /** Space: «Next» if the step waits for it (true), else the usual jump to the last message. */
  space(): boolean {
    if (this.ended || !this.runner.ack()) return false;
    this.drawn = -1;
    return true;
  }

  /** On the HUD's throttle: the panel, highlights, marks, locks and the debrief. */
  update(now: number): void {
    if (this.ended) return;
    if (now - this.lastUpdate < 150) return;
    this.lastUpdate = now;
    const m = this.runner.model(this.world);
    const locks = JSON.stringify(m.locks);
    if (JSON.stringify(this.hooks.state.locks) !== locks) this.hooks.state.locks = m.locks;
    const marksKey = JSON.stringify(m.marks);
    if (marksKey !== this.marksKey) {
      this.marksKey = marksKey;
      this.hooks.marks(m.marks);
    }
    if (m.version !== this.drawn) {
      this.drawn = m.version;
      this.draw(m);
      if (m.finished) this.showDebrief(m, !this.debriefShown);
    }
    this.highlight(m.ui, now);
  }

  /** Takes the panel, highlights and marks away (free play on the map, or the HUD rebuilt). */
  dispose(): void {
    this.unglow();
    this.el.remove();
    this.debrief.remove();
    this.pointer.remove();
  }

  private draw(m: TutorialModel): void {
    const box = this.el;
    box.replaceChildren();
    box.classList.toggle('collapsed', this.collapsed);
    if (this.collapsed) {
      const open = el('button', 'goals-open', t('tut.ui.expand'));
      open.onclick = () => {
        this.collapsed = false;
        this.drawn = -1;
        open.blur();
      };
      box.append(open);
      return;
    }
    const head = el('header', 'goals-head');
    const number = MISSIONS.indexOf(m.def) + 1;
    head.append(el('span', 'goals-mission', `${t('tut.ui.mission', { n: number })} · ${t(m.def.title)}`));
    const fold = el('button', 'goals-fold', '−');
    fold.title = t('tut.ui.collapse');
    fold.onclick = () => {
      this.collapsed = true;
      this.drawn = -1;
      fold.blur();
    };
    head.append(fold);
    box.append(head);
    const step = m.step;
    if (step && !m.finished) {
      box.append(el('div', 'goals-count', t('tut.ui.step', { n: m.index + 1, m: m.count })));
      box.append(el('p', 'goals-text', textOf(step.text, step.params)));
      if (step.more) box.append(el('p', 'goals-more', textOf(step.more, step.params)));
      if (step.hint && m.hint) box.append(el('p', 'goals-hint', `💡 ${textOf(step.hint.text, step.params)}`));
      const actions = el('div', 'goals-actions');
      if (m.waitsAck) {
        const next = el('button', 'active', t('tut.ui.next'));
        next.title = t('tut.ui.nextTip');
        next.onclick = () => {
          this.runner.ack();
          this.drawn = -1;
          next.blur();
        };
        actions.append(next);
      }
      if (step.camera || step.marker?.length || step.ring) {
        const show = el('button', '', t('tut.ui.show'));
        show.title = t('tut.ui.showTip');
        show.onclick = () => {
          const at: Point | null = this.runner.show(this.world);
          if (at) this.hooks.jump(at.x, at.y);
          show.blur();
        };
        actions.append(show);
      }
      if (step.hint && !m.hint) {
        const hint = el('button', '', t('tut.ui.hint'));
        hint.onclick = () => {
          this.runner.showHint();
          hint.blur();
        };
        actions.append(hint);
      }
      if (actions.firstChild) box.append(actions);
    }
    if (m.goals.length > 0) {
      box.append(el('h4', 'goals-title', t('tut.ui.goals')));
      const list = el('ul', 'goals-list');
      for (const g of m.goals) {
        const li = el('li', g.done ? 'done' : '', `${g.done ? '✔' : '○'} ${textOf(g.text, g.params)}`);
        list.append(li);
      }
      box.append(list);
    }
  }

  /** Lights the first element of the chain that is on the page and not yet in use. */
  private highlight(chain: readonly UiTarget[], now: number): void {
    let target: HTMLElement | null = null;
    let missing = '';
    chain.forEach((id, k) => {
      if (target) return;
      const all = [...document.querySelectorAll<HTMLElement>(`[data-ui="${id}"]`)];
      if (all.length === 0 && ALWAYS_THERE.test(id)) missing = id;
      const e = all.find(visible);
      if (!e || e.dataset.uiOn === '1') return;
      // A menu or tab already open is passed over; the last element lights up even while active.
      if (k < chain.length - 1 && e.classList.contains('active')) return;
      target = e;
    });
    if (missing) {
      if (!this.missingSince) this.missingSince = now;
      else if (now - this.missingSince > MISSING_MS && this.warned !== missing) {
        this.warned = missing;
        console.warn(`tutorial: no element for data-ui="${missing}"`);
      }
    } else this.missingSince = 0;
    if (target !== this.glowing) {
      this.unglow();
      this.glowing = target;
      (target as HTMLElement | null)?.classList.add('tut-glow');
      // A row deep in a long list (the distribution's goods, the tool orders) is scrolled into view.
      (target as HTMLElement | null)?.scrollIntoView?.({ block: 'nearest' });
    }
    this.placePointer();
  }

  private unglow(): void {
    this.glowing?.classList.remove('tut-glow');
    this.glowing = null;
    this.pointer.hidden = true;
  }

  /** The pointer sits left of the lit element, pointing at it (right of it if there is no room, below it at the top of the page). */
  private placePointer(): void {
    const e = this.glowing;
    if (!e || !visible(e)) {
      this.pointer.hidden = true;
      return;
    }
    const r = e.getBoundingClientRect();
    this.pointer.hidden = false;
    // Small buttons in a row (main menus, tabs, speeds) get it from below, so it hides no neighbour.
    const up = r.top < 70 || (r.width < 70 && r.height < 50);
    const left = !up && r.left > 40;
    this.pointer.classList.toggle('up', up);
    this.pointer.classList.toggle('flip', !up && !left);
    this.pointer.style.top = `${Math.round(up ? r.bottom + 10 : r.top + r.height / 2)}px`;
    this.pointer.style.left = `${Math.round(up ? r.left + r.width / 2 : left ? r.left - 6 : r.right + 6)}px`;
  }

  private showDebrief(m: TutorialModel, first: boolean): void {
    this.unglow();
    this.hooks.marks([]);
    const won = m.finished === 'won';
    const minutes = m.ticks / TICKS_PER_SECOND / 60;
    if (first) {
      this.debriefShown = true;
      if (won) markDone(m.def.id, Math.round(minutes * 10) / 10, Date.now());
      this.hooks.state.paused = true;
    }
    const d = this.debrief;
    d.replaceChildren();
    d.append(el('h2', won ? 'won' : 'lost', won ? t('tut.ui.won') : t('tut.ui.lost')));
    d.append(el('p', 'tut-debrief-title', t(m.def.title)));
    if (won) {
      d.append(el('h4', '', t('tut.ui.learnt')));
      const list = el('ul', 'tut-learnt');
      for (const line of t(m.def.debrief).split('\n')) list.append(el('li', '', line));
      d.append(list);
    } else d.append(el('p', '', t('tut.ui.lostText')));
    d.append(el('p', 'muted', t('tut.ui.time', { time: gameTime(m.ticks, TICKS_PER_SECOND) })));
    const actions = el('div', 'info-actions');
    const index = MISSIONS.indexOf(m.def);
    const next = MISSIONS[index + 1];
    if (won && next && !next.soon) {
      const go = el('button', 'active', t('tut.ui.nextMission'));
      go.onclick = () => this.hooks.startMission(next.id);
      actions.append(go);
    } else if (won) d.append(el('p', 'muted', t('tut.ui.allDone')));
    if (!won) {
      const again = el('button', 'active', t('tut.ui.again'));
      again.onclick = () => this.hooks.startMission(m.def.id);
      actions.append(again);
    }
    const stay = el('button', '', t('tut.ui.stay'));
    stay.onclick = () => this.stay();
    const menu = el('button', '', t('tut.ui.toMenu'));
    menu.onclick = () => this.hooks.toMenu();
    actions.append(stay, menu);
    d.append(actions);
    d.hidden = false;
  }

  /** «Stay on the map»: the locks come off, the panel goes, the game runs on as a free game. */
  private stay(): void {
    this.ended = true;
    this.hooks.state.locks = null;
    this.hooks.state.paused = false;
    this.hooks.marks([]);
    this.dispose();
  }
}
