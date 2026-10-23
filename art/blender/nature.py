"""Nature models: tree variants (conifers and broadleaf trees) and small ground props.

Our own designs in the spirit of Settlers 4 landscapes (docs/ART-STYLE.md «Природа»): dark conifers
of drooping layered branches mixed with lighter broadleaf trees, and sparse decorative props on the
grass. Registered through `SINGLE` (merged into build.py's table); `art3d.ts` lists the same names
and canvases (`ART3D_TREES`, `ART3D_PROPS`).
"""

import math
import random

import lib

#: Tree canvas (logical w, h, anchor x, y), shared by every variant.
TREE = (84, 104, 34, 84)
#: Ground prop canvas.
PROP = (32, 28, 16, 20)


def bark_mat(name='bark', light=False):
    if light:
        return lib.mat_grain(name, (0.42, 0.3, 0.18), (0.66, 0.52, 0.36), scale=7, stretch=(1, 1, 5), bump=0.9)
    return lib.mat_grain(name, (0.24, 0.14, 0.08), (0.44, 0.28, 0.15), scale=7, stretch=(1, 1, 5), bump=0.9)


def needles_mat(name, tone=0):
    dark, mid, light = [
        ((0.02, 0.12, 0.05), (0.07, 0.28, 0.1), (0.2, 0.46, 0.16)),
        ((0.03, 0.14, 0.06), (0.1, 0.32, 0.12), (0.26, 0.52, 0.2)),
        ((0.02, 0.1, 0.06), (0.06, 0.24, 0.12), (0.16, 0.4, 0.2)),
    ][tone % 3]
    return lib.mat_leaves(name, dark, mid, light, scale=22)


def leaves_mat(name, tone=0):
    dark, mid, light = [
        ((0.04, 0.16, 0.03), (0.13, 0.4, 0.07), (0.4, 0.66, 0.16)),
        ((0.06, 0.18, 0.03), (0.2, 0.46, 0.08), (0.52, 0.72, 0.2)),
        ((0.05, 0.15, 0.04), (0.16, 0.36, 0.08), (0.44, 0.58, 0.14)),
    ][tone % 3]
    return lib.mat_leaves(name, dark, mid, light)


def build_conifer(variant):
    """A fir: a straight dark trunk under tiers of drooping branches that narrow to a pointed top.
    Each tier is a skirt of many small needle clumps hanging down at its rim, so light catches the
    individual branch tips and the gaps between tiers stay dark."""
    rnd = random.Random(100 + variant)
    height = (1.45, 1.25, 1.6)[variant % 3]
    width = (0.4, 0.46, 0.34)[variant % 3]
    tiers = (6, 5, 7)[variant % 3]
    bark = bark_mat()
    needles = needles_mat(f'needles{variant}', variant)
    lib.cylinder((0, 0, height * 0.35), 0.06, height * 0.7, bark, radius2=0.025, verts=10)
    base = 0.28
    for t in range(tiers):
        f = t / (tiers - 1)
        z = base + (height - base - 0.05) * f
        r = width * (1 - 0.82 * f) + 0.05
        # The tier's body: a low cone, dark inside.
        lib.cylinder((0, 0, z + 0.05), r * 0.82, 0.16 * (1 - 0.4 * f), needles, radius2=r * 0.15, verts=12)
        # Its drooping rim: clumps round the edge, hanging a little lower than the body.
        clumps = max(6, int(22 * r / width))
        for k in range(clumps):
            a = k / clumps * math.tau + rnd.uniform(-0.15, 0.15)
            rr = r * rnd.uniform(0.82, 1.02)
            leaf = lib.lumpy((math.cos(a) * rr, math.sin(a) * rr, z - 0.02 + rnd.uniform(-0.02, 0.02)),
                             rnd.uniform(0.05, 0.075) * (1 - 0.3 * f), needles, scale=(1.3, 1.3, 0.55),
                             strength=0.5, noise=0.4, seed=k + 31 * t, subdiv=1, flat=True)
            leaf.rotation_euler = (math.sin(a) * 0.5, -math.cos(a) * 0.5, a)
    lib.lumpy((0, 0, height + 0.02), 0.05, needles, scale=(0.7, 0.7, 1.6), strength=0.3, noise=0.5, seed=7, subdiv=1)


