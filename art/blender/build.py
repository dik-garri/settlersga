"""Renders the pilot set of 3D sprites into public/art/3d.

    blender -b --factory-startup -P art/blender/build.py -- [names...]

Names: settlers (every figure, see figures.py), settlers:add (only the pose groups settlers.json
lacks, appended to its last page), signs (the geologist's signs, see signs.py), woodcutter, sawmill, stonecutter, tower, house_large, tree, deposit, piles (or piles:fish,coal), stacks (or stacks:fish,coal: goods lying on the ground), ruins (ruin1..ruin4), rocks (mountain stones and outcrops, see rocks.py), wares, icons (or icons:axe,saw: the menu icons) (default: all). Every sprite keeps the size and anchor
of the procedural sprite it replaces (src/render/sprites.ts, settlerArt.ts), so the game can swap
them in without other changes.
"""

import json
import math
import os
import sys

import bpy
import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
import figures  # noqa: E402
import goods  # noqa: E402
import lib  # noqa: E402
import buildings  # noqa: E402
import nature  # noqa: E402
import rocks  # noqa: E402
import ruins  # noqa: E402
import signs  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'art', '3d')
TMP = os.path.join(ROOT, 'art', '.tmp')

# ------------------------------------------------------------------------------------------ palette
# Colours as on screen (sRGB), after Settlers 4: saturated, warm earth, blue-grey Roman stone.


EARTH = ((0.42, 0.28, 0.17), (0.6, 0.42, 0.26))
WOOD_DARK = ((0.28, 0.17, 0.09), (0.46, 0.3, 0.16))
WOOD_LIGHT = ((0.66, 0.46, 0.26), (0.8, 0.6, 0.36))
CUT = ((0.86, 0.68, 0.42), (0.94, 0.8, 0.56))


def earth():
    return lib.mat_grain('earth', *EARTH, scale=9, stretch=(1, 1, 1), bump=0.6)


def wood(name='wood', light=False):
    a, b = WOOD_LIGHT if light else WOOD_DARK
    return lib.mat_grain(name, a, b, scale=4, stretch=(1, 1, 9), bump=0.5)


def cut_ends():
    return lib.mat_grain('cut', *CUT, scale=18, stretch=(1, 1, 1), bump=0.3)


def leaves(name='leaves'):
    return lib.mat_leaves(name, (0.04, 0.16, 0.03), (0.13, 0.4, 0.07), (0.4, 0.66, 0.16))


# ------------------------------------------------------------------------------------------ models

def column(x, y, h, stone, base):
    """A Roman corner column: plinth, shaft, capital."""
    lib.box((x, y, 0.035), (0.13, 0.13, 0.07), base, bevel=0.01)
    lib.cylinder((x, y, h / 2), 0.045, h - 0.06, stone, verts=12)
    lib.box((x, y, h - 0.02), (0.13, 0.13, 0.05), base, bevel=0.01)


def log_cabin(cx, cy, L, W, H, logs, ends, r=0.045, gable_h=0.0, gable_axis='x', overhang=0.07, door=None):
    """Walls of horizontal round logs crossing at the corners (ends sticking out), the two walls of
    each axis half a log apart. With `gable_h`, the walls across `gable_axis` (the gable ends) keep
    stacking shorter logs into the roof triangle. `door`: (x, width, height) cut into the −Y wall."""
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    step = 2 * r * 0.92
    k = 0
    z = r
    while z < H + gable_h - r * 0.5:
        for along_x in (True, False):
            zz = z + (0 if along_x else step / 2)
            above = zz + r - H  # a wall log must stay under the eaves
            if above > 0:
                # Gable triangle: only the walls across the ridge continue, shrinking.
                gable_wall = (gable_axis == 'x') != along_x
                if not gable_wall or gable_h <= 0:
                    continue
                span = (W if gable_axis == 'x' else L) * max(0.0, 1 - above / gable_h)
                if span < 0.08:
                    continue
            if along_x:
                length = L + 2 * overhang if above <= 0 else span
                for y in (y0, y1):
                    if door and y == y0 and above <= 0 and zz < door[2]:
                        dx, dw, _ = door
                        left = (x0 - overhang, dx - dw / 2)
                        right = (dx + dw / 2, x1 + overhang)
                        for a, b in (left, right):
                            lib.cylinder(((a + b) / 2, y, zz), r, b - a, logs, rot=(0, math.pi / 2, 0), verts=10)
                        continue
                    lib.cylinder((cx, y, zz), r, length, logs, rot=(0, math.pi / 2, 0), verts=10)
                    if above <= 0:
                        for x in (x0 - overhang, x1 + overhang):
                            lib.cylinder((x, y, zz), r * 0.92, 0.006, ends, rot=(0, math.pi / 2, 0), verts=10)
            else:
                length = W + 2 * overhang if above <= 0 else span
                for x in (x0, x1):
                    lib.cylinder((x, cy, zz), r, length, logs, rot=(math.pi / 2, 0, 0), verts=10)
                    if above <= 0:
                        for y in (y0 - overhang, y1 + overhang):
                            lib.cylinder((x, y, zz), r * 0.92, 0.006, ends, rot=(math.pi / 2, 0, 0), verts=10)
        z += step
        k += 1


