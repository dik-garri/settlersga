"""Geologist's signs: a small wooden board on a stake, one per prospected mountain tile.

Our own design after what the Settlers 4 geologist leaves behind (docs/ART-STYLE.md «Знаки геолога»):
a rough board of warm orange-brown planks nailed to a short stake, with a painted symbol of what lies
under the tile — golden ingots for gold, black lumps for coal, rust-red lumps for iron ore, white
blocks for stone — repeated one, two or three times for a little, some or a lot (Settlers 4's 1/2/3
signs); a bare board where nothing was found. Two board shapes (two planks, one arched board), each
standing at its own angle, so a field of signs does not look stamped.

    blender -b --factory-startup -P art/blender/build.py -- signs

writes `signs.png` (a strip of `SIGN` frames: per variant the empty board, then every ore in `ORES`
order × `LEVELS`) and `signs.json`; `art3d.ts` (`ART3D_SIGNS`, `signFrame`) reads the same layout.
"""

import json
import math
import os

import bpy

import goods
import lib

#: Logical w, h and anchor (the stake's foot) of one frame.
SIGN = (34, 38, 14, 24)
#: Ore kinds in `ORE_RESOURCES` order (src/sim/config.ts).
ORES = ['coal', 'ironore', 'goldore', 'stone']
LEVELS = 3
VARIANTS = 2

#: Height of the board's centre above the ground, and the board's size (tile units).
BOARD_Z = 0.36
BOARD_W = 0.42
BOARD_H = 0.27
THICK = 0.03


def mat_paint(name, color, glow=0.25, rough=0.55):
    """Flat paint with a touch of its own light, so a symbol keeps its colour on a board in shade."""
    mat, _, _, bsdf = lib._principled(name)
    bsdf.inputs['Base Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Emission Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Emission Strength'].default_value = glow
    return mat


def mats():
    return {
        'board': lib.mat_grain('signboard', (0.6, 0.33, 0.12), (0.86, 0.56, 0.26), scale=5, stretch=(1, 9, 1), bump=0.7),
        'board2': lib.mat_grain('signboard2', (0.54, 0.29, 0.1), (0.8, 0.5, 0.22), scale=5, stretch=(1, 9, 1), bump=0.7),
        'stake': lib.mat_grain('stake', (0.3, 0.17, 0.08), (0.5, 0.31, 0.15), scale=6, stretch=(1, 1, 8), bump=0.6),
        'nail': goods.mat_metal('nail', (0.3, 0.3, 0.32), rough=0.5, metallic=0.7),
        'earth': lib.mat_grain('signearth', (0.3, 0.2, 0.12), (0.46, 0.33, 0.2), scale=14, stretch=(1, 1, 1), bump=0.8),
        'outline': lib.mat_flat('outline', (0.16, 0.08, 0.03)),
        'gold': mat_paint('gold', (1.0, 0.78, 0.12), glow=0.35, rough=0.3),
        'goldhi': mat_paint('goldhi', (1.0, 0.95, 0.62), glow=0.45, rough=0.3),
        'stone': mat_paint('stone', (0.93, 0.93, 0.94), glow=0.35),
        'stonelo': mat_paint('stonelo', (0.62, 0.64, 0.68), glow=0.2),
        'coal': mat_paint('coal', (0.06, 0.06, 0.07), glow=0.0, rough=0.4),
        'coalhi': mat_paint('coalhi', (0.46, 0.48, 0.52), glow=0.15, rough=0.4),
        'iron': mat_paint('iron', (0.5, 0.22, 0.12), glow=0.2),
        'ironhi': mat_paint('ironhi', (0.78, 0.8, 0.86), glow=0.35, rough=0.3),
    }


# ------------------------------------------------------------------------------------------ symbols
# Built lying in the board's plane (x across, y up the board, +z out of its face), at height z.

def flat(points, z, mat, depth=0.005):
    return goods.prism(points, z, z + depth, mat)


