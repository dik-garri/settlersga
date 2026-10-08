"""Settlers and soldiers as pre-rendered 3D figures (`npm run art:render -- settlers`).

One stocky figure, posed and rendered in 8 directions for every pose group the game needs:
- holding a tool while walking (4 frames) and standing (1), per tool shape (`TOOLS` in
  src/render/animConfig.ts, including `carry`: both hands forward for goods),
- working, 4 frames per action (`ACTIONS`), with the action's tool.
Each frame is rendered twice: in full colour, and as a mask of the parts that take a colour at run
time (tunic and shield face). The game draws the full frame, then the masked part tinted with the
profession's or the player's colour. Hats are a third layer per hat style and direction (rendered
with the figure as a holdout so the head hides the back of the brim), tinted per profession.

Frames are trimmed to what they show and shelf-packed into a few atlas pages; `settlers.json`
records every frame's rectangle and its anchor, plus where goods in hand go.
"""

import json
import math
import os

import bpy
import numpy as np
from mathutils import Vector

import lib

# --------------------------------------------------------------------------------------- the sheet

#: Logical canvas and anchor (the point on the ground under the figure) of one frame.
CELL_W, CELL_H, ANCHOR_X, ANCHOR_Y = 56, 72, 28, 62
DIRS = 8  # E, SE, S, SW, W, NW, N, NE (src/render/anim.ts `DIRS`)
WALK_FRAMES = 4
PAGE = 2048  # atlas page size in pixels (at lib.RESOLUTION)

# Mirrors src/render/animConfig.ts: tool shapes, hat styles and the work actions with their tool
# and near-arm angles (turns of π: 0 hanging down, 0.5 forward, 1 straight up) and bow pull.
TOOLS = ['none', 'axe', 'hammer', 'pick', 'shovel', 'scythe', 'rod', 'bucket', 'sword', 'bow', 'carry']
HAT_STYLES = ['cap', 'straw', 'helmet', 'hood', 'chef', 'bare', 'plume', 'galea1', 'galea2', 'galea3']

#: Outfits (src/render/animConfig.ts `Outfit`): what fighters wear over the tunic, rendered as their
#: own pose groups `hold:<tool>@<outfit>` and `work:<action>@<outfit>`.
OUTFITS = {
    'legion': (['sword'], ['sword']),  # swordsman: plated armour, big curved shield
    'archer': (['bow'], ['shoot']),  # bowman: leather armour, quiver
    'leader': (['sword'], ['sword']),  # squad leader: gilded cuirass, round golden shield, cloak
}
#: Bumped when a look changes, so its cached groups are rendered again.
LOOK_REV = {'legion': 1, 'archer': 1, 'leader': 2}
ACTIONS = {
    'chop': ('axe', [0.95, 0.62, 0.2, 0.1], None),
    'hammer': ('hammer', [0.82, 0.5, 0.16, 0.34], None),
    'mine': ('pick', [0.98, 0.6, 0.18, 0.3], None),
    'dig': ('shovel', [0.34, 0.14, 0.02, 0.22], None),
    'reap': ('scythe', [0.46, 0.3, 0.12, 0.28], None),
    'sow': ('none', [0.12, 0.38, 0.56, 0.3], None),
    'fish': ('rod', [0.6, 0.66, 0.58, 0.64], None),
    'draw': ('bucket', [0.06, 0.2, 0.38, 0.2], None),
    'sword': ('sword', [0.88, 0.45, 0.14, 0.5], None),
    'shoot': ('bow', [0.5, 0.5, 0.5, 0.5], [0, 0.5, 1, 0]),
}

#: How a tool is held while walking: tool arm angle (turns) and the tool's tilt at the hand
#: (degrees about the shoulder axis; 0 = pointing up along the body, −25 = leaning back over the
#: shoulder, 180 = hanging down along the arm).
HOLD = {
    'none': (None, 0),
    'axe': (0.08, -28),
    'hammer': (0.1, -20),
    'pick': (0.08, -28),
    'shovel': (0.08, -24),
    'scythe': (0.08, -22),
    'rod': (0.08, -34),
    'bucket': (0.04, 180),
    'sword': (0.16, 155),
    'bow': (None, 0),
    'carry': (None, 0),
}
#: At work the tool continues the arm, its head at the far end.
WORK_TILT = 180
#: Tools swung with both hands at work (the other arm follows the tool arm).
TWO_HANDED = {'axe', 'pick', 'shovel', 'scythe', 'rod'}

WALK = [(26, 22), (0, 0), (-26, -22), (0, 0)]  # (leg, free-arm swing) degrees per walk frame

# ---------------------------------------------------------------------------------------- palette

SKIN = (0.93, 0.66, 0.48)
HAIR = (0.06, 0.05, 0.05)
TUNIC = (0.96, 0.96, 0.95)  # white: tinted at run time
LEATHER = (0.45, 0.27, 0.13)
SANDALS = (0.42, 0.25, 0.12)
WOOD = ((0.42, 0.26, 0.12), (0.62, 0.42, 0.22))
METAL = (0.78, 0.8, 0.84)
STEEL = (0.86, 0.88, 0.92)
GOLD = (0.96, 0.76, 0.3)
BRASS = (0.86, 0.66, 0.28)
CREST = (0.8, 0.1, 0.08)

