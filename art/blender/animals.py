"""Renders the wild animals' sprite sheets into public/art/3d (animal-<kind>.png).

    blender -b --factory-startup -P art/blender/animals.py -- [deer donkey duck chicken]

Each sheet is 8 rows (directions in DIRS order: E, SE, S, SW, W, NW, N, NE) × 6 columns: walk
0..3, standing, grazing (head down). Cells and anchors must match ANIMAL_CELLS in
src/render/animalArt.ts. Models are built from simple parts on pivots, in the Settlers 4 manner:
warm saturated colours, soft shading, a shadow on the ground.
"""

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

DIRS = 8
WALK = [22, 0, -22, 0]  # leg swing per walk frame, degrees
COLUMNS = 6  # walk ×4, stand, graze
#: Logical cell (w, h) and anchor (ax, ay); keep in sync with ANIMAL_CELLS.
CELLS = {
    'deer': (48, 48, 24, 38),
    'donkey': (48, 44, 24, 34),
    'duck': (22, 18, 11, 13),
    'chicken': (22, 22, 11, 17),
}


class Rig:
    """Parts parented to pivots under one root that faces +X before it is turned."""

    def __init__(self):
        self.root = bpy.data.objects.new('root', None)
        bpy.context.scene.collection.objects.link(self.root)
        self.legs = []  # (pivot, phase sign)
        self.neck = None

    def pivot(self, name, loc, parent=None):
        e = bpy.data.objects.new(name, None)
        bpy.context.scene.collection.objects.link(e)
        e.parent = parent or self.root
        e.location = loc
        bpy.context.view_layer.update()
        return e

    def attach(self, obj, parent=None):
        bpy.context.view_layer.update()
        world = obj.matrix_world.copy()
        obj.parent = parent or self.root
        obj.matrix_world = world
        return obj

    def pose(self, yaw, swing, graze):
        self.root.rotation_euler = (0, 0, yaw)
        for p, sign in self.legs:
            p.rotation_euler = (0, math.radians(swing * sign), 0)
        if self.neck is not None:
            self.neck.rotation_euler = (0, math.radians(70 if graze else 0), 0)
        bpy.context.view_layer.update()


def quadruped(r, coat, belly, dark, hoof, body_len, body_h, shoulder, leg_r, neck_len, head_len, stocky=1.0):
    """A four-legged animal: barrel body, legs on hip pivots, a neck pivot carrying the head."""
    hip_z = shoulder - body_h * 0.35
    r.attach(lib.sphere((0, 0, shoulder), 1.0, coat, scale=(body_len / 2, body_h * 0.42 * stocky, body_h / 2)))
    r.attach(lib.sphere((0, 0, shoulder - body_h * 0.14), 1.0, belly, scale=(body_len * 0.36, body_h * 0.34 * stocky, body_h * 0.32)))
    for fx, side, sign in ((0.32, -1, 1), (0.32, 1, -1), (-0.32, -1, -1), (-0.32, 1, 1)):
        x = fx * body_len
        y = side * body_h * 0.22 * stocky
        p = r.pivot('hip', (x, y, hip_z))
        r.attach(lib.cylinder((x, y, hip_z / 2), leg_r, hip_z, dark if fx < 0 else coat, radius2=leg_r * 0.7, verts=8), p)
        r.attach(lib.cylinder((x, y, 0.02), leg_r * 0.8, 0.04, hoof, verts=8), p)
        r.legs.append((p, sign))
    # Neck pivot at the front of the shoulders; the neck rises forward, the head at its end.
    nx = body_len * 0.4
    nz = shoulder + body_h * 0.15
    neck = r.pivot('neck', (nx, 0, nz))
    ang = math.radians(50)
    cx = nx + math.cos(ang) * neck_len / 2
    cz = nz + math.sin(ang) * neck_len / 2
    r.attach(lib.cylinder((cx, 0, cz), body_h * 0.2, neck_len, coat, rot=(0, math.pi / 2 - ang, 0), radius2=body_h * 0.15, verts=10), neck)
    hx = nx + math.cos(ang) * neck_len
    hz = nz + math.sin(ang) * neck_len
    r.attach(lib.sphere((hx + head_len * 0.3, 0, hz), 1.0, coat, scale=(head_len / 2, head_len * 0.28, head_len * 0.3)), neck)
    r.attach(lib.sphere((hx + head_len * 0.72, 0, hz - head_len * 0.06), 1.0, belly, scale=(head_len * 0.2, head_len * 0.18, head_len * 0.18)), neck)
    r.neck = neck
    # Tail.
    r.attach(lib.cylinder((-body_len / 2 - 0.02, 0, shoulder), 0.015, 0.12, dark, rot=(0, -0.5, 0), verts=6))
    return neck, (hx, hz)


