"""Mountain rocks: loose stones for walkable slopes, boulders, and craggy outcrops for the impassable
peaks (docs/ART-STYLE.md «Горы»). Our own models in the spirit of Settlers 4 mountains.

Each rock is a few faceted blocks — convex hulls of points scattered over a squashed ellipsoid,
bevelled so the edges catch the light — sunk a little below the ground plane (the shadow catcher hides
what is under it, so they sit in the ground instead of on it). The material follows the palette of the
`mountain` and `rock` ground textures (art/textures/ground.py): grey-brown stone with darker strata,
dark cracks, and olive lichen on the upward faces. The renderer (`placeBoulders` in renderer.ts) places
them: outcrops (2×2 tiles) and boulders on rock, odd small stones on slopes.

Registered through `SINGLE` (merged into build.py's table); `art3d.ts` lists the same names and
canvases (`ART3D_ROCKS`). Render with `npm run art:render -- rocks` (CPU), then quantise.
"""

import math
import random

import bmesh
import bpy

import lib

#: Canvases (logical w, h, anchor x, y). The anchor is the rock's centre on the ground: a small
#: stone's tile centre, a large outcrop's 2×2 footprint centre.
SMALL = (52, 36, 24, 22)
MEDIUM = (88, 72, 40, 48)
LARGE = (192, 150, 90, 104)


