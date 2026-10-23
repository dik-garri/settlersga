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
TOOLS = ['none', 'axe', 'hammer', 'pick', 'shovel', 'scythe', 'rod', 'bucket', 'sword', 'bow', 'carry', 'spear']
HAT_STYLES = ['cap', 'straw', 'helmet', 'hood', 'chef', 'bare', 'plume', 'galea1', 'galea2', 'galea3', 'coif', 'knit',
              'galea1t']

#: Outfits (src/render/animConfig.ts `Outfit`): what a profession wears over the tunic, rendered as
#: its own pose groups `hold:<tool>@<outfit>` and `work:<action>@<outfit>`.
OUTFITS = {
    # Swordsmen by level (`build_fighters`): leather cuirass and a small scutum; a steel chest plate
    # and an oval shield; banded steel and a big scutum with a winged emblem.
    'legion1': (['sword'], ['sword']),
    'legion2': (['sword'], ['sword']),
    'legion3': (['sword'], ['sword']),
    # Bowmen by level: a leather jerkin; studded leather with steel shoulder guards; banded steel.
    'archer1': (['bow'], ['shoot']),
    'archer2': (['bow'], ['shoot']),
    'archer3': (['bow'], ['shoot']),
    'leader': (['sword'], ['sword']),  # squad leader: gilded cuirass, round gilded shield, cloak
    'healer': (['none'], []),  # infirmary's healer: long linen robe, stole, satchel of herbs
    'watch': (['spear'], []),  # lookout's watchman: short wool cape, horn at the hip (and his spear)
    'saboteur': (['pick'], ['smash']),  # saboteur: dark jerkin, sash with pouches, leg wraps (and a pick)
    # Settlers 4's Roman builders and diggers carry their tools up on the shoulder.
    'builder': (['hammer'], ['hammer']),  # leather apron and girdle, a big mallet
    'digger': (['shovel'], ['dig']),  # brown leather jerkin, a broad spade
    'pioneer': (['shovel'], ['dig']),  # a long green apron, a broad spade, a pouch of border pegs
    'geologist': (['hammer'], ['knock']),  # leather coat, puffed shoulders, brimmed leather hat, satchel
    'thief': (['none', 'carry'], ['sow']),  # black cap, dark puffed shoulders, black breeches; loot on the shoulder
}
#: The fighters keep the body they were rendered with (`Figure.build_classic`); everybody else wears
#: the Roman civilian's (`Figure.build_civil`).
FIGHTERS = {'legion1', 'legion2', 'legion3', 'archer1', 'archer2', 'archer3', 'leader'}
#: Outfits with a cap of their own over the crown (the hair on top is hidden under it).
CAPPED = {'geologist', 'thief'}
#: Bumped when a look changes, so its cached groups are rendered again; `PLAIN_REV` for the plain
#: (civilian) groups and hats.
LOOK_REV = {'legion1': 1, 'legion2': 1, 'legion3': 1, 'archer1': 1, 'archer2': 1, 'archer3': 1, 'leader': 3,
            'healer': 2, 'watch': 2, 'saboteur': 2, 'builder': 1, 'digger': 1, 'pioneer': 1, 'geologist': 1,
            'thief': 1}
