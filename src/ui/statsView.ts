import { wareIcon } from '../render/atlas';
import { TICKS_PER_SECOND } from '../sim/config';
import { isFighter } from '../sim/military';
import { scoreOf } from '../sim/score';
import { RESOURCES, type BuildingType, type PlayerId, type SettlerKind, type Stock } from '../sim/types';
import type { World } from '../sim/world';
import { el, type View } from './dom';
import { clock, economyTable } from './modeView';
import { economyEndTick } from '../sim/modes';
import { t } from './i18n';
import { buildingName, profName, resName } from './names';
import { playerRowLabel } from './playerNames';
import { tip } from './tooltip';

/** What each player looks like at a sample (Settlers 4's land and fighters statistics). */
interface PlayerSample {
  land: number;
  settlers: number;
  fighters: number;
  killed: number;
  fallen: number;
  captured: number;
  lost: number;
}

interface Sample {
  tick: number;
  produced: Stock;
  /** The local player's kills and losses by kind. */
  killed: Partial<Record<SettlerKind, number>>;
  fallen: Partial<Record<SettlerKind, number>>;
  players: Record<PlayerId, PlayerSample>;
}

/** Samples kept: one a game minute, ten hours. */
const MAX_SAMPLES = 600;

const sum = (r: Partial<Record<SettlerKind, number>> | undefined) => Object.values(r ?? {}).reduce((n, k) => n + (k ?? 0), 0);

/**
 * The statistics menu, after Settlers 4's: production, the fighters (own losses and enemies killed by
 * kind) and every player's land, people, fighters, kills and losses, buildings taken and lost — each
 * over the time chosen with the slider (minutes back, sampled once per game minute) and in all — plus
 * population by profession, buildings by type and the score so far (`scoreOf`).
 */
export class StatsView implements View {
  readonly el = el('div', 'view stats-view');
  /** Samples once per game minute, newest last. */
  private readonly history: Sample[] = [];
  private lastSampleTick = -Infinity;
  private lastRender = -Infinity;
  /** Minutes back the window spans (the slider). */
  private minutes = 10;
  private readonly slider = el('input', 'stats-slider');
  private readonly sliderLabel = el('span', 'stats-window');
  private readonly body = el('div', 'stats-body');

  constructor(
    private readonly world: World,
    /** The player this browser plays. */
    private readonly me: PlayerId,
    /** The human players' names (`GameState.names`). */
    private readonly names: ReadonlyMap<PlayerId, string> = new Map(),
  ) {
    this.slider.type = 'range';
    this.slider.min = '1';
    this.slider.value = String(this.minutes);
    tip(this.slider, t('stats.windowTip'));
    this.slider.oninput = () => {
      this.minutes = Number(this.slider.value);
      this.lastRender = -Infinity;
      this.update(performance.now());
    };
    const bar = el('div', 'stats-bar');
    bar.append(el('span', '', t('stats.window')), this.slider, this.sliderLabel);
    this.el.append(bar, this.body);
  }

  /** Takes over another view's samples (the HUD is rebuilt when the language changes). */
  carry(from: StatsView): void {
    this.history.push(...from.history);
    this.lastSampleTick = from.lastSampleTick;
    this.minutes = from.minutes;
    this.slider.value = String(this.minutes);
  }

  /** Keeps the minute samples going even while the view is hidden. */
  sample(): void {
    const { world } = this;
    if (world.tick - this.lastSampleTick < TICKS_PER_SECOND * 60) return;
    this.lastSampleTick = world.tick;
    this.history.push(this.snapshot());
    if (this.history.length > MAX_SAMPLES) this.history.shift();
  }

  private snapshot(): Sample {
    const { world } = this;
    const players: Record<PlayerId, PlayerSample> = {};
    for (const p of world.players) {
      const war = world.stats.war[p.id];
      players[p.id] = {
        land: 0,
        settlers: 0,
        fighters: 0,
        killed: sum(war?.killed),
        fallen: sum(war?.fallen),
        captured: war?.captured ?? 0,
        lost: war?.lostBuildings ?? 0,
      };
    }
    for (const o of world.map.owner) if (o !== 0 && players[o]) players[o].land++;
    for (const s of world.settlers) {
      const p = players[s.owner];
      if (!p || world.dying.has(s.id)) continue;
      if (isFighter(s)) p.fighters++;
      else p.settlers++;
    }
    const mine = world.stats.war[this.me];
    return {
      tick: world.tick,
      produced: { ...world.stats.produced },
      killed: { ...mine?.killed },
      fallen: { ...mine?.fallen },
      players,
    };
  }

