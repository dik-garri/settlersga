"""Goods: one 3D model per resource, rendered as the ware a settler carries and as door piles of
1…PILE_MAX items, as many as really lie there.

Everything is data in `GOODS` (resource → item builder + pile layout), in the game's RESOURCES order.
Items are built lying or standing around the origin at "ware scale" (about 0.3 tile long); a layout
places copies of them into a pile. Output (see build.py):
- `piles-<res>.png`: a strip of PILE_MAX frames (PILE logical size each), frame k holds k + 1 items;
- `stacks-<res>.png`: the same goods lying loose on bare ground (Settlers 4's piles: start goods,
  ruins, dropped loads), a strip of PILE_MAX frames (STACK logical size) on a small patch of trodden
  earth, the pile layout loosened (`loosen`) so they read as put down, not stacked at a door;
- `wares.png` + `wares.json`: a strip of single wares (WARE logical size), in `GOODS` order.
"""

import json
import math
import os
import random

import bpy
import numpy as np

import lib

PILE_MAX = 8
#: Piles are drawn a little larger than carried wares, so they read at the door as in Settlers 4.
PILE_SCALE = 1.3
PILE = (44, 34, 22, 24)  # logical w, h, anchor of a pile at a door
STACK = (56, 40, 28, 26)  # logical w, h, anchor of a stack lying on the ground (a tile's centre)
WARE = (24, 16, 12, 8)  # logical w, h, anchor of a carried ware / icon (same scale as a ware in a pile)


# -------------------------------------------------------------------------------------- materials

def mat_metal(name, color, rough=0.32, metallic=0.85):
    mat, _, _, bsdf = lib._principled(name)
    bsdf.inputs['Base Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Roughness'].default_value = rough
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


MATERIALS = {
    'log': lambda: lib.mat_grain('log', (0.42, 0.24, 0.1), (0.62, 0.4, 0.2), scale=5, stretch=(1, 1, 9), bump=0.7),
    'cut': lambda: lib.mat_grain('cut', (0.86, 0.68, 0.42), (0.94, 0.8, 0.56), scale=18, stretch=(1, 1, 1), bump=0.3),
    'plank': lambda: lib.mat_grain('plank', (0.74, 0.54, 0.3), (0.86, 0.68, 0.42), scale=4, stretch=(9, 1, 1), bump=0.4),
    'handle': lambda: lib.mat_grain('handle', (0.56, 0.36, 0.16), (0.72, 0.5, 0.26), scale=5, stretch=(9, 1, 1), bump=0.3),
    'block': lambda: lib.mat_grain('block', (0.6, 0.6, 0.62), (0.82, 0.81, 0.8), scale=8, stretch=(1, 1, 1), bump=0.8),
    'steel': lambda: mat_metal('steel', (0.78, 0.8, 0.84)),
    'iron': lambda: mat_metal('iron', (0.52, 0.55, 0.6), rough=0.4),
    'gold': lambda: mat_metal('gold', (1.0, 0.76, 0.22), rough=0.25, metallic=1.0),
    'band': lambda: mat_metal('band', (0.3, 0.3, 0.32), rough=0.5, metallic=0.6),
    'water': lambda: lib.mat_flat('water', (0.25, 0.6, 0.9), rough=0.1),
    'fish': lambda: lib.mat_grain('fish', (0.45, 0.55, 0.62), (0.82, 0.88, 0.92), scale=12, stretch=(1, 1, 3), bump=0.3),
    'fin': lambda: lib.mat_flat('fin', (0.36, 0.44, 0.52)),
    'straw': lambda: lib.mat_grain('straw', (0.78, 0.6, 0.2), (0.96, 0.82, 0.38), scale=30, stretch=(9, 1, 1), bump=0.6),
    'ears': lambda: lib.mat_grain('ears', (0.82, 0.62, 0.18), (0.98, 0.84, 0.4), scale=40, stretch=(1, 1, 1), bump=0.8),
    'twine': lambda: lib.mat_flat('twine', (0.45, 0.3, 0.14)),
    'burlap': lambda: lib.mat_grain('burlap', (0.6, 0.46, 0.28), (0.78, 0.66, 0.46), scale=40, stretch=(1, 1, 1), bump=0.6),
    'sack': lambda: lib.mat_grain('sack', (0.84, 0.8, 0.7), (0.96, 0.94, 0.88), scale=40, stretch=(1, 1, 1), bump=0.5),
    'crust': lambda: lib.mat_grain('crust', (0.62, 0.36, 0.12), (0.82, 0.54, 0.22), scale=14, stretch=(1, 1, 1), bump=0.5),
    'score': lambda: lib.mat_flat('score', (0.94, 0.8, 0.52)),
    'pig': lambda: lib.mat_grain('pig', (0.9, 0.62, 0.6), (0.98, 0.76, 0.72), scale=10, stretch=(1, 1, 1), bump=0.2),
    'snout': lambda: lib.mat_flat('snout', (0.86, 0.48, 0.5)),
    'meat': lambda: lib.mat_grain('meat', (0.62, 0.12, 0.1), (0.84, 0.3, 0.26), scale=12, stretch=(1, 1, 1), bump=0.5),
    'fat': lambda: lib.mat_flat('fat', (0.96, 0.9, 0.82)),
    'bone': lambda: lib.mat_flat('bone', (0.95, 0.93, 0.86)),
    'coal': lambda: lib.mat_grain('coal', (0.04, 0.04, 0.05), (0.22, 0.22, 0.24), scale=10, stretch=(1, 1, 1), bump=1.0),
    'ironore': lambda: lib.mat_grain('ironore', (0.42, 0.2, 0.12), (0.7, 0.38, 0.22), scale=9, stretch=(1, 1, 1), bump=1.0),
    'goldore': lambda: mat_speckled('goldore', (0.46, 0.45, 0.44), (0.66, 0.65, 0.62), (1.0, 0.8, 0.2)),
    'string': lambda: lib.mat_flat('string', (0.92, 0.88, 0.75)),
    'leather': lambda: lib.mat_flat('leather', (0.36, 0.2, 0.1)),
}


