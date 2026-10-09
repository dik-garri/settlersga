import { describe, expect, it, onTestFinished } from 'vitest';
import { addBuilding, spawnSettler } from '../src/sim/buildings';
import { recomputeTerritory } from '../src/sim/territory';
import { stageStrike } from '../src/sim/aiField';
import { AI, BUILDINGS } from '../src/sim/config';
import { isCutOff, landOf } from '../src/sim/land';
import { enterGarrison, isFighter, killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Building, BuildingType } from '../src/sim/types';
import { World } from '../src/sim/world';
import { startTower } from './helpers';

const MINUTE = 600;
const LONG = 120_000;

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A manned tower of `p` far from its start tower: land cut off from its home and warehouses. */
function outpost(w: World, p: number): Building {
  const m = w.map;
  const c = startTower(w, p);
  const def = BUILDINGS.tower;
  for (let r = 26; r <= 40; r++) {
    for (let a = 0; a < 64; a++) {
      const x = Math.round(c.x + Math.cos((a / 64) * Math.PI * 2) * r);
      const y = Math.round(c.y + Math.sin((a / 64) * Math.PI * 2) * r);
      let ok = true;
      for (let dy = 0; dy <= def.h && ok; dy++) {
        for (let dx = 0; dx < def.w && ok; dx++) {
          if (!m.isBuildable(x + dx, y + dy, 'ground') || m.owner[m.idx(x + dx, y + dy)] !== 0) ok = false;
        }
      }
      if (!ok) continue;
      const t = addBuilding(w, 'tower', x, y, p, true);
      enterGarrison(w, t, spawnSettler(w, 'soldier', c));
      recomputeTerritory(w);
      return t;
    }
  }
  throw new Error('no free spot');
}

/** A finished building of `type` on the piece of land `near` stands on. */
function onPiece(w: World, type: BuildingType, near: Building): Building {
  const def = BUILDINGS[type];
  const piece = landOf(w, near);
  for (let r = 3; r < 12; r++) {
    for (let y = near.y - r; y <= near.y + r; y++) {
      for (let x = near.x - r; x <= near.x + r; x++) {
        if (!w.canPlace(type, x, y, near.owner)) continue;
        const door = { x: x + def.w - 1, y: y + def.h };
        if (w.land[w.map.idx(door.x, door.y)] !== piece) continue;
        return addBuilding(w, type, x, y, near.owner, true);
      }
    }
  }
  throw new Error(`no room for ${type}`);
}

describe('computer player: markets for cut-off land', () => {
  it('builds markets and a donkey ranch, and supplies a cut-off workplace by donkey', { timeout: LONG }, () => {
    const w = new World(42, { players: 2, ai: [1] });
    const t = outpost(w, 1);
    const piece = () => landOf(w, t);
    const mine = onPiece(w, 'woodcutter', t);
    const empty = onPiece(w, 'sawmill', t);
    empty.done = false; // a site nothing reaches: demolished after two checks
    // Goods at home (a pile at the start tower's door, as any producer's): no headquarters.
    const home0 = startTower(w, 1);
    home0.output.plank += 30;
    home0.output.stone += 30;
    home0.output.grain += 20;
    home0.output.water += 20;
    expect(isCutOff(w, mine)).toBe(true);
    const ai = w.ai[0];
    const market = () => [...w.buildings.values()].filter((b) => b.owner === 1 && b.type === 'market');
    for (let i = 0; i < 20 * MINUTE && !(ai.trade?.away && w.buildings.get(ai.trade.away)?.done); i++) w.step();
    expect(w.buildings.has(empty.id)).toBe(false);
    const away = w.buildings.get(ai.trade!.away)!;
    const home = w.buildings.get(ai.trade!.home)!;
    expect(landOf(w, away)).toBe(piece());
    expect(isCutOff(w, home)).toBe(false);
    expect(away.done).toBe(true);
    expect(home.trade?.to).toBe(away.id);
    expect(market().length).toBe(2);
    expect([...w.buildings.values()].some((b) => b.owner === 1 && b.type === 'donkeyranch')).toBe(true);
    // Nothing but the market went onto the cut-off piece (nothing else could be built there).
    for (const b of w.buildings.values()) {
      if (b.owner === 1 && landOf(w, b) === piece()) expect([t.id, mine.id, away.id]).toContain(b.id);
    }
    // What the piece makes and does not use goes home: the far market sends it on.
    mine.output.log += 6;
    run(w, AI.tradeEvery + AI.thinkEvery);
    expect(away.trade?.to).toBe(home.id);
    expect(away.trade?.orders.log).toBeDefined();
    expect(ai.stats.traded).toBeGreaterThan(0);
  });
});