def mat_rock(name, light, mid, dark, crack, lichen=(0.5, 0.52, 0.26), moss=0.35, scale=4.0):
    """Weathered mountain stone: noisy tone over faint strata, dark cracks (Voronoi edges), and olive
    lichen on faces that look up."""
    mat, nodes, links, bsdf = lib._principled(name)
    bsdf.inputs['Roughness'].default_value = 0.9
    coord = nodes.new('ShaderNodeTexCoord')
    noise = nodes.new('ShaderNodeTexNoise')
    noise.inputs['Scale'].default_value = scale
    noise.inputs['Detail'].default_value = 8
    noise.inputs['Roughness'].default_value = 0.6
    links.new(coord.outputs['Object'], noise.inputs['Vector'])
    # Strata: soft bands along the height, warped by the noise.
    wave = nodes.new('ShaderNodeTexWave')
    wave.wave_type = 'BANDS'
    wave.bands_direction = 'Z'
    wave.inputs['Scale'].default_value = scale * 0.6
    wave.inputs['Distortion'].default_value = 7.0
    wave.inputs['Detail'].default_value = 2.0
    links.new(coord.outputs['Object'], wave.inputs['Vector'])
    tone = nodes.new('ShaderNodeMath')
    tone.operation = 'MULTIPLY_ADD'
    tone.inputs[1].default_value = 0.1
    links.new(wave.outputs['Fac'], tone.inputs[0])
    links.new(noise.outputs['Fac'], tone.inputs[2])
    stone = lib._ramp(nodes, [(0.32, dark), (0.58, mid), (0.82, light)])
    links.new(tone.outputs['Value'], stone.inputs['Fac'])
    # Cracks.
    vor = nodes.new('ShaderNodeTexVoronoi')
    vor.feature = 'DISTANCE_TO_EDGE'
    vor.inputs['Scale'].default_value = scale * 0.7
    links.new(coord.outputs['Object'], vor.inputs['Vector'])
    cr = nodes.new('ShaderNodeMapRange')
    cr.inputs['From Min'].default_value = 0.0
    cr.inputs['From Max'].default_value = 0.025
    links.new(vor.outputs['Distance'], cr.inputs['Value'])
    cracked = nodes.new('ShaderNodeMix')
    cracked.data_type = 'RGBA'
    cracked.inputs['A'].default_value = (*lib.lin(crack), 1)
    # Only some seams open into cracks (where a coarse noise is high), the rest of the stone is whole:
    # a full Voronoi net reads as masonry, not rock.
    gaps = nodes.new('ShaderNodeTexNoise')
    gaps.inputs['Scale'].default_value = scale * 0.8
    links.new(coord.outputs['Object'], gaps.inputs['Vector'])
    open_ = nodes.new('ShaderNodeMapRange')
    open_.inputs['From Min'].default_value = 0.5
    open_.inputs['From Max'].default_value = 0.58
    open_.inputs['To Min'].default_value = 1.0
    open_.inputs['To Max'].default_value = 0.0
    links.new(gaps.outputs['Fac'], open_.inputs['Value'])
    shut = nodes.new('ShaderNodeMath')
    shut.operation = 'MAXIMUM'
    links.new(cr.outputs['Result'], shut.inputs[0])
    links.new(open_.outputs['Result'], shut.inputs[1])
    links.new(shut.outputs['Value'], cracked.inputs['Factor'])
    links.new(stone.outputs['Color'], cracked.inputs['B'])
    # Lichen where the surface faces up, in blotches.
    geo = nodes.new('ShaderNodeNewGeometry')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(geo.outputs['Normal'], sep.inputs['Vector'])
    up = nodes.new('ShaderNodeMapRange')
    up.inputs['From Min'].default_value = 0.45
    up.inputs['From Max'].default_value = 0.95
    links.new(sep.outputs['Z'], up.inputs['Value'])
    blot = nodes.new('ShaderNodeTexNoise')
    blot.inputs['Scale'].default_value = scale * 3
    blot.inputs['Detail'].default_value = 6
    links.new(coord.outputs['Object'], blot.inputs['Vector'])
    blots = nodes.new('ShaderNodeMapRange')
    blots.inputs['From Min'].default_value = 0.5
    blots.inputs['From Max'].default_value = 0.62
    links.new(blot.outputs['Fac'], blots.inputs['Value'])
    cover = nodes.new('ShaderNodeMath')
    cover.operation = 'MULTIPLY'
    links.new(up.outputs['Result'], cover.inputs[0])
    links.new(blots.outputs['Result'], cover.inputs[1])
    amount = nodes.new('ShaderNodeMath')
    amount.operation = 'MULTIPLY'
    amount.inputs[1].default_value = moss
    links.new(cover.outputs['Value'], amount.inputs[0])
    mossy = nodes.new('ShaderNodeMix')
    mossy.data_type = 'RGBA'
    mossy.inputs['B'].default_value = (*lib.lin(lichen), 1)
    links.new(amount.outputs['Value'], mossy.inputs['Factor'])
    links.new(cracked.outputs['Result'], mossy.inputs['A'])
    links.new(mossy.outputs['Result'], bsdf.inputs['Base Color'])
    # Cracks sink in, the noise roughens the faces.
    bump_h = nodes.new('ShaderNodeMath')
    bump_h.operation = 'MULTIPLY_ADD'
    bump_h.inputs[1].default_value = 0.35
    links.new(noise.outputs['Fac'], bump_h.inputs[0])
    links.new(shut.outputs['Value'], bump_h.inputs[2])
    lib._bump(nodes, links, bsdf, bump_h.outputs['Value'], strength=0.7)
    return mat


def slope_mat():
    """Warm grey-brown slope stone (the `mountain` ground texture)."""
    return mat_rock('slope', (0.78, 0.73, 0.64), (0.56, 0.52, 0.45), (0.32, 0.3, 0.26), (0.14, 0.13, 0.11))


def peak_mat():
    """Paler, cooler peak stone (the `rock` ground texture), a little lichen."""
    return mat_rock('peak', (0.9, 0.88, 0.83), (0.64, 0.62, 0.58), (0.36, 0.35, 0.33), (0.16, 0.15, 0.14),
                    moss=0.45)


def dim_sky(strength=0.16):
    """Less sky light than the buildings get, so the faces turned from the sun fall into shade and
    the facets read (the pale stone would otherwise go flat)."""
    bpy.context.scene.world.node_tree.nodes['Background'].inputs['Strength'].default_value = strength


