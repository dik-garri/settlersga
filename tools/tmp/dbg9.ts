import { spawnSettler, centerOf } from '../../src/sim/buildings';
import { enterGarrison, isFighter, killSettler } from '../../src/sim/military';
import { World } from '../../src/sim/world';
import { placeNear } from '../scenario';
const w = new World(42, { players: 2 });
const st = (p: number) => {
  const h = w.homeOf(p);
  return w.buildingAt(h.x, h.y)!;
};
const [a, b] = [st(1), st(2)];
a.output.plank = 80;
a.output.stone = 40;
for (let k = 0; k < 6; k++) spawnSettler(w, 'soldier', a).inside = null;
const f2 = () => w.settlers.filter((s) => s.owner === 2 && isFighter(s) && !w.dying.has(s.id));
const keep = f2().find((s) => s.kind === 'soldier' && s.home === b.id)!;
for (const s of f2()) if (s !== keep) killSettler(w, s);
keep.hp = 1;
w.step();
const ca = centerOf(a);
const cb = centerOf(b);
let tower = null as ReturnType<typeof placeNear>;
for (const k of [0.2, 0.38]) {
  tower = placeNear(w, 'tower', Math.round(ca.x + (cb.x - ca.x) * k), Math.round(ca.y + (cb.y - ca.y) * k), 5, 1)!;
  for (let i = 0; i < 3000; i++) w.step();
}
for (let k = 0; k < 2; k++) enterGarrison(w, tower!, spawnSettler(w, 'soldier', tower!));
const party = w.attackerComposition(b.id, 2, 1);
console.log('party', party.map((s) => `${s.id} home${s.home} at ${s.x.toFixed(0)},${s.y.toFixed(0)}`), 'target door', b.door);
console.log(w.attack(b.id, 2, 1));
for (let i = 0; i < 3000 && !w.isDefeated(2); i++) {
  w.step();
  if (i % 300 === 0)
    console.log(
      i,
      party.map((s) => `${s.id}:${s.x.toFixed(1)},${s.y.toFixed(1)} ${s.tasks.map((t) => t.t).join('/')} opp${s.opponent} dying${w.dying.has(s.id)}`).join(' | '),
      'door',
      b.doorHp,
      'keep hp',
      keep.hp,
      'owner',
      b.owner,
    );
}