def plank_roof(cx, cy, L, W, H, rh, boards, axis='x', overhang=0.12, width=0.085, seed=1):
    """Gable roof of individual boards running down the slopes (ridge along `axis`), uneven in
    length, tone and lie, with dark gaps between them."""
    import random

    rnd = random.Random(seed)
    along, across = (L, W) if axis == 'x' else (W, L)
    run = across / 2 + overhang
    drop = overhang * rh / (across / 2)
    rise = rh + drop
    angle = math.atan2(rise, run)
    slope = math.hypot(run, rise)
    n = int((along + 2 * overhang) / width)
    for side in (-1, 1):
        for k in range(n):
            t = -along / 2 - overhang + (k + 0.5) * (along + 2 * overhang) / n
            ln = slope + rnd.uniform(-0.1, 0.1)
            off = rnd.uniform(-0.02, 0.02)
            mid_h = side * (run / 2) + side * off * math.cos(angle)
            z = H - drop + rise / 2 + 0.02 + rnd.uniform(-0.006, 0.006)
            tilt = side * angle
            mat = boards[rnd.randrange(len(boards))]
            yaw = rnd.uniform(-0.07, 0.07)
            if axis == 'x':
                lib.box((cx + t, cy + mid_h, z), (width * 0.9, ln, 0.022), mat, rot=(-tilt, 0, yaw), bevel=0.004)
            else:
                lib.box((cx + mid_h, cy + t, z), (ln, width * 0.9, 0.022), mat, rot=(0, tilt, yaw), bevel=0.004)
    # Ridge log.
    if axis == 'x':
        lib.cylinder((cx, cy, H + rh + 0.035), 0.04, along + 2 * overhang + 0.06, boards[0], rot=(0, math.pi / 2, 0), verts=10)
    else:
        lib.cylinder((cx, cy, H + rh + 0.035), 0.04, along + 2 * overhang + 0.06, boards[0], rot=(math.pi / 2, 0, 0), verts=10)


def stakes(points, mat, string):
    """Pegs at the corners of a footprint with a string between them (construction stage 0)."""
    for x, y in points:
        lib.box((x, y, 0.07), (0.025, 0.025, 0.14), mat, rot=(0.08, -0.06, 0))
    for (xa, ya), (xb, yb) in zip(points, points[1:] + points[:1]):
        length = math.hypot(xb - xa, yb - ya)
        lib.box(((xa + xb) / 2, (ya + yb) / 2, 0.11), (length, 0.006, 0.006), string,
                rot=(0, 0, math.atan2(yb - ya, xb - xa)))


def timber_frame(cx, cy, L, W, H, rh, beam, axis='x'):
    """Square-timber skeleton the walls are raised around: corner posts, plates and gable rafters."""
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    t = 0.05
    for x in (x0, x1):
        for y in (y0, y1):
            lib.box((x, y, H / 2), (t, t, H), beam)
    lib.box((cx, y0, H), (L + t, t, t), beam)
    lib.box((cx, y1, H), (L + t, t, t), beam)
    lib.box((x0, cy, H), (t, W + t, t), beam)
    lib.box((x1, cy, H), (t, W + t, t), beam)
    across = W if axis == 'x' else L
    ang = math.atan2(rh, across / 2)
    length = math.hypot(across / 2, rh) + 0.06
    ends = (x0, x1) if axis == 'x' else (y0, y1)
    for e in ends:
        for side in (-1, 1):
            if axis == 'x':
                lib.box((e, cy + side * across / 4, H + rh / 2), (t, length, t), beam, rot=(-side * ang, 0, 0))
            else:
                lib.box((cx + side * across / 4, e, H + rh / 2), (length, t, t), beam, rot=(0, side * ang, 0))
    if axis == 'x':
        lib.box((cx, cy, H + rh), (L + 0.1, t, t), beam)
    else:
        lib.box((cx, cy, H + rh), (t, W + 0.1, t), beam)