FIGURE_SCALE = 1.15


class Figure:
    """A stocky settler on pivots (hips, shoulders, tool at the hand), facing +X before the root turns.
    Parts that take the run-time colour carry `obj['mask'] = 1`."""

    def __init__(self):
        self.skin = lib.mat_flat('skin', SKIN, 0.55)
        self.hair = lib.mat_grain('hair', HAIR, (0.2, 0.16, 0.12), scale=30, stretch=(1, 1, 3), bump=0.5)
        self.tunic = lib.mat_grain('tunic', (0.86, 0.86, 0.85), TUNIC, scale=18, stretch=(1, 1, 4), bump=0.35)
        self.leather = lib.mat_grain('leather', LEATHER, (0.58, 0.36, 0.18), scale=24, stretch=(1, 1, 1), bump=0.4)
        self.sandals = lib.mat_flat('sandals', SANDALS)
        self.wood = lib.mat_grain('wood', *WOOD, scale=6, stretch=(1, 1, 8), bump=0.4)
        self.metal = lib.mat_flat('metal', METAL, rough=0.25)
        self.metal.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.9
        self.dark = lib.mat_flat('dark', (0.12, 0.1, 0.08))

        self.root = bpy.data.objects.new('root', None)
        bpy.context.scene.collection.objects.link(self.root)
        self.tools = {}  # shape → list of objects (shown only when that tool is in hand)
        self.extras = {}  # shape → objects worn with it (shield, armour, quiver)

        def pivot(name, loc, parent=None):
            e = bpy.data.objects.new(name, None)
            bpy.context.scene.collection.objects.link(e)
            e.parent = parent or self.root
            e.location = loc
            bpy.context.view_layer.update()
            return e

        self.pivot = pivot

        hip_z = 0.29
        self.legs = []
        for side in (-1, 1):
            p = pivot(f'hip{side}', (0, side * 0.062, hip_z))
            self.attach(lib.cylinder((0, side * 0.062, hip_z - 0.13), 0.05, 0.27, self.skin, radius2=0.043, verts=10), p)
            self.attach(lib.box((0.035, side * 0.062, 0.024), (0.12, 0.07, 0.05), self.sandals, bevel=0.018), p)
            # Leather straps of the sandals.
            self.attach(lib.cylinder((0, side * 0.062, 0.08), 0.047, 0.025, self.leather, verts=10), p)
            self.legs.append(p)
        tunic = [
            # A short tunic flaring to the knee, a belt and a strap across the chest.
            lib.cylinder((0, 0, 0.42), 0.155, 0.32, self.tunic, radius2=0.112, verts=18),
            lib.cylinder((0, 0, 0.615), 0.112, 0.07, self.tunic, radius2=0.085, verts=18),
        ]
        for obj in tunic:
            obj['mask'] = 1
            self.attach(obj, self.root)
        for obj in (
            lib.cylinder((0, 0, 0.45), 0.118, 0.045, self.leather, verts=18),
            lib.box((0.0, 0.0, 0.55), (0.24, 0.035, 0.03), self.leather, rot=(0.9, 0, 0)),
            lib.sphere((0.005, 0, 0.76), 0.122, self.skin),
            # A mop of black hair, a big nose, ears.
            lib.sphere((-0.018, 0, 0.8), 0.128, self.hair, scale=(1.0, 1.04, 0.78)),
            lib.sphere((-0.04, 0, 0.74), 0.11, self.hair, scale=(0.9, 1.05, 0.75)),
            lib.sphere((0.122, 0, 0.745), 0.028, self.skin, scale=(1, 0.9, 1.2)),
            lib.sphere((0.0, 0.118, 0.75), 0.026, self.skin),
            lib.sphere((0.0, -0.118, 0.75), 0.026, self.skin),
            lib.sphere((0.108, 0.04, 0.775), 0.012, self.dark),
            lib.sphere((0.108, -0.04, 0.775), 0.012, self.dark),
        ):
            self.attach(obj, self.root)
        self.arms = []
        self.hands = []
        self.grips = []
        for side in (-1, 1):
            p = pivot(f'shoulder{side}', (0, side * 0.145, 0.62))
            sleeve = lib.cylinder((0, side * 0.145, 0.59), 0.055, 0.08, self.tunic, verts=10)
            sleeve['mask'] = 1
            self.attach(sleeve, p)
            self.attach(lib.cylinder((0, side * 0.145, 0.49), 0.041, 0.19, self.skin, verts=10), p)
            hand = lib.sphere((0, side * 0.145, 0.38), 0.045, self.skin)
            self.attach(hand, p)
            self.arms.append(p)
            self.hands.append(hand)
            # Tool pivot at the grip, tilted per pose.
            self.grips.append(pivot(f'grip{side}', (0, 0, 0.38 - 0.62), p))
        self.build_tools()
        self.root.scale = (FIGURE_SCALE,) * 3
        bpy.context.view_layer.update()

    def attach(self, obj, parent):
        bpy.context.view_layer.update()
        world = obj.matrix_world.copy()
        obj.parent = parent
        obj.matrix_world = world
        return obj

    # ------------------------------------------------------------------------------------- tools

    def tool(self, shape, grip, parts):
        """Parts built around the origin (the grip), tool pointing up +Z with its head at the top;
        attached to a grip pivot."""
        objs = []
        for obj in parts:
            # Re-base from the origin onto the grip pivot.
            obj.parent = grip
            objs.append(obj)
        self.tools.setdefault(shape, []).extend(objs)

    def build_tools(self):
        r, l = self.grips[0], self.grips[1]  # right (tool) hand, left hand
        W, M = self.wood, self.metal
        self.tool('axe', r, [
            lib.cylinder((0, 0, 0.17), 0.018, 0.46, W, verts=8),
            lib.box((-0.06, 0, 0.36), (0.1, 0.022, 0.1), M, bevel=0.01),
            lib.box((-0.115, 0, 0.36), (0.02, 0.026, 0.13), M),
        ])
        self.tool('hammer', r, [
            lib.cylinder((0, 0, 0.13), 0.017, 0.32, W, verts=8),
            lib.box((0, 0, 0.29), (0.13, 0.055, 0.055), M, bevel=0.01),
        ])
        self.tool('pick', r, [
            lib.cylinder((0, 0, 0.17), 0.018, 0.46, W, verts=8),
            lib.cylinder((0, 0, 0.38), 0.022, 0.32, M, radius2=0.006, rot=(0, math.pi / 2, 0), verts=8),
        ])
        self.tool('shovel', r, [
            lib.cylinder((0, 0, 0.2), 0.016, 0.52, W, verts=8),
            lib.box((0, 0, 0.5), (0.11, 0.02, 0.15), M, bevel=0.012),
        ])
        self.tool('scythe', r, [
            lib.cylinder((0, 0, 0.22), 0.016, 0.6, W, verts=8),
            lib.box((-0.15, 0, 0.5), (0.3, 0.012, 0.05), M, rot=(0, -0.25, 0)),
        ])
        self.tool('rod', r, [
            lib.cylinder((0, 0, 0.35), 0.012, 0.8, W, radius2=0.005, verts=6),
        ])
        self.tool('bucket', r, [
            lib.cylinder((0, 0, 0.1), 0.058, 0.11, W, radius2=0.07, verts=12),
            lib.cylinder((0, 0, 0.16), 0.072, 0.01, M, verts=12),
        ])
        self.tool('sword', r, [
            lib.box((0, 0, 0.24), (0.04, 0.012, 0.36), M, bevel=0.006),
            lib.box((0, 0, 0.055), (0.11, 0.03, 0.022), M),
            lib.cylinder((0, 0, 0.0), 0.018, 0.1, self.leather, verts=8),
        ])
        # Bow in the left hand: a curved stave and its string.
        stave = []
        for k in range(7):
            t = k / 6 - 0.5
            stave.append(lib.cylinder((0.07 * (1 - (2 * t) ** 2), 0, t * 0.5), 0.013, 0.1, W,
                                      rot=(0, -1.6 * t, 0), verts=6))
        stave.append(lib.cylinder((-0.005, 0, 0), 0.003, 0.5, self.dark, verts=4))
        self.tool('bow', l, stave)
        self.build_outfits()

    def build_outfits(self):
        """What the fighters wear (`OUTFITS`): parts are hidden unless their outfit is shown. Shields
        hang on the left hand's grip; the rest is attached to the body. Parts in the player's colour
        (shield faces, the leader's cloak) carry `mask`."""
        l = self.grips[1]
        steel = lib.mat_flat('steel', STEEL, rough=0.22)
        steel.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.9
        gold = lib.mat_flat('gold', GOLD, rough=0.25)
        gold.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.95
        brass = lib.mat_flat('brass', BRASS, rough=0.3)
        brass.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.9
        L = self.leather

        def on_grip(parts):
            for obj in parts:
                obj.parent = l
            return parts

        def on_body(parts):
            for obj in parts:
                self.attach(obj, self.root)
            return parts

        def masked(obj):
            obj['mask'] = 1
            return obj

        # Plated armour: overlapping steel bands round the chest, layered shoulder plates, a leather
        # kilt of strips — wider than a civilian, so a soldier reads as one at a glance.
        bands = on_body([lib.cylinder((0, 0, 0.47 + 0.042 * k), 0.142 - 0.006 * k, 0.05, steel, radius2=0.136 - 0.006 * k,
                                      verts=20) for k in range(5)])
        pauldrons = on_body([lib.sphere((0, side * (0.15 + 0.012 * k), 0.63 - 0.035 * k), 0.07 - 0.008 * k, steel,
                                        scale=(1.1, 0.9, 0.55)) for side in (-1, 1) for k in range(3)])
        kilt = on_body([lib.box((math.cos(a) * 0.13, math.sin(a) * 0.13, 0.38), (0.035, 0.05, 0.11), L,
                                rot=(0, 0, a)) for a in [k * math.pi / 5 for k in range(10)]])
        belt = on_body([lib.cylinder((0, 0, 0.45), 0.146, 0.035, brass, verts=20)])

        # The legionary's shield: tall, curved round the arm, face in the player's colour with a
        # brass rim, a boss and two brass bars across (our own simple motif).
        scutum = []
        n, half_w, height = 7, 0.17, 0.46
        for k in range(n):
            t = (k + 0.5) / n * 2 - 1  # −1 … 1 across the width
            a = t * 0.55
            y = math.sin(a) * 0.3
            x = 0.09 + (1 - math.cos(a)) * 0.3 * -1 + 0.08
            scutum.append(masked(lib.box((x, y, 0.03), (0.016, 2 * half_w / n + 0.004, height), self.tunic,
                                         rot=(0, 0, a))))
            for z in (0.03 + height / 2, 0.03 - height / 2):
                scutum.append(lib.box((x + 0.004, y, z), (0.02, 2 * half_w / n + 0.004, 0.022), brass, rot=(0, 0, a)))
            if k in (0, n - 1):
                scutum.append(lib.box((x + 0.004, y, 0.03), (0.02, 0.018, height), brass, rot=(0, 0, a)))
        scutum += [lib.sphere((0.185, 0, 0.03), 0.05, brass, scale=(0.7, 1, 1))]
        scutum += [lib.box((0.182, 0, 0.03 + dz), (0.012, 0.2, 0.025), brass) for dz in (0.13, -0.13)]
        scutum = on_grip(scutum)

        # The bowman: leather armour with shoulder pads, a quiver on the back.
        jerkin = on_body([lib.cylinder((0, 0, 0.555), 0.13, 0.18, L, radius2=0.105, verts=18)] +
                         [lib.sphere((0, side * 0.145, 0.615), 0.065, L, scale=(1, 1, 0.6)) for side in (-1, 1)])
        quiver = on_body([lib.cylinder((-0.15, 0.05, 0.6), 0.048, 0.32, L, rot=(0.25, -0.2, 0), verts=10)] +
                         [lib.box((-0.165 + 0.02 * k, 0.05 + 0.01 * k, 0.79), (0.012, 0.03, 0.05),
                                  lib.mat_flat('feather', (0.9, 0.85, 0.7)), rot=(0.25, -0.2, 0)) for k in range(3)])

        # The squad leader: a gilded muscled cuirass, a round golden shield, a cloak in the player's
        # colour hanging from the shoulders.
        cuirass = on_body([lib.cylinder((0, 0, 0.54), 0.148, 0.2, gold, radius2=0.132, verts=22),
                           lib.sphere((0.07, 0.05, 0.57), 0.07, gold, scale=(0.7, 1, 0.8)),
                           lib.sphere((0.07, -0.05, 0.57), 0.07, gold, scale=(0.7, 1, 0.8)),
                           lib.cylinder((0, 0, 0.445), 0.15, 0.03, gold, verts=22)] +
                          [lib.sphere((0, side * 0.155, 0.625), 0.072, gold, scale=(1.1, 0.9, 0.55)) for side in (-1, 1)])
        cloak = on_body([masked(lib.box((-0.15, 0, 0.42), (0.03, 0.3, 0.44), self.tunic, rot=(0, -0.18, 0), bevel=0.01)),
                         masked(lib.box((-0.11, 0, 0.64), (0.07, 0.3, 0.04), self.tunic))])
        round_shield = on_grip([lib.cylinder((0.11, 0, 0.02), 0.17, 0.026, gold, rot=(0, math.pi / 2, 0), verts=28),
                                lib.sphere((0.124, 0, 0.02), 0.06, gold, scale=(0.5, 1, 1))])

        self.extras = {
            'legion': bands + pauldrons + kilt + belt + scutum,
            'archer': jerkin + quiver + kilt + belt,
            'leader': cuirass + kilt + cloak + round_shield,
        }

    def show(self, shape, outfit=None):
        """Shows the tool `shape` and the outfit's parts (none for plain clothes), hides the others."""
        for s, objs in self.tools.items():
            for o in objs:
                o.hide_render = s != shape
        worn = set(self.extras.get(outfit, []))
        for objs in self.extras.values():
            for o in objs:
                o.hide_render = o not in worn

    # ------------------------------------------------------------------------------------- poses

    def pose(self, yaw, leg=0.0, right=None, left=None, right_yaw=0.0, left_yaw=0.0, tilt=0.0, left_tilt=0.0):
        """Arm angles in turns (0 down … 1 up), None for a hanging arm; yaws (degrees) swing a raised
        arm inward; tilts (degrees) turn the tool at the hand."""
        self.root.rotation_euler = (0, 0, yaw)
        for side, p in zip((-1, 1), self.legs):
            p.rotation_euler = (0, math.radians(side * leg), 0)
        for side, p, a, y in ((-1, self.arms[0], right, right_yaw), (1, self.arms[1], left, left_yaw)):
            p.rotation_euler = (0, -math.pi * (a or 0.0), math.radians(-side * y))
        self.grips[0].rotation_euler = (0, math.radians(tilt), 0)
        self.grips[1].rotation_euler = (0, math.radians(left_tilt), 0)
        bpy.context.view_layer.update()

    def point(self, obj):
        dg = bpy.context.evaluated_depsgraph_get()
        ev = obj.evaluated_get(dg)
        corners = [ev.matrix_world @ Vector(c) for c in ev.bound_box]
        return sum(corners, Vector()) / 8

    def hand_point(self):
        return (self.point(self.hands[0]) + self.point(self.hands[1])) / 2


