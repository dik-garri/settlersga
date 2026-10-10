/**
 * The command layer (roadmap phase 6, step 1): validation, ordering, saving the queue, checksums and
 * replays — an AI-against-AI game played again from seed + setup + command log ends in the same state.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hashValue, stateChecksum } from '../src/sim/checksum';
import { COMMAND_KINDS, SPECS, type Command } from '../src/sim/commands';
import { saveWorld } from '../src/sim/save';
import { playReplay, replayOf, verifyReplay } from '../src/sim/replay';
import { World } from '../src/sim/world';
import { base, startTower } from './helpers';

function run(w: World, ticks: number): void {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A spot near the start where the type fits. */
function spotFor(w: World, type: Parameters<World['canPlace']>[0], dx: number, dy: number, player = 1) {
  const c = base(w, player);
  let best: { x: number; y: number } | null = null;
  let bestD = Infinity;
  for (let y = 0; y < w.map.h; y++) {
    for (let x = 0; x < w.map.w; x++) {
      if (!w.canPlace(type, x, y, player)) continue;
      const d = Math.hypot(x - c.x - dx, y - c.y - dy);
      if (d < bestD) {
        bestD = d;
        best = { x, y };
      }
    }
  }
  return best!;
}

describe('commands: validation', () => {
  it('refuses malformed commands without touching the world or the log', () => {
    const w = new World(3, { players: 2 });
    run(w, 50);
    const before = stateChecksum(w);
    const at = spotFor(w, 'woodcutter', 4, 0);
    const bad: unknown[] = [
      null,
      42,
      [],
      { kind: 'nonsense', player: 1 },
      { kind: 'toString', player: 1 },
      { kind: 'placeBuilding', player: 0, type: 'woodcutter', x: at.x, y: at.y },
      { kind: 'placeBuilding', player: 3, type: 'woodcutter', x: at.x, y: at.y },
      { kind: 'placeBuilding', player: 1.5, type: 'woodcutter', x: at.x, y: at.y },
      { kind: 'placeBuilding', player: 1, type: 'palace', x: at.x, y: at.y },
      { kind: 'placeBuilding', player: 1, type: 'constructor', x: at.x, y: at.y },
      { kind: 'placeBuilding', player: 1, type: 'woodcutter', x: String(at.x), y: at.y },
      { kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x + 0.5, y: at.y },
      { kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x },
      { kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x, y: at.y, tick: 'soon' },
      { kind: 'orderWorkers', player: 1, prof: 'wizard', count: 3 },
      { kind: 'orderWorkers', player: 1, prof: 'builder', count: NaN },
      { kind: 'orderWorkers', player: 1, prof: 'builder', count: Infinity },
      { kind: 'orderTool', player: 1, res: 'gold_bar', count: 1 },
      { kind: 'moveTransport', player: 1, res: 'plank', how: 'sideways' },
      { kind: 'orderMove', player: 1, ids: 'all', x: 10, y: 10 },
      { kind: 'orderMove', player: 1, ids: [1, 'two'], x: 10, y: 10 },
      { kind: 'orderMove', player: 1, ids: new Array(6000).fill(1), x: 10, y: 10 },
      { kind: 'setWorkArea', player: 1, id: 1, at: { x: 'a', y: 2 } },
      { kind: 'setPriority', player: 1, id: 1, on: 'yes' },
      { kind: 'grant', player: 1, res: 'plank' },
    ];
    for (const cmd of bad) expect([false, 0, null, undefined]).toContain(w.apply(cmd as Command));
    for (const cmd of bad) expect(w.schedule(cmd as Command)).toBe(false);
    expect(w.commandLog).toHaveLength(0);
    expect(w.pendingCommands).toHaveLength(0);
    expect(stateChecksum(w)).toBe(before);
  });

  it('refuses stale and foreign targets the same way, harmlessly', () => {
    const w = new World(3, { players: 2 });
    run(w, 50);
    const theirs = startTower(w, 2);
    const before = stateChecksum(w);
    expect(w.apply({ kind: 'demolish', player: 1, id: 99999 })).toBe(false);
    expect(w.apply({ kind: 'setStopped', player: 1, id: 99999, on: true })).toBe(false);
    expect(w.apply({ kind: 'setPriority', player: 1, id: theirs.id, on: true })).toBe(false);
    expect(w.apply({ kind: 'fillGarrison', player: 1, id: theirs.id })).toBe(false);
    expect(w.apply({ kind: 'releaseFighters', player: 1, id: theirs.id, count: 5 })).toBe(0);
    expect(w.apply({ kind: 'orderMove', player: 1, ids: [999999], x: 10, y: 10 })).toBe(0);
    expect(w.apply({ kind: 'setTradeRoute', player: 1, id: theirs.id, to: null })).toBe(false);
    expect(stateChecksum(w)).toBe(before);
  });

  it('has checks and a handler for every kind, and the World shorthands are commands', () => {
    expect(COMMAND_KINDS.length).toBeGreaterThanOrEqual(33);
    for (const k of COMMAND_KINDS) {
      expect(typeof SPECS[k].run).toBe('function');
      // The takeover names nobody but its player.
      if (k !== 'aiTakeover') expect(Object.keys(SPECS[k].fields).length).toBeGreaterThan(0);
    }
    const w = new World(3);
    const at = spotFor(w, 'woodcutter', 4, 0);
    const b = w.placeBuilding('woodcutter', at.x, at.y)!;
    w.setPriority(b.id, true);
    expect(w.commandLog.map((r) => r.cmd)).toEqual([
      { kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x, y: at.y },
      { kind: 'setPriority', player: 1, id: b.id, on: true },
    ]);
  });

  it('keeps nothing of the caller in the log', () => {
    const w = new World(3);
    const ids = [1, 2, 3];
    w.apply({ kind: 'orderHold', player: 1, ids });
    ids.push(4);
    expect(w.commandLog[0].cmd).toEqual({ kind: 'orderHold', player: 1, ids: [1, 2, 3] });
  });
});