def build_woodcutter():
    """A log cabin after the Settlers 4 woodcutter: round-log walls, a roof of loose boards and a
    lower annex at the side, on trodden earth. Goods (the logs it cuts) are not part of the model:
    the game draws the real pile at the door. Tagged with construction stages: 0 stakes, 1 timber
    frame, 2 lower walls, 3 walls and half the roof, 4 finished."""
    logs = lib.mat_grain('logs', (0.36, 0.18, 0.08), (0.62, 0.36, 0.17), scale=7, stretch=(1, 1, 6), bump=1.0)
    ends = lib.mat_grain('ends', (0.82, 0.6, 0.32), (0.93, 0.76, 0.48), scale=30, stretch=(1, 1, 1), bump=0.4)
    boards = [
        lib.mat_grain(f'board{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.6)
        for k, (a, b) in enumerate((
            ((0.5, 0.34, 0.12), (0.76, 0.58, 0.26)),
            ((0.38, 0.24, 0.1), (0.6, 0.42, 0.18)),
            ((0.62, 0.46, 0.2), (0.84, 0.68, 0.36)),
            ((0.44, 0.36, 0.22), (0.62, 0.52, 0.34)),
        ))
    ]
    beam = lib.mat_grain('beam', (0.3, 0.16, 0.07), (0.46, 0.26, 0.12), scale=5, stretch=(1, 1, 8), bump=0.6)
    dark = lib.mat_flat('dark', (0.07, 0.05, 0.04))
    string = lib.mat_flat('string', (0.92, 0.88, 0.75))
    # The earth reaches out over the door tile, where the goods piles lie.
    lib.pad((0.08, -0.22, 0), 1.0, 1.12, lib.mat_grain('earth', (0.34, 0.18, 0.09), (0.66, 0.42, 0.22), scale=16,
                                                       stretch=(1, 1, 1), bump=1.0, detail=12), jitter=0.1, seed=5)
    lib.tag(0)

    cx, cy, L, W, H, rh = -0.22, 0.12, 0.95, 0.85, 0.52, 0.46
    ax, ay, aL, aW, aH, arh = 0.52, 0.2, 0.48, 0.68, 0.36, 0.24
    stakes([(cx - L / 2, cy - W / 2), (ax + aL / 2, cy - W / 2), (ax + aL / 2, cy + W / 2), (cx - L / 2, cy + W / 2)],
           beam, string)
    lib.tag(0, until=0)

    timber_frame(cx, cy, L, W, H, rh, beam, axis='x')
    timber_frame(ax, ay, aL, aW, aH, arh, beam, axis='y')
    lib.tag(1, until=3)

    # Main cabin: ridge along X, so its big board slope faces the camera; the door on the −Y wall.
    log_cabin(cx, cy, L, W, H, logs, ends, gable_h=rh, gable_axis='x', door=(cx + 0.12, 0.24, 0.36))
    log_cabin(ax, ay, aL, aW, aH, logs, ends, r=0.04, gable_h=arh, gable_axis='y', overhang=0.05)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)

    plank_roof(cx, cy, L, W, H, rh, boards, axis='x', seed=2)
    plank_roof(ax, ay, aL, aW, aH, arh, boards, axis='y', overhang=0.09, seed=4)
    # Half the boards go on in stage 3 (those on the camera's side of each ridge), the rest at the end.
    lib.tag(None, split=lambda o: 3 if o.location.y < cy - 0.05 or o.location.x > ax + 0.05 else 4)

    lib.box((cx + 0.12, cy - W / 2 + 0.03, 0.18), (0.22, 0.06, 0.36), dark)
    for dx in (-0.13, 0.13):
        lib.box((cx + 0.12 + dx, cy - W / 2 - 0.04, 0.19), (0.04, 0.04, 0.38), boards[1])
    lib.box((cx + 0.12, cy - W / 2 - 0.04, 0.39), (0.32, 0.05, 0.04), boards[1])
    lib.box((ax, ay - aW / 2 - 0.01, 0.16), (0.18, 0.04, 0.2), dark)
    # Chopping block and a few chips by the door.
    lib.cylinder((-0.55, -0.6, 0.08), 0.1, 0.16, logs, verts=14)
    lib.cylinder((-0.55, -0.6, 0.163), 0.095, 0.006, ends, verts=14)
    for k, (x, y) in enumerate(((-0.35, -0.7), (-0.7, -0.45), (-0.2, -0.55), (0.0, -0.8))):
        lib.box((x, y, 0.015), (0.06, 0.03, 0.015), ends, rot=(0, 0, k * 1.3))
    lib.tag(4)


