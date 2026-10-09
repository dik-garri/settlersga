/**
 * Blows and shots, as in Settlers 4 (Settlers United wiki: «Unit stats», «Effects of fighting
 * strength», the swordsman, archer and squad leader pages; decompiled `CSoldierRole::LogicUpdateJob`
 * and `CTowerSoldier::LogicUpdate` in S4Forge.RE). Sources and the comparison are in
 * `docs/TIMINGS.md`, «Бой и армия».
 *
 * - Every attack lands: there is no hit chance. Its damage is the level's `damage` (`CombatDef.levels`)
 *   × the owner's fighting strength where the attacker stands (`fieldFactor`: defence at home,
 *   attack strength on anyone else's land), rounded, at least 1.
 * - A squad leader's bonus (`moraleOf`) adds `morale − 1` of that on top; its fraction is rounded up
 *   with that probability (S4 draws a random byte for it).
 * - The target's `armor` (the squad leader's 2) is subtracted, never below 1 damage.
 * - A garrison archer's shot deals `ranged.tower` more, `ranged.towerDoor` more at an enemy standing
 *   at the door, after fighting strength.
 * - In a duel both fighters attack independently, each every `combat.every` ticks (`Settler.reload`
 *   counts down; fractional cadences carry over). A duel starts with a random phase for each, so who
 *   strikes first is not decided by ids; when both are due on the same tick, a coin decides who
 *   strikes first — a fighter killed by that blow does not strike back.
 *
 * All randomness comes from the world RNG, so battles stay deterministic and replay after a load.
 */
import { fighterLevel, hpOf, PROFESSIONS, type CombatDef } from './config';
import { moraleOf } from './field';
import { donkeyHit } from './intruders';
import { killSettler, warStats } from './military';
import { fieldFactor } from './strength';
import type { Settler, SettlerKind } from './types';
import type { World } from './world';

export function combatOf(s: Settler): CombatDef | undefined {
  return PROFESSIONS[s.kind].combat;
}

/** Full hit points of a settler: a fighter's level, a specialist's profession (`hpOf`). */
export function maxHp(s: Settler): number {
  return hpOf(s.kind, s.level);
}

/**
 * Damage of one attack from `hitter` on `victim` (null: a tower's door, which has no armour), `bonus`
 * added after fighting strength (tower archers).
 */
export function hitDamage(w: World, hitter: Settler, victim: Settler | null, bonus = 0): number {
  const base = fighterLevel(hitter.kind, hitter.level)?.damage ?? 0;
  let damage = Math.max(1, Math.round(base * fieldFactor(w, hitter)));
  const extra = damage * (moraleOf(w, hitter) - 1);
  if (extra > 0) {
    const whole = Math.floor(extra);
    damage += whole + (w.rng() < extra - whole ? 1 : 0);
  }
  damage += bonus;
  return Math.max(1, damage - (victim ? (combatOf(victim)?.armor ?? 0) : 0));
}

/** One attack: the victim loses the damage and dies at 0 (a donkey drops its load instead). True if he died. */
export function strike(w: World, hitter: Settler, victim: Settler, bonus = 0): boolean {
  // A loaded donkey is not hurt: it drops its load and goes home (`intruders.ts`).
  if (PROFESSIONS[victim.kind].dropsLoad) {
    donkeyHit(w, victim);
    return false;
  }
  victim.hp -= hitDamage(w, hitter, victim, bonus);
  if (victim.hp > 0) return false;
  const killed = warStats(w, hitter.owner).killed;
  killed[victim.kind] = (killed[victim.kind] ?? 0) + 1;
  killSettler(w, victim);
  return true;
}

/** Lets a fighter's attack timer run on and restarts it after an attack (fractional cadence carries over). */
export function rearm(s: Settler): void {
  s.reload += combatOf(s)?.every ?? 1;
}

/** A duel begins: each side's first attack comes after a random part of his cadence. */
export function startDuel(w: World, a: Settler, b: Settler): void {
  a.reload = w.rng() * (combatOf(a)?.every ?? 1);
  b.reload = w.rng() * (combatOf(b)?.every ?? 1);
}

/**
 * One tick of a duel, run by whichever side's task drives it (the other stands): both timers run;
 * each fighter whose attack is due strikes (both due: a coin picks who goes first). Specialists and
 * other non-fighters never strike back (`strikesBack` false for the second side).
 */
export function duelTick(w: World, a: Settler, b: Settler, strikesBack = true): void {
  a.reload--;
  if (strikesBack) b.reload--;
  const aDue = a.reload <= 0;
  const bDue = strikesBack && b.reload <= 0;
  if (!aDue && !bDue) return;
  const order: [Settler, Settler][] = [];
  if (aDue) order.push([a, b]);
  if (bDue) order.push([b, a]);
  if (order.length === 2 && w.rng() < 0.5) order.reverse();
  for (const [hitter, victim] of order) {
    if (w.dying.has(hitter.id) || w.dying.has(victim.id)) return;
    rearm(hitter);
    if (strike(w, hitter, victim)) return;
  }
}

/**
 * What a fighter is worth in one-on-one duels: hit points × damage per tick at fighting strength
 * `strength` (1 = 100 %), in units of a level-1 swordsman at 100 %. In a duel the winner keeps
 * exactly his worth minus the loser's (hp × dps is what one-on-one fights trade), so a party beats
 * a garrison roughly when the sum of its worth exceeds theirs. Used by the AI for its estimates.
 */
export function duelWorth(kind: SettlerKind, level: number, strength = 1): number {
  const c = PROFESSIONS[kind].combat;
  const lv = fighterLevel(kind, level);
  if (!c || !lv) return 0;
  const unit = PROFESSIONS.soldier.combat!;
  const ref = unit.levels[0];
  const damage = Math.max(1, Math.round(lv.damage * strength));
  return (lv.hp * damage * unit.every) / (ref.hp * ref.damage * c.every);
}
