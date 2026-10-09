"""Burnt ruins: what is left of a building that burnt (conquest, a defeated player), one model per
footprint size — `ruin1` (eyecatchers) … `ruin4` (castle, fortress). Our own design in the spirit
of Settlers 4's smouldering remains: a patch of scorched earth and ash, broken stubs of blackened
walls round the footprint, charred beams fallen across and a post or two still standing, rubble,
roof-tile shards and a few glowing embers. The game adds the smoke (`Effects`) and fades the ruin
out; the sprite blocks nothing.

Registered through `SINGLE` (merged into build.py's table) on the canvas of a building of that size
(`ART3D_RUINS` in src/render/art3d.ts lists the same names and canvases).
"""

import math
import random

import lib

#: Canvas per footprint size (logical w, h, anchor x, y): the buildings' (`BUILDING_CANVAS`).
CANVAS = {
    1: (80, 120, 40, 92),
    2: (150, 140, 75, 100),
    3: (220, 190, 110, 135),
    4: (320, 290, 160, 200),
}


def mat_glow(name, color, strength):
    """Embers: an emission that reads as glowing coals in the dark ash."""
    mat, _, _, bsdf = lib._principled(name)
    bsdf.inputs['Base Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Emission Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Emission Strength'].default_value = strength
    return mat


def build_ruin(n):
    """Remains of an n×n building around the footprint centre (the origin)."""
    rnd = random.Random(40 + n)
    half = n / 2
    scorched = lib.mat_grain('scorched', (0.06, 0.05, 0.045), (0.24, 0.2, 0.16), scale=14, stretch=(1, 1, 1), bump=0.9)
    ash = lib.mat_grain('ash', (0.32, 0.31, 0.3), (0.58, 0.56, 0.53), scale=30, stretch=(1, 1, 1), bump=0.5)
    stones = lib.mat_stones('burnt', (0.7, 0.67, 0.62), (0.4, 0.38, 0.35), (0.12, 0.1, 0.09), scale=11)
    soot = lib.mat_stones('soot', (0.34, 0.32, 0.3), (0.13, 0.12, 0.11), (0.04, 0.04, 0.04), scale=11)
    char = lib.mat_grain('char', (0.03, 0.025, 0.02), (0.16, 0.1, 0.06), scale=9, stretch=(1, 1, 7), bump=1.0)
    tile = lib.mat_grain('shard', (0.32, 0.12, 0.06), (0.52, 0.24, 0.12), scale=12, stretch=(1, 1, 1), bump=0.4)
    ember = mat_glow('ember', (1.0, 0.42, 0.08), 6.0)

    # Scorched ground, a little wider than the footprint, fading into the grass.
    lib.pad((0, 0, 0), half * 0.92, half * 0.92, scorched, jitter=0.16, seed=n, core=0.62, reach=1.18, grain=30.0 / n)
    for k in range(2 + 2 * n):
        a = rnd.uniform(0, math.tau)
        r = rnd.uniform(0, half * 0.6)
        lib.lumpy((math.cos(a) * r, math.sin(a) * r, 0.0), rnd.uniform(0.08, 0.16) * min(n, 3) ** 0.5, ash,
                  scale=(1.4, 1.1, 0.22), strength=0.4, noise=1.2, seed=k, subdiv=2)

    if n == 1:
        # An eyecatcher: its plinth cracked and blackened, the rest lying round it.
        lib.box((0, 0, 0.06), (0.36, 0.36, 0.12), soot, rot=(0, 0, 0.1), bevel=0.02)
        lib.box((0.03, -0.02, 0.17), (0.24, 0.22, 0.1), stones, rot=(0.12, -0.08, 0.3), bevel=0.02)
    else:
        # Wall stubs round the footprint: courses of blackened blocks, broken off at uneven heights,
        # with breaches; taller at the back so the front stays open to the eye.
        inset = half - 0.12
        step = 0.17
        for side in range(4):
            count = int(2 * inset / step)
            for k in range(count):
                t = -inset + (k + 0.5) * (2 * inset / count)
                x, y = [(t, -inset), (inset, t), (t, inset), (-inset, t)][side]
                back = side in (2, 3)  # +y and −x: away from the camera
                if rnd.random() < (0.22 if back else 0.4):
                    continue  # a breach
                top = rnd.uniform(0.06, 0.16) + (rnd.uniform(0.04, 0.22) * min(n, 3) / 2 if back else 0)
                z = 0.0
                course = 0
                while z < top:
                    h = rnd.uniform(0.07, 0.1)
                    w = step * rnd.uniform(0.85, 1.05)
                    size = (w, 0.14, h) if side in (0, 2) else (0.14, w, h)
                    mat = soot if z + h >= top - 0.02 and rnd.random() < 0.7 else stones
                    lib.box((x + rnd.uniform(-0.01, 0.01), y + rnd.uniform(-0.01, 0.01), z + h / 2), size, mat,
                            rot=(0, 0, rnd.uniform(-0.06, 0.06)), bevel=0.012)
                    z += h
                    course += 1
        # Corner posts burnt down to stumps; one or two still stand higher.
        for k, (cx, cy) in enumerate([(-inset, -inset), (inset, -inset), (inset, inset), (-inset, inset)]):
            h = rnd.uniform(0.12, 0.25) if k in (0, 1) else rnd.uniform(0.35, 0.3 + 0.15 * n)
            lib.cylinder((cx, cy, h / 2), 0.05, h, char, rot=(rnd.uniform(-0.12, 0.12), rnd.uniform(-0.12, 0.12), 0), verts=8)
        # Charred beams: fallen across the floor, a few leaning on the walls.
        for k in range(2 + n):
            a = rnd.uniform(0, math.pi)
            length = rnd.uniform(0.5, 0.9) * half * 1.4
            x, y = rnd.uniform(-half * 0.4, half * 0.4), rnd.uniform(-half * 0.4, half * 0.4)
            lean = rnd.uniform(0.15, 0.45) if k % 3 == 2 else rnd.uniform(-0.04, 0.04)
            z = 0.045 + math.sin(abs(lean)) * length / 2
            lib.box((x, y, z), (length, 0.08, 0.075), char, rot=(0, lean, a), bevel=0.012)
        # Roof-tile shards and rubble spilt round the walls.
        for k in range(6 * n):
            a = rnd.uniform(0, math.tau)
            r = rnd.uniform(0.2, half * 0.95)
            x, y = math.cos(a) * r, math.sin(a) * r
            if k % 3 == 0:
                lib.box((x, y, 0.012), (0.09, 0.06, 0.02), tile, rot=(rnd.uniform(-0.3, 0.3), rnd.uniform(-0.3, 0.3), a), bevel=0.005)
            else:
                lib.lumpy((x, y, 0.025), rnd.uniform(0.035, 0.06), stones, scale=(1.2, 1.0, 0.7), strength=0.5,
                          noise=1.0, seed=100 + k, subdiv=1, flat=True)
    # Embers glowing in the ash.
    for k in range(3 + 3 * n):
        a = rnd.uniform(0, math.tau)
        r = rnd.uniform(0, half * 0.55)
        lib.lumpy((math.cos(a) * r, math.sin(a) * r, 0.02), rnd.uniform(0.018, 0.03), ember, scale=(1.3, 1.0, 0.6),
                  strength=0.4, noise=1.5, seed=200 + k, subdiv=1, flat=True)


SINGLE = {f'ruin{n}': ((lambda n=n: build_ruin(n)), *CANVAS[n]) for n in CANVAS}