def mat_speckled(name, a, b, speck):
    """Rock with bright metal specks (gold ore)."""
    mat, nodes, links, bsdf = lib._principled(name)
    bsdf.inputs['Roughness'].default_value = 0.6
    coord = nodes.new('ShaderNodeTexCoord')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = 10
    noise.inputs['Detail'].default_value = 6
    links.new(coord.outputs['Object'], noise.inputs['Vector'])
    vor = nodes.new('ShaderNodeTexVoronoi')
    vor.inputs['Scale'].default_value = 40
    links.new(coord.outputs['Object'], vor.inputs['Vector'])
    rock = lib._ramp(nodes, [(0.3, a), (0.7, b)])
    links.new(noise.outputs['Fac'], rock.inputs['Fac'])
    spot = nodes.new('ShaderNodeMapRange')
    spot.inputs['From Min'].default_value = 0.12
    spot.inputs['From Max'].default_value = 0.08
    links.new(vor.outputs['Distance'], spot.inputs['Value'])
    mix = nodes.new('ShaderNodeMix')
    mix.data_type = 'RGBA'
    mix.inputs['B'].default_value = (*lib.lin(speck), 1)
    links.new(spot.outputs['Result'], mix.inputs['Factor'])
    links.new(rock.outputs['Color'], mix.inputs['A'])
    links.new(mix.outputs['Result'], bsdf.inputs['Base Color'])
    links.new(spot.outputs['Result'], bsdf.inputs['Metallic'])
    return mat


class Mats:
    """Materials of the current scene, made on first use."""

    def __init__(self):
        self.cache = {}

    def __getitem__(self, name):
        if name not in self.cache:
            self.cache[name] = MATERIALS[name]()
        return self.cache[name]


# ------------------------------------------------------------------------------------------- items
# Each builds one item around the origin (long axis along +X, lying on z = 0 unless it stands).

X = (0, math.pi / 2, 0)  # cylinder axis along X
Y = (math.pi / 2, 0, 0)  # cylinder axis along Y


def item_log(m, rnd):
    lib.cylinder((0, 0, 0.04), 0.04, 0.32, m['log'], rot=X, verts=10)
    for s in (-1, 1):
        lib.cylinder((s * 0.16, 0, 0.04), 0.037, 0.005, m['cut'], rot=X, verts=10)


def item_plank(m, rnd):
    lib.box((0, 0, 0.011), (0.34, 0.085, 0.022), m['plank'], bevel=0.003)


def item_stone(m, rnd):
    lib.box((0, 0, 0.037), (0.12, 0.11, 0.075), m['block'], rot=(0, 0, rnd.uniform(-0.15, 0.15)), bevel=0.012)


def item_water(m, rnd):
    """A squat wooden bucket brimful of water, iron bands, so the blue reads from the camera."""
    lib.cylinder((0, 0, 0.04), 0.05, 0.08, m['handle'], radius2=0.06, verts=14)
    for z in (0.015, 0.065):
        lib.cylinder((0, 0, z), 0.052 + z * 0.13, 0.012, m['band'], verts=14)
    lib.cylinder((0, 0, 0.078), 0.056, 0.008, m['water'], verts=14)


def item_fish(m, rnd):
    """A fish lying on its side: a slim silver body and a small forked tail."""
    lib.sphere((0, 0, 0.02), 0.05, m['fish'], scale=(2.4, 0.85, 0.42))
    for s in (-1, 1):
        lib.box((-0.125, s * 0.012, 0.02), (0.035, 0.014, 0.006), m['fin'], rot=(0, 0, s * 0.5))


def item_grain(m, rnd):
    """A sheaf: straw bound in the middle, ears flaring at one end."""
    lib.cylinder((-0.03, 0, 0.042), 0.04, 0.22, m['straw'], rot=X, verts=12, radius2=0.05)
    lib.lumpy((0.11, 0, 0.05), 0.06, m['ears'], scale=(1.1, 1.1, 0.9), strength=0.5, noise=0.25, subdiv=2)
    lib.cylinder((-0.01, 0, 0.044), 0.046, 0.025, m['twine'], rot=X, verts=12)


def item_flour(m, rnd):
    """A white sack of flour, standing, tied at the top."""
    lib.lumpy((0, 0, 0.065), 0.07, m['sack'], scale=(1.0, 0.95, 1.05), strength=0.2, noise=0.6, subdiv=3)
    lib.cylinder((0, 0, 0.135), 0.02, 0.03, m['sack'], verts=10, radius2=0.03)
    lib.cylinder((0, 0, 0.128), 0.024, 0.01, m['twine'], verts=10)


def item_bread(m, rnd):
    lib.sphere((0, 0, 0.03), 0.06, m['crust'], scale=(1.5, 1.0, 0.6))
    for k in (-1, 0, 1):
        lib.box((k * 0.035, 0, 0.064), (0.012, 0.05, 0.006), m['score'], rot=(0, 0, 0.5))


def item_pig(m, rnd):
    lib.sphere((0, 0, 0.075), 0.065, m['pig'], scale=(1.5, 1.0, 0.95))
    lib.sphere((0.1, 0, 0.085), 0.045, m['pig'])
    lib.cylinder((0.145, 0, 0.08), 0.02, 0.02, m['snout'], rot=X, verts=10)
    for s in (-1, 1):
        lib.cylinder((0.095, s * 0.03, 0.13), 0.015, 0.03, m['snout'], radius2=0.002, verts=6, rot=(s * 0.4, 0, 0))
        for x in (-0.06, 0.05):
            lib.cylinder((x, s * 0.035, 0.022), 0.014, 0.045, m['pig'], verts=8)


def item_meat(m, rnd):
    """A ham: red meat with a fat rim and a bone sticking out."""
    lib.sphere((0, 0, 0.035), 0.055, m['meat'], scale=(1.4, 1.0, 0.7))
    lib.cylinder((0.07, 0, 0.035), 0.04, 0.012, m['fat'], rot=X, verts=12)
    lib.cylinder((-0.09, 0, 0.035), 0.011, 0.045, m['bone'], rot=X, verts=8)
    lib.sphere((-0.115, 0, 0.035), 0.016, m['bone'])


def lump(mat):
    def build(m, rnd):
        lib.lumpy((0, 0, 0.035), 0.05, m[mat], scale=(1.2, 1.0, 0.8), strength=0.45, noise=0.9,
                  seed=rnd.randrange(1000), subdiv=1, flat=True)
    return build


def item_bar(mat):
    def build(m, rnd):
        lib.box((0, 0, 0.024), (0.22, 0.08, 0.048), m[mat], bevel=0.01)
    return build


