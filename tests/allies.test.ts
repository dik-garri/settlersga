import { describe, expect, it } from 'vitest';
import { knownEnemies } from '../src/sim/ai';
import { inBuildingSight } from '../src/sim/fog';
import { saveWorld } from '../src/sim/save';
import { World } from '../src/sim/world';

function run(w: World, ticks: number) {
  for (let i = 0; i < ticks; i++) w.step();
}

describe('shared vision of allies', () => {
  it('a player sees and knows what its allies see, but not what its foes see', () => {
    const w = new World(42, { size: 96, players: 4, teams: [1, 1, 2, 2] });
    run(w, 30);
    const c2 = w.castleOf(2);
    const c3 = w.castleOf(3);
    // Player 1 never went near its ally's castle, yet sees it through the ally.
    expect(w.isExplored(c2.door.x, c2.door.y, 1)).toBe(true);
    expect(w.isVisible(c2.door.x, c2.door.y, 1)).toBe(true);
    expect(inBuildingSight(w, w.map.idx(c2.door.x, c2.door.y), 1)).toBe(true);
    // A foe's castle stays hidden from it.
    expect(w.isExplored(c3.door.x, c3.door.y, 1)).toBe(false);
    // Players 3 and 4 share theirs too.
    expect(w.isExplored(c3.door.x, c3.door.y, 4)).toBe(true);
  });

  it('without teams nobody sees through anyone else', () => {
    const w = new World(42, { size: 96, players: 4 });
    run(w, 30);
    const c2 = w.castleOf(2);
    expect(w.isExplored(c2.door.x, c2.door.y, 1)).toBe(false);
    expect(w.isVisible(c2.door.x, c2.door.y, 1)).toBe(false);
  });

  it('what an ally has explored counts for the AI too, and survives a save', () => {
    const w = new World(42, { size: 96, players: 4, teams: [1, 1, 2, 2] });
    run(w, 30);
    // Player 2 learns of player 3's castle: player 1 knows it as well.
    const c3 = w.castleOf(3);
    w.map.explored[w.map.idx(c3.door.x, c3.door.y)] |= 1 << 1;
    expect(knownEnemies(w, 1).some((e) => e.b === c3)).toBe(true);
    expect(knownEnemies(w, 1).some((e) => e.b.owner === 2)).toBe(false);
    const l = World.load(JSON.parse(JSON.stringify(saveWorld(w))));
    expect(knownEnemies(l, 1).some((e) => e.b.id === c3.id)).toBe(true);
    expect(l.isExplored(w.castleOf(2).door.x, w.castleOf(2).door.y, 1)).toBe(true);
  });
});
