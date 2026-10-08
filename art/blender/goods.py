"""Goods: one 3D model per resource, rendered as the ware a settler carries and as door piles of
1…PILE_MAX items, as many as really lie there.

Everything is data in `GOODS` (resource → item builder + pile layout), in the game's RESOURCES order.
Items are built lying or standing around the origin at "ware scale" (about 0.3 tile long); a layout
places copies of them into a pile. Output (see build.py):
- `piles-<res>.png`: a strip of PILE_MAX frames (PILE logical size each), frame k holds k + 1 items;
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
        lib.box((x, y, 0.008), (0.042, 0.016, 0.014), m['handle'], rot=(0, 0, -math.atan(-0.12 * t / 0.16 * 2)))
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