PLAIN_REV = 2
#: Hat styles worn by the fighters (rendered with their body); the rest sit on the civilian's
#: bigger mop of hair and are drawn a little larger (`CIVIL_HAT_SCALE`).
FIGHTER_HATS = {'galea1', 'galea2', 'galea3', 'galea1t', 'plume'}
CIVIL_HAT_SCALE = 1.1
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
    # The geologist bent over the rock, knocking it with his hammer.
    'knock': ('hammer', [1.0, 0.43, 0.38, 0.41], None),
    # The saboteur hacking at a wall: the pick from over his head into the wall at chest height.
    'smash': ('pick', [1.04, 0.78, 0.5, 0.6], None),
}
#: Actions done bent over (animConfig.ts `ActionDef.bend`): the torso's forward bend per frame in
#: degrees; the arm angles above are then the torso's, the free hand rests forward (two-handed tools
#: keep both hands on the haft), the feet apart.
BEND = {
    'knock': [30, 42, 50, 46],
    'smash': [-4, 4, 14, 8],  # leaning back on the swing, into the blow
}
#: Actions only ever done in an outfit (the geologist's knock, the saboteur's smash, the fighters'
#: sword): no plain group (the game falls back to the tool held still, which nobody sees).
OUTFIT_ONLY = {'knock', 'smash', 'sword'}
#: Where the torso bends (the belt), in figure space.
WAIST_Z = 0.44

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
    # Upright at the side, the butt near the ground: the tilt cancels the arm's angle.
    'spear': (0.06, 7),
}
#: Tools carried on the shoulder (arm angle in turns, tool tilt in degrees) by outfit.
SHOULDERED = {'builder': (0.3, 8), 'digger': (0.3, -4), 'pioneer': (0.3, -4)}
#: The carrier's near arm up at the load on his shoulder (turns, inward yaw in degrees), and where
#: the load sits (figure space: on top of the near shoulder, against the head).
CARRY_ARM, CARRY_YAW = 0.93, -14
LOAD_AT = (0.0, -0.155, 0.635)
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
        # Everything above the belt hangs from the waist, so a work pose can bend the torso (`BEND`).
        self.waist = pivot('waist', (0, 0, WAIST_Z))
        self.head_ref = pivot('head', (0.005, 0, 0.76 - WAIST_Z), self.waist)
        self.load_ref = pivot('load', (LOAD_AT[0], LOAD_AT[1], LOAD_AT[2] - WAIST_Z), self.waist)
        self.legs = []
        for side in (-1, 1):
            p = pivot(f'hip{side}', (0, side * 0.062, hip_z))
            self.attach(lib.cylinder((0, side * 0.062, hip_z - 0.13), 0.05, 0.27, self.skin, radius2=0.043, verts=10), p)
            self.attach(lib.box((0.035, side * 0.062, 0.024), (0.12, 0.07, 0.05), self.sandals, bevel=0.018), p)
            # Leather straps of the sandals.
            self.attach(lib.cylinder((0, side * 0.062, 0.08), 0.047, 0.025, self.leather, verts=10), p)
            self.legs.append(p)
        # Two bodies share the limbs, the tools and the outfits: the fighters keep the body they were
        # rendered with (`FIGHTERS`, `classic`); everybody else wears Settlers 4's Roman civilian
        # (`civil`, `build_civil`). Each body: {'always': parts, 'upright': whole tunic, 'bent': skirt
        # and bodice, 'crown': hair a cap hides}.
        self.bodies = {'classic': self.build_classic(), 'civil': self.build_civil()}
        self.body = 'classic'
        self.bend = 0.0
        self.capped = False
        self.hair_hidden = False
        self.arms = []
        self.hands = []
        self.grips = []
        for side in (-1, 1):
            p = pivot(f'shoulder{side}', (0, side * 0.145, 0.62 - WAIST_Z), self.waist)
            sleeve = lib.cylinder((0, side * 0.145, 0.59), 0.055, 0.08, self.tunic, verts=10)
            sleeve['mask'] = 1
            self.bodies['classic']['always'].append(self.attach(sleeve, p))
            # The civilian's tunic is all but sleeveless: a short cap over the shoulder.
            sleeve = lib.cylinder((0, side * 0.147, 0.6), 0.052, 0.05, self.tunic, radius2=0.048, verts=12)
            sleeve['mask'] = 1
            self.bodies['civil']['always'].append(self.attach(sleeve, p))
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

    def build_classic(self):
        """The body the fighters were rendered with (kept as it was, so their frames stay
        reproducible): a short tunic flaring to the knee, a belt and a strap across the chest, a round
        head under a mop of black hair."""
        tunic = [
            lib.cylinder((0, 0, 0.42), 0.155, 0.32, self.tunic, radius2=0.112, verts=18),
            lib.cylinder((0, 0, 0.615), 0.112, 0.07, self.tunic, radius2=0.085, verts=18),
        ]
        for obj in tunic:
            obj['mask'] = 1
            self.attach(obj, self.waist)
        # Bent over, the tunic is two parts: the skirt below the belt stays with the legs, the bodice
        # above it bends with the torso (the whole tunic would swing its hem up behind). Hidden upright.
        skirt = lib.cylinder((0, 0, 0.35), 0.155, 0.18, self.tunic, radius2=0.131, verts=18)
        bodice = lib.cylinder((0, 0, 0.49), 0.134, 0.18, self.tunic, radius2=0.112, verts=18)
        for obj, parent in ((skirt, self.root), (bodice, self.waist)):
            obj['mask'] = 1
            self.attach(obj, parent)
        always = [tunic[1]]
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
            always.append(self.attach(obj, self.waist))
        return {'always': always, 'upright': [tunic[0]], 'bent': [skirt, bodice], 'crown': [], 'hair': []}

    def build_civil(self):
        """Settlers 4's Roman civilian: a big round head under a thick mop of tousled black hair —
        locks sticking out at the sides and the back, a fringe over the brow —, a round face with a
        big nose, brows and ears; an all but sleeveless tunic to the knee (the player's colour) with a
        rolled hem, belted low with a pale cord; sandal straps wound up the shins. Stockier than the
        fighters' body, the same height (hats, rank marks and goods in hand keep their places)."""
        S = self.skin
        hair = lib.mat_grain('civhair', (0.035, 0.035, 0.045), (0.17, 0.17, 0.21), scale=44, stretch=(1, 1, 3), bump=0.8)
        cord = lib.mat_grain('cord', (0.6, 0.56, 0.48), (0.82, 0.78, 0.68), scale=50, stretch=(1, 1, 1), bump=0.6)
        tunic = [
            # The tunic hangs straight from the shoulders and flares a little to a rolled hem.
            lib.cylinder((0, 0, 0.43), 0.16, 0.32, self.tunic, radius2=0.118, verts=22),
            lib.cylinder((0, 0, 0.62), 0.12, 0.07, self.tunic, radius2=0.09, verts=22),
            lib.cylinder((0, 0, 0.278), 0.164, 0.03, self.tunic, verts=22),
        ]
        for obj in tunic:
            obj['mask'] = 1
            self.attach(obj, self.waist)
        skirt = lib.cylinder((0, 0, 0.36), 0.16, 0.18, self.tunic, radius2=0.136, verts=22)
        hem = lib.cylinder((0, 0, 0.278), 0.164, 0.03, self.tunic, verts=22)
        bodice = lib.cylinder((0, 0, 0.5), 0.138, 0.18, self.tunic, radius2=0.118, verts=22)
        for obj, parent in ((skirt, self.root), (hem, self.root), (bodice, self.waist)):
            obj['mask'] = 1
            self.attach(obj, parent)
        always = [tunic[1]]
        parts = [
            lib.cylinder((0, 0, 0.455), 0.141, 0.03, cord, verts=24),
            lib.sphere((0.138, 0.035, 0.452), 0.02, cord),
            lib.cylinder((0.145, 0.045, 0.41), 0.008, 0.07, cord, rot=(0.15, -0.1, 0), verts=6),
            lib.cylinder((0, 0, 0.665), 0.052, 0.06, S, verts=12),
            # A big round head: face, nose, brows, eyes, ears.
            lib.sphere((0.005, 0, 0.765), 0.128, S, scale=(1.0, 1.0, 1.02)),
            lib.sphere((0.13, 0, 0.748), 0.031, S, scale=(1.0, 0.9, 1.2)),
            lib.sphere((0.0, 0.126, 0.752), 0.028, S, scale=(0.7, 1, 1.15)),
            lib.sphere((0.0, -0.126, 0.752), 0.028, S, scale=(0.7, 1, 1.15)),
            lib.sphere((0.112, 0.044, 0.778), 0.014, self.dark),
            lib.sphere((0.112, -0.044, 0.778), 0.014, self.dark),
            lib.box((0.112, 0.046, 0.805), (0.016, 0.045, 0.013), hair, rot=(0.2, -0.3, 0)),
            lib.box((0.112, -0.046, 0.805), (0.016, 0.045, 0.013), hair, rot=(-0.2, -0.3, 0)),
        ]
        crown = []
        # The mop: a cap of hair over the crown and the back of the head, down to the nape …
        crown.append(lib.lumpy((-0.02, 0, 0.82), 0.142, hair, scale=(1.0, 1.06, 0.72), strength=0.5, noise=0.7, seed=61))
        parts.append(lib.lumpy((-0.055, 0, 0.75), 0.13, hair, scale=(0.86, 1.06, 0.86), strength=0.45, noise=0.7, seed=62))

        def lock(theta, phi, length, radius, seed, droop=0.35):
            """A tapering lock of hair from the head's surface, pointing out and a little down
            (theta from the top, phi round from the face)."""
            c = Vector((-0.02, 0, 0.785))
            d = Vector((math.sin(theta) * math.cos(phi), math.sin(theta) * math.sin(phi), math.cos(theta)))
            d.z -= droop * math.sin(theta)
            d.normalize()
            base = c + d * 0.112
            mid = base + d * length / 2
            rot = d.to_track_quat('Z', 'Y').to_euler()
            obj = lib.cylinder(tuple(mid), radius, length, hair, radius2=radius * 0.22, rot=tuple(rot), verts=7)
            return obj

        k = 0
        # … tousled locks all round below the crown (none in front of the face) …
        for phi in range(40, 330, 26):
            if 150 < phi < 210:  # the back of the head
                theta, length = 1.55, 0.085
            else:
                theta, length = 1.3, 0.075
            a = math.radians(phi + (7 if k % 2 else -7))
            parts.append(lock(theta + (0.18 if k % 2 else 0), a, length, 0.034, k))
            k += 1
        # … spikes on top (hidden under a cap) …
        for phi, theta in ((0, 0.55), (60, 0.6), (120, 0.62), (180, 0.65), (240, 0.62), (300, 0.6), (30, 0.2), (200, 0.25)):
            crown.append(lock(theta, math.radians(phi), 0.07, 0.036, k, droop=0.1))
            k += 1
        # … and a fringe of short locks over the brow.
        for y in (-0.06, -0.02, 0.02, 0.06):
            parts.append(lock(0.95, math.atan2(y, 0.11), 0.06, 0.03, k, droop=0.9))
            k += 1
        for obj in parts + crown:
            self.attach(obj, self.waist)
        always += parts
        hair_parts = [o for o in parts + crown if hair.name in [m.name for m in o.data.materials]]
        # Sandal straps wound up the shins.
        for i, side in enumerate((-1, 1)):
            for j in range(3):
                strap = lib.cylinder((0.003, side * 0.062, 0.115 + 0.042 * j), 0.05 - 0.002 * j, 0.012, self.leather,
                                     rot=((0.22 if j % 2 else -0.22), 0, 0), verts=12)
                always.append(self.attach(strap, self.legs[i]))
        return {'always': always, 'upright': [tunic[0], tunic[2]], 'bent': [skirt, hem, bodice], 'crown': crown,
                'hair': hair_parts}

    def show_body(self):
        """Shows the current body (`self.body`), upright or bent, its crown hair unless a cap covers it."""
        for name, parts in self.bodies.items():
            on = name == self.body
            for o in parts['always']:
                o.hide_render = not on
            for o in parts['upright']:
                o.hide_render = not on or self.bend != 0
            for o in parts['bent']:
                o.hide_render = not on or self.bend == 0
            for o in parts['crown']:
                o.hide_render = not on or self.capped
            if self.hair_hidden:
                for o in parts['hair']:
                    o.hide_render = True

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
        # The gladius: a short broad blade with a long point, a brass guard and a round pommel.
        brass = lib.mat_flat('swordbrass', BRASS, rough=0.3)
        brass.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.9
        self.tool('sword', r, [
            lib.box((0, 0, 0.22), (0.048, 0.012, 0.3), M, bevel=0.006),
            lib.box((0, 0, 0.385), (0.034, 0.011, 0.05), M, rot=(0, math.pi / 4, 0), bevel=0.004),
            lib.box((0, 0, 0.065), (0.09, 0.032, 0.022), brass, bevel=0.006),
            lib.cylinder((0, 0, 0.01), 0.016, 0.09, self.leather, verts=8),
            lib.sphere((0, 0, -0.04), 0.024, brass),
        ])
        # Bow in the left hand: a curved stave and its string.
        # A long recurve of light orange wood (Settlers 4's bows), its tips curling forward, a grip wrap.
        bow_wood = lib.mat_grain('bowwood', (0.66, 0.34, 0.1), (0.86, 0.52, 0.2), scale=6, stretch=(1, 1, 8), bump=0.3)
        stave = []
        n = 11
        for k in range(n):
            t = k / (n - 1) - 0.5
            bulge = 0.075 * (1 - (2 * t) ** 2) - 0.03 * max(0.0, abs(2 * t) - 0.75) / 0.25
            stave.append(lib.cylinder((bulge, 0, t * 0.62), 0.013 - 0.004 * abs(2 * t), 0.072, bow_wood,
                                      rot=(0, -1.5 * t + (0.9 * math.copysign(1, t) if abs(2 * t) > 0.75 else 0), 0), verts=6))
        stave.append(lib.cylinder((0.075, 0, 0), 0.017, 0.07, self.leather, verts=8))
        stave.append(lib.cylinder((-0.012, 0, 0), 0.003, 0.58, self.dark, verts=4))
        self.tool('bow', l, stave)
        # The watchman's spear: a long ash shaft, butt near the ground, a leaf-shaped iron head.
        self.tool('spear', r, [
            lib.cylinder((0, 0, 0.16), 0.014, 0.92, W, verts=8),
            lib.cylinder((0, 0, 0.625), 0.02, 0.03, M, verts=8),
            lib.sphere((0, 0, 0.69), 0.032, M, scale=(1, 0.35, 2.6)),
        ])
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
                self.attach(obj, self.waist)
            return parts

        def masked(obj):
            obj['mask'] = 1
            return obj

        fighters = self.build_fighters(steel, gold, brass, on_grip, on_body, masked)

        # The healer: a long linen robe to the ankles over the tunic, a stole in the player's colour
        # round the neck and down the front, a rope girdle, a leather satchel of herbs at the hip and
        # a small clay flask on the other side.
        linen = lib.mat_grain('linen', (0.84, 0.8, 0.7), (0.97, 0.95, 0.88), scale=16, stretch=(1, 1, 5), bump=0.4)
        rope = lib.mat_grain('rope', (0.55, 0.42, 0.24), (0.78, 0.64, 0.4), scale=40, stretch=(1, 1, 1), bump=0.6)
        herbs = lib.mat_grain('herbs', (0.2, 0.38, 0.12), (0.42, 0.62, 0.22), scale=30, stretch=(1, 1, 1), bump=0.6)
        clay = lib.mat_flat('clay', (0.66, 0.36, 0.2), rough=0.6)
        robe = on_body([lib.cylinder((0, 0, 0.36), 0.185, 0.56, linen, radius2=0.122, verts=24),
                        lib.cylinder((0, 0, 0.645), 0.122, 0.05, linen, radius2=0.092, verts=24),
                        lib.cylinder((0, 0, 0.455), 0.15, 0.026, rope, verts=24)])
        stole = on_body([masked(lib.cylinder((0, 0, 0.64), 0.124, 0.035, self.tunic, radius2=0.098, verts=20))] +
                        [masked(lib.box((0.141, side * 0.052, 0.47), (0.018, 0.045, 0.34), self.tunic,
                                        rot=(0, -math.atan(0.12), 0))) for side in (-1, 1)])
        satchel = on_body([lib.box((0.0, 0.17, 0.4), (0.12, 0.05, 0.1), L, bevel=0.015),
                           lib.box((0.0, 0.198, 0.425), (0.122, 0.012, 0.06), L, bevel=0.005),
                           # The strap, a ring slanting across the chest from the far shoulder.
                           lib.cylinder((0, 0, 0.52), 0.152, 0.022, L, rot=(-0.55, 0, 0), verts=24)] +
                          [lib.lumpy((-0.03 + 0.03 * k, 0.168, 0.46 + 0.012 * (k % 2)), 0.026, herbs, scale=(1, 0.8, 1.3),
                                     strength=0.4, noise=2.0, seed=31 + k, subdiv=2) for k in range(3)] +
                          [lib.sphere((0.02, -0.16, 0.39), 0.04, clay, scale=(1, 1, 1.15)),
                           lib.cylinder((0.02, -0.16, 0.44), 0.014, 0.04, clay, verts=8),
                           lib.cylinder((0.02, -0.16, 0.465), 0.016, 0.015, rope, verts=8)])

        # The watchman: no armour, a wool shoulder cape with its hood thrown back, and
        # a curved horn on a strap at the hip to sound the alarm.
        wool = lib.mat_grain('wool', (0.24, 0.24, 0.16), (0.38, 0.36, 0.24), scale=26, stretch=(1, 1, 2), bump=0.5)
        ivory = lib.mat_flat('ivory', (0.92, 0.86, 0.7), rough=0.45)
        cape = on_body([lib.cylinder((0, 0, 0.565), 0.178, 0.15, wool, radius2=0.112, verts=24),
                        lib.cylinder((0, 0, 0.495), 0.18, 0.012, wool, verts=24),
                        lib.sphere((-0.13, 0, 0.655), 0.075, wool, scale=(0.75, 1.3, 0.7))])
        horn = []
        n = 6
        for k in range(n):
            t = k / (n - 1)
            a = t * 2.2  # the horn bends round in an arc
            x = 0.05 - 0.085 * math.sin(a)
            z = 0.34 + 0.085 * (1 - math.cos(a))
            horn.append(lib.cylinder((x, 0.17, z), 0.013 + 0.022 * t, 0.045, ivory, rot=(0, a - math.pi / 2, 0), verts=10))
        horn.append(lib.cylinder((0.05 - 0.085 * math.sin(2.2), 0.17, 0.34 + 0.085 * (1 - math.cos(2.2))), 0.038, 0.016,
                                 brass, rot=(0, 2.2 - math.pi / 2, 0), verts=12))
        horn.append(lib.cylinder((0, 0, 0.47), 0.145, 0.022, L, rot=(-0.5, 0, 0), verts=24))
        horn = on_body(horn)

        # The saboteur: a close-fitting jerkin of dark wool to mid-thigh, laced up the front, a sash in
        # the player's colour knotted at the hip with its ends hanging, small leather pouches on it, and
        # dark cloth wraps bound round the shins with leather thongs — dark from the cap to the ankles
        # but for the sash, the sleeves and the tunic's hem, unlike any other settler. The jerkin's
        # skirt hangs from the root (like the tunic's skirt), so it stays with the legs in a bent pose.
        jerk = lib.mat_grain('jerkin', (0.12, 0.11, 0.12), (0.25, 0.22, 0.22), scale=26, stretch=(1, 1, 3), bump=0.45)
        wrap = lib.mat_grain('wraps', (0.16, 0.14, 0.12), (0.3, 0.27, 0.22), scale=34, stretch=(1, 4, 1), bump=0.55)
        lean = math.atan(0.11)  # the jerkin's front leans in towards the shoulders
        doublet = on_body([lib.cylinder((0, 0, 0.54), 0.139, 0.2, jerk, radius2=0.117, verts=22),
                          lib.cylinder((0, 0, 0.648), 0.104, 0.03, jerk, radius2=0.086, verts=20),
                          lib.box((0.133, 0, 0.545), (0.012, 0.022, 0.17), L, rot=(0, -lean, 0))] +
                         [lib.box((0.136 - 0.011 * k, 0, 0.49 + 0.05 * k), (0.01, 0.06, 0.01), L, rot=(0, -lean, 0))
                          for k in range(3)] +
                         [lib.sphere((0, side * 0.14, 0.618), 0.062, jerk, scale=(1.05, 0.9, 0.55)) for side in (-1, 1)])
        doublet += [self.attach(lib.cylinder((0, 0, 0.39), 0.153, 0.12, jerk, radius2=0.139, verts=22), self.root)]
        sash = on_body([masked(lib.cylinder((0, 0, 0.455), 0.147, 0.055, self.tunic, verts=24)),
                        masked(lib.sphere((0.025, -0.145, 0.458), 0.032, self.tunic, scale=(1, 0.8, 1))),
                        masked(lib.box((0.035, -0.152, 0.395), (0.032, 0.012, 0.1), self.tunic, rot=(0.12, 0.18, 0))),
                        masked(lib.box((0.0, -0.152, 0.4), (0.028, 0.012, 0.085), self.tunic, rot=(0.1, -0.12, 0)))])
        pouches = []
        for k, a in enumerate((0.45, 1.15, 2.1)):
            r = 0.158
            pouches += [lib.box((math.cos(a) * r, math.sin(a) * r, 0.435), (0.034, 0.05, 0.06), L, rot=(0, 0, a), bevel=0.012),
                        lib.box((math.cos(a) * (r + 0.006), math.sin(a) * (r + 0.006), 0.452), (0.03, 0.054, 0.022), L,
                                rot=(0, 0, a), bevel=0.006)]
        pouches = on_body(pouches)
        wraps = []
        for i, side in enumerate((-1, 1)):
            parts = [lib.cylinder((0, side * 0.062, 0.15), 0.057, 0.18, wrap, radius2=0.051, verts=12)]
            parts += [lib.cylinder((0, side * 0.062, 0.09 + 0.05 * k), 0.06 - 0.002 * k, 0.012, L,
                                   rot=((0.18 if k % 2 else -0.18), 0, 0), verts=12) for k in range(3)]
            for obj in parts:
                self.attach(obj, self.legs[i])
            wraps += parts

        self.extras = {
            **fighters,
            'healer': robe + stole + satchel,
            'watch': cape + horn,
            'saboteur': doublet + sash + pouches + wraps,
            **self.build_workers(on_body, masked),
        }

    def build_workers(self, on_body, masked):
        """The Roman workers and specialists of Settlers 4 who look their trade (`OUTFITS`), over the
        civilian's tunic: the builder's leather apron and girdle with a big mallet, the digger's brown
        leather jerkin with a broad spade, the pioneer's long green apron with the same spade and a
        pouch of pegs, the geologist's leather coat with puffed shoulders in the player's colour and a
        brimmed leather hat, the thief's black cap with a band in the player's colour, dark puffed
        shoulders and black breeches. Returns outfit → parts."""
        r = self.grips[0]
        L = self.leather
        hide = lib.mat_grain('workhide', (0.36, 0.2, 0.09), (0.55, 0.33, 0.15), scale=22, stretch=(1, 1, 1), bump=0.5)
        dark_hide = lib.mat_grain('darkhide', (0.24, 0.14, 0.07), (0.4, 0.25, 0.12), scale=22, stretch=(1, 1, 1), bump=0.5)
        green = lib.mat_grain('apron', (0.2, 0.36, 0.12), (0.34, 0.52, 0.2), scale=18, stretch=(1, 1, 4), bump=0.4)
        black = lib.mat_grain('black', (0.05, 0.05, 0.06), (0.16, 0.15, 0.16), scale=26, stretch=(1, 1, 3), bump=0.45)
        iron = lib.mat_flat('bigiron', (0.86, 0.88, 0.9), rough=0.3)
        iron.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.8
        brass = lib.mat_flat('workbrass', BRASS, rough=0.3)
        brass.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.9
        lean = math.atan(0.13)  # a garment's front leans in towards the shoulders

        def on_grip(parts):
            for obj in parts:
                obj.parent = r
            return parts

        def mallet():
            """The builder's big mallet (Settlers 4's builders carry a hammer with a head as big as
            their fist): a rounded iron head round the plain hammer's, iron bands at the faces."""
            return on_grip([lib.box((0, 0, 0.3), (0.23, 0.115, 0.115), iron, bevel=0.035),
                            lib.cylinder((0, 0, 0.12), 0.02, 0.3, self.wood, verts=8)])

        def spade():
            """A broad, rounded iron spade round the plain shovel's blade, a socket on the haft."""
            return on_grip([lib.sphere((0, 0, 0.52), 1.0, iron, scale=(0.085, 0.016, 0.12)),
                            lib.cylinder((0, 0, 0.43), 0.024, 0.06, iron, verts=10),
                            lib.cylinder((0, 0, -0.03), 0.026, 0.04, self.wood, rot=(math.pi / 2, 0, 0), verts=8)])

        def belt(mat, z=0.45, r=0.14, depth=0.05, buckle=True):
            parts = [lib.cylinder((0, 0, z), r, depth, mat, verts=22)]
            if buckle:
                parts.append(lib.box((r + 0.004, 0, z), (0.012, 0.04, 0.036), brass, bevel=0.004))
            return parts

        def jerkin(mat, top=0.64, puffs=None):
            """A sleeveless jerkin over the tunic from the belt to the shoulders; `puffs` (a material,
            or 'mask' for the player's colour) gives it round puffed shoulders."""
            parts = [lib.cylinder((0, 0, 0.53), 0.146, 0.2, mat, radius2=0.124, verts=22),
                     lib.cylinder((0, 0, top), 0.125, 0.05, mat, radius2=0.096, verts=22)]
            if puffs:
                for side in (-1, 1):
                    m = self.tunic if puffs == 'mask' else puffs
                    p = lib.lumpy((0, side * 0.148, 0.615), 0.07, m, scale=(1.1, 0.95, 0.72), strength=0.3, noise=1.4,
                                  seed=70 + side)
                    if puffs == 'mask':
                        masked(p)
                    parts.append(p)
            return parts

        # The builder: a leather apron from the belt to the knee in front, a broad girdle and a strap
        # over the shoulder, leather bracers; the tunic shows at the chest and the sides.
        builder = on_body(belt(L, depth=0.06) +
                          [lib.box((0.152, 0, 0.36), (0.014, 0.17, 0.2), hide, rot=(0, -0.1, 0), bevel=0.01),
                           lib.box((0.0, 0.0, 0.55), (0.29, 0.04, 0.03), L, rot=(0.9, 0, 0)),
                           lib.cylinder((0, 0, 0.54), 0.131, 0.03, L, verts=22)])
        builder += mallet()
        # The digger: a brown leather jerkin, a girdle, leather bracers; the red skirt shows below.
        digger = on_body(jerkin(hide, puffs=hide) + belt(dark_hide, z=0.44) +
                         [lib.box((0.136 - 0.012 * k, 0, 0.5 + 0.045 * k), (0.01, 0.05, 0.008), dark_hide, rot=(0, -lean, 0))
                          for k in range(3)])
        digger += spade()
        # The pioneer: a long green apron from the chest to below the knee, on a neck strap, tied at
        # the waist, and a leather pouch of border pegs at the hip.
        pioneer = on_body([lib.box((0.158, 0, 0.42), (0.016, 0.2, 0.36), green, rot=(0, -0.09, 0), bevel=0.012),
                           lib.box((0.13, 0, 0.6), (0.014, 0.15, 0.06), green, rot=(0, -0.35, 0), bevel=0.01),
                           lib.cylinder((0, 0, 0.635), 0.11, 0.016, L, rot=(0, 0.35, 0), verts=20)] +
                          belt(L, z=0.455, r=0.138, depth=0.03, buckle=False) +
                          [lib.box((0.0, 0.16, 0.42), (0.08, 0.04, 0.09), L, bevel=0.012),
                           lib.cylinder((-0.015, 0.165, 0.475), 0.008, 0.06, self.wood, verts=6),
                           lib.cylinder((0.02, 0.165, 0.48), 0.008, 0.07, self.wood, verts=6)])
        pioneer += spade()
        # The geologist: a leather coat over the tunic, puffed shoulders in the player's colour, a
        # satchel on a strap, and a round leather hat with a brim and a band in the player's colour
        # (worn over the hair: a cap of his own, `CAPPED`).
        geo = on_body(jerkin(hide, puffs='mask') + belt(dark_hide, z=0.45) +
                      [lib.box((0.0, -0.165, 0.41), (0.1, 0.045, 0.09), dark_hide, bevel=0.015),
                       lib.cylinder((0, 0, 0.53), 0.148, 0.02, dark_hide, rot=(0.55, 0, 0), verts=24),
                       lib.sphere((-0.012, 0, 0.845), 0.138, dark_hide, scale=(1.02, 1.04, 0.74)),
                       lib.cylinder((-0.005, 0, 0.83), 0.205, 0.016, dark_hide, verts=28),
                       masked(lib.cylinder((-0.01, 0, 0.855), 0.145, 0.03, self.tunic, verts=26))])
        # The thief: a black round cap with a band in the player's colour, black puffed shoulders on a
        # black jerkin open over the tunic, a leather belt, black breeches to the knee (over the
        # tunic's skirt, on the legs so they walk).
        thief = on_body([lib.sphere((-0.02, 0, 0.835), 0.138, black, scale=(1.0, 1.05, 0.68)),
                         masked(lib.cylinder((-0.01, 0, 0.815), 0.141, 0.035, self.tunic, rot=(0, -0.15, 0), verts=26))] +
                        [lib.lumpy((0, side * 0.148, 0.615), 0.072, black, scale=(1.1, 0.95, 0.72), strength=0.3,
                                   noise=1.4, seed=80 + side) for side in (-1, 1)] +
                        belt(L, z=0.45, r=0.138, depth=0.04))
        for i, side in enumerate((-1, 1)):
            for obj in (lib.cylinder((0, side * 0.064, 0.27), 0.068, 0.15, black, radius2=0.058, verts=14),):
                thief.append(self.attach(obj, self.legs[i]))
        thief.append(self.attach(lib.cylinder((0, 0, 0.36), 0.168, 0.14, black, radius2=0.142, verts=22), self.root))
        return {'builder': builder, 'digger': digger, 'pioneer': pioneer, 'geologist': geo, 'thief': thief}

    def build_fighters(self, steel, gold, brass, on_grip, on_body, masked):
        """The Roman fighters by level, after Settlers 4: their gear changes with the level, not only
        the helmet's crest. Swordsmen go from a leather cuirass and a curved rectangular scutum with
        zigzag bolts (level 1) over leather with a steel chest plate and an oval shield (2) to banded
        steel armour and a broad round shield (3), both with a running scroll; bowmen from a leather
        jerkin (1) over steel shoulder guards on studded leather (2) to banded steel (3), a light green
        quiver across the back and a long orange recurve bow. All of
        them show the tunic — skirt and sleeves, in the player's colour — under the armour, wear a
        cloth scarf at the neck, a belt with a short apron of studded straps, and strapped legionary
        sandals up the shins. The squad leader: a gilded muscled cuirass, a cloak in the player's
        colour, a round gilded shield. Returns outfit → parts."""
        L = self.leather
        hide = lib.mat_grain('hide', (0.5, 0.27, 0.1), (0.7, 0.42, 0.17), scale=22, stretch=(1, 1, 1), bump=0.45)
        scarf_cloth = lib.mat_grain('scarf', (0.82, 0.55, 0.22), (0.95, 0.72, 0.36), scale=30, stretch=(1, 1, 3), bump=0.4)
        quiver_hide = lib.mat_grain('quiver', (0.5, 0.68, 0.22), (0.68, 0.84, 0.36), scale=20, stretch=(1, 1, 4), bump=0.4)
        feather = lib.mat_flat('feather', (0.94, 0.92, 0.86))
        red_fletch = lib.mat_flat('fletch', (0.78, 0.12, 0.08))

        def ring(z, r, depth, mat, verts=22):
            return lib.cylinder((0, 0, z), r, depth, mat, verts=verts)

        # --- what every fighter wears
        def sandals():
            """Legionary sandals: straps wound up the shin to mid-calf (on the legs, so they walk)."""
            parts = []
            for i, side in enumerate((-1, 1)):
                own = [lib.cylinder((0.004, side * 0.062, 0.055 + 0.04 * k), 0.054 - 0.002 * k, 0.013, L,
                                    rot=((0.2 if k % 2 else -0.2), 0, 0), verts=12) for k in range(4)]
                own.append(lib.box((0.05, side * 0.062, 0.05), (0.03, 0.03, 0.06), L))  # the front lacing
                for obj in own:
                    self.attach(obj, self.legs[i])
                parts += own
            return parts

        def scarf():
            return on_body([lib.cylinder((0, 0, 0.652), 0.104, 0.04, scarf_cloth, radius2=0.09, verts=20),
                            lib.sphere((0.085, 0.0, 0.63), 0.032, scarf_cloth, scale=(0.8, 1.4, 0.8))])

        def belt_and_apron(studs):
            """A belt over the tunic and, in front, the apron of four straps with metal studs."""
            parts = [ring(0.452, 0.146, 0.036, studs)]
            for k in range(4):
                y = (k - 1.5) * 0.034
                parts.append(lib.box((0.142, y, 0.38), (0.012, 0.024, 0.12), L, rot=(0, -0.12, 0)))
                parts += [lib.sphere((0.15 - 0.012 * j, y, 0.41 - 0.045 * j), 0.008, studs) for j in range(2)]
            return on_body(parts)

        # --- torso armour
        def leather_cuirass(mat=hide):
            """A moulded leather cuirass with rounded shoulder flaps."""
            return on_body([lib.cylinder((0, 0, 0.555), 0.141, 0.19, mat, radius2=0.11, verts=22),
                            lib.sphere((0.06, 0.045, 0.575), 0.068, mat, scale=(0.72, 0.95, 0.8)),
                            lib.sphere((0.06, -0.045, 0.575), 0.068, mat, scale=(0.72, 0.95, 0.8))] +
                           [lib.sphere((0, side * 0.148, 0.618), 0.066, mat, scale=(1.05, 0.95, 0.55)) for side in (-1, 1)])

        def chest_plate():
            """A steel plate over the chest, with a rivet in each corner."""
            parts = [lib.sphere((0.098, 0, 0.565), 0.085, steel, scale=(0.42, 1.15, 0.95))]
            parts += [lib.sphere((0.128, dy, 0.565 + dz), 0.008, brass) for dy in (-0.06, 0.06) for dz in (-0.05, 0.05)]
            return on_body(parts)

        def shoulder_guards(layers=1, mat=None):
            mat = mat or steel
            return on_body([lib.sphere((0, side * (0.152 + 0.012 * k), 0.632 - 0.035 * k), 0.074 - 0.008 * k, mat,
                                       scale=(1.12, 0.9, 0.52)) for side in (-1, 1) for k in range(layers)])

        def bands(n=5):
            """Banded steel armour round the chest (lorica segmentata), dark seams between the bands."""
            return on_body([lib.cylinder((0, 0, 0.47 + 0.042 * k), 0.143 - 0.006 * k, 0.046, steel,
                                         radius2=0.137 - 0.006 * k, verts=22) for k in range(n)] +
                           [lib.box((0.13, 0, 0.555), (0.014, 0.016, 0.17), brass, rot=(0, -0.2, 0))])

        def studded():
            """Rows of brass studs over a leather jerkin."""
            parts = []
            for row in range(3):
                for k in range(5):
                    a = (k - 2) * 0.32
                    r = 0.137 - 0.009 * row
                    parts.append(lib.sphere((math.cos(a) * r, math.sin(a) * r, 0.5 + 0.045 * row), 0.009, brass))
            return on_body(parts)

        # --- shields: a curved face in the player's colour, a steel rim, a boss and our thunderbolt
        def shield(half_w, height, curv, radius, oval=False, emblem='bolts', n=9):
            """Curved round the arm: across position t ∈ [−1, 1] sits at angle t·curv on a cylinder of
            `radius`, the face's centre `x0` ahead of the hand. An oval one is cut to an ellipse."""
            x0 = 0.175

            def at(t, off=0.0):
                a = t * curv
                return (x0 - (1 - math.cos(a)) * radius + off * math.cos(a), math.sin(a) * radius + off * math.sin(a), a)

            def tall(t):
                return height * (math.sqrt(max(0.0, 1 - t * t)) * 0.9 + 0.1 if oval else 1.0)

            parts = []
            w = 2 * half_w / n
            for k in range(n):
                t = (k + 0.5) / n * 2 - 1
                x, y, a = at(t)
                h = tall(t)
                parts.append(masked(lib.box((x, y, 0.03), (0.016, w + 0.004, h), self.tunic, rot=(0, 0, a))))
                # The rim along the top and bottom edge, rolled to follow an oval's slope.
                dt = 1 / n
                slope = (tall(min(1, t + dt)) - tall(max(-1, t - dt))) / 2 / (2 * dt * half_w)
                for sgn in (1, -1):
                    xr, yr, _ = at(t, 0.006)
                    parts.append(lib.box((xr, yr, 0.03 + sgn * h / 2), (0.02, w + 0.006, 0.022), steel,
                                         rot=(sgn * math.atan(slope), 0, a)))
            for t in (-1, 1):
                x, y, a = at(t, 0.006)
                parts.append(lib.box((x, y, 0.03), (0.02, 0.02, tall(t * 0.97) + 0.02), steel, rot=(0, 0, a)))

            def piece(t0, z0, t1, z1, wide=0.02, mat=steel):
                """A flat strip on the face from (t0, z0) to (t1, z1)."""
                tm = (t0 + t1) / 2
                x, y, a = at(tm, 0.011)
                du, dz = (t1 - t0) * half_w, z1 - z0
                return lib.box((x, y, 0.03 + (z0 + z1) / 2), (0.01, math.hypot(du, dz), wide), mat,
                               rot=(math.atan2(dz, du), 0, a))

            x, y, a = at(0, 0.008)
            if emblem == 'bolts':
                # The boss, then four zigzag bolts out to the corners (the level-1 scutum).
                parts.append(lib.sphere((x, y, 0.03), 0.048, steel, scale=(0.6, 1, 1)))
                reach_t, reach_z = 0.72, height * 0.36
                for sx in (-1, 1):
                    for sz in (-1, 1):
                        mt, mz = sx * reach_t * 0.45, sz * reach_z * 0.62
                        parts.append(piece(sx * 0.18, sz * 0.03, mt, mz))
                        parts.append(piece(mt - sx * 0.08, mz - sz * 0.02, sx * reach_t, sz * reach_z, wide=0.016))
            else:
                # A running scroll: two spirals turning out of the middle, point-symmetric like an S
                # (the round shields of levels 2 and 3); a small boss where they meet.
                parts.append(lib.sphere((x, y, 0.03), 0.034, steel, scale=(0.6, 1, 1)))
                su, sv = 0.62, height * 0.36
                pts = []
                for k in range(10):
                    th = -math.pi / 2 - k / 9 * 1.6 * math.pi
                    r = 0.5 * (1 - 0.5 * k / 9)
                    pts.append((r * math.cos(th), 0.5 + r * math.sin(th)))
                for sgn in (1, -1):
                    for (u0, v0), (u1, v1) in zip(pts, pts[1:]):
                        parts.append(piece(sgn * u0 * su, sgn * v0 * sv, sgn * u1 * su, sgn * v1 * sv, wide=0.02))
                if emblem == 'scroll+studs':
                    for k in range(8):
                        th = k * math.pi / 4 + math.pi / 8
                        parts.append(piece(0.86 * math.cos(th), 0.43 * height * math.sin(th),
                                           0.86 * math.cos(th) + 0.02, 0.43 * height * math.sin(th), wide=0.02))
            return on_grip(parts)

        # --- the bowman's quiver: pale hide, a dark trim, fletchings out of the top; a strap across
        def quiver():
            parts = [lib.cylinder((-0.155, 0.05, 0.6), 0.05, 0.33, quiver_hide, rot=(0.25, -0.22, 0), verts=12),
                     lib.cylinder((-0.19, 0.09, 0.755), 0.054, 0.025, L, rot=(0.25, -0.22, 0), verts=12),
                     lib.cylinder((-0.12, 0.012, 0.44), 0.052, 0.022, L, rot=(0.25, -0.22, 0), verts=12),
                     lib.cylinder((0, 0, 0.55), 0.15, 0.022, L, rot=(-0.6, 0, 0), verts=24)]
            for k in range(4):
                mat = red_fletch if k % 2 else feather
                parts.append(lib.box((-0.2 + 0.015 * k, 0.085 + 0.012 * (k % 2) - 0.008 * k, 0.8 + 0.008 * (k % 2)),
                                     (0.012, 0.026, 0.06), mat, rot=(0.25, -0.22, 0)))
            return on_body(parts)

        common_steel = lambda: sandals() + scarf() + belt_and_apron(steel)  # noqa: E731
        common_brass = lambda: sandals() + scarf() + belt_and_apron(brass)  # noqa: E731

        # The squad leader.
        cuirass = on_body([lib.cylinder((0, 0, 0.545), 0.15, 0.2, gold, radius2=0.128, verts=24),
                           lib.sphere((0.072, 0.05, 0.575), 0.07, gold, scale=(0.7, 1, 0.8)),
                           lib.sphere((0.072, -0.05, 0.575), 0.07, gold, scale=(0.7, 1, 0.8)),
                           lib.sphere((0.1, 0, 0.49), 0.06, gold, scale=(0.5, 1.4, 0.6)),
                           ring(0.445, 0.152, 0.032, gold)] +
                          [lib.sphere((0, side * (0.155 + 0.012 * k), 0.632 - 0.035 * k), 0.076 - 0.008 * k, gold,
                                      scale=(1.12, 0.9, 0.52)) for side in (-1, 1) for k in range(2)])
        pteruges = on_body([lib.box((math.cos(a) * 0.14, math.sin(a) * 0.14, 0.39), (0.03, 0.045, 0.1), hide,
                                    rot=(0, 0, a)) for a in [k * math.pi / 6 for k in range(12)]] +
                           [lib.sphere((math.cos(a) * 0.15, math.sin(a) * 0.15, 0.345), 0.009, gold)
                            for a in [k * math.pi / 6 for k in range(12)]])
        cloak = on_body([masked(lib.box((-0.155, 0, 0.42), (0.03, 0.31, 0.46), self.tunic, rot=(0, -0.2, 0), bevel=0.01)),
                         masked(lib.box((-0.115, 0, 0.645), (0.08, 0.31, 0.045), self.tunic)),
                         lib.sphere((0.02, 0.135, 0.645), 0.022, gold), lib.sphere((0.02, -0.135, 0.645), 0.022, gold)])
        round_shield = []
        for k, (r, mat, x) in enumerate(((0.175, gold, 0.11), (0.15, None, 0.122), (0.06, gold, 0.13))):
            if mat is None:
                round_shield.append(masked(lib.cylinder((x, 0, 0.02), r, 0.01, self.tunic, rot=(0, math.pi / 2, 0), verts=28)))
            else:
                round_shield.append(lib.cylinder((x, 0, 0.02), r, 0.026 if k == 0 else 0.03, mat, rot=(0, math.pi / 2, 0), verts=28))
        round_shield.append(lib.sphere((0.145, 0, 0.02), 0.04, gold, scale=(0.6, 1, 1)))
        round_shield = on_grip(round_shield)

        return {
            'legion1': leather_cuirass() + common_steel() + shield(0.15, 0.42, 0.5, 0.3),
            'legion2': leather_cuirass() + chest_plate() + shoulder_guards(1) + common_steel() +
                       shield(0.16, 0.42, 0.45, 0.3, oval=True, emblem='scroll'),
            'legion3': bands() + shoulder_guards(3) + common_steel() +
                       shield(0.2, 0.42, 0.3, 0.45, oval=True, emblem='scroll+studs', n=11),
            'archer1': leather_cuirass(hide) + common_brass() + quiver(),
            'archer2': leather_cuirass(hide) + studded() + shoulder_guards(1) + common_brass() + quiver(),
            'archer3': bands(4) + shoulder_guards(2) + common_steel() + quiver(),
            'leader': cuirass + pteruges + cloak + round_shield + sandals() + scarf(),
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
        self.body = 'classic' if outfit in FIGHTERS else 'civil'
        self.capped = outfit in CAPPED
        self.show_body()

    # ------------------------------------------------------------------------------------- poses

    def pose(self, yaw, leg=0.0, right=None, left=None, right_yaw=0.0, left_yaw=0.0, tilt=0.0, left_tilt=0.0, bend=0.0,
             left_roll=0.0):
        """Arm angles in turns (0 down … 1 up), None for a hanging arm; yaws (degrees) swing a raised
        arm inward; tilts (degrees) turn the tool at the hand; `left_roll` (degrees) turns the left
        hand's tool across the body (the bowman's bow held low); `bend` (degrees) bows the torso forward."""
        self.root.rotation_euler = (0, 0, yaw)
        self.waist.rotation_euler = (0, math.radians(bend), 0)
        self.bend = bend
        self.show_body()
        for side, p in zip((-1, 1), self.legs):
            p.rotation_euler = (0, math.radians(side * leg), 0)
        for side, p, a, y in ((-1, self.arms[0], right, right_yaw), (1, self.arms[1], left, left_yaw)):
            p.rotation_euler = (0, -math.pi * (a or 0.0), math.radians(-side * y))
        self.grips[0].rotation_euler = (0, math.radians(tilt), 0)
        self.grips[1].rotation_euler = (math.radians(left_roll), math.radians(left_tilt), 0)
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


def hold_frames(shape, outfit=None):
    """Walk frames then standing, holding `shape` (in `outfit`): [(shape, pose kwargs)]."""
    arm, tilt = HOLD[shape]
    frames = []
    for f in range(WALK_FRAMES + 1):
        leg, sw = WALK[f] if f < WALK_FRAMES else (0, 0)
        if shape == 'carry':
            # Settlers 4's carriers bear the load on the shoulder, steadied by the raised near hand,
            # the free arm swinging (the ware itself is drawn by the game at `carryAt`).
            kw = dict(leg=leg * 0.85, right=CARRY_ARM, right_yaw=CARRY_YAW, left=swing(sw))
        elif outfit in SHOULDERED and shape == OUTFITS[outfit][0][0]:
            # Builders, diggers and pioneers carry their tools up on the shoulder, head behind.
            arm, tilt = SHOULDERED[outfit]
            kw = dict(leg=leg, right=arm + swing(-sw) * 0.1, right_yaw=16, left=swing(sw), tilt=tilt)
        elif shape == 'bow' and outfit and outfit.startswith('archer'):
            # Settlers 4's bowman carries the bow low before him, slanting across the body.
            kw = dict(leg=leg, right=swing(-sw) + 0.04, left=0.16, left_yaw=18, left_roll=-62, left_tilt=-12)
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
        if action in BEND:
            kw.update(bend=BEND[action][f], leg=12)
            if shape not in TWO_HANDED:
                kw.update(left=0.3, left_yaw=12)
        frames.append((shape, kw))
    return frames


def poses():
    """Every pose group: (group key, frames, outfit) where a frame is the tool shown plus the kwargs
    for `Figure.pose`. Hold groups have 4 walk frames and a standing one; work groups 4 frames. The
    plain groups come first, then each outfit's own (`hold:<tool>@<outfit>`, `work:<action>@<outfit>`)."""
    groups = [(f'hold:{shape}', hold_frames(shape), None) for shape in TOOLS]
    groups += [(f'work:{action}', work_frames(action), None) for action in ACTIONS if action not in OUTFIT_ONLY]
    for outfit, (tools, actions) in OUTFITS.items():
        groups += [(f'hold:{shape}@{outfit}', hold_frames(shape, outfit), outfit) for shape in tools]
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
        lib.cylinder((0, 0, z + 0.075), 0.275, 0.035, None, verts=24),
        lib.cylinder((-0.01, 0, z + 0.16), 0.15, 0.26, None, verts=18),
        lib.cylinder((-0.02, 0, z - 0.1), 0.17, 0.1, None, verts=18),
        # Fighters' helmets: their crests front to back (down the back at level 3) and the squad
        # leader's side to side.
        lib.box((-0.06, 0, z + 0.28), (0.5, 0.12, 0.42), None),
        lib.box((-0.2, 0, z + 0.05), (0.2, 0.12, 0.3), None),
        lib.box((-0.01, 0, z + 0.28), (0.12, 0.5, 0.36), None),
    ]
    for o in objs:
        fig.attach(o, fig.waist)
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

    def save(self, out, prefix, first=0, names=None):
        """Writes pages `first`… (the earlier ones are kept as they are on disk) as `prefix-<k>.png`,
        or under `names`; returns their names."""
        written = []
        for k, page in enumerate(self.pages):
            if k < first:
                continue
            # The last page is cut down to the rows it uses.
            used = self.y + self.row + 1 if k == len(self.pages) - 1 else PAGE
            name = names[k - first] if names else f'{prefix}-{k}.png'
            save_rgba(page[:used], os.path.join(out, name))
            written.append(name)
        return written


