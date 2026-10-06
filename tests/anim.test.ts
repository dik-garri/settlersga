import { describe, expect, it } from 'vitest';
import {
  DIRS,
  dirFromTileVelocity,
  dirTowards,
  FACES_AWAY,
  idleDir,
  MIRRORED,
  PAINTED_DIR,
  STRIDE_TILES,
  WALK_FRAMES,
  walkFrame,
  WORK_FRAMES,
  workFrame,
} from '../src/render/anim';
import { ACTION_IDS, ACTIONS, GATHER_ACTION, PLANT_ACTION, styleOf } from '../src/render/animConfig';
import { PROFESSIONS } from '../src/sim/config';
import type { SettlerKind } from '../src/sim/types';

const dir = (name: (typeof DIRS)[number]) => DIRS.indexOf(name);

describe('direction from velocity', () => {
  it('maps tile steps to the screen direction they appear in', () => {
    // +x goes right-down on screen, +y left-down, +x+y straight down.
    expect(dirFromTileVelocity(1, 0, 0)).toBe(dir('SE'));
    expect(dirFromTileVelocity(0, 1, 0)).toBe(dir('SW'));
    expect(dirFromTileVelocity(1, 1, 0)).toBe(dir('S'));
    expect(dirFromTileVelocity(-1, -1, 0)).toBe(dir('N'));
    expect(dirFromTileVelocity(1, -1, 0)).toBe(dir('E'));
    expect(dirFromTileVelocity(-1, 1, 0)).toBe(dir('W'));
    expect(dirFromTileVelocity(-1, 0, 0)).toBe(dir('NW'));
    expect(dirFromTileVelocity(0, -1, 0)).toBe(dir('NE'));
  });

  it('keeps the fallback when standing still', () => {
    expect(dirFromTileVelocity(0, 0, 5)).toBe(5);
    expect(dirTowards(3, 3, 3, 3, 6)).toBe(6);
  });

  it('is scale-invariant and always in range', () => {
    for (let a = 0; a < 64; a++) {
      const dx = Math.cos(a);
      const dy = Math.sin(a * 1.7);
      const d = dirFromTileVelocity(dx, dy, 0);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThan(8);
      expect(dirFromTileVelocity(dx * 0.01, dy * 0.01, 0)).toBe(d);
    }
  });

  it('mirrors every westward direction from a painted eastward one', () => {
    for (let d = 0; d < 8; d++) {
      expect(PAINTED_DIR[d]).toBeLessThan(FACES_AWAY.length);
      if (MIRRORED[d]) {
        // The mirror image of d (reflected across the vertical axis) must be painted directly.
        const mirror = (12 - d) % 8;
        expect(MIRRORED[mirror]).toBe(false);
        expect(PAINTED_DIR[mirror]).toBe(PAINTED_DIR[d]);
      }
    }
  });
});

describe('frame selection', () => {
  it('walk frames follow the distance walked, one cycle per stride', () => {
    const step = STRIDE_TILES / WALK_FRAMES;
    const frames = [0, 1, 2, 3, 4, 5].map((k) => walkFrame(k * step + step / 2));
    expect(frames).toEqual([0, 1, 2, 3, 0, 1]);
    expect(walkFrame(0)).toBe(0);
  });

  it('work frames loop over time and are desynchronised by id', () => {
    const loop = ACTIONS.chop.loopMs;
    const seen = new Set<number>();
    for (let t = 0; t < loop; t += loop / 16) seen.add(workFrame(t, 1, loop));
    expect([...seen].sort()).toEqual([0, 1, 2, 3]);
    expect(workFrame(1234, 7, loop)).toBe(workFrame(1234 + loop * 5, 7, loop));
    const atZero = new Set([1, 2, 3, 4, 5, 6, 7, 8].map((id) => workFrame(0, id, loop)));
    expect(atZero.size).toBeGreaterThan(1);
  });

  it('idle glances stay near the facing and hold for a while', () => {
    let changes = 0;
    let prev = idleDir(0, 3, 2);
    for (let t = 0; t < 60_000; t += 100) {
      const d = idleDir(t, 3, 2);
      expect([1, 2, 3]).toContain(d);
      if (d !== prev) changes++;
      prev = d;
    }
    expect(changes).toBeGreaterThan(0);
    expect(changes).toBeLessThan(30);
  });
});

describe('animation data', () => {
  it('every action has four arm poses and a sound frame inside the loop', () => {
    for (const id of ACTION_IDS) {
      const a = ACTIONS[id];
      expect(a.arm).toHaveLength(WORK_FRAMES);
      if ('soundFrame' in a) expect(a.soundFrame).toBeLessThan(WORK_FRAMES);
    }
  });

  it('every profession resolves to a style with a known action', () => {
    for (const kind of Object.keys(PROFESSIONS) as SettlerKind[]) {
      expect(ACTION_IDS).toContain(styleOf(kind).work);
    }
    for (const a of [...Object.values(PLANT_ACTION), ...Object.values(GATHER_ACTION)]) expect(ACTION_IDS).toContain(a);
  });
});