def build_broadleaf(variant):
    """A deciduous tree: a crooked, lighter trunk with a few limbs, roots at the foot, and a crown of
    many leaf clusters over an uneven ellipsoid (variant: size, shape and tone)."""
    rnd = random.Random(200 + variant)
    bark = bark_mat('bark_light', light=True)
    foliage = leaves_mat(f'leaves{variant}', variant)
    cz, crx, cry, crz = [(0.92, 0.42, 0.42, 0.34), (0.86, 0.46, 0.38, 0.3), (1.0, 0.36, 0.38, 0.4)][variant % 3]
    lib.cylinder((0, 0, 0.06), 0.11, 0.12, bark, radius2=0.075, verts=12)
    lib.cylinder((0.01, 0, 0.32), 0.075, 0.44, bark, radius2=0.05, verts=12, rot=(0.08 * (variant - 1), 0.06, 0))
    for a in (0.3, 1.9, 3.6, 5.0):  # roots
        lib.cylinder((math.cos(a) * 0.09, math.sin(a) * 0.09, 0.03), 0.03, 0.16, bark, radius2=0.01,
                     rot=(math.sin(a) * -1.3, math.cos(a) * 1.3, 0), verts=6)
    for a, z, length in ((0.5, 0.5, 0.32), (2.4, 0.56, 0.3), (4.2, 0.52, 0.3), (5.6, 0.62, 0.26)):
        lib.cylinder((math.cos(a) * 0.09, math.sin(a) * 0.09, z + 0.08), 0.03, length, bark, radius2=0.015,
                     rot=(math.sin(a) * -0.8, math.cos(a) * 0.8, 0), verts=8)
    for k in range(140):
        u = rnd.uniform(0, math.tau)
        v = rnd.uniform(-0.55, 1.0)
        rr = math.sqrt(max(0.0, 1 - v * v)) * rnd.uniform(0.8, 1.08)
        leaf = lib.lumpy((math.cos(u) * rr * crx, math.sin(u) * rr * cry, cz + v * crz), rnd.uniform(0.045, 0.075),
                         foliage, scale=(1, 1, 0.7), strength=0.5, noise=0.3, seed=k, subdiv=1, flat=True)
        leaf.rotation_euler = (rnd.uniform(0, 3), rnd.uniform(0, 3), rnd.uniform(0, 3))
    lib.lumpy((0, 0, cz), min(crx, cry) * 0.86, foliage, scale=(crx / min(crx, cry), cry / min(crx, cry), 0.9),
              strength=0.3, noise=0.5, seed=99 + variant)


# ------------------------------------------------------------------------------------- ground props

def build_tuft(variant):
    """A clump of tall grass: thin blades fanning out, yellow-green tips."""
    rnd = random.Random(300 + variant)
    blade = lib.mat_grain(f'blade{variant}', (0.42, 0.6, 0.12), (0.82, 0.82, 0.32), scale=8, stretch=(1, 1, 4), bump=0.2)
    for k in range(22 + 8 * variant):
        a = rnd.uniform(0, math.tau)
        lean = rnd.uniform(0.15, 0.7)
        h = rnd.uniform(0.18, 0.3)
        d = rnd.uniform(0, 0.06)
        lib.box((math.cos(a) * d, math.sin(a) * d, h / 2), (0.02, 0.006, h), blade,
                rot=(math.sin(a) * lean, -math.cos(a) * lean, a))