def build_deposit(size):
    """Quarry stone as in Settlers 4: a cluster of tall, jagged, pale rock spires with dark cracks.
    Size 0 is the full deposit; 1 and 2 are what is left as it is quarried."""
    rock = lib.mat_crystal('rock', (0.93, 0.93, 0.9), (0.62, 0.64, 0.66), (0.12, 0.13, 0.14), scale=6)
    spires = [
        ((0.0, 0.02, 0), 0.17, 0.78),
        ((0.17, -0.1, 0), 0.13, 0.55),
        ((-0.16, 0.12, 0), 0.13, 0.6),
        ((0.1, 0.2, 0), 0.11, 0.42),
        ((-0.08, -0.17, 0), 0.11, 0.36),
        ((0.26, 0.12, 0), 0.08, 0.28),
    ]
    keep = (6, 4, 2)[size]
    for k, (loc, r, h) in enumerate(spires[:keep]):
        lib.spire(loc, r, h * (1.0, 0.85, 0.7)[size], rock, seed=k + 1)
    # Chips at the foot.
    for k in range(5 - size * 2):
        a = k * 1.9
        lib.lumpy((math.cos(a) * 0.3, math.sin(a) * 0.3, 0.02), 0.04, rock, scale=(1.2, 1, 0.7), strength=0.4,
                  noise=0.8, seed=k, subdiv=1, flat=True)




# ------------------------------------------------------------------------------------------ main

SINGLE = {
    # name: (builder, logical w, h, anchor x, y) — sizes of the procedural sprites they replace.
    'woodcutter': (build_woodcutter, 150, 140, 75, 100),
    'sawmill': (buildings.build_sawmill, 150, 140, 75, 100),
    'stonecutter': (buildings.build_stonecutter, 150, 140, 75, 100),
    'tower': (buildings.build_tower, 150, 210, 75, 170),
    'house_large': (buildings.build_house_large, 220, 190, 110, 135),
    'house_medium': (buildings.build_house_medium, 150, 140, 75, 100),
    'house_small': (buildings.build_house_small, 150, 140, 75, 100),
    'coalmine': (buildings.build_coalmine, 150, 140, 75, 100),
    'stonemine': (buildings.build_stonemine, 150, 140, 75, 100),
    'ironmine': (buildings.build_ironmine, 150, 140, 75, 100),
    'goldmine': (buildings.build_goldmine, 150, 140, 75, 100),
    'ironsmelter': (buildings.build_ironsmelter, 150, 140, 75, 100),
    'goldsmelter': (buildings.build_goldsmelter, 150, 140, 75, 100),
    'weaponsmith': (buildings.build_weaponsmith, 150, 140, 75, 100),
    'barracks': (buildings.build_barracks, 220, 190, 110, 135),
    'castle': (buildings.build_castle, 320, 290, 160, 200),
    'fortress': (buildings.build_fortress, 320, 290, 160, 200),
    'bigtower': (buildings.build_bigtower, 170, 240, 85, 190),
    'lookout': (buildings.build_lookout, 150, 210, 75, 170),
    'infirmary': (buildings.build_infirmary, 150, 140, 75, 100),
    'hunter': (buildings.build_hunter, 150, 140, 75, 100),
    'slaughterhouse': (buildings.build_slaughterhouse, 150, 140, 75, 100),
    'toolsmith': (buildings.build_toolsmith, 150, 140, 75, 100),
    'pigfarm': (buildings.build_pigfarm, 220, 190, 110, 135),
    'forester': (buildings.build_forester, 150, 140, 75, 100),
    'market': (buildings.build_market, 150, 140, 75, 100),
    'donkeyranch': (buildings.build_donkeyranch, 220, 190, 110, 135),
    'fisher': (buildings.build_fisher, 150, 140, 75, 100),
    'fountain': (buildings.build_fountain, 150, 140, 75, 100),
    'flowerbed': (buildings.build_flowerbed, 80, 120, 40, 92),
    'column': (buildings.build_column, 80, 120, 40, 92),
    'statue': (buildings.build_statue, 80, 120, 40, 92),
    'obelisk': (buildings.build_obelisk, 80, 120, 40, 92),
    'farm': (buildings.build_farm, 220, 190, 110, 135),
    'mill': (buildings.build_mill, 150, 210, 75, 165),
    'bakery': (buildings.build_bakery, 150, 140, 75, 100),
    'waterworks': (buildings.build_waterworks, 150, 140, 75, 100),
    'warehouse': (buildings.build_warehouse, 150, 140, 75, 100),
    'deposit0': (lambda: build_deposit(0), 64, 72, 30, 58),
    'deposit1': (lambda: build_deposit(1), 64, 72, 30, 58),
    'deposit2': (lambda: build_deposit(2), 64, 72, 30, 58),
}
# Tree variants and ground props (`-- trees`, `-- props`).
SINGLE.update(nature.SINGLE)
# Mountain rocks: loose stones, boulders, outcrops (`-- rocks`).
SINGLE.update(rocks.SINGLE)
# Burnt ruins per footprint size (`-- ruins` or `-- ruin2`).
SINGLE.update(ruins.SINGLE)


