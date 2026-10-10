import { describe, expect, it } from 'vitest';
import { addBuilding, spawnSettler } from '../src/sim/buildings';
import { BUILDINGS, buildersOf, buildingDamage, buildingHp, PROFESSIONS, SABOTEUR } from '../src/sim/config';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import { canSabotage } from '../src/sim/specialists';
import { recomputeTerritory } from '../src/sim/territory';
import type { Building, Settler } from '../src/sim/types';
import { World } from '../src/sim/world';
import { defaultSetup, worldArgs } from '../src/ui/setup';
import { base } from './helpers';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** The player's saboteur, recruited on order (a carrier with a pickaxe). */
function recruit(w: World, p = 1): Settler {
  expect(w.orderSpecialist('saboteur', 1, p)).toBe(true);
  for (let i = 0; i < 2000 && !w.settlers.some((s) => s.owner === p && s.kind === 'saboteur'); i++) w.step();
  const s = w.settlers.find((o) => o.owner === p && o.kind === 'saboteur');
  expect(s).toBeDefined();
  run(w, 50);
  return s!;
}

/** Two players with saboteurs allowed; a finished woodcutter's hut of player 2, explored by player 1. */
function target(): { w: World; hut: Building } {
  const w = new World(42, { players: 2, saboteurs: true });
  const other = base(w, 2);
  let hut: Building | null = null;
  for (let r = 5; r < 14 && !hut; r++) {
    for (let dx = -r; dx <= r && !hut; dx++) {
      if (w.canPlace('woodcutter', other.x + dx, other.y + r, 2)) hut = addBuilding(w, 'woodcutter', other.x + dx, other.y + r, 2, true);
    }
  }
  expect(hut).not.toBeNull();
  recomputeTerritory(w);
  w.map.explored[w.map.idx(hut!.door.x, hut!.door.y)] |= 1;
  // Nobody of player 2's standing outside to unmask and chase him.
  for (const s of w.settlers.filter((o) => o.owner === 2 && o.inside === null && (o.kind === 'soldier' || o.kind === 'archer'))) killSettler(w, s);
  return { w, hut: hut! };
}

describe('saboteur (Settlers 4, network games only)', () => {
  it('a blow does (6 − 5) / 2, at least 1; buildings stand by their cost', () => {
    expect(buildingDamage(SABOTEUR.damage)).toBe(1);
    expect(buildingDamage(24)).toBe(9); // a level-1 axe warrior
    expect(buildingDamage(0)).toBe(0);
    expect(buildingHp('bigtower')).toBeGreaterThan(2 * buildingHp('tower') - 1);
    expect(buildingHp('fortress')).toBeLessThanOrEqual(255);
    expect(PROFESSIONS.saboteur.tool).toBe('pickaxe');
    expect(PROFESSIONS.saboteur.hp).toBe(25);
    expect(PROFESSIONS.saboteur.cloaked).toBe(true);
    expect(PROFESSIONS.saboteur.sight).toBeUndefined();
  });

  it('can be ordered only where the game allows him: network games', () => {
    const w = new World(42);
    expect(w.orderSpecialist('saboteur', 1)).toBe(false);
    expect(new World(42, { saboteurs: true }).orderSpecialist('saboteur', 1)).toBe(true);
    expect(worldArgs(defaultSetup(), 1).opts.saboteurs).toBeUndefined();
    expect(worldArgs({ ...defaultSetup(), mode: 'network' }, 1).opts.saboteurs).toBe(true);
  });

  it('destroys an enemy building blow by blow, unmasked as he strikes', () => {
    const { w, hut } = target();
    const s = recruit(w);
    expect(s.exposed).toBeFalsy();
    expect(w.sendSaboteur(hut.id)).toBe(true);
    let struck = false;
    for (let i = 0; i < 6000 && w.buildings.has(hut.id); i++) {
      w.step();
      if (hut.hp !== undefined && !struck) {
        struck = true;
        expect(s.exposed).toBe(true);
        expect(s.tasks[0]?.t).toBe('sabotage');
      }
    }
    expect(struck).toBe(true);
    expect(w.buildings.has(hut.id)).toBe(false);
    expect(w.ruins.length).toBeGreaterThan(0);
    expect(s.kind).toBe('saboteur');
  });

  it('never attacks his own, an ally\'s, an unexplored or an immune building', () => {
    const { w, hut } = target();
    recruit(w);
    const own = [...w.buildings.values()].find((b) => b.owner === 1)!;
    expect(w.sendSaboteur(own.id)).toBe(false);
    w.map.explored[w.map.idx(hut.door.x, hut.door.y)] = 0;
    expect(w.sendSaboteur(hut.id)).toBe(false);
    w.map.explored[w.map.idx(hut.door.x, hut.door.y)] |= 1;
    BUILDINGS.woodcutter.sabotageImmune = true;
    try {
      expect(canSabotage(w, hut, 1)).toBe(false);
      expect(w.sendSaboteur(hut.id)).toBe(false);
    } finally {
      delete BUILDINGS.woodcutter.sabotageImmune;
    }
    const allies = new World(42, { players: 2, teams: [1, 1], saboteurs: true });
    const theirs = [...allies.buildings.values()].find((b) => b.owner === 2)!;
    allies.map.explored[allies.map.idx(theirs.door.x, theirs.door.y)] |= 1;
    expect(canSabotage(allies, theirs, 1)).toBe(false);
  });

  it('no more saboteurs on a building than it has builder spots', () => {
    const { w, hut } = target();
    const n = buildersOf('woodcutter');
    for (let k = 0; k <= n; k++) {
      const s = spawnSettler(w, 'saboteur', [...w.buildings.values()].find((b) => b.owner === 1)!);
      s.inside = null;
      s.hp = PROFESSIONS.saboteur.hp!;
    }
    for (let k = 0; k <= n; k++) w.sendSaboteur(hut.id);
    run(w, 400);
    const at = w.settlers.filter((s) => s.kind === 'saboteur' && s.tasks.some((t) => t.t === 'sabotage' && t.b === hut.id));
    expect(at.length).toBe(n);
  });

  it('is unmasked by a fighter close by and cut down on hostile land', () => {
    const { w, hut } = target();
    const s = recruit(w);
    const guards: number[] = [];
    for (let k = 0; k < 2; k++) {
      const g = spawnSettler(w, 'soldier', hut);
      g.inside = null;
      g.hp = 100;
      guards.push(g.id);
    }
    w.orderMove(guards, hut.door.x + 1, hut.door.y + 1, 2);
    w.sendSaboteur(hut.id);
    run(w, 8000);
    expect(w.settlers.includes(s)).toBe(false);
    expect(w.stats.intrudersKilled).toBe(1);
  });

  it('a saboteur at work survives save and load bit-for-bit', () => {
    const { w, hut } = target();
    recruit(w);
    w.sendSaboteur(hut.id);
    run(w, 500);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 1500);
    run(l, 1500);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
