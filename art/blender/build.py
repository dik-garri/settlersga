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

SKIN = (0.96, 0.78, 0.64)
HAIR = (0.52, 0.36, 0.2)
SHIRT = (0.93, 0.89, 0.8)
VEST = (0.7, 0.5, 0.32)
TROUSERS = (0.5, 0.4, 0.3)
SHOES = (0.36, 0.25, 0.16)


def wood_mat(name='wood', light=False):
    if light:
        return lib.mat_noisy(name, (0.74, 0.58, 0.4), (0.82, 0.66, 0.46), scale=4, stretch=(1, 1, 8))
    return lib.mat_noisy(name, (0.48, 0.34, 0.2), (0.58, 0.42, 0.26), scale=4, stretch=(1, 1, 8))


# ------------------------------------------------------------------------------------------ models

def build_woodcutter():
    stone = lib.mat_brick('stone', (0.66, 0.62, 0.55), (0.74, 0.7, 0.62), (0.5, 0.46, 0.4), scale=7, row=0.3, width=0.55)
    plaster = lib.mat_noisy('plaster', (0.86, 0.8, 0.66), (0.92, 0.86, 0.72), scale=12)
    beam = wood_mat('beam')
    roof = lib.mat_brick('roof', (0.76, 0.33, 0.2), (0.84, 0.42, 0.26), (0.5, 0.2, 0.12), scale=6, row=0.22, width=0.4, mortar_size=0.035, roof='y')
    dark = lib.mat_flat('dark', (0.2, 0.16, 0.12))
    door_mat = wood_mat('door')
    shutter = lib.mat_flat('shutter', (0.36, 0.5, 0.3))
    log_mat = wood_mat('log', light=True)
    cut = lib.mat_noisy('cut', (0.86, 0.72, 0.5), (0.92, 0.8, 0.6), scale=20)
    iron = lib.mat_flat('iron', (0.62, 0.64, 0.68), rough=0.4)

    # Ridge along Y, so the gable with the door faces the camera's lower left (the −Y side, where
    # the game's door tile is).
    cx, cy = 0.02, 0.05
    L, W, H, plinth, rh = 1.15, 1.3, 0.68, 0.22, 0.48
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    lib.box((cx, cy, plinth / 2), (L + 0.04, W + 0.04, plinth), stone, bevel=0.015)
    lib.box((cx, cy, plinth + (H - plinth) / 2), (L, W, H - plinth), plaster)
    lib.gable((cx, cy, H), L - 0.02, rh - 0.03, y0 + 0.01, plaster, along='y')
    lib.gable((cx, cy, H), L - 0.02, rh - 0.03, y1 - 0.01, plaster, along='y')
    # Timber frame: corner posts, sills and top plates on the two walls the camera sees.
    for x in (x0, x1):
        for y in (y0, y1):
            lib.box((x, y, (plinth + H) / 2), (0.07, 0.07, H - plinth), beam)
    lib.box((cx, y0 - 0.005, H - 0.03), (L + 0.04, 0.07, 0.06), beam)
    lib.box((cx, y0 - 0.005, plinth + 0.02), (L + 0.04, 0.07, 0.05), beam)
    lib.box((x1 + 0.005, cy, plinth + 0.02), (0.07, W + 0.04, 0.05), beam)
    lib.box((x1 + 0.005, cy, H - 0.03), (0.07, W + 0.04, 0.06), beam)
    for y in (cy - 0.2, cy + 0.25):
        lib.box((x1 + 0.005, y, (plinth + H) / 2), (0.07, 0.06, H - plinth), beam)
    brace = math.atan2(H - plinth, 0.4)
    lib.box((x1 + 0.01, y1 - 0.25, (plinth + H) / 2), (0.05, 0.55, 0.05), beam, rot=(-brace, 0, 0))
    # Gable timbers: king post and rafters.
    lib.box((cx, y0 - 0.01, H + rh / 2 - 0.02), (0.06, 0.05, rh - 0.06), beam)
    for side in (-1, 1):
        lib.box((cx + side * L / 4, y0 - 0.015, H + rh / 2 - 0.01), (math.hypot(L / 2, rh) + 0.02, 0.05, 0.06), beam,
                rot=(0, side * math.atan2(rh, L / 2), 0))
    lib.prism_roof((cx, cy, H), W, L, rh, roof, overhang=0.09, thickness=0.07, along='y')
    lib.box((cx, cy, H + rh + 0.03), (0.1, W + 0.2, 0.07), lib.mat_flat('ridge', (0.62, 0.26, 0.15)), bevel=0.02)
    # Chimney through the far slope.
    lib.box((cx - 0.28, cy + 0.35, H + 0.38), (0.17, 0.17, 0.62), stone, bevel=0.01)
    lib.box((cx - 0.28, cy + 0.35, H + 0.7), (0.21, 0.21, 0.05), stone, bevel=0.01)
    # Door under the gable (the game's door tile is in front of the right part of this wall).
    lib.box((0.3, y0 - 0.015, 0.2), (0.26, 0.04, 0.42), door_mat, bevel=0.01)
    lib.box((0.3, y0 - 0.025, 0.43), (0.32, 0.05, 0.05), beam)
    lib.box((-0.24, y0 - 0.015, 0.45), (0.17, 0.04, 0.16), dark)
    for dx in (-0.13, 0.13):
        lib.box((-0.24 + dx, y0 - 0.025, 0.45), (0.085, 0.03, 0.18), shutter, bevel=0.005)
    lib.box((cx, y0 - 0.015, H + 0.16), (0.12, 0.04, 0.12), dark)
    lib.box((x1 + 0.015, cy + 0.02, 0.45), (0.04, 0.17, 0.16), dark)
    for dy in (-0.13, 0.13):
        lib.box((x1 + 0.025, cy + 0.02 + dy, 0.45), (0.03, 0.085, 0.18), shutter, bevel=0.005)
    # Log pile against the +X wall and a chopping block by the door.
    for row, n in enumerate((4, 3, 2)):
        for i in range(n):
            y = cy + 0.05 + (i + row * 0.5) * 0.14
            lib.cylinder((x1 + 0.16, y, 0.065 + row * 0.115), 0.065, 0.34, log_mat, rot=(0, math.pi / 2, 0), verts=12)
            lib.cylinder((x1 + 0.33, y, 0.065 + row * 0.115), 0.061, 0.005, cut, rot=(0, math.pi / 2, 0), verts=12)
    lib.cylinder((0.85, -0.85, 0.09), 0.12, 0.18, log_mat, verts=14)
    lib.cylinder((0.85, -0.85, 0.185), 0.115, 0.01, cut, verts=14)
    lib.box((0.85, -0.85, 0.3), (0.025, 0.025, 0.22), beam, rot=(0.25, 0, 0))
    lib.box((0.85, -0.83, 0.2), (0.025, 0.12, 0.06), iron)
    for i, (x, y) in enumerate(((0.58, -0.95), (0.95, -0.6), (0.68, -0.72))):
        lib.box((x, y, 0.01), (0.06, 0.03, 0.015), cut, rot=(0, 0, i * 1.1))