  update(nowMs: number): void {
    if (nowMs - this.lastRender < 1000) return;
    this.lastRender = nowMs;
    const { world } = this;
    const now = this.snapshot();
    const span = Math.max(1, this.history.length);
    this.slider.max = String(span);
    this.minutes = Math.min(this.minutes, span);
    this.slider.value = String(this.minutes);
    const old = this.history[this.history.length - this.minutes] ?? this.history[0] ?? now;
    const minutes = Math.max(1, Math.round((now.tick - old.tick) / (TICKS_PER_SECOND * 60)));
    this.sliderLabel.textContent = t('common.minutes', { n: minutes });
    const body = this.body;
    body.innerHTML = '';
    const row = (name: string, value: string, icon?: HTMLElement) => {
      const r = el('span', 'stock-row');
      if (icon) r.append(icon);
      r.append(el('span', 'stock-name', name), el('b', '', value));
      return r;
    };

    // The economic mode: time to the count and how the seven goods stand now (Settlers 4's eco statistics).
    if (world.rules?.mode === 'economy') {
      body.append(el('h4', '', t('ecowin.title')));
      body.append(el('p', 'muted', world.result ? t('ecowin.done') : t('ecowin.left', { time: clock(economyEndTick() - world.tick) })));
      body.append(economyTable(world, this.me, world.result?.tally, this.names));
    }
    body.append(el('h4', '', t('stats.production', { n: minutes })));
    const grid = el('div', 'stats-grid');
    for (const r of RESOURCES) {
      if (now.produced[r] === 0) continue;
      grid.append(row(resName(r), `${now.produced[r] - old.produced[r]} / ${now.produced[r]}`, wareIcon(r, 16)));
    }
    body.append(grid);

    // Settlers 4's fighters statistics: enemies killed and own losses by kind.
    const kinds = new Set([...Object.keys(now.killed), ...Object.keys(now.fallen)] as SettlerKind[]);
    body.append(el('h4', '', t('stats.fights', { n: minutes })));
    if (kinds.size === 0) body.append(el('p', 'muted', t('stats.noFights')));
    else {
      const war = el('table', 'stats-table');
      const head = el('tr');
      for (const h of ['', t('stats.killed'), t('stats.lost')]) head.append(el('th', '', h));
      war.append(head);
      const cell = (a: number | undefined, b: number | undefined) => `${(a ?? 0) - (b ?? 0)} / ${a ?? 0}`;
      for (const k of [...kinds].sort()) {
        const tr = el('tr');
        tr.append(el('td', '', profName(k)), el('td', '', cell(now.killed[k], old.killed[k])), el('td', '', cell(now.fallen[k], old.fallen[k])));
        war.append(tr);
      }
      body.append(war);
    }

    // Every player (Settlers 4 shows them all): land and people now (change over the window), war in the window / all.
    body.append(el('h4', '', t('stats.players')));
    const table = el('table', 'stats-table');
    const head = el('tr');
    for (const h of ['', t('stats.col.land'), t('stats.col.settlers'), t('stats.col.fighters'), t('stats.col.killed'), t('stats.col.losses'), t('stats.col.taken'), t('stats.col.given'), t('stats.col.score')]) {
      head.append(el('th', '', h));
    }
    table.append(head);
    const delta = (a: number, b: number) => (a - b > 0 ? `+${a - b}` : a - b < 0 ? String(a - b) : '±0');
    for (const p of world.players) {
      const n = now.players[p.id];
      const o = old.players[p.id] ?? n;
      const tr = el('tr', p.id === this.me ? 'mine' : '');
      const name = playerRowLabel(world, this.names, p.id, this.me);
      tr.append(
        el('td', '', name),
        el('td', '', `${n.land} (${delta(n.land, o.land)})`),
        el('td', '', `${n.settlers} (${delta(n.settlers, o.settlers)})`),
        el('td', '', `${n.fighters} (${delta(n.fighters, o.fighters)})`),
        el('td', '', `${n.killed - o.killed} / ${n.killed}`),
        el('td', '', `${n.fallen - o.fallen} / ${n.fallen}`),
        el('td', '', `${n.captured - o.captured} / ${n.captured}`),
        el('td', '', `${n.lost - o.lost} / ${n.lost}`),
        el('td', '', String(scoreOf(world, p.id).total)),
      );
      table.append(tr);
    }
    tip(table, t('stats.playersTip'));
    body.append(table);

    const people = new Map<SettlerKind, number>();
    for (const s of world.settlers) if (s.owner === this.me) people.set(s.kind, (people.get(s.kind) ?? 0) + 1);
    body.append(el('h4', '', t('stats.population')));
    const pop = el('div', 'stats-grid');
    for (const [kind, n] of [...people].sort((a, b) => b[1] - a[1])) pop.append(row(profName(kind), String(n)));
    body.append(pop);

    const types = new Map<BuildingType, number>();
    for (const b of world.buildings.values()) if (b.owner === this.me) types.set(b.type, (types.get(b.type) ?? 0) + 1);
    body.append(el('h4', '', t('stats.buildings')));
    const houses = el('div', 'stats-grid');
    for (const [type, n] of [...types].sort((a, b) => b[1] - a[1])) houses.append(row(buildingName(type), String(n)));
    body.append(houses);
  }
}