def build_flowers(variant):
    """A few flowering stems in a small leafy clump (white or yellow heads, or violet bells)."""
    rnd = random.Random(400 + variant)
    stem = lib.mat_flat('stem', (0.22, 0.42, 0.1))
    head = lib.mat_flat(f'petals{variant}', [(0.95, 0.95, 0.88), (0.98, 0.82, 0.2), (0.66, 0.42, 0.86)][variant % 3], rough=0.5)
    heart = lib.mat_flat('heart', (0.9, 0.7, 0.1))
    leaves = leaves_mat('flowerleaves', 1)
    lib.lumpy((0, 0, 0.02), 0.06, leaves, scale=(1.2, 1.2, 0.5), strength=0.5, noise=0.6, seed=variant, subdiv=1, flat=True)
    for k in range(5):
        a = rnd.uniform(0, math.tau)
        d = rnd.uniform(0.01, 0.06)
        h = rnd.uniform(0.08, 0.15)
        x, y = math.cos(a) * d, math.sin(a) * d
        lib.cylinder((x, y, h / 2), 0.005, h, stem, verts=5)
        lib.sphere((x, y, h + 0.01), 0.022, head, scale=(1, 1, 0.55), subdiv=1)
        lib.sphere((x, y, h + 0.02), 0.008, heart, subdiv=1)


def build_mushrooms(variant=0):
    """A small group of red-capped mushrooms with pale spots."""
    rnd = random.Random(500 + variant)
    stalk = lib.mat_flat('stalk', (0.92, 0.88, 0.8))
    cap = lib.mat_flat('cap', (0.78, 0.12, 0.08), rough=0.4)
    spot = lib.mat_flat('spot', (0.97, 0.95, 0.9))
    for k, (x, y, s) in enumerate(((0, 0, 1.0), (0.06, 0.04, 0.7), (-0.05, 0.05, 0.55))):
        h = 0.07 * s
        lib.cylinder((x, y, h / 2), 0.012 * s, h, stalk, verts=8)
        lib.sphere((x, y, h), 0.04 * s, cap, scale=(1, 1, 0.55), subdiv=2)
        for j in range(3):
            a = rnd.uniform(0, math.tau)
            lib.sphere((x + math.cos(a) * 0.022 * s, y + math.sin(a) * 0.022 * s, h + 0.012 * s), 0.007 * s, spot, subdiv=1)


def build_stones(variant=0):
    """A few weathered field stones half sunk into the grass."""
    rnd = random.Random(600 + variant)
    rock = lib.mat_grain('fieldstone', (0.46, 0.44, 0.4), (0.74, 0.72, 0.66), scale=9, stretch=(1, 1, 1), bump=1.0)
    for k in range(3):
        a = rnd.uniform(0, math.tau)
        d = rnd.uniform(0, 0.06)
        lib.lumpy((math.cos(a) * d, math.sin(a) * d, 0.01), rnd.uniform(0.03, 0.05), rock, scale=(1.3, 1.0, 0.6),
                  strength=0.5, noise=0.9, seed=k, subdiv=2, flat=True)