def build_tree():
    bark = lib.mat_noisy('bark', (0.4, 0.29, 0.19), (0.52, 0.39, 0.26), scale=10, stretch=(1, 1, 6))
    leaves = lib.mat_noisy('leaves', (0.2, 0.42, 0.12), (0.42, 0.64, 0.2), scale=9, detail=8, rough=0.9)
    lib.cylinder((0, 0, 0.3), 0.08, 0.6, bark, radius2=0.04, verts=12)
    for a, z in ((0.6, 0.48), (2.6, 0.55), (4.4, 0.5)):
        lib.cylinder((math.cos(a) * 0.08, math.sin(a) * 0.08, z), 0.025, 0.25, bark,
                     rot=(math.sin(a) * -0.9, math.cos(a) * 0.9, 0), verts=8)
    # A dense crown from many small clumps, so it reads as foliage rather than one ball.
    clumps = [
        ((0, 0, 1.0), 0.3), ((0.2, 0.08, 0.85), 0.22), ((-0.2, 0.06, 0.88), 0.22),
        ((0.06, -0.22, 0.84), 0.22), ((-0.06, 0.22, 0.9), 0.21), ((0.16, -0.12, 1.12), 0.2),
        ((-0.14, -0.1, 1.1), 0.19), ((0.02, 0.12, 1.22), 0.18), ((0.22, 0.16, 1.02), 0.16),
        ((-0.22, -0.16, 0.95), 0.16), ((0.0, -0.05, 1.32), 0.14),
    ]
    for i, (loc, r) in enumerate(clumps):
        lib.lumpy(loc, r, leaves, scale=(1, 1, 0.85), strength=0.5, noise=0.45, seed=i)