describe('commands: scheduling', () => {
  it('applies scheduled commands after their tick, by tick, then player, then sequence', () => {
    const w = new World(3, { players: 2 });
    const t0 = w.tick;
    w.schedule({ kind: 'orderWorkers', player: 2, prof: 'builder', count: 7, tick: t0 + 2 });
    w.schedule({ kind: 'orderWorkers', player: 1, prof: 'builder', count: 8, tick: t0 + 2, seq: 5 });
    w.schedule({ kind: 'orderWorkers', player: 1, prof: 'digger', count: 9, tick: t0 + 2, seq: 1 });
    w.schedule({ kind: 'orderWorkers', player: 2, prof: 'digger', count: 2, tick: t0 + 1 });
    w.step();
    expect(w.commandLog).toHaveLength(0);
    w.step();
    expect(w.commandLog.map((r) => [r.tick, r.cmd.player, r.cmd.kind === 'orderWorkers' && r.cmd.count])).toEqual([[t0 + 1, 2, 2]]);
    w.flushCommands();
    expect(w.commandLog.map((r) => [r.tick, r.cmd.player, r.cmd.kind === 'orderWorkers' && r.cmd.count])).toEqual([
      [t0 + 1, 2, 2],
      [t0 + 2, 1, 9],
      [t0 + 2, 1, 8],
      [t0 + 2, 2, 7],
    ]);
    expect(w.pendingCommands).toHaveLength(0);
    expect(w.players[0].economy!.orders.builder).toBe(8);
    expect(w.players[1].economy!.orders.builder).toBe(7);
  });

  it('saves the queue of commands not yet applied', () => {
    const a = new World(5);
    run(a, 100);
    a.schedule({ kind: 'orderWorkers', player: 1, prof: 'digger', count: 9, tick: a.tick + 50 });
    const b = World.load(JSON.parse(JSON.stringify(saveWorld(a))));
    expect(b.pendingCommands).toEqual(a.pendingCommands);
    expect(stateChecksum(b)).toBe(stateChecksum(a));
    run(a, 60);
    run(b, 60);
    expect(saveWorld(b)).toEqual(saveWorld(a));
    expect(b.players[0].economy!.orders.digger).toBe(9);
  });
});

describe('commands: checksum', () => {
  it('is stable, independent of key order, survives save and load and notices a change', () => {
    expect(hashValue({ a: 1, b: [2, { c: 'x', d: null }] })).toBe(hashValue({ b: [2, { d: null, c: 'x' }], a: 1 }));
    expect(hashValue({ a: 1, u: undefined })).toBe(hashValue({ a: 1 }));
    expect(hashValue(-0)).toBe(hashValue(0));
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
    expect(hashValue('1')).not.toBe(hashValue(1));
    const w = new World(11);
    run(w, 300);
    const sum = stateChecksum(w);
    expect(sum).toMatch(/^[0-9a-f]{8}$/);
    expect(stateChecksum(w)).toBe(sum);
    expect(stateChecksum(World.load(JSON.parse(JSON.stringify(saveWorld(w)))))).toBe(sum);
    const twin = new World(11);
    run(twin, 300);
    expect(stateChecksum(twin)).toBe(sum);
    twin.settlers[0].x += 0.001;
    expect(stateChecksum(twin)).not.toBe(sum);
    run(w, 1);
    expect(stateChecksum(w)).not.toBe(sum);
  });
});

