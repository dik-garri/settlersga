import { describe, expect, it } from 'vitest';
import { spawnSettler } from '../src/sim/buildings';
import { hpOf, INTRUDERS, PROFESSIONS } from '../src/sim/config';
import { isTarget } from '../src/sim/intruders';
import { killSettler } from '../src/sim/military';
import { saveWorld } from '../src/sim/save';
import type { Settler } from '../src/sim/types';
import { World } from '../src/sim/world';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

/** A specialist of player 2 standing (idle, without errand) on player 1's land, `off` tiles from the castle door. */
function intruder(w: World, kind: 'pioneer' | 'geologist' | 'thief', off: number): Settler {
  const s = spawnSettler(w, kind, w.castleOf(2));
  const c = w.castleOf(1);
  s.inside = null;
  s.hp = hpOf(kind);
  s.x = s.px = c.door.x + off;
  s.y = s.py = c.door.y + 1;
  // Pinned down by a post on the spot, so he stays on the hostile land for the test.
  s.post = { x: Math.round(s.x), y: Math.round(s.y) };
  return s;
}

describe('specialists on hostile land (Settlers 4)', () => {
  it('a pioneer on enemy land attracts a swordsman from a nearby garrison and dies', () => {
    const w = new World(42, { players: 2 });
    const castle = w.castleOf(1);
    const before = castle.garrison.length;
    const p = intruder(w, 'pioneer', 3);
    run(w, 400);
    expect(w.settlers.includes(p)).toBe(false);
    expect(w.stats.intrudersKilled).toBe(1);
    // The responder goes back into a garrison afterwards.
    run(w, 600);
    expect(castle.garrison.length).toBe(before);
  });

  it('a thief is no target until a fighter of that land comes close', () => {
    const w = new World(42, { players: 2 });
    const c = w.castleOf(1);
    // Beyond the decloak radius of the castle door, within its response radius.
    const t = intruder(w, 'thief', INTRUDERS.decloakRadius + 3);
    run(w, 300);
    expect(isTarget(w, t, 1)).toBe(false);
    expect(w.settlers.includes(t)).toBe(true);
    // A swordsman steps out next to him: unmasked, then cut down.
    w.releaseFighters(c.id, 1);
    const g = w.settlers.find((s) => s.owner === 1 && s.kind === 'soldier' && s.inside === null)!;
    w.orderMove([g.id], Math.round(t.x), Math.round(t.y) + 1);
    run(w, 600);
    expect(w.settlers.includes(t)).toBe(false);
  });

  it('allies are never attacked', () => {
    const w = new World(42, { players: 2, teams: [1, 1] });
    const p = intruder(w, 'pioneer', 3);
    run(w, 600);
    expect(w.settlers.includes(p)).toBe(true);
    expect(w.stats.intrudersKilled).toBe(0);
  });

  it('a garrison down to its keep sends nobody', () => {
    const w = new World(42, { players: 2 });
    const c = w.castleOf(1);
    // Leave only the castle's keep inside.
    const keep = 4;
    for (const id of c.garrison.slice(keep)) killSettler(w, w.getSettler(id)!);
    run(w, 1);
    expect(c.garrison.length).toBe(keep);
    const p = intruder(w, 'geologist', 3);
    run(w, 400);
    expect(w.settlers.includes(p)).toBe(true);
    expect(c.garrison.length).toBe(keep);
  });

  it('a chase survives save and load bit-for-bit', () => {
    const w = new World(42, { players: 2 });
    intruder(w, 'pioneer', 6);
    run(w, 25);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    run(w, 400);
    run(l, 400);
    expect(saveWorld(l)).toEqual(saveWorld(w));
  });
});
