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


def build_woodcutter():
    walls = lib.mat_stones('walls', (0.86, 0.86, 0.88), (0.6, 0.62, 0.68), (0.28, 0.27, 0.3), scale=11)
    trim = lib.mat_grain('trim', (0.82, 0.8, 0.74), (0.92, 0.9, 0.84), scale=10, stretch=(1, 1, 1), bump=0.2)
    roof = lib.mat_tiles('roof', (0.86, 0.45, 0.2), (0.72, 0.32, 0.14), (0.32, 0.13, 0.06), scale=5, along='y')
    shingles = lib.mat_grain('shingles', (0.32, 0.22, 0.13), (0.5, 0.36, 0.2), scale=12, stretch=(1, 4, 1), bump=0.8)
    dark = lib.mat_flat('dark', (0.08, 0.06, 0.05))
    door = wood('door')
    beam = wood('beam')
    logs = wood('logs', light=True)
    cut = cut_ends()
    iron = lib.mat_flat('iron', (0.55, 0.57, 0.62), rough=0.35)
    ivy = leaves('ivy')

    lib.pad((0.05, -0.05, 0), 0.98, 0.98, earth(), jitter=0.08, seed=3)

    # House: ridge along Y, gable with the door towards the camera's lower left (−Y).
    cx, cy = -0.12, 0.12
    L, W, H, rh = 1.0, 1.15, 0.62, 0.42
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    lib.box((cx, cy, H / 2), (L, W, H), walls)
    lib.gable((cx, cy, H), L - 0.02, rh - 0.02, y0 + 0.01, walls, along='y')
    lib.gable((cx, cy, H), L - 0.02, rh - 0.02, y1 - 0.01, walls, along='y')
    for x in (x0, x1):
        for y in (y0, y1):
            column(x, y, H, trim, trim)
    lib.box((cx, y0 - 0.01, H - 0.02), (L + 0.08, 0.06, 0.05), trim, bevel=0.01)
    lib.box((x1 + 0.01, cy, H - 0.02), (0.06, W + 0.08, 0.05), trim, bevel=0.01)
    lib.prism_roof((cx, cy, H), W, L, rh, roof, overhang=0.1, thickness=0.06, along='y')
    lib.box((cx, cy, H + rh + 0.02), (0.09, W + 0.22, 0.07), lib.mat_flat('ridge', (0.6, 0.24, 0.1)), bevel=0.025)
    # Door with a stone frame, a small window above it, a shuttered window on the side.
    dx = cx + 0.18
    lib.box((dx, y0 - 0.02, 0.21), (0.24, 0.04, 0.42), door, bevel=0.01)
    lib.box((dx - 0.15, y0 - 0.03, 0.23), (0.05, 0.05, 0.46), trim, bevel=0.01)
    lib.box((dx + 0.15, y0 - 0.03, 0.23), (0.05, 0.05, 0.46), trim, bevel=0.01)
    lib.box((dx, y0 - 0.03, 0.47), (0.36, 0.06, 0.06), trim, bevel=0.01)
    lib.box((cx - 0.22, y0 - 0.015, 0.4), (0.15, 0.04, 0.17), dark)
    lib.box((cx - 0.22, y0 - 0.03, 0.31), (0.21, 0.05, 0.035), trim)
    lib.cylinder((cx, y0 - 0.01, H + 0.15), 0.06, 0.03, dark, rot=(math.pi / 2, 0, 0), verts=16)
    lib.box((x1 + 0.015, cy + 0.18, 0.4), (0.04, 0.15, 0.17), dark)
    # Lean-to shelter on the +X side with the log pile under it.
    sx0, sx1 = x1 + 0.05, x1 + 0.45
    for y in (cy - 0.35, cy + 0.42):
        lib.box((sx1, y, 0.24), (0.05, 0.05, 0.48), beam)
    lib.box((sx1, cy + 0.035, 0.47), (0.06, 0.85, 0.05), beam)
    tilt = math.atan2(0.18, sx1 - sx0)
    lib.box(((sx0 + sx1) / 2 + 0.02, cy + 0.035, 0.55), (sx1 - sx0 + 0.16, 0.95, 0.035), shingles, rot=(0, tilt, 0))
    for row, n in enumerate((5, 4, 3)):
        for k in range(n):
            y = cy - 0.27 + (k + row * 0.5) * 0.14
            z = 0.06 + row * 0.105
            lib.cylinder(((sx0 + sx1) / 2 + 0.02, y, z), 0.06, 0.34, logs, rot=(0, math.pi / 2, 0), verts=12)
            lib.cylinder((sx1 + 0.17, y, z), 0.056, 0.006, cut, rot=(0, math.pi / 2, 0), verts=12)
    # Chopping block with an axe, chips around it.
    bx, by = 0.62, -0.72
    lib.cylinder((bx, by, 0.09), 0.11, 0.18, logs, verts=14)
    lib.cylinder((bx, by, 0.183), 0.105, 0.008, cut, verts=14)
    lib.box((bx - 0.02, by, 0.29), (0.025, 0.025, 0.22), beam, rot=(0.3, 0.15, 0))
    lib.box((bx - 0.02, by + 0.02, 0.2), (0.025, 0.11, 0.06), iron)
    for k, (x, y) in enumerate(((0.4, -0.85), (0.8, -0.55), (0.5, -0.55), (0.75, -0.9))):
        lib.box((x, y, 0.015), (0.06, 0.03, 0.015), cut, rot=(0, 0, k * 1.3))
    # Ivy climbing the back corner and the gable.
    for k, (x, y, z, r) in enumerate(((x0 + 0.02, y0 + 0.05, 0.15, 0.09), (x0 + 0.03, y0 + 0.08, 0.32, 0.08),
                                      (x0 + 0.06, y0 + 0.02, 0.46, 0.07), (x0 - 0.02, y0 + 0.2, 0.1, 0.08))):
        lib.lumpy((x, y, z), r, ivy, strength=0.5, noise=0.5, seed=k)


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
    rock = lib.mat_grain('rock', (0.38, 0.39, 0.42), (0.66, 0.66, 0.66), scale=6, stretch=(1, 1, 1), bump=1.0)
    rocks = [
        ((0.0, 0.0, 0.13), 0.22, (1.1, 1.0, 0.85)),
        ((0.23, -0.13, 0.08), 0.15, (1.2, 0.9, 0.75)),
        ((-0.22, 0.1, 0.09), 0.16, (1.0, 1.1, 0.8)),
        ((0.13, 0.22, 0.07), 0.14, (1.0, 1.2, 0.75)),
        ((-0.12, -0.23, 0.06), 0.13, (1.2, 1.0, 0.75)),
        ((0.32, 0.12, 0.05), 0.11, (1.0, 1.0, 0.75)),
        ((-0.32, -0.05, 0.05), 0.11, (1.1, 1.0, 0.75)),
    ]
    keep = (7, 5, 3)[size]
    for k, (loc, r, sc) in enumerate(rocks[:keep]):
        lib.lumpy(loc, r, rock, scale=sc, strength=0.5, noise=0.9, seed=k, subdiv=2, flat=True)


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
    'tree': (build_tree, 84, 100, 34, 80),
    'deposit0': (lambda: build_deposit(0), 56, 44, 28, 34),
    'deposit1': (lambda: build_deposit(1), 56, 44, 28, 34),
    'deposit2': (lambda: build_deposit(2), 56, 44, 28, 34),
    'log': (build_log, 16, 10, 8, 5),
}


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    names = args or ['carrier', *SINGLE]
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
            build, w, h, ax, ay = SINGLE[n]
            if n == 'log':
                bpy.data.objects['ShadowCatcher'].hide_render = True
            lib.setup_camera(scene, w, h, ax, ay)
            build()
            lib.render_to(scene, os.path.join(OUT, f'{n}.png'))
        print('rendered', name)


main()
