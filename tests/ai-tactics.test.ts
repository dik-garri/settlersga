import { describe, expect, it } from 'vitest';
import { partySize, siegeGoals } from '../src/sim/ai';
import { AI } from '../src/sim/config';
import { centerOf } from '../src/sim/buildings';
import { startPositions, World } from '../src/sim/world';
import { placeNear } from '../tools/scenario';
import { startTower } from './helpers';

const MINUTE = 600;
const LONG = 120_000;

/** Marks a tile explored for a player (what its buildings or settlers would have seen). */
function explore(w: World, x: number, y: number, player: number): void {
  w.map.explored[w.map.idx(x, y)] |= 1 << (player - 1);
}

describe('AI assault tactics', () => {
  it('sends what a target takes with a margin, keeping the rest home — but everything at a decisive target', () => {
    // 40 fighters of power 1 each against a tower holding one defender (defence factor 1.2).
    const small = partySize(40, 40, 1.2, false);
    expect(small).toBeLessThan(40);
    expect(small).toBeGreaterThanOrEqual(AI.minAttackers);
    expect(small).toBeGreaterThanOrEqual(Math.ceil(AI.attackRatio * 1.2 + 1));
    // A strong garrison takes more; never more than there are.
    expect(partySize(40, 40, 12, false)).toBeGreaterThan(small);
    expect(partySize(40, 40, 100, false)).toBe(40);
    // The enemy's last known military building may put him out (no occupied tower left): all of them.
    expect(partySize(40, 40, 1.2, true)).toBe(40);
    expect(partySize(2, 2, 1, false)).toBe(2);
  });

  it('besieges an enemy whose towers it has not seen at the start position nearest to the enemy buildings it knows', () => {
    const w = new World(42, { players: 2 });
    const enemy = startTower(w, 2);
    const hut = placeNear(w, 'woodcutter', enemy.x + 4, enemy.y + 1, 12, 2)!;
    expect(hut).not.toBeNull();
    expect(siegeGoals(w, 1)).toEqual([]);
    // Player 1 has seen the hut, not the start tower: the enemy's home is presumed at player 2's start.
    explore(w, hut.door.x, hut.door.y, 1);
    const [presumed] = siegeGoals(w, 1);
    expect(presumed.seen).toBe(false);
    expect(presumed.owner).toBe(2);
    const start = startPositions(w.map.w, 2)[1];
    expect({ x: presumed.x, y: presumed.y }).toEqual(start);
    // Once its door is explored, the goal is the start tower itself (the enemy's heart).
    explore(w, enemy.door.x, enemy.door.y, 1);
    const [seen] = siegeGoals(w, 1);
    expect(seen.seen).toBe(true);
    expect({ x: seen.x, y: seen.y }).toEqual(centerOf(enemy));
  });

  it('a stronger AI that knows only its rival\'s huts still finds and defeats it', { timeout: LONG }, () => {
    // 96×96, seed 8: one side stalls with a handful of soldiers; the other only ever sees two of its
    // civil buildings from its towers. It used to sit at its unit cap for the rest of the game.
    const w = new World(8, { size: 96, players: 2, ai: [1, 2] });
    for (let i = 0; i < 110 * MINUTE && w.outcome(1) === 'playing'; i++) w.step();
    expect(w.isDefeated(1) || w.isDefeated(2)).toBe(true);
  });
});