def build_deer(r):
    coat = lib.mat_grain('coat', (0.56, 0.3, 0.13), (0.72, 0.43, 0.2), scale=14, stretch=(1, 1, 3), bump=0.3)
    belly = lib.mat_flat('belly', (0.93, 0.84, 0.68))
    dark = lib.mat_grain('legs', (0.42, 0.24, 0.12), (0.55, 0.33, 0.17), scale=14, stretch=(1, 1, 3), bump=0.2)
    hoof = lib.mat_flat('hoof', (0.12, 0.09, 0.07))
    antler = lib.mat_flat('antler', (0.9, 0.84, 0.7))
    neck, (hx, hz) = quadruped(r, coat, belly, dark, hoof, 0.46, 0.2, 0.32, 0.024, 0.18, 0.15)
    for side in (-1, 1):
        r.attach(lib.cylinder((hx + 0.02, side * 0.035, hz + 0.1), 0.008, 0.16, antler, rot=(side * 0.35, -0.3, 0), verts=6), neck)
        r.attach(lib.cylinder((hx + 0.06, side * 0.06, hz + 0.15), 0.006, 0.08, antler, rot=(side * 0.5, 0.4, 0), verts=6), neck)
        r.attach(lib.sphere((hx - 0.01, side * 0.045, hz + 0.05), 1.0, coat, scale=(0.02, 0.03, 0.012)), neck)


def build_donkey(r):
    coat = lib.mat_grain('coat', (0.48, 0.47, 0.46), (0.62, 0.61, 0.6), scale=14, stretch=(1, 1, 3), bump=0.3)
    belly = lib.mat_flat('belly', (0.88, 0.87, 0.84))
    dark = lib.mat_flat('dark', (0.22, 0.21, 0.2))
    hoof = lib.mat_flat('hoof', (0.12, 0.1, 0.09))
    neck, (hx, hz) = quadruped(r, coat, belly, coat, hoof, 0.48, 0.24, 0.3, 0.032, 0.15, 0.17, stocky=1.15)
    for side in (-1, 1):
        r.attach(lib.sphere((hx, side * 0.04, hz + 0.08), 1.0, coat, scale=(0.025, 0.018, 0.075)), neck)
        r.attach(lib.sphere((hx, side * 0.04, hz + 0.13), 1.0, dark, scale=(0.018, 0.012, 0.022)), neck)
    # Dark mane along the neck.
    r.attach(lib.box((hx - 0.08, 0, hz - 0.01), (0.14, 0.02, 0.04), dark, rot=(0, -0.85, 0)), neck)