def handle(length, x0=0.0, r=0.011, m=None):
    lib.cylinder((x0, 0, r), r, length, m['handle'], rot=X, verts=8)


def item_axe(m, rnd):
    handle(0.28, m=m)
    lib.box((0.12, 0.035, 0.014), (0.05, 0.08, 0.016), m['steel'], bevel=0.004)


def item_saw(m, rnd):
    lib.box((0.03, 0, 0.004), (0.24, 0.07, 0.006), m['steel'])
    for k in range(10):
        lib.box((-0.08 + k * 0.024, -0.037, 0.004), (0.012, 0.012, 0.005), m['steel'], rot=(0, 0, math.pi / 4))
    lib.box((-0.12, 0.005, 0.014), (0.06, 0.05, 0.026), m['handle'], bevel=0.006)


def item_pickaxe(m, rnd):
    handle(0.28, m=m)
    for s in (-1, 1):
        lib.cylinder((0.13, s * 0.05, 0.014), 0.014, 0.1, m['iron'], rot=(s * -math.pi / 2, 0, 0), radius2=0.003, verts=8)


def item_shovel(m, rnd):
    handle(0.22, -0.04, m=m)
    lib.box((0.12, 0, 0.008), (0.1, 0.075, 0.008), m['iron'], bevel=0.012)


def item_scythe(m, rnd):
    handle(0.32, m=m)
    for k in range(6):
        a = k / 5 * 1.1
        lib.box((0.15 - math.sin(a) * 0.04, 0.02 + k * 0.022, 0.01), (0.03, 0.024, 0.006), m['steel'], rot=(0, 0, -a))


def item_rod(m, rnd):
    lib.cylinder((0, 0, 0.008), 0.007, 0.34, m['handle'], rot=X, verts=6, radius2=0.003)
    lib.cylinder((-0.1, 0, 0.022), 0.018, 0.016, m['band'], rot=Y, verts=10)
    lib.box((0.02, 0.02, 0.004), (0.24, 0.003, 0.003), m['string'], rot=(0, 0, 0.08))


def item_hammer(m, rnd):
    handle(0.22, -0.02, m=m)
    lib.box((0.09, 0, 0.022), (0.04, 0.09, 0.04), m['iron'], bevel=0.006)


def item_sword(m, rnd):
    lib.box((0.05, 0, 0.006), (0.22, 0.026, 0.008), m['steel'], bevel=0.003)
    lib.box((-0.065, 0, 0.01), (0.014, 0.08, 0.014), m['gold'], bevel=0.003)
    lib.cylinder((-0.1, 0, 0.01), 0.011, 0.055, m['leather'], rot=X, verts=8)
    lib.sphere((-0.132, 0, 0.01), 0.016, m['gold'])


def item_bow(m, rnd):
    segs = 9
    for k in range(segs):
        t = (k + 0.5) / segs * 2 - 1  # −1..1 along the bow
        x = t * 0.16
        y = 0.06 * (1 - t * t)
        # Along the arc's tangent (dy/dx = −0.75 t), a little longer than a step so segments join.
        slope = -0.75 * t
        lib.box((x, y, 0.008), (0.04 * math.hypot(1, slope), 0.016, 0.014), m['handle'], rot=(0, 0, math.atan(slope)))
    lib.box((0, 0, 0.008), (0.32, 0.003, 0.003), m['string'])


def item_armor(m, rnd):
    """A squad leader's armour, lying flat: a rounded breastplate with a raised ridge, two
    shoulder straps and a belt of leather."""
    lib.sphere((0, 0, 0.02), 0.1, m['steel'], scale=(1.0, 0.8, 0.28))
    lib.box((0, 0, 0.045), (0.16, 0.012, 0.012), m['steel'], bevel=0.004)
    for s in (-1, 1):
        lib.box((0.07, s * 0.05, 0.035), (0.05, 0.025, 0.012), m['leather'], bevel=0.003)
    lib.box((-0.08, 0, 0.02), (0.02, 0.15, 0.016), m['leather'], bevel=0.003)
    lib.sphere((-0.08, 0, 0.03), 0.012, m['gold'])


# ----------------------------------------------------------------------------------------- layouts
# Each returns PILE_MAX placements (x, y, z, yaw); a pile of n items uses the first n.

def rows(spacing, height, width=4):
    """Long items in a pyramid: rows of 4, 3, 2… along Y, stacked into the dips."""
    out = []
    row, count = 0, width
    while len(out) < PILE_MAX:
        for k in range(count):
            out.append(((0, (k - (count - 1) / 2) * spacing, row * height, 0)))
        row += 1
        count = max(1, count - 1)
    return out[:PILE_MAX]


def layers(per_layer, spacing, height, cross=False):
    """Flat items side by side along Y, `per_layer` a layer; with `cross` every other layer turns 90°."""
    out = []
    for k in range(PILE_MAX):
        layer, i = divmod(k, per_layer)
        off = (i - (per_layer - 1) / 2) * spacing
        turned = cross and layer % 2 == 1
        out.append((off if turned else 0, 0 if turned else off, layer * height, math.pi / 2 if turned else 0))
    return out


def grid(spacing, height):
    """Bulky items standing on a 2×2 base, then 3 on top, then 1 (blocks, sacks)."""
    s = spacing / 2
    base = [(-s, -s), (s, -s), (-s, s), (s, s)]
    mid = [(0, -s), (0, s), (-s, 0)]
    out = [(x, y, 0, 0) for x, y in base] + [(x, y, height, 0) for x, y in mid] + [(0, 0, height * 2, 0)]
    return out


def spread(spacing):
    """Standing items side by side on the ground, 3 + 3 + 2 rows (buckets, pigs)."""
    out = []
    for k in range(PILE_MAX):
        row, i = divmod(k, 3)
        out.append(((row - 1) * spacing, (i - 1) * spacing + (row % 2) * spacing * 0.3, 0, 0))
    return out


def heap(r, height):
    """Small items in a mound: a ring on the ground, then a smaller ring, then the top."""
    out = []
    for k in range(5):
        a = k / 5 * math.tau + 0.3
        out.append((math.cos(a) * r, math.sin(a) * r, 0, a))
    for k in range(2):
        a = k * math.pi + 1.2
        out.append((math.cos(a) * r * 0.4, math.sin(a) * r * 0.4, height, a + 1))
    out.append((0, 0, height * 2, 0.4))
    # Start from the middle so small heaps sit on the door spot, not on one side.
    return [out[5], out[0], out[2], out[6], out[3], out[1], out[4], out[7]]