def grown(points, by):
    """The outline grown outwards by `by` (about its centre): the dark rim painted under a symbol."""
    cx = sum(p[0] for p in points) / len(points)
    cy = sum(p[1] for p in points) / len(points)
    out = []
    for x, y in points:
        dx, dy = x - cx, y - cy
        d = math.hypot(dx, dy) or 1
        out.append((x + dx / d * by, y + dy / d * by))
    return out


def painted(points, z, m, fill, rim=0.013):
    flat(grown(points, rim), z, m['outline'], 0.003)
    return flat(points, z + 0.003, m[fill])


def ingot(x, y, z, m):
    """A gold bar seen from the side: a trapezoid with a bright top edge."""
    w, t, h = 0.135, 0.09, 0.07
    painted([(x - w / 2, y - h / 2), (x + w / 2, y - h / 2), (x + t / 2, y + h / 2), (x - t / 2, y + h / 2)], z, m, 'gold')
    flat([(x - t / 2 + 0.008, y + h / 2 - 0.02), (x + t / 2 - 0.008, y + h / 2 - 0.02),
          (x + t / 2 - 0.004, y + h / 2 - 0.006), (x - t / 2 + 0.004, y + h / 2 - 0.006)], z + 0.008, m['goldhi'], 0.002)


def block(x, y, z, m):
    """A cut stone block: a white rectangle with a grey lower face."""
    w, h = 0.13, 0.068
    painted([(x - w / 2, y - h / 2), (x + w / 2, y - h / 2), (x + w / 2, y + h / 2), (x - w / 2, y + h / 2)], z, m, 'stone')
    flat([(x - w / 2, y - h / 2), (x + w / 2, y - h / 2), (x + w / 2, y - h / 2 + 0.02), (x - w / 2, y - h / 2 + 0.02)],
         z + 0.008, m['stonelo'], 0.002)


def lump(fill, shine, glint=(0.014, 0.009)):
    """A rough lump of ore: an irregular rounded polygon with a small highlight."""

    def draw(x, y, z, m, seed=0):
        import random

        rnd = random.Random(seed)
        r = 0.05
        pts = []
        for k in range(9):
            a = k / 9 * math.tau
            rr = r * rnd.uniform(0.78, 1.08)
            pts.append((x + math.cos(a) * rr * 1.25, y + math.sin(a) * rr))
        painted(pts, z, m, fill)
        hx, hy = x - 0.018, y + 0.016
        flat([(hx + math.cos(a) * glint[0], hy + math.sin(a) * glint[1]) for a in (k / 6 * math.tau for k in range(6))],
             z + 0.008, m[shine], 0.002)

    return draw


SYMBOLS = {
    'coal': lump('coal', 'coalhi'),
    'ironore': lump('iron', 'ironhi', (0.024, 0.012)),
    'goldore': ingot,
    'stone': block,
}

#: Where 1, 2 or 3 symbols sit on the board (a pile of three: two below, one on top).
LAYOUT = {
    1: [(0.0, 0.0)],
    2: [(-0.09, 0.0), (0.09, 0.0)],
    3: [(-0.085, -0.042), (0.085, -0.042), (0.0, 0.048)],
}


# -------------------------------------------------------------------------------------------- board

def board(variant, m):
    """The board lying in the xy plane (face up), centred on the origin; returns the face height."""
    if variant == 0:
        # Two planks of uneven length, one a shade darker, nailed on.
        h = BOARD_H / 2
        for k, (dx, ln, mat) in enumerate(((0.012, BOARD_W, 'board'), (-0.01, BOARD_W - 0.03, 'board2'))):
            y = (0.5 - k) * h
            lib.box((dx, y, THICK / 2), (ln, h - 0.008, THICK), m[mat], rot=(0, 0, (0.03, -0.025)[k]), bevel=0.012)
            for side in (-1, 1):
                lib.cylinder((dx + side * (ln / 2 - 0.035), y, THICK + 0.002), 0.008, 0.004, m['nail'], verts=8)
    else:
        # One board with an arched top and a chipped lower corner.
        pts = []
        w, h = BOARD_W * 0.96, BOARD_H * 1.05
        steps = 14
        for k in range(steps + 1):
            a = math.pi * k / steps
            pts.append((math.cos(a) * w / 2, h / 2 - 0.07 + math.sin(a) * 0.07))
        pts += [(-w / 2, -h / 2 + 0.012), (-w / 2 + 0.03, -h / 2), (w / 2 - 0.05, -h / 2), (w / 2, -h / 2 + 0.035)]
        # Counter-clockwise for `prism`: the arc runs right → left over the top, then down and back along the foot.
        slab = goods.prism(pts, 0, THICK, m['board'], bevel=0.008)
        slab.name = 'slab'
        lib.cylinder((0, h / 2 - 0.05, THICK + 0.002), 0.009, 0.004, m['nail'], verts=8)
    return THICK + 0.001