def swing(deg):
    """Free-arm walk swing in degrees → turns (small forward/back sway around hanging)."""
    return deg / 180


def hold_frames(shape):
    """Walk frames then standing, holding `shape`: [(shape, pose kwargs)]."""
    arm, tilt = HOLD[shape]
    frames = []
    for f in range(WALK_FRAMES + 1):
        leg, sw = WALK[f] if f < WALK_FRAMES else (0, 0)
        if shape == 'carry':
            kw = dict(leg=leg * 0.8, right=0.42, left=0.42, right_yaw=26, left_yaw=26)
        elif shape == 'bow':
            kw = dict(leg=leg, right=swing(-sw), left=0.1, left_tilt=0)
        elif shape == 'sword':
            kw = dict(leg=leg, right=arm, left=0.28, tilt=tilt, left_yaw=20)
        elif arm is None:
            kw = dict(leg=leg, right=swing(-sw), left=swing(sw))
        else:
            kw = dict(leg=leg, right=arm + swing(-sw) * 0.3, left=swing(sw), tilt=tilt)
        frames.append((shape, kw))
    return frames


def work_frames(action):
    """The 4 frames of a work action: [(shape, pose kwargs)]."""
    shape, arms, pull = ACTIONS[action]
    frames = []
    for f, a in enumerate(arms):
        if shape == 'bow':
            p = pull[f]
            kw = dict(right=0.5, right_yaw=22 + 18 * p, left=0.5, left_yaw=-6, left_tilt=90)
        elif shape == 'sword':
            kw = dict(right=a, tilt=WORK_TILT, left=0.32, left_yaw=24)
        elif shape in TWO_HANDED:
            kw = dict(right=a, left=a, right_yaw=14, left_yaw=30, tilt=WORK_TILT)
        elif shape == 'none':
            kw = dict(right=a, left=0.25, left_yaw=20)
        else:
            kw = dict(right=a, left=0.04, tilt=WORK_TILT)
        frames.append((shape, kw))
    return frames