def bundle(spacing):
    """Long tools and weapons lying side by side, 4 a layer, slightly fanned."""
    out = []
    for k in range(PILE_MAX):
        layer, i = divmod(k, 4)
        out.append((layer * 0.02, (i - 1.5) * spacing + layer * spacing / 2, layer * 0.028, (i - 1.5) * 0.06))
    return out


# --------------------------------------------------------------------------------------- the table
# In the game's RESOURCES order (src/sim/types.ts); every resource needs an entry.

GOODS = {
    'log': (item_log, rows(0.085, 0.072)),
    'plank': (item_plank, layers(2, 0.09, 0.023)),
    'stone': (item_stone, grid(0.13, 0.076)),
    'water': (item_water, spread(0.12)),
    'fish': (item_fish, layers(4, 0.055, 0.022)),
    'grain': (item_grain, rows(0.095, 0.08)),
    'flour': (item_flour, grid(0.15, 0.12)),
    'bread': (item_bread, heap(0.1, 0.04)),
    'pig': (item_pig, spread(0.16)),
    'meat': (item_meat, heap(0.11, 0.045)),
    'coal': (lump('coal'), heap(0.09, 0.05)),
    'ironore': (lump('ironore'), heap(0.09, 0.05)),
    'goldore': (lump('goldore'), heap(0.09, 0.05)),
    'iron': (item_bar('iron'), layers(3, 0.09, 0.05, cross=True)),
    'gold': (item_bar('gold'), layers(3, 0.09, 0.05, cross=True)),
    'axe': (item_axe, bundle(0.1)),
    'saw': (item_saw, bundle(0.085)),
    'pickaxe': (item_pickaxe, bundle(0.07)),
    'shovel': (item_shovel, bundle(0.085)),
    'scythe': (item_scythe, bundle(0.1)),
    'rod': (item_rod, bundle(0.05)),
    'hammer': (item_hammer, bundle(0.09)),
    'sword': (item_sword, bundle(0.075)),
    'bow': (item_bow, bundle(0.08)),
    'armor': (item_armor, grid(0.15, 0.05)),
}


# --------------------------------------------------------------------------------------- building

def place(build, m, rnd, x, y, z, yaw, scale=1.0):
    """Builds one item and moves it to (x, y, z), turned by `yaw` and scaled."""
    before = set(bpy.data.objects)
    root = bpy.data.objects.new('item', None)
    bpy.context.scene.collection.objects.link(root)
    build(m, rnd)
    bpy.context.view_layer.update()
    for obj in set(bpy.data.objects) - before - {root}:
        obj.parent = root
    root.location = (x, y, z)
    root.rotation_euler = (0, 0, yaw)
    root.scale = (scale, scale, scale)
    bpy.context.view_layer.update()
    return root


def screen_yaw():
    """Yaw that lays an item's long axis along the screen's horizontal."""
    gx, gy = lib.ground_dir(0)
    return math.atan2(gy, gx)