def build_deposit(size):
    rock = lib.mat_noisy('rock', (0.6, 0.58, 0.54), (0.76, 0.73, 0.68), scale=7, detail=6)
    rocks = [
        ((0.0, 0.0, 0.12), 0.21, (1.1, 1.0, 0.8)),
        ((0.22, -0.13, 0.07), 0.14, (1.2, 0.9, 0.7)),
        ((-0.21, 0.1, 0.08), 0.15, (1.0, 1.1, 0.75)),
        ((0.13, 0.21, 0.06), 0.13, (1.0, 1.2, 0.7)),
        ((-0.12, -0.22, 0.05), 0.12, (1.2, 1.0, 0.7)),
        ((0.31, 0.12, 0.04), 0.1, (1.0, 1.0, 0.7)),
        ((-0.31, -0.05, 0.04), 0.1, (1.1, 1.0, 0.7)),
    ]
    keep = (7, 5, 3)[size]
    for i, (loc, r, sc) in enumerate(rocks[:keep]):
        lib.lumpy(loc, r, rock, scale=sc, strength=0.45, noise=0.9, seed=i, subdiv=2, flat=True)


def build_log():
    log_mat = wood_mat('log', light=True)
    cut = lib.mat_noisy('cut', (0.78, 0.62, 0.4), (0.86, 0.72, 0.5), scale=20)
    gx, gy = lib.ground_dir(0)
    yaw = math.atan2(gy, gx)
    lib.cylinder((0, 0, 0), 0.05, 0.3, log_mat, rot=(0, math.pi / 2, yaw), verts=12)
    for s in (-1, 1):
        lib.cylinder((s * 0.15 * gx, s * 0.15 * gy, 0), 0.047, 0.004, cut, rot=(0, math.pi / 2, yaw), verts=12)


# ------------------------------------------------------------------------------------------ carrier

class Figure:
    """A small, stocky settler built from parts on pivots, facing +X before the root is turned."""

    def __init__(self):
        skin = lib.mat_flat('skin', SKIN, 0.6)
        hair = lib.mat_flat('hair', HAIR)
        shirt = lib.mat_noisy('shirt', SHIRT, tuple(c * 0.92 for c in SHIRT), scale=20)
        vest = lib.mat_flat('vest', VEST)
        trousers = lib.mat_flat('trousers', TROUSERS)
        shoes = lib.mat_flat('shoes', SHOES)
        belt = lib.mat_flat('belt', (0.38, 0.26, 0.16))

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

        hip_z = 0.25
        self.legs = []
        for side in (-1, 1):
            p = pivot(f'hip{side}', (0, side * 0.058, hip_z))
            leg = lib.cylinder((0, side * 0.058, hip_z - 0.12), 0.05, 0.24, trousers, radius2=0.042, verts=10)
            shoe = lib.box((0.03, side * 0.058, 0.025), (0.12, 0.07, 0.05), shoes, bevel=0.02)
            attach(leg, p)
            attach(shoe, p)
            self.legs.append(p)
        for obj in (
            lib.cylinder((0, 0, 0.39), 0.1, 0.28, shirt, radius2=0.088, verts=16),
            lib.cylinder((0, 0, 0.385), 0.104, 0.2, vest, radius2=0.094, verts=16),
            lib.cylinder((0, 0, 0.28), 0.106, 0.04, belt, verts=16),
            lib.sphere((0.005, 0, 0.62), 0.1, skin),
            lib.sphere((-0.01, 0, 0.655), 0.103, hair, scale=(1, 1, 0.65)),
            lib.sphere((0.1, 0, 0.61), 0.022, skin),
        ):
            attach(obj, self.root)
        self.arms = []
        self.hands = []
        for side in (-1, 1):
            p = pivot(f'shoulder{side}', (0, side * 0.125, 0.5))
            arm = lib.cylinder((0, side * 0.125, 0.41), 0.038, 0.18, shirt, verts=10)
            hand = lib.sphere((0, side * 0.125, 0.31), 0.034, skin)
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
    'tree': (build_tree, 80, 96, 32, 78),
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