def poses():
    """Every pose group: (group key, frames, outfit) where a frame is the tool shown plus the kwargs
    for `Figure.pose`. Hold groups have 4 walk frames and a standing one; work groups 4 frames. The
    plain groups come first, then each outfit's own (`hold:<tool>@<outfit>`, `work:<action>@<outfit>`)."""
    groups = [(f'hold:{shape}', hold_frames(shape), None) for shape in TOOLS]
    groups += [(f'work:{action}', work_frames(action), None) for action in ACTIONS]
    for outfit, (tools, actions) in OUTFITS.items():
        groups += [(f'hold:{shape}@{outfit}', hold_frames(shape), outfit) for shape in tools]
        groups += [(f'work:{action}@{outfit}', work_frames(action), outfit) for action in actions]
    return groups


# --------------------------------------------------------------------------------------- rendering

def mask_material():
    """Emission of the object's `mask` property: white where the run-time colour goes."""
    mat = bpy.data.materials.new('mask')
    mat.use_nodes = True
    nodes, links = mat.node_tree.nodes, mat.node_tree.links
    for n in list(nodes):
        nodes.remove(n)
    attr = nodes.new('ShaderNodeAttribute')
    attr.attribute_type = 'OBJECT'
    attr.attribute_name = 'mask'
    emit = nodes.new('ShaderNodeEmission')
    out = nodes.new('ShaderNodeOutputMaterial')
    links.new(attr.outputs['Fac'], emit.inputs['Strength'])
    links.new(emit.outputs['Emission'], out.inputs['Surface'])
    return mat