describe('commands: replay', () => {
  it('an AI-against-AI game replays from seed + setup + log to the same state', () => {
    const minutes = 30;
    const w = new World(42, { players: 2, ai: [1, 2] });
    const mid = 12 * 600;
    let midSum = '';
    for (let i = 0; i < minutes * 600; i++) {
      w.step();
      if (w.tick === mid) midSum = stateChecksum(w);
    }
    expect(w.commandLog.length).toBeGreaterThan(100);
    expect(w.commandLog.every((r) => r.ai)).toBe(true);
    const file = replayOf(w)!;
    let replayMid = '';
    const again = playReplay(JSON.parse(JSON.stringify(file)), (r) => {
      if (r.tick === mid) replayMid = stateChecksum(r);
    });
    expect(replayMid).toBe(midSum);
    expect(again.tick).toBe(w.tick);
    expect(stateChecksum(again)).toBe(file.checksum);
    // The replay applied the very same commands at the very same points.
    expect(again.commandLog).toEqual(file.log);
    // Nobody thought in the replay: its computer players' memory is as it was at the start.
    expect(again.ai).toEqual(new World(42, { players: 2, ai: [1, 2] }).ai);
  });

  it('replays a human player giving orders between ticks against a computer player', () => {
    const w = new World(8, { players: 2, ai: [2] });
    run(w, 200);
    const at = spotFor(w, 'woodcutter', 5, -1);
    expect(w.issue({ kind: 'placeBuilding', player: 1, type: 'woodcutter', x: at.x, y: at.y })).toBe(true);
    const wc = w.buildingAt(at.x, at.y)!;
    w.issue({ kind: 'setPriority', player: 1, id: wc.id, on: true });
    run(w, 400);
    const st = spotFor(w, 'stonecutter', -5, 3);
    w.issue({ kind: 'placeBuilding', player: 1, type: 'stonecutter', x: st.x, y: st.y });
    w.issue({ kind: 'orderWorkers', player: 1, prof: 'builder', count: 6 });
    w.issue({ kind: 'grant', player: 1, res: 'plank', n: 5 });
    w.issue({ kind: 'demolish', player: 1, id: 123456 }); // stale: refused the same way in the replay
    run(w, 1500);
    w.issue({ kind: 'setStopped', player: 1, id: wc.id, on: true }); // after the last tick
    const file = replayOf(w)!;
    expect(file.log.some((r) => !r.ai)).toBe(true);
    expect(file.log.some((r) => r.ai)).toBe(true);
    expect(verifyReplay(file)).toEqual({ ok: true, expected: file.checksum, got: file.checksum });
  });

  it('notices a replay that does not match', () => {
    const w = new World(8);
    run(w, 100);
    const at = spotFor(w, 'woodcutter', 5, -1);
    w.placeBuilding('woodcutter', at.x, at.y);
    run(w, 300);
    const file = replayOf(w)!;
    expect(verifyReplay({ ...file, log: [] }).ok).toBe(false);
  });
});

describe('commands: the interface changes the world only through commands', () => {
  it('src/ui, src/tutorial, src/render and main.ts call no World command method directly', () => {
    const shorthands = [
      ...COMMAND_KINDS,
      'orderSpecialist', // orderWorkers
      'removeBuilding',
      'defeatPlayer',
    ];
    const call = new RegExp(`\\b(world|w|this\\.world)\\.(${shorthands.join('|')})\\(`);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts')) files.push(p);
      }
    };
    for (const d of ['src/ui', 'src/tutorial', 'src/render', 'src/audio']) walk(d);
    files.push('src/main.ts');
    const offenders = files.flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, k) => [line, k] as const)
        .filter(([line]) => call.test(line) && !line.trim().startsWith('//') && !line.trim().startsWith('*'))
        .map(([line, k]) => `${f}:${k + 1}: ${line.trim()}`),
    );
    expect(offenders).toEqual([]);
  });
});