#: Construction stages rendered before the finished building (0 stakes … 3 roof half on).
STAGES = 4

def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = args or ['settlers', 'piles', 'stacks', 'wares', 'icons', 'millsails', 'signs', *SINGLE]
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    for name in names:
        if name == 'deposit':
            todo = ['deposit0', 'deposit1', 'deposit2']
        elif name == 'ruins':
            todo = list(ruins.SINGLE)
        elif name == 'rocks':
            todo = list(rocks.ROCKS)
        elif name in ('trees', 'props'):
            todo = list(nature.TREES if name == 'trees' else nature.PROPS)
        else:
            todo = [name]
        for n in todo:
            scene = lib.reset_scene()
            if n == 'settlers':
                figures.build_settlers(OUT, TMP)
                continue
            if n == 'settlers:add':
                # Only the pose groups the sheet lacks, appended to its last page.
                figures.build_settlers(OUT, TMP, add=True)
                continue
            if n == 'piles' or n.startswith('piles:'):
                # `piles` renders every resource's piles, `piles:fish,coal` only those.
                goods.render_piles(OUT, TMP, n.split(':', 1)[1].split(',') if ':' in n else None)
                continue
            if n == 'stacks' or n.startswith('stacks:'):
                # Goods lying loose on bare ground: `stacks` for every resource, `stacks:fish,coal` those.
                goods.render_stacks(OUT, TMP, n.split(':', 1)[1].split(',') if ':' in n else None)
                continue
            if n == 'millsails':
                _, w, h, ax, ay = SINGLE['mill']
                buildings.render_mill_sails(OUT, TMP, w, h, ax, ay, goods.save_strip)
                continue
            if n == 'wares':
                goods.render_wares(OUT, TMP)
                continue
            if n == 'signs':
                signs.render_signs(OUT, TMP)
                continue
            if n == 'icons' or n.startswith('icons:'):
                # `icons` renders every resource's menu icon, `icons:axe,saw` only those.
                goods.render_icons(OUT, TMP, n.split(':', 1)[1].split(',') if ':' in n else None)
                continue
            build, w, h, ax, ay = SINGLE[n]
            if n in ruins.SINGLE or n in rocks.ROCKS:
                scene.cycles.device = 'CPU'  # few and small: spare the GPU (and the machine's heat)
                scene.render.threads_mode = 'FIXED'
                scene.render.threads = 4
            lib.setup_camera(scene, w, h, ax, ay)
            build()
            staged = any('stage' in o for o in scene.objects)
            if staged:
                for k in range(STAGES):
                    lib.show_stage(k)
                    lib.render_to(scene, os.path.join(OUT, f'{n}-s{k}.png'))
                lib.show_stage(STAGES)
            lib.render_to(scene, os.path.join(OUT, f'{n}.png'))
        print('rendered', name)


main()