def read_png(path):
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h, w, 4)[::-1]  # top row first


def render_full(scene, path):
    lib.render_to(scene, path)
    return read_png(path)


def render_mask(scene, path, mask_mat):
    """Mask pass: few samples, every material replaced by the mask emission, no shadow."""
    layer = bpy.context.view_layer
    catcher = bpy.data.objects['ShadowCatcher']
    samples, denoise = scene.cycles.samples, scene.cycles.use_denoising
    scene.cycles.samples, scene.cycles.use_denoising = 6, False
    layer.material_override = mask_mat
    catcher.hide_render = True
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    layer.material_override = None
    catcher.hide_render = False
    scene.cycles.samples, scene.cycles.use_denoising = samples, denoise
    return read_png(path)


def build_hat_proxy(fig):
    """The space any hat may take (the union of the hat styles, a little generous): hidden in the
    normal passes, a holdout in the arm-over-hat pass. Built in figure space like the hats."""
    scale = fig.root.scale.copy()
    fig.root.scale = (1, 1, 1)
    fig.root.rotation_euler = (0, 0, 0)
    bpy.context.view_layer.update()
    z = 0.76
    objs = [
        lib.sphere((-0.01, 0, z + 0.06), 0.16, None, scale=(1.05, 1.05, 0.85)),
        lib.cylinder((0, 0, z + 0.07), 0.25, 0.03, None, verts=24),
        lib.cylinder((-0.01, 0, z + 0.16), 0.15, 0.26, None, verts=18),
        lib.cylinder((-0.02, 0, z - 0.1), 0.17, 0.1, None, verts=18),
        # Tall crests of fighters' helmets, front to back.
        lib.box((-0.02, 0, z + 0.3), (0.38, 0.08, 0.3), None),
    ]
    for o in objs:
        fig.attach(o, fig.root)
        o.hide_render = True
    fig.root.scale = scale
    bpy.context.view_layer.update()
    return objs