def build_sign(variant, ore, level):
    m = mats()
    yaw, tilt, roll = [(math.radians(52), math.radians(18), math.radians(4)),
                       (math.radians(36), math.radians(24), math.radians(-5))][variant]
    # The stake, leaning a little with the board, and a trodden mound of earth at its foot.
    face_dir = (math.sin(yaw), -math.cos(yaw))
    top = BOARD_Z + BOARD_H * 0.3
    lib.box((0, 0, top / 2), (0.04, 0.04, top), m['stake'], rot=(0, 0, yaw), bevel=0.006)
    lib.lumpy((0, 0, 0.0), 0.05, m['earth'], scale=(1.4, 1.2, 0.35), strength=0.5, noise=0.9, seed=variant, subdiv=2, flat=True)

    before = set(bpy.data.objects)
    z = board(variant, m)
    if ore:
        for k, (x, y) in enumerate(LAYOUT[level]):
            sym = SYMBOLS[ore]
            if sym in (ingot, block):
                sym(x, y, z, m)
            else:
                sym(x, y, z, m, seed=7 * k + level)
    bpy.context.view_layer.update()
    root = bpy.data.objects.new('board', None)
    bpy.context.scene.collection.objects.link(root)
    for obj in set(bpy.data.objects) - before - {root}:
        obj.parent = root
    # Stand the board up (face towards −Y), lean it back, hang it a little crooked, turn it to the camera.
    root.rotation_mode = 'XYZ'
    root.rotation_euler = (math.pi / 2 - tilt, roll, yaw)
    root.location = (face_dir[0] * 0.022, face_dir[1] * 0.022, BOARD_Z)
    bpy.context.view_layer.update()


def fill_light(scene):
    """A soft light from the camera's side, without shadows: the board's face, turned away from the
    sun, would otherwise show only the sky's dim light."""
    data = bpy.data.lights.new('Fill', 'SUN')
    data.energy = 1.4
    data.angle = math.radians(30)
    try:
        data.use_shadow = False
    except AttributeError:
        pass
    try:
        data.cycles.cast_shadow = False
    except AttributeError:
        pass
    obj = bpy.data.objects.new('Fill', data)
    scene.collection.objects.link(obj)
    from mathutils import Vector

    toward = Vector((-0.75, 0.75, -0.6)).normalized()
    obj.rotation_euler = toward.to_track_quat('-Z', 'Y').to_euler()


def frames():
    """Every frame's (variant, ore, level), in strip order."""
    out = []
    for v in range(VARIANTS):
        out.append((v, None, 0))
        for ore in ORES:
            for level in range(1, LEVELS + 1):
                out.append((v, ore, level))
    return out


def render_signs(out, tmp, only=None):
    pixels = []
    for v, ore, level in frames():
        name = f'sign-{v}-{ore or "none"}-{level}'

        def setup(scene, v=v, ore=ore, level=level):
            fill_light(scene)
            build_sign(v, ore, level)

        pixels.append(goods.render_frame(os.path.join(tmp, f'{name}.png'), SIGN, setup))
        print('rendered', name)
    goods.save_strip(pixels, os.path.join(out, 'signs.png'))
    with open(os.path.join(out, 'signs.json'), 'w') as f:
        json.dump({'frame': list(SIGN), 'variants': VARIANTS, 'levels': LEVELS, 'ores': ORES}, f)