describe('computer player: field orders', () => {
  /** Player 1's fighters standing in the field on the edge of player 2's land, in its start tower's sight. */
  function intruders(w: World, n: number) {
    const c2 = startTower(w, 2);
    const out = [];
    for (let k = 0; k < n; k++) {
      const s = spawnSettler(w, 'soldier', startTower(w, 1));
      s.inside = null;
      s.home = null;
      // Four abreast: all within its sight (its land and a band beyond it, `FOG`).
      s.x = s.px = c2.door.x + 3 + (k % 4);
      s.y = s.py = c2.door.y + 3 + Math.floor(k / 4);
      s.post = { x: Math.round(s.x), y: Math.round(s.y) };
      out.push(s);
    }
    return out;
  }

  it('meets enemy field units near its land with a field squad, then goes back to its rally', () => {
    const w = new World(42, { players: 2, ai: [2] });
    const c2 = startTower(w, 2);
    // Extra swordsmen inside (test setup beyond the tower's slots; in play a fortress would hold them).
    for (let k = 0; k < 6; k++) enterGarrison(w, c2, spawnSettler(w, 'soldier', c2));
    const enemy = intruders(w, 2);
    // Keep them from walking off or fighting back for the check.
    for (const s of enemy) s.hp = 1e9;
    run(w, AI.thinkEvery * 2);
    const ai = w.ai[0];
    expect(ai.defense?.ids.length).toBeGreaterThanOrEqual(Math.ceil(2 * AI.defendRatio));
    for (const id of ai.defense!.ids) {
      const s = w.getSettler(id)!;
      expect(s.inside).toBeNull();
      expect(s.post).toBeTruthy();
    }
    expect(ai.stats.defended).toBe(1);
    // Saved and loaded with the squad out, the game goes on identically.
    const copy = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 100);
    run(copy, 100);
    expect(saveWorld(copy)).toEqual(saveWorld(w));
    // The intruders gone, the squad joins the others at its rally point (Settlers 4: free fighters
    // stand about; its towers call in whom they wish).
    for (const s of enemy) killSettler(w, s);
    run(w, AI.thinkEvery * 2 + 600);
    expect(ai.defense).toBeUndefined();
    const rally = ai.rally!;
    const out = w.settlers.filter((s) => s.owner === 2 && isFighter(s) && s.post);
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) expect(Math.hypot(s.post!.x - rally.x, s.post!.y - rally.y)).toBeLessThanOrEqual(AI.rallySlack + 2);
  });

  it('stays behind its walls when it cannot match them in the open', () => {
    const w = new World(42, { players: 2, ai: [2] });
    // More of them than all its fighters outside its start tower (S4's start help included).
    const own = w.settlers.filter((s) => s.owner === 2 && isFighter(s)).length;
    for (const s of intruders(w, own + 2)) s.hp = 1e9;
    run(w, AI.thinkEvery * 2);
    const ai = w.ai[0];
    expect(ai.defense).toBeUndefined();
    // Nobody sent against them: its free fighters only gather at its rally point.
    for (const s of w.settlers.filter((q) => q.owner === 2 && isFighter(q) && q.post)) {
      expect(Math.hypot(s.post!.x - ai.rally!.x, s.post!.y - ai.rally!.y)).toBeLessThanOrEqual(AI.rallySlack + 2);
    }
  });

  it('takes a free squad leader along, and the squad forms round him', () => {
    const w = new World(42, { players: 2, ai: [2] });
    const c2 = startTower(w, 2);
    for (const s of w.settlers.filter((q) => q.owner === 2 && isFighter(q))) killSettler(w, s);
    w.step();
    for (let k = 0; k < 8; k++) enterGarrison(w, c2, spawnSettler(w, 'soldier', c2));
    // The leader never goes into a building: he stands by it.
    const leader = spawnSettler(w, 'leader', c2);
    leader.inside = null;
    // An enemy tower a walk away from the start tower.
    const def = BUILDINGS.tower;
    let target: Building | undefined;
    for (let r = 16; r < 26 && !target; r++) {
      for (let a = 0; a < 32 && !target; a++) {
        const x = Math.round(c2.x + Math.cos((a / 32) * Math.PI * 2) * r);
        const y = Math.round(c2.y + Math.sin((a / 32) * Math.PI * 2) * r);
        let ok = true;
        for (let dy = 0; dy <= def.h && ok; dy++) {
          for (let dx = 0; dx < def.w && ok; dx++) if (!w.map.isBuildable(x + dx, y + dy, 'ground')) ok = false;
        }
        if (ok) target = addBuilding(w, 'tower', x, y, 1, true);
      }
    }
    enterGarrison(w, target!, spawnSettler(w, 'soldier', startTower(w, 1)));
    const ai = w.ai[0];
    // Three spares out of the tower, and the leader comes along.
    expect(stageStrike(w, ai, target!, 3)).toBe(4);
    expect(ai.strike!.ids).toContain(leader.id);
    for (const id of ai.strike!.ids) {
      if (id !== leader.id) expect(w.getSettler(id)!.post!.leader).toBe(leader.id);
    }
  });

  it('gathers its strike group in the field, then attacks together', { timeout: LONG }, () => {
    // Staging is off by default (see AI.stageStrike); this checks the mechanism when switched on.
    const saved = AI.stageStrike;
    (AI as { stageStrike: boolean }).stageStrike = true;
    onTestFinished(() => {
      (AI as { stageStrike: boolean }).stageStrike = saved;
    });
    const w = new World(7, { players: 2, ai: [2] });
    const attacks: { ids: readonly number[]; target: number; explored: boolean }[] = [];
    const orderAttack = w.orderAttack.bind(w);
    w.orderAttack = (ids, target, player) => {
      const b = w.buildings.get(target);
      if (player === 2 && b) attacks.push({ ids, target, explored: w.isExplored(b.door.x, b.door.y, 2) });
      return orderAttack(ids, target, player);
    };
    const ai = w.ai[0];
    let staged: { target: number; ids: number[] } | undefined;
    for (let i = 0; i < 100 * MINUTE && !staged; i++) {
      w.step();
      if (ai.strike) staged = { target: ai.strike.target, ids: [...ai.strike.ids] };
    }
    expect(staged).toBeDefined();
    const target = w.buildings.get(staged!.target)!;
    // Out of the garrisons, on posts short of the target, beyond its archers' range.
    for (const id of staged!.ids) {
      const s = w.getSettler(id)!;
      expect(s.inside).toBeNull();
      expect(Math.hypot(s.post!.x - target.door.x, s.post!.y - target.door.y)).toBeGreaterThan(4);
    }
    for (let i = 0; i < AI.stageTimeout + AI.thinkEvery && ai.strike; i++) w.step();
    expect(ai.strike).toBeUndefined();
    const strike = attacks.find((a) => a.target === staged!.target);
    expect(strike).toBeDefined();
    expect(strike!.explored).toBe(true);
    expect(strike!.ids.length).toBeGreaterThan(0);
    expect(strike!.ids.every((id) => staged!.ids.includes(id))).toBe(true);
  });
});
