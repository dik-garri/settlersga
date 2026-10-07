"""Renders the pilot set of 3D sprites into public/art/3d.

    blender -b --factory-startup -P art/blender/build.py -- [names...]

Names: carrier, woodcutter, tree, deposit, log (default: all). Every sprite keeps the size and anchor
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
import lib  # noqa: E402
import buildings  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'art', '3d')
TMP = os.path.join(ROOT, 'art', '.tmp')

# ------------------------------------------------------------------------------------------ palette
# Colours as on screen (sRGB), after Settlers 4: saturated, warm earth, blue-grey Roman stone.

SKIN = (0.93, 0.66, 0.48)
HAIR = (0.17, 0.11, 0.07)
TUNIC = (0.95, 0.93, 0.88)
TEAM = (0.16, 0.32, 0.86)  # player colour trim (blue, like the local player)
SANDALS = (0.45, 0.27, 0.13)

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


# Goods lying at a door: one sprite per count, as many items as there really are.
PILE_MAX = 8


def build_pile(res, n):
    import random

    rnd = random.Random(n)
    if res == 'log':
        logs = wood('logs', light=False)
        cut = cut_ends()
        rows = []
        left = n
        width = 4
        while left > 0:
            rows.append(min(width, left))
            left -= rows[-1]
            width -= 1
        for row, count in enumerate(rows):
            for k in range(count):
                y = (k - (count - 1) / 2) * 0.09
                z = 0.04 + row * 0.075
                x = rnd.uniform(-0.02, 0.02)
                lib.cylinder((x, y, z), 0.04, 0.34, logs, rot=(0, math.pi / 2, 0), verts=10)
                for sgn in (-1, 1):
                    lib.cylinder((x + sgn * 0.17, y, z), 0.037, 0.005, cut, rot=(0, math.pi / 2, 0), verts=10)
    elif res == 'plank':
        board = lib.mat_grain('plank', (0.74, 0.54, 0.3), (0.86, 0.68, 0.42), scale=4, stretch=(1, 9, 1), bump=0.4)
        for k in range(n):
            layer, col = divmod(k, 2)
            lib.box(((col - 0.5) * 0.1 + rnd.uniform(-0.01, 0.01), 0, 0.012 + layer * 0.026), (0.09, 0.36, 0.022), board,
                    rot=(0, 0, rnd.uniform(-0.05, 0.05)), bevel=0.003)
    elif res == 'stone':
        stone = lib.mat_grain('block', (0.6, 0.6, 0.62), (0.8, 0.79, 0.78), scale=8, stretch=(1, 1, 1), bump=0.8)
        spots = [(-0.07, -0.07, 0), (0.07, -0.07, 0), (-0.07, 0.07, 0), (0.07, 0.07, 0),
                 (0, -0.07, 1), (0, 0.07, 1), (-0.035, 0, 2), (0.035, 0, 2)]
        for k in range(n):
            x, y, layer = spots[k]
            lib.box((x, y, 0.04 + layer * 0.075), (0.12, 0.12, 0.075), stone, rot=(0, 0, rnd.uniform(-0.2, 0.2)), bevel=0.012)


def build_tree():
    bark = lib.mat_grain('bark', (0.36, 0.2, 0.09), (0.62, 0.38, 0.18), scale=7, stretch=(1, 1, 5), bump=0.9)
    foliage = leaves()
    # A slightly crooked trunk flaring at the base, with a few limbs into the crown.
    lib.cylinder((0, 0, 0.06), 0.11, 0.12, bark, radius2=0.075, verts=12)
    lib.cylinder((0.01, 0, 0.32), 0.075, 0.44, bark, radius2=0.05, verts=12, rot=(0.06, 0.05, 0))
    for a, z, l in ((0.5, 0.5, 0.32), (2.4, 0.56, 0.3), (4.2, 0.52, 0.3), (5.6, 0.62, 0.26)):
        lib.cylinder((math.cos(a) * 0.09, math.sin(a) * 0.09, z + 0.08), 0.03, l, bark, radius2=0.015,
                     rot=(math.sin(a) * -0.8, math.cos(a) * 0.8, 0), verts=8)
    # Crown: many small leaf clumps over an ellipsoid, so light catches individual clusters.
    import random

    rnd = random.Random(7)
    for k in range(150):
        u = rnd.uniform(0, math.tau)
        v = rnd.uniform(-0.55, 1.0)
        rr = math.sqrt(max(0.0, 1 - v * v)) * rnd.uniform(0.8, 1.08)
        x = math.cos(u) * rr * 0.37
        y = math.sin(u) * rr * 0.37
        z = 0.98 + v * 0.31
        leaf = lib.lumpy((x, y, z), rnd.uniform(0.045, 0.075), foliage, scale=(1, 1, 0.7), strength=0.5, noise=0.3,
                         seed=k, subdiv=1, flat=True)
        leaf.rotation_euler = (rnd.uniform(0, 3), rnd.uniform(0, 3), rnd.uniform(0, 3))
    lib.lumpy((0, 0, 0.98), 0.32, foliage, scale=(1, 1, 0.9), strength=0.3, noise=0.5, seed=99)


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


def build_log():
    logs = wood('log', light=True)
    cut = cut_ends()
    gx, gy = lib.ground_dir(0)
    yaw = math.atan2(gy, gx)
    lib.cylinder((0, 0, 0), 0.05, 0.3, logs, rot=(0, math.pi / 2, yaw), verts=12)
    for sgn in (-1, 1):
        lib.cylinder((sgn * 0.15 * gx, sgn * 0.15 * gy, 0), 0.047, 0.004, cut, rot=(0, math.pi / 2, yaw), verts=12)


# ------------------------------------------------------------------------------------------ carrier

class Figure:
    """A small, stocky settler built from parts on pivots, facing +X before the root is turned."""

    def __init__(self):
        skin = lib.mat_flat('skin', SKIN, 0.6)
        hair = lib.mat_grain('hair', HAIR, tuple(min(1, c * 1.8) for c in HAIR), scale=30, stretch=(1, 1, 3), bump=0.4)
        tunic = lib.mat_grain('tunic', tuple(c * 0.9 for c in TUNIC), TUNIC, scale=20, stretch=(1, 1, 4), bump=0.3)
        team = lib.mat_flat('team', TEAM, 0.6)
        sandals = lib.mat_flat('sandals', SANDALS)

        self.root = bpy.data.objects.new('root', None)
        bpy.context.scene.collection.objects.link(self.root)

        def pivot(name, loc):
            e = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(e)
            e.parent = self.root
            e.location = loc
            bpy.context.view_layer.update()  # so children attach to the pivot's real position
            return e

        def attach(obj, parent):
            bpy.context.view_layer.update()
            world = obj.matrix_world.copy()
            obj.parent = parent
            obj.matrix_world = world

        hip_z = 0.27
        self.legs = []
        for side in (-1, 1):
            p = pivot(f'hip{side}', (0, side * 0.055, hip_z))
            leg = lib.cylinder((0, side * 0.055, hip_z - 0.13), 0.042, 0.26, skin, radius2=0.036, verts=10)
            shoe = lib.box((0.03, side * 0.055, 0.02), (0.11, 0.06, 0.04), sandals, bevel=0.015)
            attach(leg, p)
            attach(shoe, p)
            self.legs.append(p)
        for obj in (
            # Tunic to the knees, flaring out, with a coloured hem and belt; bare arms and legs.
            lib.cylinder((0, 0, 0.37), 0.13, 0.3, tunic, radius2=0.092, verts=16),
            lib.cylinder((0, 0, 0.235), 0.132, 0.03, team, verts=16),
            lib.cylinder((0, 0, 0.405), 0.107, 0.035, team, verts=16),
            lib.cylinder((0, 0, 0.535), 0.092, 0.05, tunic, radius2=0.07, verts=16),
            lib.sphere((0.005, 0, 0.64), 0.105, skin),
            lib.sphere((-0.006, 0, 0.678), 0.109, hair, scale=(1.02, 1.03, 0.74)),
            lib.sphere((0.106, 0, 0.625), 0.022, skin),
        ):
            attach(obj, self.root)
        self.arms = []
        self.hands = []
        for side in (-1, 1):
            p = pivot(f'shoulder{side}', (0, side * 0.12, 0.52))
            sleeve = lib.cylinder((0, side * 0.12, 0.49), 0.045, 0.07, tunic, verts=10)
            arm = lib.cylinder((0, side * 0.12, 0.4), 0.032, 0.16, skin, verts=10)
            hand = lib.sphere((0, side * 0.12, 0.31), 0.034, skin)
            attach(sleeve, p)
            attach(arm, p)
            attach(hand, p)
            self.arms.append(p)
            self.hands.append(hand)

    def pose(self, yaw, leg, arm, carry):
        self.root.rotation_euler = (0, 0, yaw)
        for side, p in zip((-1, 1), self.legs):
            p.rotation_euler = (0, math.radians(side * leg), 0)
        for side, p in zip((-1, 1), self.arms):
            if carry:
                # Both arms forward and in, hands together in front of the belly.
                p.rotation_euler = (math.radians(-side * 22), math.radians(-55), 0)
            else:
                p.rotation_euler = (0, math.radians(-side * arm), 0)
        bpy.context.view_layer.update()

    def hand_point(self):
        """Between the hands, from the evaluated scene (what the render actually shows)."""
        from mathutils import Vector

        dg = bpy.context.evaluated_depsgraph_get()
        pts = []
        for h in self.hands:
            ev = h.evaluated_get(dg)
            corners = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
            pts.append(sum(corners, Vector()) / 8)
        return (pts[0] + pts[1]) / 2


WALK = [(24, 20), (0, 0), (-24, -20), (0, 0)]  # (leg, arm) degrees per walk frame
DIR_COUNT = 8


def build_carrier(scene):
    """Sheet: 8 rows (directions E, SE, S, SW, W, NW, N, NE), 10 columns: walk 0–3 and stand, empty
    handed, then the same carrying. Plus where the carried ware goes (offset from the anchor)."""
    w, h, ax, ay = 26, 38, 13, 34
    lib.setup_camera(scene, w, h, ax, ay)
    fig = Figure()
    poses = [(leg, arm, False) for leg, arm in WALK] + [(0, 6, False)]
    poses += [(leg, 0, True) for leg, _ in WALK] + [(0, 0, True)]
    cw, ch = w * lib.RESOLUTION, h * lib.RESOLUTION
    sheet = np.zeros((DIR_COUNT * ch, len(poses) * cw, 4), dtype=np.float32)
    carry = []
    behind = []
    for d in range(DIR_COUNT):
        gx, gy = lib.ground_dir(d * math.pi / 4)
        yaw = math.atan2(gy, gx)
        row = []
        for c, (leg, arm, holding) in enumerate(poses):
            fig.pose(yaw, leg, arm, holding)
            path = os.path.join(TMP, f'carrier_{d}_{c}.png')
            lib.render_to(scene, path)
            img = bpy.data.images.load(path)
            px = np.empty(cw * ch * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            bpy.data.images.remove(img)
            # Blender images start at the bottom row; the sheet's row 0 is the top.
            sheet[(DIR_COUNT - 1 - d) * ch:(DIR_COUNT - d) * ch, c * cw:(c + 1) * cw] = px.reshape(ch, cw, 4)
            if holding:
                sx, sy = lib.screen_point(scene, fig.hand_point())
                row.append([round(sx - ax, 1), round(sy - ay, 1)])
        carry.append(row)
        # Goods in hand go behind the figure when the hands are further from the camera than the body.
        fig.pose(yaw, 0, 0, True)
        hand_depth = lib.camera_depth(scene, fig.hand_point())
        behind.append(hand_depth > lib.camera_depth(scene, (0, 0, 0.35)))
    save_sheet(sheet, os.path.join(OUT, 'carrier.png'))
    meta = {'cell': [w, h], 'anchor': [ax, ay], 'columns': len(poses), 'walk': 4, 'carryColumn': 5, 'carryAt': carry, 'carryBehind': behind}
    with open(os.path.join(OUT, 'carrier.json'), 'w') as f:
        json.dump(meta, f, indent=1)


def save_sheet(pixels, path):
    h, w, _ = pixels.shape
    img = bpy.data.images.new('sheet', width=w, height=h, alpha=True)
    img.pixels.foreach_set(pixels.ravel())  # rows are already in Blender's bottom-up order
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


# ------------------------------------------------------------------------------------------ main

SINGLE = {
    # name: (builder, logical w, h, anchor x, y) — sizes of the procedural sprites they replace.
    'woodcutter': (build_woodcutter, 150, 140, 75, 100),
    'sawmill': (buildings.build_sawmill, 150, 140, 75, 100),
    'stonecutter': (buildings.build_stonecutter, 150, 140, 75, 100),
    'tower': (buildings.build_tower, 150, 210, 75, 170),
    'house_large': (buildings.build_house_large, 220, 190, 110, 135),
    'tree': (build_tree, 84, 100, 34, 80),
    'deposit0': (lambda: build_deposit(0), 64, 72, 30, 58),
    'deposit1': (lambda: build_deposit(1), 64, 72, 30, 58),
    'deposit2': (lambda: build_deposit(2), 64, 72, 30, 58),
    'log': (build_log, 16, 10, 8, 5),
}


#: Construction stages rendered before the finished building (0 stakes … 3 roof half on).
STAGES = 4
PILE = (44, 34, 22, 24)  # logical w, h, anchor of a goods pile at a door


def render_piles():
    w, h, ax, ay = PILE
    for res in ('log', 'plank', 'stone'):
        for n in range(1, PILE_MAX + 1):
            scene = lib.reset_scene()
            lib.setup_camera(scene, w, h, ax, ay)
            build_pile(res, n)
            lib.render_to(scene, os.path.join(OUT, f'pile-{res}-{n}.png'))


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = args or ['carrier', 'piles', *SINGLE]
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    for name in names:
        if name == 'deposit':
            todo = ['deposit0', 'deposit1', 'deposit2']
        else:
            todo = [name]
        for n in todo:
            scene = lib.reset_scene()
            if n == 'carrier':
                build_carrier(scene)
                continue
            if n == 'piles':
                render_piles()
                continue
            build, w, h, ax, ay = SINGLE[n]
            if n == 'log':
                bpy.data.objects['ShadowCatcher'].hide_render = True
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