def bird(r, body, belly, beak_mat, leg_mat, length, height, neck_h, head_r, legs, comb=None, tail=None):
    """A small bird: round body on (optional) legs, neck pivot carrying head and beak."""
    lift = 0.05 if legs else 0.0
    if legs:
        for side, sign in ((-1, 1), (1, -1)):
            p = r.pivot('hip', (0, side * length * 0.15, lift))
            r.attach(lib.cylinder((0, side * length * 0.15, lift / 2), 0.006, lift, leg_mat, verts=6), p)
            r.legs.append((p, sign))
    r.attach(lib.sphere((0, 0, lift + height * 0.45), 1.0, body, scale=(length / 2, length * 0.32, height * 0.45)))
    r.attach(lib.sphere((0.01, 0, lift + height * 0.32), 1.0, belly, scale=(length * 0.4, length * 0.28, height * 0.3)))
    if tail is not None:
        r.attach(lib.sphere((-length * 0.48, 0, lift + height * 0.75), 1.0, tail, scale=(length * 0.18, length * 0.1, height * 0.3)))
    neck = r.pivot('neck', (length * 0.35, 0, lift + height * 0.65))
    hx, hz = length * 0.42, lift + height * 0.65 + neck_h
    r.attach(lib.sphere((hx, 0, hz), head_r, body), neck)
    r.attach(lib.cylinder((hx + head_r * 1.3, 0, hz - head_r * 0.2), head_r * 0.45, head_r * 1.2, beak_mat,
                          rot=(0, math.pi / 2, 0), radius2=head_r * 0.15, verts=8), neck)
    if comb is not None:
        r.attach(lib.sphere((hx, 0, hz + head_r * 0.9), 1.0, comb, scale=(head_r * 0.8, head_r * 0.3, head_r * 0.5)), neck)
    r.neck = neck


def build_duck(r):
    body = lib.mat_flat('duck', (0.96, 0.95, 0.9), 0.5)
    beak = lib.mat_flat('bill', (0.95, 0.6, 0.12), 0.4)
    bird(r, body, body, beak, beak, 0.2, 0.1, 0.06, 0.035, legs=True)


def build_chicken(r):
    body = lib.mat_grain('feathers', (0.62, 0.28, 0.11), (0.8, 0.42, 0.18), scale=30, stretch=(1, 1, 2), bump=0.3)
    belly = lib.mat_flat('breast', (0.86, 0.62, 0.38))
    beak = lib.mat_flat('beak', (0.92, 0.72, 0.2))
    comb = lib.mat_flat('comb', (0.86, 0.12, 0.08))
    tail = lib.mat_flat('tail', (0.18, 0.14, 0.1))
    bird(r, body, belly, beak, beak, 0.17, 0.13, 0.06, 0.032, legs=True, comb=comb, tail=tail)


BUILDERS = {'deer': build_deer, 'donkey': build_donkey, 'duck': build_duck, 'chicken': build_chicken}


def render_kind(kind):
    w, h, ax, ay = CELLS[kind]
    scene = lib.reset_scene(samples=32)
    # Small sprites render fine on the CPU, and the GPU may be busy with other renders.
    scene.cycles.device = 'CPU'
    # A few threads only, so a batch of renders does not overheat the machine.
    scene.render.threads_mode = 'FIXED'
    scene.render.threads = 4
    lib.setup_camera(scene, w, h, ax, ay)
    r = Rig()
    BUILDERS[kind](r)
    cw, ch = w * lib.RESOLUTION, h * lib.RESOLUTION
    sheet = np.zeros((DIRS * ch, COLUMNS * cw, 4), dtype=np.float32)
    poses = [(s, False) for s in WALK] + [(0, False), (0, True)]
    for d in range(DIRS):
        gx, gy = lib.ground_dir(d * math.pi / 4)
        yaw = math.atan2(gy, gx)
        for c, (swing, graze) in enumerate(poses):
            if not r.legs:
                swing = 0
            r.pose(yaw, swing, graze)
            path = os.path.join(TMP, f'{kind}_{d}_{c}.png')
            lib.render_to(scene, path)
            img = bpy.data.images.load(path)
            px = np.empty(cw * ch * 4, dtype=np.float32)
            img.pixels.foreach_get(px)
            bpy.data.images.remove(img)
            # Blender images start at the bottom row; the sheet's row 0 (direction 0) is the top.
            sheet[(DIRS - 1 - d) * ch:(DIRS - d) * ch, c * cw:(c + 1) * cw] = px.reshape(ch, cw, 4)
    out = bpy.data.images.new('sheet', width=sheet.shape[1], height=sheet.shape[0], alpha=True)
    out.pixels.foreach_set(sheet.ravel())
    out.filepath_raw = os.path.join(OUT, f'animal-{kind}.png')
    out.file_format = 'PNG'
    out.save()
    bpy.data.images.remove(out)
    print('rendered', kind)


def main():
    args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    for kind in args or list(BUILDERS):
        render_kind(kind)


main()