def arm_parts(fig):
    """Every mesh hanging from the shoulders: sleeves, arms, hands, and the tools at the grips."""
    parts = []
    for p in fig.arms:
        parts += [o for o in p.children_recursive if o.type == 'MESH']
    return parts


def render_over(scene, path, fig, proxy, neck_y):
    """Arm-over-hat pass for work poses: only the arms and tools render, everything else (the body,
    head and the hat proxy) is a holdout, so what remains is the arm and tool where they pass in front
    of the head and any hat. Rows below the neck are cleared (no hat there to cover), so frames with
    the arms down come out empty. The game draws it above the hat layer."""
    arms = set(arm_parts(fig))
    catcher = bpy.data.objects['ShadowCatcher']
    changed = []
    for o in scene.objects:
        if o.type != 'MESH' or o is catcher or o.hide_render and o not in proxy:
            continue
        if o not in arms:
            changed.append(o)
            o.is_holdout = True
    for o in proxy:
        o.hide_render = False
    samples, denoise = scene.cycles.samples, scene.cycles.use_denoising
    scene.cycles.samples, scene.cycles.use_denoising = 10, False
    catcher.hide_render = True
    px = render_full(scene, path)
    catcher.hide_render = False
    scene.cycles.samples, scene.cycles.use_denoising = samples, denoise
    for o in proxy:
        o.hide_render = True
    for o in changed:
        o.is_holdout = False
    px[int(neck_y):, :, 3] = 0
    return px


class Packer:
    """Trims frames to their opaque pixels and shelf-packs them into PAGE×PAGE pages."""

    def __init__(self):
        self.pages = []
        self.frames = []  # [page, x, y, w, h, ax, ay] in pixels; ax/ay: the anchor inside the rect
        self.x = self.y = self.row = 0
        self.new_page()

    def new_page(self):
        self.pages.append(np.zeros((PAGE, PAGE, 4), dtype=np.float32))
        self.x = self.y = self.row = 1

    def add(self, px):
        """Adds a frame (top row first, full cell); returns its index or −1 when it is empty."""
        alpha = px[..., 3] > 0.02
        if not alpha.any():
            return -1
        ys, xs = np.nonzero(alpha)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        crop = px[y0:y1, x0:x1]
        h, w = crop.shape[:2]
        if self.x + w + 1 > PAGE:
            self.x = 1
            self.y += self.row + 1
            self.row = 0
        if self.y + h + 1 > PAGE:
            self.new_page()
        self.pages[-1][self.y:self.y + h, self.x:self.x + w] = crop
        r = lib.RESOLUTION
        self.frames.append([len(self.pages) - 1, int(self.x), int(self.y), int(w), int(h),
                            int(ANCHOR_X * r - x0), int(ANCHOR_Y * r - y0)])
        self.x += w + 1
        self.row = max(self.row, h)
        return len(self.frames) - 1

    def save(self, out, prefix):
        names = []
        for k, page in enumerate(self.pages):
            # The last page is cut down to the rows it uses.
            used = self.y + self.row + 1 if k == len(self.pages) - 1 else PAGE
            name = f'{prefix}-{k}.png'
            save_rgba(page[:used], os.path.join(out, name))
            names.append(name)
        return names