def build_meadow_flowers(variant):
    """Meadow flowers of other kinds: red poppies with dark hearts (0), blue cornflowers (1), white
    daisies with yellow hearts (2) — more, smaller heads on thin stems over a few grass blades."""
    rnd = random.Random(700 + variant)
    stem = lib.mat_flat('stem2', (0.26, 0.46, 0.12))
    petal = lib.mat_flat(f'meadow{variant}', [(0.86, 0.1, 0.06), (0.28, 0.42, 0.92), (0.97, 0.97, 0.94)][variant % 3], rough=0.5)
    heart = lib.mat_flat(f'meadowheart{variant}', [(0.12, 0.06, 0.05), (0.18, 0.2, 0.5), (0.95, 0.75, 0.1)][variant % 3])
    blade = lib.mat_grain('blade-m', (0.36, 0.56, 0.12), (0.7, 0.78, 0.28), scale=8, stretch=(1, 1, 4), bump=0.2)
    for k in range(8):
        a = rnd.uniform(0, math.tau)
        h = rnd.uniform(0.07, 0.13)
        lib.box((math.cos(a) * 0.03, math.sin(a) * 0.03, h / 2), (0.016, 0.005, h), blade,
                rot=(math.sin(a) * 0.5, -math.cos(a) * 0.5, a))
    for k in range(7):
        a = rnd.uniform(0, math.tau)
        d = rnd.uniform(0.0, 0.075)
        h = rnd.uniform(0.09, 0.17)
        x, y = math.cos(a) * d, math.sin(a) * d
        lib.cylinder((x, y, h / 2), 0.004, h, stem, verts=5)
        lib.sphere((x, y, h + 0.008), 0.018, petal, scale=(1, 1, 0.4 if variant != 1 else 0.7), subdiv=1)
        lib.sphere((x, y, h + 0.015), 0.007, heart, subdiv=1)


def build_fern(variant):
    """A fern: arching fronds from one crown, each a midrib with paired leaflets shrinking to the tip."""
    rnd = random.Random(800 + variant)
    frond = lib.mat_leaves(f'fern{variant}', (0.03, 0.14, 0.03), (0.12, 0.38, 0.08), (0.36, 0.6, 0.14), scale=30)
    count = (7, 9)[variant % 2]
    length = (0.2, 0.24)[variant % 2]
    for k in range(count):
        a = k / count * math.tau + rnd.uniform(-0.2, 0.2)
        rise = rnd.uniform(0.5, 0.8)  # how steeply the frond starts up
        seg = 7
        for j in range(seg):
            t = (j + 0.5) / seg
            r = length * t
            z = 0.02 + length * (rise * t - 0.75 * t * t)  # up, then arching over
            x, y = math.cos(a) * r, math.sin(a) * r
            size = 0.05 * (1 - 0.75 * t)
            slope = math.atan(rise - 1.5 * t)
            for side in (-1, 1):
                ox, oy = -math.sin(a) * side * size * 0.45, math.cos(a) * side * size * 0.45
                lib.box((x + ox, y + oy, z), (size * 0.38, size, 0.004), frond,
                        rot=(side * 0.35, -slope, a))


def build_bush(variant):
    """A low leafy shrub of clustered leaves over a dark core; variant 1 bears red berries."""
    rnd = random.Random(900 + variant)
    foliage = leaves_mat(f'bush{variant}', variant + 1)
    rx, ry, rz = [(0.2, 0.17, 0.15), (0.17, 0.2, 0.17)][variant % 2]
    lib.lumpy((0, 0, rz * 0.8), min(rx, ry) * 0.8, foliage, scale=(rx / min(rx, ry), ry / min(rx, ry), rz / min(rx, ry)),
              strength=0.35, noise=0.6, seed=40 + variant)
    for k in range(60):
        u = rnd.uniform(0, math.tau)
        v = rnd.uniform(-0.3, 1.0)
        rr = math.sqrt(max(0.0, 1 - v * v)) * rnd.uniform(0.85, 1.08)
        leaf = lib.lumpy((math.cos(u) * rr * rx, math.sin(u) * rr * ry, rz * (0.85 + v * 0.95)), rnd.uniform(0.03, 0.05),
                         foliage, scale=(1, 1, 0.7), strength=0.5, noise=0.3, seed=k, subdiv=1, flat=True)
        leaf.rotation_euler = (rnd.uniform(0, 3), rnd.uniform(0, 3), rnd.uniform(0, 3))
    if variant % 2:
        berry = lib.mat_flat('berry', (0.72, 0.05, 0.06), rough=0.3)
        for k in range(16):
            u = rnd.uniform(0, math.tau)
            v = rnd.uniform(0.0, 0.9)
            rr = math.sqrt(max(0.0, 1 - v * v)) * 1.06
            lib.sphere((math.cos(u) * rr * rx, math.sin(u) * rr * ry, rz * (0.85 + v * 0.95)), 0.014, berry, subdiv=1)