def centre(root):
    """Moves an item so the middle of its bounding box sits on the world origin (for wares)."""
    from mathutils import Vector

    dg = bpy.context.evaluated_depsgraph_get()
    pts = []
    for obj in root.children:
        ev = obj.evaluated_get(dg)
        pts += [ev.matrix_world @ Vector(c) for c in ev.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    root.location -= (lo + hi) / 2
    bpy.context.view_layer.update()


def render_frame(path, size, setup):
    """Renders one frame of `size` (logical w, h, ax, ay) after `setup()` builds the scene; returns
    the pixels (Blender's bottom-up rows)."""
    scene = lib.reset_scene(samples=24)  # small sprites: fewer samples, the denoiser does the rest
    # Tiny frames render fine on the CPU, and it leaves the GPU to bigger renders running alongside.
    scene.cycles.device = 'CPU'
    w, h, ax, ay = size
    lib.setup_camera(scene, w, h, ax, ay)
    setup(scene)
    lib.render_to(scene, path)
    img = bpy.data.images.load(path)
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(h * lib.RESOLUTION, w * lib.RESOLUTION, 4)


def save_strip(frames, path):
    strip = np.concatenate(frames, axis=1)
    h, w, _ = strip.shape
    img = bpy.data.images.new('strip', width=w, height=h, alpha=True)
    img.pixels.foreach_set(strip.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def render_piles(out, tmp, only=None):
    """`piles-<res>.png` for every resource (or those in `only`)."""
    for res, (build, layout) in GOODS.items():
        if only and res not in only:
            continue
        frames = []
        for n in range(1, PILE_MAX + 1):
            def setup(scene, n=n):
                m = Mats()
                rnd = random.Random(n)
                # Long goods lie along world X, so their ends face the camera (logs show their rings).
                k = PILE_SCALE
                for x, y, z, yaw in layout[:n]:
                    place(build, m, rnd, x * k, y * k, z * k, yaw, k)
            frames.append(render_frame(os.path.join(tmp, f'pile-{res}-{n}.png'), PILE, setup))
        save_strip(frames, os.path.join(out, f'piles-{res}.png'))
        print('rendered pile', res)


def loosen(layout, rnd):
    """A pile layout put down loosely: the ground layer first (a small heap lies on the ground, not
    on top of nothing), every item shifted and turned a little, more on the ground layer than higher
    up (where they rest on the ones below)."""
    out = []
    for x, y, z, yaw in sorted(layout, key=lambda p: p[2]):
        k = 1.0 if z == 0 else 0.35
        out.append((x + rnd.uniform(-0.018, 0.018) * k, y + rnd.uniform(-0.018, 0.018) * k, z,
                    yaw + rnd.uniform(-0.3, 0.3) * k))
    return out


def ground_patch(seed):
    """The grass flattened and scuffed bare where goods were put down: a small, soft-edged patch of
    dark earth, mostly fringe, so it reads as the stack's contact shadow on the ground."""
    mat = lib.mat_grain(f'patch{seed}', (0.2, 0.15, 0.08), (0.36, 0.27, 0.15), scale=22, stretch=(1, 1, 1), bump=0.6)
    lib.pad((0, 0, 0), 0.24, 0.22, mat, verts=64, jitter=0.18, seed=seed, core=0.45, reach=1.35, grain=70.0)


def render_stacks(out, tmp, only=None):
    """`stacks-<res>.png` for every resource (or those in `only`)."""
    for res, (build, layout) in GOODS.items():
        if only and res not in only:
            continue
        frames = []
        for n in range(1, PILE_MAX + 1):
            def setup(scene, n=n):
                m = Mats()
                rnd = random.Random(n)
                ground_patch(n)
                k = PILE_SCALE
                for x, y, z, yaw in loosen(layout, random.Random(7))[:n]:
                    place(build, m, rnd, x * k, y * k, z * k, yaw, k)
            frames.append(render_frame(os.path.join(tmp, f'stack-{res}-{n}.png'), STACK, setup))
        save_strip(frames, os.path.join(out, f'stacks-{res}.png'))
        print('rendered stack', res)


def render_wares(out, tmp):
    """`wares.png`: one carried ware per resource, in `GOODS` order (listed in `wares.json`)."""
    frames = []
    for res, (build, _) in GOODS.items():
        def setup(scene, build=build):
            bpy.data.objects['ShadowCatcher'].hide_render = True
            root = place(build, Mats(), random.Random(1), 0, 0, 0, screen_yaw())
            centre(root)
        frames.append(render_frame(os.path.join(tmp, f'ware-{res}.png'), WARE, setup))
    save_strip(frames, os.path.join(out, 'wares.png'))
    with open(os.path.join(out, 'wares.json'), 'w') as f:
        json.dump({'frame': list(WARE), 'order': list(GOODS)}, f)
    print('rendered wares')


# ------------------------------------------------------------------------------------------- icons
# Menu icons: the same item models, each framed tightly in its own square so it reads at 13–48 CSS
# px. A carried ware is ~14 logical px wide, far too small to scale up into a menu; these render at
# ICON px, enough for the largest UI use on a 2× display. Bulk goods lie as a small group on the
# ground (soft contact shadow); tools, weapons and the sheaf stand upright, diagonal with the working
# end up-right, their broad side to the camera so the silhouettes (axe blade, pick points, hammer
# block, saw teeth…) read.

#: Pixels of one icon (square).
ICON = 96
#: Icons per row of `icons.png`.
ICON_COLUMNS = 8
#: Camera elevation above the horizon (a 3/4 view from the front).
ICON_ELEVATION = math.radians(36)
#: Empty margin around the item, as a fraction of the icon.
ICON_MARGIN = 0.05


def ground(at, yaw=0, build=None):
    """Items lying as placed by `at` ((x, y, z, yaw) each, as in pile layouts), the group turned
    `yaw`°; `build` replaces the ware's model."""
    return {'view': 'ground', 'at': at, 'yaw': yaw, 'build': build}


def upright(build=None, roll=-45, turn=18, tilt=24):
    """One item stood up facing the camera: its long +X axis rolled to `roll`° (−45 = up-right,
    −90 = straight up), leant back `tilt`° and turned `turn`° about the vertical to show its depth;
    `build` replaces the ware's model."""
    return {'view': 'upright', 'roll': roll, 'turn': turn, 'tilt': tilt, 'build': build}


BARS = [(0, -0.045, 0, 0), (0, 0.045, 0, 0), (0, 0, 0.048, math.pi / 2)]


# Icon-only models: the carried wares are tuned for ~14 px, where a thin handle and a small head are
# enough; at menu size the tools need chunkier handles and drawn-out heads (flat profiles extruded
# with `prism`), so pickaxe, hammer and axe differ at a glance. Built like the items: long axis +X,
# working end at +X, broad side up (+Z), which `upright` turns to the camera.

ICON_HANDLE = 0.016


def prism(points, z0, z1, mat, bevel=0.0):
    """A flat profile (x, y points, counter-clockwise) extruded from z0 to z1."""
    import bmesh

    mesh = bpy.data.meshes.new('prism')
    bm = bmesh.new()
    low = [bm.verts.new((x, y, z0)) for x, y in points]
    high = [bm.verts.new((x, y, z1)) for x, y in points]
    bm.faces.new(list(reversed(low)))
    bm.faces.new(high)
    n = len(points)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((low[i], low[j], high[j], high[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('prism', mesh)
    bpy.context.scene.collection.objects.link(obj)
    if bevel > 0:
        mod = obj.modifiers.new('Bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 2
        mod.limit_method = 'ANGLE'
    if mat is not None:
        mesh.materials.append(mat)
    return obj


def strip(centre, width, steps):
    """Outline of a curved strip: `centre(u)` → (x, y) for u in 0..1, `width(u)` across it."""
    left, right = [], []
    for k in range(steps + 1):
        u = k / steps
        x, y = centre(u)
        x2, y2 = centre(min(1, u + 1e-3)) if u < 1 else centre(u)
        x1, y1 = centre(max(0, u - 1e-3))
        tx, ty = x2 - x1, y2 - y1
        n = math.hypot(tx, ty) or 1
        nx, ny = -ty / n, tx / n
        w = width(u) / 2
        left.append((x + nx * w, y + ny * w))
        right.append((x - nx * w, y - ny * w))
    return right + list(reversed(left))


def icon_handle(x0, x1, m, r=ICON_HANDLE):
    lib.cylinder(((x0 + x1) / 2, 0, 0), r, x1 - x0, m['handle'], rot=X, verts=12)


def icon_axe(m, rnd):
    icon_handle(-0.17, 0.15, m)
    lib.box((0.115, 0, 0), (0.05, 0.05, 0.034), m['iron'], bevel=0.006)  # eye round the handle
    # The blade flares from the eye to a curved cutting edge on the +Y side.
    edge = [(0.2 - 0.15 * k / 8, 0.125 + 0.028 * math.sin(math.pi * k / 8)) for k in range(9)]
    prism([(0.095, 0.02), (0.135, 0.02)] + edge, -0.008, 0.008, m['steel'], bevel=0.003)
    prism([(0.1, -0.02), (0.13, -0.02), (0.125, -0.05), (0.105, -0.05)], -0.014, 0.014, m['iron'], bevel=0.004)


def icon_pickaxe(m, rnd):
    icon_handle(-0.17, 0.14, m)
    head = strip(lambda u: (0.115 + 0.045 * (1 - (2 * u - 1) ** 2), 0.16 * (2 * u - 1)),
                 lambda u: 0.006 + 0.034 * (1 - abs(2 * u - 1)) ** 0.7, 16)
    prism(head, -0.015, 0.015, m['iron'], bevel=0.004)


def icon_hammer(m, rnd):
    icon_handle(-0.17, 0.12, m)
    lib.box((0.13, 0, 0), (0.075, 0.15, 0.075), m['iron'], bevel=0.01)
    for s in (-1, 1):
        lib.box((0.13, s * 0.08, 0), (0.085, 0.014, 0.085), m['band'], bevel=0.005)


def icon_shovel(m, rnd):
    icon_handle(-0.17, 0.06, m)
    lib.cylinder((-0.17, 0, 0), ICON_HANDLE, 0.08, m['handle'], rot=Y, verts=10)  # T grip
    prism([(0.04, -0.02), (0.08, -0.025), (0.08, 0.025), (0.04, 0.02)], -0.012, 0.012, m['iron'], bevel=0.003)
    prism([(0.075, -0.055), (0.17, -0.055), (0.215, 0), (0.17, 0.055), (0.075, 0.055)], -0.006, 0.006, m['steel'], bevel=0.004)


def icon_scythe(m, rnd):
    icon_handle(-0.18, 0.15, m)
    lib.cylinder((-0.02, 0.035, 0), ICON_HANDLE * 0.8, 0.07, m['handle'], rot=Y, verts=10)  # hand peg
    blade = strip(lambda u: (0.15 - 0.12 * u * u, 0.01 + 0.22 * u), lambda u: 0.045 * (1 - u) + 0.004, 16)
    prism(blade, -0.006, 0.006, m['steel'], bevel=0.003)


def icon_saw(m, rnd):
    teeth = []
    n = 12
    for k in range(n + 1):
        x = 0.19 - 0.25 * k / n
        y = -0.02 - 0.02 * k / n
        teeth.append((x, y))
        if k < n:
            teeth.append((x - 0.25 / n / 2, y - 0.018))
    # Toothed lower edge from the heel to the toe, then the straight back.
    prism(list(reversed(teeth)) + [(0.2, -0.02), (0.2, 0.03), (-0.06, 0.05)], -0.004, 0.004, m['steel'])
    prism([(-0.16, -0.05), (-0.055, -0.05), (-0.055, 0.06), (-0.14, 0.07), (-0.18, 0.01)], -0.014, 0.014, m['handle'], bevel=0.006)
    lib.cylinder((-0.11, 0.005, 0), 0.022, 0.04, m['band'], verts=12)  # dark hand hole


def icon_sword(m, rnd):
    prism([(-0.04, -0.022), (0.17, -0.022), (0.22, 0), (0.17, 0.022), (-0.04, 0.022)], -0.007, 0.007, m['steel'], bevel=0.004)
    lib.box((0.07, 0, 0.007), (0.2, 0.008, 0.002), m['iron'])  # fuller
    lib.box((-0.05, 0, 0), (0.022, 0.12, 0.024), m['gold'], bevel=0.005)
    lib.cylinder((-0.1, 0, 0), 0.015, 0.08, m['leather'], rot=X, verts=10)
    lib.sphere((-0.145, 0, 0), 0.022, m['gold'])


def icon_bow(m, rnd):
    # The stave: one smooth strip along the arc, thick in the middle, thin at the tips.
    stave = strip(lambda u: (0.19 * (2 * u - 1), 0.085 * (1 - (2 * u - 1) ** 2)),
                  lambda u: 0.024 * (1 - 0.6 * abs(2 * u - 1)) + 0.004, 24)
    prism(stave, -0.009, 0.009, m['handle'], bevel=0.004)
    lib.box((0, 0.085, 0), (0.05, 0.03, 0.024), m['leather'], bevel=0.006)  # grip
    lib.box((0, 0, 0), (0.38, 0.003, 0.003), m['string'])
    # An arrow on the string, pointing out past the grip.
    lib.cylinder((0, 0.07, 0.012), 0.004, 0.14, m['handle'], rot=Y, verts=6)
    lib.cylinder((0, 0.15, 0.012), 0.012, 0.03, m['iron'], rot=(-math.pi / 2, 0, 0), radius2=0.0, verts=4)
    for s_ in (-1, 1):
        prism([(0, 0.002), (s_ * 0.016, 0.008), (s_ * 0.016, 0.034), (0, 0.04)], 0.01, 0.014, m['meat'])


def icon_rod(m, rnd):
    lib.cylinder((0.02, 0, 0), 0.012, 0.38, m['handle'], rot=X, verts=10, radius2=0.004)
    lib.cylinder((-0.14, 0, 0), 0.016, 0.07, m['leather'], rot=X, verts=10)
    lib.cylinder((-0.09, 0, 0.018), 0.026, 0.02, m['band'], verts=14)  # reel
    # The line hangs from the tip (screen down is −X−Y here) to a red float.
    tip, bob = (0.21, 0.0), (0.13, -0.11)
    dx, dy = bob[0] - tip[0], bob[1] - tip[1]
    lib.box(((tip[0] + bob[0]) / 2, (tip[1] + bob[1]) / 2, 0), (math.hypot(dx, dy), 0.003, 0.003), m['string'],
            rot=(0, 0, math.atan2(dy, dx)))
    lib.sphere((bob[0], bob[1], 0), 0.02, m['meat'])
    lib.sphere((bob[0] + 0.012, bob[1] + 0.012, 0), 0.012, m['fat'])


def icon_armor(m, rnd):
    """A cuirass standing up (+X up, +Y left, +Z to the camera): a torso-shaped plate (broad
    shoulders, neck notch, narrow waist) with a ridge and gilt trim, shoulder plates, a belt and a
    skirt of leather strips."""
    half = [(0.125, 0.0), (0.135, 0.035), (0.13, 0.075), (0.105, 0.105), (0.065, 0.088), (0.0, 0.074),
            (-0.065, 0.066), (-0.085, 0.072)]
    outline = [(x, -y) for x, y in reversed(half)] + half[1:]
    prism(outline, -0.01, 0.03, m['steel'], bevel=0.016)
    lib.box((0.02, 0, 0.034), (0.2, 0.01, 0.01), m['steel'], bevel=0.004)  # ridge
    neck = strip(lambda u: (0.128 - 0.012 * (1 - (2 * u - 1) ** 2), 0.04 * (2 * u - 1)), lambda u: 0.01, 10)
    prism(neck, 0.02, 0.036, m['gold'], bevel=0.003)
    for s_ in (-1, 1):
        lib.sphere((0.1, s_ * 0.105, 0.02), 0.045, m['steel'], scale=(0.75, 1.0, 0.45))  # shoulder plates
        lib.box((0.1, s_ * 0.105, 0.036), (0.012, 0.06, 0.006), m['gold'], bevel=0.002)
    lib.box((-0.085, 0, 0.012), (0.028, 0.16, 0.05), m['leather'], bevel=0.008)  # belt
    lib.sphere((-0.085, 0, 0.038), 0.014, m['gold'])
    for k in range(6):
        y = (k - 2.5) * 0.027
        lib.box((-0.135, y, 0.004), (0.07, 0.022, 0.012), m['leather'], bevel=0.004)


def icon_grain(m, rnd):
    """A sheaf: stalks bound in the middle, fanning out to ears on top and to cut ends below."""
    r = random.Random(7)
    for k in range(11):
        a = (k - 5) / 5
        z = r.uniform(-0.02, 0.02)
        top = (0.15, a * 0.07, z)
        low = (-0.15, a * 0.04, z * 0.5)
        for (x0, y0, z0), (x1, y1, z1) in (((0, a * 0.012, 0), top), ((0, a * 0.012, 0), low)):
            dx, dy = x1 - x0, y1 - y0
            lib.cylinder(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), 0.0055, math.hypot(dx, dy), m['straw'],
                         rot=(0, math.pi / 2, math.atan2(dy, dx)), verts=6)
        ang = math.atan2(top[1], top[0])
        lib.sphere((top[0] + 0.03 * math.cos(ang), top[1] + 0.03 * math.sin(ang), top[2]), 0.016, m['ears'],
                   scale=(2.3, 0.75, 0.75), subdiv=2).rotation_euler = (0, 0, ang)
    lib.cylinder((0, 0, 0), 0.022, 0.025, m['twine'], rot=X, verts=12)


def icon_fish(m, rnd):
    lib.sphere((0, 0, 0.03), 0.06, m['fish'], scale=(2.3, 0.9, 0.45))
    prism([(-0.12, 0), (-0.2, 0.06), (-0.175, 0), (-0.2, -0.06)], 0.022, 0.034, m['fin'], bevel=0.003)
    prism([(-0.05, 0.045), (0.04, 0.045), (-0.03, 0.085)], 0.024, 0.032, m['fin'])  # dorsal
    lib.sphere((0.1, 0.012, 0.05), 0.011, m['bone'])
    lib.sphere((0.104, 0.014, 0.056), 0.006, m['coal'])
    lib.box((0.07, 0, 0.052), (0.004, 0.06, 0.004), m['fin'], rot=(0, 0, 0.15))  # gill line


def icon_flour(m, rnd):
    """An open burlap sack with a white mound of flour in its mouth, a little spilt in front."""
    lib.lumpy((0, 0, 0.07), 0.075, m['burlap'], scale=(1.0, 1.0, 0.95), strength=0.15, noise=0.6, subdiv=3)
    lib.cylinder((0, 0, 0.13), 0.068, 0.03, m['burlap'], radius2=0.075, verts=24, bevel=0.008)  # rolled rim
    lib.lumpy((0, 0, 0.15), 0.064, m['fat'], scale=(1.0, 1.0, 0.45), strength=0.15, noise=0.8, subdiv=3)
    lib.lumpy((0.075, -0.075, 0.0), 0.04, m['fat'], scale=(1.4, 1.0, 0.4), strength=0.2, noise=0.8, subdiv=2)


def icon_goldore(m, rnd):
    lump('goldore')(m, rnd)
    for k in range(3):
        a = rnd.uniform(0, math.tau)
        lib.lumpy((math.cos(a) * 0.04, math.sin(a) * 0.035, 0.05 + rnd.uniform(-0.01, 0.01)), 0.016, m['gold'],
                  strength=0.4, noise=1.0, seed=rnd.randrange(1000), subdiv=1, flat=True)


def icon_world(scene):
    """A sky that is bright above and dark below, so metal shows highlights and a horizon."""
    nodes, links = scene.world.node_tree.nodes, scene.world.node_tree.links
    bg = nodes['Background']
    coord = nodes.new('ShaderNodeTexCoord')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(coord.outputs['Generated'], sep.inputs['Vector'])
    span = nodes.new('ShaderNodeMapRange')
    span.inputs['From Min'].default_value = -0.3
    span.inputs['From Max'].default_value = 0.8
    links.new(sep.outputs['Z'], span.inputs['Value'])
    ramp = lib._ramp(nodes, [(0.0, (0.1, 0.08, 0.06)), (0.45, (0.45, 0.44, 0.42)), (1.0, (1.0, 0.97, 0.9))])
    links.new(span.outputs['Result'], ramp.inputs['Fac'])
    links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = 0.7

ICONS = {
    'log': ground([(0, -0.043, 0, 0), (0, 0.043, 0, 0), (0, 0, 0.072, 0)], yaw=32),
    'plank': ground(layers(2, 0.09, 0.023)[:4], yaw=28),
    'stone': ground([(-0.066, 0.01, 0, 0.12), (0.066, 0.02, 0, -0.1), (0, 0.012, 0.076, 0.05)], yaw=18),
    'water': ground([(0, 0, 0, 0)]),
    'fish': ground([(0, 0, 0, 0)], yaw=14, build=icon_fish),
    'grain': upright(icon_grain, roll=-70, turn=10, tilt=10),
    'flour': ground([(0, 0, 0, 0)], build=icon_flour),
    'bread': ground([(0, 0, 0, 0)], yaw=24),
    'pig': ground([(0, 0, 0, 0)], yaw=-28),
    'meat': ground([(0, 0, 0, 0)], yaw=16),
    'coal': ground(heap(0.09, 0.05), yaw=10),
    'ironore': ground(heap(0.09, 0.05), yaw=10),
    'goldore': ground(heap(0.09, 0.05), yaw=10, build=icon_goldore),
    'iron': ground(BARS, yaw=24),
    'gold': ground(BARS, yaw=24),
    'axe': upright(icon_axe),
    'saw': upright(icon_saw, roll=-30),
    'pickaxe': upright(icon_pickaxe),
    'shovel': upright(icon_shovel),
    'scythe': upright(icon_scythe),
    'rod': upright(icon_rod),
    'hammer': upright(icon_hammer),
    'sword': upright(icon_sword),
    'bow': upright(icon_bow, turn=10),
    'armor': upright(icon_armor, roll=-90, turn=14, tilt=14),
}
assert list(ICONS) == list(GOODS), 'ICONS must list every resource in GOODS order'


def icon_camera(scene):
    """Orthographic camera looking along +Y, raised by ICON_ELEVATION, rendering ICON² pixels."""
    cam_data = bpy.data.cameras.new('IconCamera')
    cam_data.type = 'ORTHO'
    cam = bpy.data.objects.new('IconCamera', cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.rotation_euler = (math.pi / 2 - ICON_ELEVATION, 0, 0)
    cam_data.clip_start = 0.1
    cam_data.clip_end = 100
    scene.render.resolution_x = ICON
    scene.render.resolution_y = ICON
    scene.render.resolution_percentage = 100
    return cam


def icon_light():
    """Sun from the upper left, a little in front, so faces turned to the camera are lit too."""
    from mathutils import Vector

    sun = bpy.data.objects['Sun']
    sun.rotation_euler = Vector((0.75, 0.55, -1.25)).normalized().to_track_quat('-Z', 'Y').to_euler()


def fit_camera(cam, roots, shadow):
    """Centres the camera on what the roots hold and zooms so it fills the frame (less
    ICON_MARGIN); with `shadow`, the shadow cast on the ground stays in frame too."""
    from mathutils import Vector

    bpy.context.view_layer.update()
    dg = bpy.context.evaluated_depsgraph_get()
    ray = bpy.data.objects['Sun'].matrix_world.to_quaternion() @ Vector((0, 0, -1))  # light travels
    pts = []
    for root in roots:
        for obj in root.children_recursive:
            if obj.type != 'MESH':
                continue
            ev = obj.evaluated_get(dg)
            mesh = ev.to_mesh()
            for v in mesh.vertices:
                p = ev.matrix_world @ v.co
                pts.append(p)
                if shadow and ray.z < 0 and p.z > 0:
                    pts.append(p + ray * (p.z / -ray.z))
            ev.to_mesh_clear()
    rot = cam.matrix_world.to_quaternion()
    right, up, back = rot @ Vector((1, 0, 0)), rot @ Vector((0, 1, 0)), rot @ Vector((0, 0, 1))
    xs = [p.dot(right) for p in pts]
    ys = [p.dot(up) for p in pts]
    span = max(max(xs) - min(xs), max(ys) - min(ys))
    cam.location = right * ((min(xs) + max(xs)) / 2) + up * ((min(ys) + max(ys)) / 2) + back * 20
    cam.data.ortho_scale = span / (1 - 2 * ICON_MARGIN)
    bpy.context.view_layer.update()


def render_icon(res, path):
    """Renders the icon of `res` into `path` (ICON² pixels); returns Blender's bottom-up pixels."""
    from mathutils import Matrix

    spec = ICONS[res]
    build = spec['build'] or GOODS[res][0]
    scene = lib.reset_scene(samples=64)
    scene.cycles.device = 'CPU'
    cam = icon_camera(scene)
    icon_light()
    icon_world(scene)
    m = Mats()
    rnd = random.Random(3)
    if spec['view'] == 'ground':
        group = bpy.data.objects.new('group', None)
        scene.collection.objects.link(group)
        for x, y, z, yaw in spec['at']:
            place(build, m, rnd, x, y, z, yaw).parent = group
        group.rotation_euler = (0, 0, math.radians(spec['yaw']))
        root = group
    else:
        root = place(build, m, rnd, 0, 0, 0, 0)
        centre(root)
        # Lying flat → broad side to the camera (+Z to −Y), long axis rolled, leant back, turned.
        root.matrix_world = (
            Matrix.Rotation(math.radians(spec['turn']), 4, 'Z')
            @ Matrix.Rotation(-math.radians(spec['tilt']), 4, 'X')
            @ Matrix.Rotation(math.radians(spec['roll']), 4, 'Y')
            @ Matrix.Rotation(math.pi / 2, 4, 'X')
            @ root.matrix_world
        )
        bpy.data.objects['ShadowCatcher'].hide_render = True
    fit_camera(cam, [root], spec['view'] == 'ground')
    lib.render_to(scene, path)
    img = bpy.data.images.load(path)
    px = np.empty(len(img.pixels), dtype=np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    return px.reshape(ICON, ICON, 4)


def render_icons(out, tmp, only=None):
    """`icons.png`: one menu icon per resource in `GOODS` order, ICON_COLUMNS a row (`icons.json`:
    icon size, columns and order). With `only`, re-renders just those and keeps the others' pixels
    from the existing sheet."""
    order = list(GOODS)
    rows_n = (len(order) + ICON_COLUMNS - 1) // ICON_COLUMNS
    w, h = ICON_COLUMNS * ICON, rows_n * ICON
    path = os.path.join(out, 'icons.png')
    sheet = np.zeros((h, w, 4), dtype=np.float32)
    if only and os.path.exists(path):
        old = bpy.data.images.load(path)
        if tuple(old.size) == (w, h):
            old.pixels.foreach_get(sheet.ravel())
        bpy.data.images.remove(old)
    for k, res in enumerate(order):
        if only and res not in only:
            continue
        px = render_icon(res, os.path.join(tmp, f'icon-{res}.png'))
        row, col = divmod(k, ICON_COLUMNS)
        y0 = (rows_n - 1 - row) * ICON  # Blender's rows run bottom-up
        sheet[y0:y0 + ICON, col * ICON:(col + 1) * ICON] = px
        print('rendered icon', res)
    img = bpy.data.images.new('icons', width=w, height=h, alpha=True)
    img.pixels.foreach_set(sheet.ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    with open(os.path.join(out, 'icons.json'), 'w') as f:
        json.dump({'size': ICON, 'columns': ICON_COLUMNS, 'order': order}, f)
    print('rendered icons')