def block(loc, size, mat, seed, rot=(0.0, 0.0, 0.0), points=12, top_cut=0.0, bevel=0.012, boxy=0.6):
    """A faceted rock: the convex hull of points over a squashed box-ish ellipsoid of half sizes
    `size` (`boxy` 0 = round, 1 = corners of a box: blocky crags with flat faces), its top optionally
    sliced at a slant (`top_cut`: fraction of the height cut off), edges bevelled."""
    rnd = random.Random(seed)
    sx, sy, sz = size
    pts = []
    for k in range(points):
        u = rnd.uniform(-1, 1)
        a = rnd.uniform(0, math.tau)
        r = math.sqrt(1 - u * u)
        x, y, z = math.cos(a) * r, math.sin(a) * r, u
        # Push towards the box corner of that octant.
        m = max(abs(x), abs(y), abs(z), 1e-6)
        x, y, z = (x * (1 - boxy) + x / m * boxy * 0.82, y * (1 - boxy) + y / m * boxy * 0.82, z * (1 - boxy) + z / m * boxy * 0.82)
        j = rnd.uniform(0.78, 1.0)
        x, y, z = x * sx * j, y * sy * j, z * sz * j
        if top_cut > 0:
            z = min(z, sz * (1 - top_cut) + x * 0.35 + y * 0.2)
        pts.append((x, y, z))
    bm = bmesh.new()
    verts = [bm.verts.new(p) for p in pts]
    bmesh.ops.convex_hull(bm, input=verts)
    loose = [v for v in bm.verts if not v.link_faces]
    bmesh.ops.delete(bm, geom=loose, context='VERTS')
    mesh = bpy.data.meshes.new('rock')
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new('rock', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = loc
    obj.rotation_euler = rot
    obj.data.materials.append(mat)
    if bevel > 0:
        mod = obj.modifiers.new('Bevel', 'BEVEL')
        mod.width = bevel
        mod.segments = 1
        mod.limit_method = 'ANGLE'
        mod.angle_limit = math.radians(25)
    return obj


def rubble(rnd, mat, cx, cy, radius, count, size=(0.03, 0.06), seed=0):
    """Small stones scattered round a point, half sunk."""
    for k in range(count):
        a = rnd.uniform(0, math.tau)
        d = radius * math.sqrt(rnd.uniform(0.3, 1.0))
        s = rnd.uniform(*size)
        block((cx + math.cos(a) * d, cy + math.sin(a) * d, s * 0.25), (s * 1.2, s, s * 0.75), mat, seed * 100 + k,
              rot=(0, 0, rnd.uniform(0, math.pi)), points=10, bevel=0.005)


# ------------------------------------------------------------------------------------------- shapes

def build_small(variant):
    """Two to four loose stones on a slope, within about a third of a tile."""
    dim_sky()
    rnd = random.Random(700 + variant)
    mat = slope_mat()
    n = (2, 3, 4, 3)[variant % 4]
    for k in range(n):
        a = rnd.uniform(0, math.tau)
        d = 0.0 if k == 0 else rnd.uniform(0.12, 0.26)
        s = (0.19 if k == 0 else 0.1) * rnd.uniform(0.85, 1.2)
        block((math.cos(a) * d, math.sin(a) * d, s * 0.3), (s * 1.25, s, s * 0.8), mat, 700 + variant * 10 + k,
              rot=(rnd.uniform(-0.2, 0.2), rnd.uniform(-0.2, 0.2), rnd.uniform(0, math.pi)), points=12, bevel=0.008)


def build_medium(variant):
    """A boulder over half a tile across with a smaller stone or two leaning on it, and a few stones
    at its foot."""
    dim_sky()
    rnd = random.Random(800 + variant)
    mat = peak_mat()
    h = (0.38, 0.3, 0.46)[variant % 3]
    block((0, 0.02, h * 0.6), (0.38, 0.3, h), mat, 800 + variant, rot=(rnd.uniform(-0.15, 0.15), 0.12, rnd.uniform(0, 3)),
          top_cut=0.25 if variant != 1 else 0.0, bevel=0.02, points=14)
    if variant == 0:
        block((0.3, -0.18, 0.12), (0.2, 0.16, 0.18), mat, 811, rot=(0.3, -0.2, 0.6), bevel=0.012)
    elif variant == 1:
        block((-0.26, 0.18, 0.15), (0.24, 0.2, 0.24), mat, 812, rot=(0.0, 0.25, 1.2), top_cut=0.2, bevel=0.015)
        block((0.27, 0.14, 0.08), (0.14, 0.12, 0.12), mat, 813, rot=(0, 0, 0.4), bevel=0.01)
    else:
        block((0.08, 0.3, 0.18), (0.2, 0.18, 0.28), mat, 814, rot=(0.25, 0.1, 2.0), bevel=0.015)
    rubble(rnd, mat, 0.0, -0.08, 0.5, 5, size=(0.04, 0.08), seed=80 + variant)


#: Outcrop shapes (2×2 tiles; world units from the centre, ±1 is the area's edge): how far the blocks
#: spread, the height of the tallest, how many blocks.
OUTCROPS = [
    (0.8, 1.15, 10),   # a crag with shoulders
    (1.0, 0.8, 12),    # a broad, stepped ridge
    (0.65, 1.4, 9),    # a tall, narrow tor
    (1.0, 0.68, 13),   # a low knoll of cracked blocks
]


def build_large(variant):
    """A craggy outcrop over a 2×2 tile area: a cluster of overlapping angular blocks — tallest at the
    back and in the middle, lower towards the edges and the front — whose slanted tops lean the same
    way, so they read as one layered mass split by clefts; sunk into the ground, scree at the foot."""
    dim_sky()
    rnd = random.Random(900 + variant)
    mat = peak_mat()
    spread, height, n = OUTCROPS[variant % len(OUTCROPS)]
    lean = rnd.uniform(0, math.tau)
    tilt = 0.16
    for k in range(n):
        # The first blocks make the core; later ones sit further out.
        a = rnd.uniform(0, math.tau)
        d = spread * math.sqrt(rnd.uniform(0.2, 1)) * (0.35 + 0.65 * k / max(1, n - 1))
        x, y = math.cos(a) * d, math.sin(a) * d
        back = (-x + y) / math.sqrt(2) / max(spread, 0.01)  # +1 at the back, −1 towards the camera
        h = height * (0.45 + 0.55 * (1 - d / spread)) * (0.85 + 0.2 * back) * rnd.uniform(0.85, 1.12)
        sx, sy = rnd.uniform(0.32, 0.5), rnd.uniform(0.28, 0.42)
        rot = (math.cos(lean) * tilt, math.sin(lean) * tilt, rnd.uniform(0, math.pi))
        block((x, y, h * 0.5), (sx, sy, h), mat, 900 + variant * 20 + k, rot=rot, points=11,
              top_cut=rnd.uniform(0.15, 0.3), bevel=0.02, boxy=0.85)
    rubble(rnd, mat, 0.1, -0.15, spread + 0.4, 16, size=(0.04, 0.1), seed=90 + variant)


SMALLS = {f'rock-small{v}': (lambda v=v: build_small(v), SMALL) for v in range(4)}
MEDIUMS = {f'rock-medium{v}': (lambda v=v: build_medium(v), MEDIUM) for v in range(3)}
LARGES = {f'rock-large{v}': (lambda v=v: build_large(v), LARGE) for v in range(4)}
ROCKS = {**SMALLS, **MEDIUMS, **LARGES}
#: For build.py's `SINGLE` table: name → (builder, w, h, ax, ay).
SINGLE = {name: (build, *canvas) for name, (build, canvas) in ROCKS.items()}