def build_boletes(variant=0):
    """Brown-capped boletes, stout pale stalks (variant 0); a ring of small pale caps (variant 1)."""
    rnd = random.Random(1000 + variant)
    if variant == 0:
        stalk = lib.mat_grain('bolete-stalk', (0.78, 0.72, 0.6), (0.93, 0.89, 0.8), scale=12, stretch=(1, 1, 3), bump=0.3)
        cap = lib.mat_grain('bolete-cap', (0.36, 0.2, 0.09), (0.56, 0.34, 0.16), scale=9, stretch=(1, 1, 1), bump=0.3)
        for x, y, s in ((0, 0, 1.0), (0.055, -0.03, 0.75), (-0.04, 0.05, 0.6)):
            h = 0.06 * s
            lib.cylinder((x, y, h / 2), 0.02 * s, h, stalk, radius2=0.014 * s, verts=10)
            lib.sphere((x, y, h + 0.005), 0.045 * s, cap, scale=(1, 1, 0.6), subdiv=2)
        return
    stalk = lib.mat_flat('small-stalk', (0.94, 0.92, 0.86))
    cap = lib.mat_flat('small-cap', (0.88, 0.8, 0.62), rough=0.5)
    for k in range(7):
        a = k / 7 * math.tau + rnd.uniform(-0.2, 0.2)
        r = rnd.uniform(0.06, 0.08)
        s = rnd.uniform(0.6, 1.0)
        x, y = math.cos(a) * r, math.sin(a) * r
        h = 0.04 * s
        lib.cylinder((x, y, h / 2), 0.006 * s, h, stalk, verts=6)
        lib.sphere((x, y, h), 0.02 * s, cap, scale=(1, 1, 0.6), subdiv=1)


#: Bigger canvas for the shrubs (logical w, h, anchor x, y).
BUSH = (52, 44, 26, 30)

#: Name → (builder, canvas). Trees 0–2 are conifers, 3–5 broadleaf trees.
TREES = {
    'tree0': (lambda: build_conifer(0), TREE),
    'tree1': (lambda: build_conifer(1), TREE),
    'tree2': (lambda: build_conifer(2), TREE),
    'tree3': (lambda: build_broadleaf(0), TREE),
    'tree4': (lambda: build_broadleaf(1), TREE),
    'tree5': (lambda: build_broadleaf(2), TREE),
}
PROPS = {
    'prop-tuft0': (lambda: build_tuft(0), PROP),
    'prop-tuft1': (lambda: build_tuft(1), PROP),
    'prop-flowers0': (lambda: build_flowers(0), PROP),
    'prop-flowers1': (lambda: build_flowers(1), PROP),
    'prop-flowers2': (lambda: build_flowers(2), PROP),
    'prop-mushrooms': (lambda: build_mushrooms(0), PROP),
    'prop-stones': (lambda: build_stones(0), PROP),
    'prop-poppies': (lambda: build_meadow_flowers(0), PROP),
    'prop-cornflowers': (lambda: build_meadow_flowers(1), PROP),
    'prop-daisies': (lambda: build_meadow_flowers(2), PROP),
    'prop-boletes': (lambda: build_boletes(0), PROP),
    'prop-ring': (lambda: build_boletes(1), PROP),
    'prop-fern0': (lambda: build_fern(0), PROP),
    'prop-fern1': (lambda: build_fern(1), PROP),
    'prop-bush0': (lambda: build_bush(0), BUSH),
    'prop-bush1': (lambda: build_bush(1), BUSH),
}
#: For build.py's `SINGLE` table: name → (builder, w, h, ax, ay).
SINGLE = {name: (build, *canvas) for name, (build, canvas) in {**TREES, **PROPS}.items()}