def save_rgba(px, path):
    h, w = px.shape[:2]
    img = bpy.data.images.new('page', width=w, height=h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(px[::-1]).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def build_settlers(out, tmp, only=None, hats=None):
    """Renders every pose group in every direction plus the hat layers; writes settlers-*.png and
    settlers.json into `out`. `only`: a list of group keys to render (for quick looks)."""
    scene = lib.reset_scene(samples=14)
    # Small frames render fine on the CPU; it keeps the GPU (and the machine) cool, and Metal kernel
    # compilation has crashed long runs.
    scene.cycles.device = 'CPU'
    lib.setup_camera(scene, CELL_W, CELL_H, ANCHOR_X, ANCHOR_Y)
    cache = os.path.join(tmp, 'settlers-cache')
    os.makedirs(cache, exist_ok=True)
    fig = Figure()
    proxy = build_hat_proxy(fig)
    # Rows below the head (render pixels): the arm-over-hat pass keeps only what is above.
    fig.pose(0.0)
    _, neck = lib.screen_point(scene, fig.root.matrix_world @ Vector((0, 0, 0.66)))
    neck_y = neck * lib.RESOLUTION
    mask_mat = mask_material()
    pack = Packer()
    meta = {
        'cell': [CELL_W, CELL_H], 'anchor': [ANCHOR_X, ANCHOR_Y], 'resolution': lib.RESOLUTION,
        'walk': WALK_FRAMES, 'groups': {}, 'hats': {}, 'carryAt': [], 'carryBehind': [],
        'rankY': -round(1.02 * FIGURE_SCALE * lib.PX_PER_UNIT * math.cos(math.radians(30)) + 6),
    }
    path = os.path.join(tmp, 'fig.png')
    mpath = os.path.join(tmp, 'fig-mask.png')
    opath = os.path.join(tmp, 'fig-over.png')
    yaws = []
    for d in range(DIRS):
        gx, gy = lib.ground_dir(d * math.pi / 4)
        yaws.append(math.atan2(gy, gx))
    for key, frames, outfit in poses():
        if only and key not in only:
            continue
        # Each group is cached (uint8) once rendered, so an interrupted run resumes where it stopped.
        work = key.startswith('work:')
        per = 3 if work else 2  # work poses add the arm-over-hat pass
        rev = f'-r{LOOK_REV[outfit]}' if outfit else ''
        cached = os.path.join(cache, key.replace(':', '-').replace('@', '_') + f'-{DIRS}-{per}{rev}.npz')
        if os.path.exists(cached):
            data = np.load(cached)['frames'].astype(np.float32) / 255
        else:
            data = []
            for d in range(DIRS):
                for shape, kw in frames:
                    fig.show(shape, outfit)
                    fig.pose(yaws[d], **kw)
                    full = render_full(scene, path)
                    mask = render_mask(scene, mpath, mask_mat)[..., 0]
                    tint = full.copy()
                    tint[..., 3] = full[..., 3] * np.clip(mask, 0, 1)
                    data += [full, tint]
                    if work:
                        data.append(render_over(scene, opath, fig, proxy, neck_y))
            data = np.stack(data)
            np.savez_compressed(cached, frames=np.round(np.clip(data, 0, 1) * 255).astype(np.uint8))
        rows = []
        k = 0
        for d in range(DIRS):
            row = []
            for _ in frames:
                row.append([pack.add(data[k + j]) for j in range(per)])
                k += per
            rows.append(row)
        meta['groups'][key] = rows
        print('settlers: rendered', key, flush=True)
    # Goods in hand: where the hands are in the carry poses, and whether they are behind the body.
    for d in range(DIRS):
        fig.show('carry')
        row = []
        for _, kw in hold_frames('carry'):
            fig.pose(yaws[d], **kw)
            sx, sy = lib.screen_point(scene, fig.hand_point())
            row.append([round(sx - ANCHOR_X, 1), round(sy - ANCHOR_Y, 1)])
        meta['carryAt'].append(row)
        behind = lib.camera_depth(scene, fig.hand_point()) > lib.camera_depth(scene, (0, 0, 0.45))
        meta['carryBehind'].append(bool(behind))
    if hats if hats is not None else not only:
        meta['hats'] = render_hats(scene, fig, yaws, pack, path)
    meta['pages'] = pack.save(out, 'settlers')
    meta['frames'] = pack.frames
    with open(os.path.join(out, 'settlers.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))


def build_hat(style, fig):
    """A hat on the figure's head (white, tinted at run time), or None for bare heads."""
    white = lib.mat_grain('hatcloth', (0.86, 0.86, 0.84), (0.98, 0.98, 0.97), scale=20, stretch=(1, 1, 1), bump=0.3)
    straw = lib.mat_grain('straw', (0.86, 0.84, 0.76), (1.0, 0.98, 0.92), scale=14, stretch=(1, 8, 1), bump=0.6)
    shiny = lib.mat_flat('helm', (0.96, 0.96, 0.98), rough=0.2)
    shiny.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.85
    z = 0.76
    steel = lib.mat_flat('galea', (0.9, 0.92, 0.95), rough=0.18)
    steel.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.92
    gilt = lib.mat_flat('gilt', (0.98, 0.78, 0.3), rough=0.22)
    gilt.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.95
    red = lib.mat_grain('crest', (0.62, 0.05, 0.04), (0.9, 0.16, 0.1), scale=40, stretch=(1, 6, 1), bump=0.6)

    def galea(metal, crest_size=0.0):
        """A legionary-style helmet: dome, brow band, cheek guards, a flared neck guard at the back, a
        knob on top; with `crest_size` a red brush crest running front to back on a small holder."""
        parts = [
            lib.sphere((-0.005, 0, z + 0.05), 0.138, metal, scale=(1.05, 1.05, 0.88)),
            lib.cylinder((0, 0, z + 0.0), 0.148, 0.03, metal, verts=22),
            # Neck guard: a flared plate at the back (−X).
            lib.box((-0.13, 0, z - 0.03), (0.06, 0.24, 0.02), metal, rot=(0, 0.45, 0), bevel=0.008),
        ]
        for side in (-1, 1):  # cheek guards
            parts.append(lib.box((0.04, side * 0.125, z - 0.04), (0.075, 0.016, 0.1), metal, rot=(side * 0.12, 0, 0), bevel=0.008))
        if crest_size <= 0:
            parts.append(lib.sphere((-0.01, 0, z + 0.175), 0.022, metal))
            return parts
        # The crest: brush tufts along an arc over the dome, front to back, tallest in the middle; its
        # height and length grow with `crest_size` (small at level 2, big at level 3, taller still for
        # the squad leader).
        h = 0.035 + 0.13 * crest_size
        span = 0.55 + 0.5 * min(crest_size, 1.0)
        n = 7
        for k in range(n):
            t = k / (n - 1) * 2 - 1
            a = t * span
            x = -0.01 + math.sin(a) * 0.125
            zc = z + 0.05 + math.cos(a) * 0.112
            hh = h * (1 - 0.45 * t * t)
            parts.append(lib.lumpy((x, 0, zc + hh / 2), 0.05, red, scale=(0.9, 0.62, max(0.4, hh / 0.1)),
                                   strength=0.3, noise=0.9, seed=11 + k, subdiv=2))
        return parts

    parts = {
        'cap': lambda: [lib.sphere((-0.01, 0, z + 0.06), 0.13, white, scale=(1.05, 1.05, 0.6)),
                        lib.box((0.11, 0, z + 0.04), (0.08, 0.16, 0.015), white, bevel=0.01)],
        'straw': lambda: [lib.cylinder((0, 0, z + 0.07), 0.24, 0.018, straw, verts=24),
                          lib.cylinder((0, 0, z + 0.12), 0.12, 0.1, straw, radius2=0.09, verts=18)],
        'helmet': lambda: [lib.sphere((-0.005, 0, z + 0.05), 0.135, shiny, scale=(1.05, 1.05, 0.85)),
                           lib.cylinder((0, 0, z + 0.0), 0.15, 0.025, shiny, verts=20),
                           lib.box((-0.01, 0, z + 0.19), (0.2, 0.025, 0.04), shiny, bevel=0.01)],
        'hood': lambda: [lib.sphere((-0.03, 0, z + 0.03), 0.15, white, scale=(1.05, 1.05, 1.0)),
                         lib.cylinder((-0.02, 0, z - 0.12), 0.16, 0.08, white, radius2=0.12, verts=18)],
        'chef': lambda: [lib.cylinder((-0.01, 0, z + 0.14), 0.12, 0.2, white, radius2=0.14, verts=18),
                         lib.sphere((-0.01, 0, z + 0.25), 0.15, white, scale=(1, 1, 0.5))],
        'bare': lambda: [],
        # Squad leader: a gilded helmet with a very tall crest.
        'plume': lambda: galea(gilt, crest_size=1.35),
        # Fighters' helmets (galea) by level: no crest, a small crest, a big crest.
        'galea1': lambda: galea(steel),
        'galea2': lambda: galea(steel, crest_size=0.35),
        'galea3': lambda: galea(steel, crest_size=1.0),
    }
    objs = parts[style]()
    for o in objs:
        fig.attach(o, fig.root)
    return objs


def render_hats(scene, fig, yaws, pack, path):
    """Hat layers: per style and direction, standing, with the figure as a holdout so the head
    hides what is behind it. Built in figure space (before the root scale), so they sit on the head."""
    hats = {}
    fig.show('none')
    bpy.data.objects['ShadowCatcher'].hide_render = True
    body = [o for o in scene.objects if o.type == 'MESH' and o.name != 'ShadowCatcher']
    for o in body:
        o.is_holdout = True
    scale = fig.root.scale.copy()
    for style in HAT_STYLES:
        fig.root.scale = (1, 1, 1)
        fig.root.rotation_euler = (0, 0, 0)
        bpy.context.view_layer.update()
        objs = build_hat(style, fig)
        fig.root.scale = scale
        if not objs:
            hats[style] = [-1] * DIRS
            continue
        row = []
        for d in range(DIRS):
            fig.pose(yaws[d])
            row.append(pack.add(render_full(scene, path)))
        hats[style] = row
        for o in objs:
            bpy.data.objects.remove(o)
        print('settlers: hat', style, flush=True)
    for o in body:
        o.is_holdout = False
    return hats