def save_rgba(px, path):
    h, w = px.shape[:2]
    img = bpy.data.images.new('page', width=w, height=h, alpha=True)
    img.pixels.foreach_set(np.ascontiguousarray(px[::-1]).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def build_settlers(out, tmp, only=None, hats=None, add=False, civil=False):
    """Renders every pose group in every direction plus the hat layers; writes settlers-*.png and
    settlers.json into `out`. `only`: a list of group keys to render (for quick looks). With `add`,
    keeps the existing sheet as it is and renders only the groups it lacks (a new action or outfit),
    packed after the frames on its last page (re-quantize that page afterwards). With `civil`
    (`settlers:civil`), keeps the fighters' groups and helmets with the pages they lie on, file and
    pixels as they are, and renders everything else — the plain groups, every other outfit, the
    other hats and the goods in hand — onto new pages (quantize only those, then run
    art/tools/blank_unused.py, which clears what is left of the old frames on the kept pages)."""
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
    kept = 0  # pages of an existing sheet left untouched (`add`, `civil`)
    names = None  # the kept pages' file names (`civil`)
    if civil:
        with open(os.path.join(out, 'settlers.json')) as f:
            old = json.load(f)
        groups = {k: v for k, v in old['groups'].items() if k.partition('@')[2] in FIGHTERS}
        hat_rows = {k: v for k, v in old['hats'].items() if k in FIGHTER_HATS}
        ids = sorted({i for rows in groups.values() for row in rows for fr in row for i in fr if i >= 0} |
                     {i for row in hat_rows.values() for i in row if i >= 0})
        pages = sorted({old['frames'][i][0] for i in ids})
        names = [old['pages'][p] for p in pages]
        new_id = {i: k for k, i in enumerate(ids)}
        pack.frames = [[pages.index(old['frames'][i][0])] + old['frames'][i][1:] for i in ids]
        remap = lambda i: new_id[i] if i >= 0 else -1  # noqa: E731
        meta['groups'] = {k: [[[remap(i) for i in fr] for fr in row] for row in rows] for k, rows in groups.items()}
        meta['hats'] = {k: [remap(i) for i in row] for k, row in hat_rows.items()}
        meta['heads'] = {k: v for k, v in old.get('heads', {}).items() if k in groups}
        kept = len(pages)
        pack.pages = [None] * kept
        pack.new_page()
    if add:
        with open(os.path.join(out, 'settlers.json')) as f:
            meta = json.load(f)
        kept = len(meta['pages']) - 1
        last = read_png(os.path.join(out, meta['pages'][-1]))
        pack.pages = [None] * kept + [np.zeros((PAGE, PAGE, 4), dtype=np.float32)]
        pack.pages[-1][:last.shape[0], :last.shape[1]] = last
        pack.frames = meta['frames']
        pack.x, pack.y, pack.row = 1, last.shape[0] + 1, 0
    meta.setdefault('heads', {})
    path = os.path.join(tmp, 'fig.png')
    mpath = os.path.join(tmp, 'fig-mask.png')
    opath = os.path.join(tmp, 'fig-over.png')
    yaws = []
    for d in range(DIRS):
        gx, gy = lib.ground_dir(d * math.pi / 4)
        yaws.append(math.atan2(gy, gx))
    for key, frames, outfit in poses():
        if only and key not in only or (add or civil) and key in meta['groups']:
            continue
        # Where the head is when the pose bends the torso, against standing (the hat layer follows).
        heads = None
        if any(kw.get('bend') for _, kw in frames):
            heads = [[list(head_offset(scene, fig, yaws[d], kw)) for _, kw in frames] for d in range(DIRS)]
            meta['heads'][key] = heads
        # Each group is cached (uint8) once rendered, so an interrupted run resumes where it stopped.
        work = key.startswith('work:')
        per = 3 if work else 2  # work poses add the arm-over-hat pass
        rev = f'-r{LOOK_REV[outfit]}' if outfit else f'-p{PLAIN_REV}'
        cached = os.path.join(cache, key.replace(':', '-').replace('@', '_') + f'-{DIRS}-{per}{rev}.npz')
        if os.path.exists(cached):
            data = np.load(cached)['frames'].astype(np.float32) / 255
        else:
            data = []
            for d in range(DIRS):
                for f, (shape, kw) in enumerate(frames):
                    fig.show(shape, outfit)
                    fig.pose(yaws[d], **kw)
                    full = render_full(scene, path)
                    mask = render_mask(scene, mpath, mask_mat)[..., 0]
                    tint = full.copy()
                    tint[..., 3] = full[..., 3] * np.clip(mask, 0, 1)
                    data += [full, tint]
                    if work:
                        drop = heads[d][f][1] * lib.RESOLUTION if heads else 0
                        data.append(render_over(scene, opath, fig, proxy, neck_y + drop))
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
    if add:
        # Hat styles the sheet lacks (a new one) go after the new groups.
        missing = [s for s in HAT_STYLES if s not in meta['hats']]
        if missing:
            meta['hats'].update(render_hats(scene, fig, yaws, pack, path, missing))
        meta['pages'] = meta['pages'][:kept] + pack.save(out, 'settlers', first=kept)
        meta['frames'] = pack.frames
        with open(os.path.join(out, 'settlers.json'), 'w') as f:
            json.dump(meta, f, separators=(',', ':'))
        return
    # Goods in hand: where the hands are in the carry poses, and whether they are behind the body.
    for d in range(DIRS):
        fig.show('carry')
        row = []
        for _, kw in hold_frames('carry'):
            fig.pose(yaws[d], **kw)
            sx, sy = lib.screen_point(scene, fig.load_ref.matrix_world.translation)
            row.append([round(sx - ANCHOR_X, 1), round(sy - ANCHOR_Y, 1)])
        meta['carryAt'].append(row)
        # The load on the far shoulder is drawn behind the figure (the head hides part of it): further
        # from the camera than the body's axis at its height.
        behind = lib.camera_depth(scene, fig.load_ref.matrix_world.translation) > \
            lib.camera_depth(scene, fig.root.matrix_world @ Vector((0, 0, LOAD_AT[2])))
        meta['carryBehind'].append(bool(behind))
    if civil:
        meta['hats'].update(render_hats(scene, fig, yaws, pack, path, [h for h in HAT_STYLES if h not in FIGHTER_HATS]))
        # New pages take the free names; the old ones nothing refers to any more are removed.
        free = (f'settlers-{k}.png' for k in range(10 ** 4) if f'settlers-{k}.png' not in names)
        fresh = [next(free) for _ in pack.pages[kept:]]
        for name in os.listdir(out):
            if name.startswith('settlers-') and name.endswith('.png') and name not in names + fresh:
                os.remove(os.path.join(out, name))
        meta['pages'] = names + pack.save(out, 'settlers', first=kept, names=fresh)
    else:
        if hats if hats is not None else not only:
            meta['hats'] = render_hats(scene, fig, yaws, pack, path)
        meta['pages'] = pack.save(out, 'settlers')
        # A denser sheet may need fewer pages than the one it replaces: drop the pages left over.
        for name in os.listdir(out):
            if name.startswith('settlers-') and name.endswith('.png') and name not in meta['pages']:
                os.remove(os.path.join(out, name))
    meta['frames'] = pack.frames
    with open(os.path.join(out, 'settlers.json'), 'w') as f:
        json.dump(meta, f, separators=(',', ':'))


def head_offset(scene, fig, yaw, kw):
    """Logical px from where the head is standing to where it is in pose `kw` (facing `yaw`)."""
    fig.pose(yaw)
    x0, y0 = lib.screen_point(scene, fig.head_ref.matrix_world.translation)
    fig.pose(yaw, **kw)
    x1, y1 = lib.screen_point(scene, fig.head_ref.matrix_world.translation)
    return round(x1 - x0, 1), round(y1 - y0, 1)


def build_hat(style, fig):
    """A hat on the figure's head (white, tinted at run time), or None for bare heads."""
    white = lib.mat_grain('hatcloth', (0.86, 0.86, 0.84), (0.98, 0.98, 0.97), scale=20, stretch=(1, 1, 1), bump=0.3)
    straw = lib.mat_grain('straw', (0.86, 0.84, 0.76), (1.0, 0.98, 0.92), scale=14, stretch=(1, 8, 1), bump=0.6)
    shiny = lib.mat_flat('helm', (0.96, 0.96, 0.98), rough=0.2)
    shiny.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.85
    z = 0.76
    # Settlers 4's helmets read bright silver with a hard highlight: a light base, less mirror.
    steel = lib.mat_flat('galea', (0.95, 0.95, 0.96), rough=0.22)
    steel.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.55
    gilt = lib.mat_flat('gilt', (0.98, 0.78, 0.3), rough=0.22)
    gilt.node_tree.nodes['Principled BSDF'].inputs['Metallic'].default_value = 0.95
    knit = lib.mat_grain('knit', (0.8, 0.8, 0.78), (0.98, 0.98, 0.97), scale=34, stretch=(1, 1, 6), bump=0.6)
    red = lib.mat_grain('crest', (0.62, 0.05, 0.04), (0.9, 0.16, 0.1), scale=40, stretch=(1, 6, 1), bump=0.6)

    def dome(loc, r, scale, mat):
        """The upper half of a sphere, open below (a helmet's bowl, so the face shows under it)."""
        import bmesh
        bpy.ops.mesh.primitive_uv_sphere_add(segments=28, ring_count=14, radius=r, location=loc)
        obj = bpy.context.active_object
        bm = bmesh.new()
        bm.from_mesh(obj.data)
        bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -0.002], context='VERTS')
        bm.to_mesh(obj.data)
        bm.free()
        obj.scale = scale
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
        obj.data.materials.append(mat)
        bpy.ops.object.shade_smooth()
        return obj

    def galea(metal, crest=None, across=False):
        """Settlers 4's Roman helmet, big on the head: a deep dome to below the ears, a brow band with a
        small peak, broad cheek guards, a wide flared neck guard and a knob on top. `crest` = (front,
        back, height, tufts): a red brush crest as a fan of flat tufts along the dome from angle
        `front` to `back` (radians from the top, + forwards), tallest in the middle; `across` sets
        it side to side instead (the squad leader's)."""
        brow = z + 0.035  # the rim sits just above the eyes: the face shows under it
        parts = [
            dome((-0.008, 0, brow), 0.152, (1.06, 1.07, 0.95), metal),
            lib.cylinder((0, 0, brow), 0.163, 0.03, metal, verts=26),
            # The peak over the brow and the flared neck guard at the back (−X), down over the nape.
            lib.box((0.158, 0, brow - 0.004), (0.05, 0.21, 0.014), metal, rot=(0, -0.28, 0), bevel=0.005),
            lib.box((-0.13, 0, brow - 0.07), (0.035, 0.25, 0.11), metal, rot=(0, -0.1, 0), bevel=0.01),
            lib.box((-0.165, 0, brow - 0.13), (0.075, 0.3, 0.018), metal, rot=(0, 0.5, 0), bevel=0.008),
            lib.sphere((-0.01, 0, brow + 0.15), 0.024, metal),
        ]
        for side in (-1, 1):  # cheek guards, hinged at the rim, angled in towards the chin
            parts.append(lib.box((0.04, side * 0.143, brow - 0.07), (0.1, 0.018, 0.13), metal, rot=(side * 0.18, 0, 0),
                                 bevel=0.01))
        if not crest:
            return parts
        front, back, height, n = crest
        for k in range(n):
            t = k / (n - 1)
            a = front + (back - front) * t
            mid = 1 - (2 * t - 1) ** 2  # tallest in the middle
            hh = height * (0.45 + 0.55 * mid)
            r = 0.14
            if across:
                y, zc = math.sin(a) * r, z + 0.04 + math.cos(a) * r * 0.95
                loc, rot, scale = (-0.01, y + math.sin(a) * hh / 2, zc + math.cos(a) * hh / 2), (-a, 0, 0), (0.42, 0.75, hh / 0.1)
            else:
                x, zc = -0.01 + math.sin(a) * r, z + 0.04 + math.cos(a) * r * 0.95
                loc, rot, scale = (x + math.sin(a) * hh / 2, 0, zc + math.cos(a) * hh / 2), (0, a, 0), (0.75, 0.42, hh / 0.1)
            tuft = lib.lumpy(loc, 0.05, red, scale=scale, strength=0.35, noise=1.1, seed=11 + k, subdiv=2)
            tuft.modifiers['Displace'].texture_coords = 'LOCAL'
            tuft.rotation_euler = rot
            parts.append(tuft)
        return parts

    parts = {
        'cap': lambda: [lib.sphere((-0.01, 0, z + 0.06), 0.13, white, scale=(1.05, 1.05, 0.6)),
                        lib.box((0.11, 0, z + 0.04), (0.08, 0.16, 0.015), white, bevel=0.01)],
        'straw': lambda: [lib.cylinder((0, 0, z + 0.07), 0.24, 0.018, straw, verts=24),
                          lib.cylinder((0, 0, z + 0.12), 0.12, 0.1, straw, radius2=0.09, verts=18)],
        'helmet': lambda: [lib.sphere((-0.005, 0, z + 0.05), 0.135, shiny, scale=(1.05, 1.05, 0.85)),
                           lib.cylinder((0, 0, z + 0.0), 0.15, 0.025, shiny, verts=20),
                           lib.box((-0.01, 0, z + 0.19), (0.2, 0.025, 0.04), shiny, bevel=0.01)],
        'hood': lambda: [lib.sphere((-0.058, 0, z + 0.035), 0.15, white, scale=(1.05, 1.05, 1.0)),
                         lib.cylinder((-0.02, 0, z - 0.12), 0.16, 0.08, white, radius2=0.12, verts=18)],
        'chef': lambda: [lib.cylinder((-0.01, 0, z + 0.14), 0.12, 0.2, white, radius2=0.14, verts=18),
                         lib.sphere((-0.01, 0, z + 0.25), 0.15, white, scale=(1, 1, 0.5))],
        'bare': lambda: [],
        # The saboteur's knitted cap: pulled down to the brows over a rolled, ribbed band, its soft
        # crown slumping back over the nape.
        'knit': lambda: [lib.sphere((-0.018, 0, z + 0.062), 0.133, knit, scale=(1.04, 1.05, 0.8)),
                         lib.cylinder((-0.01, 0, z + 0.04), 0.138, 0.042, knit, radius2=0.135, rot=(0, -0.16, 0), verts=24),
                         lib.sphere((-0.1, 0, z + 0.1), 0.062, knit, scale=(1.3, 1.0, 0.72)),
                         lib.sphere((-0.158, 0, z + 0.066), 0.04, knit, scale=(1.0, 0.95, 0.9))],
        # The healer's linen coif: a close cap over the hair, the face left open, a flap at the nape.
        'coif': lambda: [lib.sphere((-0.04, 0, z + 0.06), 0.14, white, scale=(1.05, 1.08, 0.75)),
                         lib.box((-0.115, 0, z - 0.045), (0.05, 0.19, 0.13), white, rot=(0, 0.28, 0), bevel=0.02)],
        # Squad leader: a gilded helmet with a tall crest set side to side, a centurion's.
        'plume': lambda: galea(gilt, (-1.2, 1.2, 0.15, 13), across=True),
        # Fighters' helmets by level, as in Settlers 4: swordsmen none at level 1 (bowmen a little
        # tuft, `galea1t`), an upright brush at level 2, a big fan from the brow down the back at 3.
        'galea1': lambda: galea(steel),
        'galea1t': lambda: galea(steel, (-0.25, -0.5, 0.045, 3)),
        'galea2': lambda: galea(steel, (0.32, -0.45, 0.16, 7)),
        'galea3': lambda: galea(steel, (0.6, -1.8, 0.2, 15)),
    }
    objs = parts[style]()
    if style not in FIGHTER_HATS:
        # Civilians' hats sit on the bigger mop of hair: a little larger, about the head's centre.
        c = Vector((0.005, 0, 0.775))
        for o in objs:
            o.location = c + (o.location - c) * CIVIL_HAT_SCALE
            o.scale = o.scale * CIVIL_HAT_SCALE
    for o in objs:
        fig.attach(o, fig.waist)
    return objs


def render_hats(scene, fig, yaws, pack, path, styles=HAT_STYLES):
    """Hat layers: per style and direction, standing, with the figure as a holdout so the head
    hides what is behind it. Built in figure space (before the root scale), so they sit on the head."""
    hats = {}
    fig.show('none')
    bpy.data.objects['ShadowCatcher'].hide_render = True
    body = [o for o in scene.objects if o.type == 'MESH' and o.name != 'ShadowCatcher']
    for o in body:
        o.is_holdout = True
    scale = fig.root.scale.copy()
    for style in styles:
        # A hat is cut by the head it sits on: the fighters' body for theirs, the civilian's for the rest.
        fig.body, fig.capped, fig.bend = ('classic' if style in FIGHTER_HATS else 'civil'), False, 0.0
        # The civilian's hair is left out of the cut: the hat is drawn over it in the game, so locks
        # under the hat are covered and only those sticking out from under it show.
        fig.hair_hidden = True
        fig.show_body()
        fig.root.scale = (1, 1, 1)
        fig.root.rotation_euler = (0, 0, 0)
        fig.waist.rotation_euler = (0, 0, 0)
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
    fig.hair_hidden = False
    fig.show_body()
    return hats
