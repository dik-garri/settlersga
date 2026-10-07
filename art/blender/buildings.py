"""Settlers 4 style models of the starting buildings: sawmill, stonecutter, small tower, large house.

Each is tagged with construction stages like the woodcutter (`lib.tag`): 0 stakes on cleared earth,
1 frame or foundation, 2 lower walls, 3 walls and half the roof, 4 finished. Goods are never part of
a model (the game draws the real piles at the door).

World X is tile x, world Y is minus tile y; a 2×2 footprint spans ±1 around the origin and its door
tile is at (0.5, −1.5), a 3×3 one spans ±1.5 with the door at (1, −2). The camera sees the −Y and +X
walls, so doors go on the −Y wall.

The shared helpers (log walls, board roofs, stakes, timber frames, materials) live in build.py, the
script Blender runs; they are reached through `__main__` at call time.
"""

import math
import random

import bpy

import lib

# Screen-space point (relative to the sprite anchor) where a building's banner pole stands, filled in
# while rendering so the game can put the owner's banner on the 3D model (art3d.ts copies it).
BANNER_AT = {}


def note_banner(name, point):
    """Records (and prints) where the banner pole stands, in sprite pixels from the anchor."""
    scene = bpy.context.scene
    sx, sy = lib.screen_point(scene, point)
    cam = scene.camera.data
    w = scene.render.resolution_x / lib.RESOLUTION
    h = scene.render.resolution_y / lib.RESOLUTION
    # Anchor = where the world origin lands.
    ox, oy = lib.screen_point(scene, (0, 0, 0))
    BANNER_AT[name] = (round(sx - ox, 1), round(sy - oy, 1))
    print('banner', name, BANNER_AT[name], 'sprite', w, h, cam.type)


def _b():
    import __main__

    return __main__


# ------------------------------------------------------------------------------------- materials

def stone_walls(name='walls'):
    """The wall core showing between the blocks: dark mortar and shadowed stone."""
    return lib.mat_stones(name, (0.42, 0.41, 0.4), (0.24, 0.24, 0.25), (0.08, 0.08, 0.08), scale=9, bump=0.9)


def block_mats(prefix='blocks'):
    """Rough stone blocks in a few tones, so masonry reads as separate stones, not tiles."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=7, stretch=(1, 1, 1), bump=1.0) for k, (a, b) in enumerate((
        ((0.5, 0.49, 0.46), (0.86, 0.84, 0.78)),
        ((0.42, 0.42, 0.41), (0.72, 0.71, 0.68)),
        ((0.58, 0.55, 0.48), (0.92, 0.88, 0.78)),
        ((0.36, 0.36, 0.36), (0.62, 0.62, 0.6)),
    ))]


def earth_pad(loc, hx, hy, seed=5):
    mat = lib.mat_grain('earth', (0.34, 0.18, 0.09), (0.66, 0.42, 0.22), scale=16, stretch=(1, 1, 1), bump=1.0,
                        detail=12)
    lib.pad(loc, hx, hy, mat, jitter=0.1, seed=seed)


def boards_mats():
    return [
        lib.mat_grain(f'board{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.6)
        for k, (a, b) in enumerate((
            ((0.5, 0.34, 0.12), (0.76, 0.58, 0.26)),
            ((0.38, 0.24, 0.1), (0.6, 0.42, 0.18)),
            ((0.62, 0.46, 0.2), (0.84, 0.68, 0.36)),
            ((0.44, 0.36, 0.22), (0.62, 0.52, 0.34)),
        ))
    ]


def logs_mat():
    return lib.mat_grain('logs', (0.36, 0.18, 0.08), (0.62, 0.36, 0.17), scale=7, stretch=(1, 1, 6), bump=1.0)


def ends_mat():
    return lib.mat_grain('ends', (0.82, 0.6, 0.32), (0.93, 0.76, 0.48), scale=30, stretch=(1, 1, 1), bump=0.4)


def beam_mat():
    return lib.mat_grain('beam', (0.3, 0.16, 0.07), (0.46, 0.26, 0.12), scale=5, stretch=(1, 1, 8), bump=0.6)


# ------------------------------------------------------------------------------------- pieces

def torus(loc, major, minor, mat, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=major, minor_radius=minor, major_segments=32, minor_segments=8,
                                     location=loc, rotation=rot)
    obj = bpy.context.active_object
    obj.data.materials.append(mat)
    bpy.ops.object.shade_smooth()
    return obj


def stone_course(x0, x1, y0, y1, z0, z1, mats, rnd, block=0.16, depth=0.05):
    """Rugged blocks proud of a wall's two visible faces (−Y and +X), between heights z0 and z1: the
    lumpy masonry of Settlers 4 stone buildings. Every block gets its own tone, size, depth and
    tilt, with dark gaps between them."""
    if not isinstance(mats, list):
        mats = [mats]
    rows = max(1, round((z1 - z0) / (block * 0.7)))
    h = (z1 - z0) / rows

    def one(loc, size, rot):
        lib.box(loc, size, mats[rnd.randrange(len(mats))], rot=rot, bevel=0.02)

    for r in range(rows):
        z = z0 + (r + 0.5) * h
        shift = (r % 2) * block / 2
        x = x0 - shift
        while x < x1:
            w = min(block * rnd.uniform(0.65, 1.35), x1 - x)
            if w > 0.04:
                d = depth * rnd.uniform(0.6, 1.4)
                one((x + w / 2, y0 - d / 2, z + rnd.uniform(-0.01, 0.01)), (w - 0.035, d, h * rnd.uniform(0.74, 0.88)),
                    (rnd.uniform(-0.06, 0.06), rnd.uniform(-0.08, 0.08), rnd.uniform(-0.05, 0.05)))
            x += w
        y = y0 - shift
        while y < y1:
            w = min(block * rnd.uniform(0.65, 1.35), y1 - y)
            if w > 0.04:
                d = depth * rnd.uniform(0.6, 1.4)
                one((x1 + d / 2, y + w / 2, z + rnd.uniform(-0.01, 0.01)), (d, w - 0.035, h * rnd.uniform(0.74, 0.88)),
                    (rnd.uniform(-0.08, 0.08), rnd.uniform(-0.06, 0.06), rnd.uniform(-0.05, 0.05)))
            y += w


def corner_stakes(x0, x1, y0, y1):
    _b().stakes([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], beam_mat(), lib.mat_flat('string', (0.92, 0.88, 0.75)))


def window(x, y, z, w, h, frame, dark, face='y'):
    if face == 'y':
        lib.box((x, y - 0.012, z), (w, 0.03, h), dark)
        lib.box((x, y - 0.025, z), (w + 0.05, 0.03, 0.03), frame)
        lib.box((x, y - 0.025, z - h / 2), (w + 0.06, 0.04, 0.03), frame)
        lib.box((x, y - 0.025, z + h / 2), (w + 0.06, 0.04, 0.03), frame)
    else:
        lib.box((x + 0.012, y, z), (0.03, w, h), dark)
        lib.box((x + 0.025, y, z), (0.03, w + 0.05, 0.03), frame)
        lib.box((x + 0.025, y, z - h / 2), (0.04, w + 0.06, 0.03), frame)
        lib.box((x + 0.025, y, z + h / 2), (0.04, w + 0.06, 0.03), frame)


# ------------------------------------------------------------------------------------- sawmill

def plank_walls(x0, x1, y0, y1, z0, z1, mats, core, post, rnd, board=0.085, faces=('y', 'x')):
    """Walls of horizontal dark planks on the visible faces (−Y, +X) over a core, with corner posts."""
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0), core)
    rows = max(1, round((z1 - z0) / board))
    h = (z1 - z0) / rows
    for r in range(rows):
        z = z0 + (r + 0.5) * h
        for face in faces:
            off = rnd.uniform(0.004, 0.012)
            if face == 'y':
                lib.box(((x0 + x1) / 2 + rnd.uniform(-0.01, 0.01), y0 - off, z), (x1 - x0 - 0.02, 0.022, h * 0.86),
                        mats[rnd.randrange(len(mats))], rot=(0, rnd.uniform(-0.015, 0.015), 0), bevel=0.004)
            else:
                lib.box((x1 + off, (y0 + y1) / 2 + rnd.uniform(-0.01, 0.01), z), (0.022, y1 - y0 - 0.02, h * 0.86),
                        mats[rnd.randrange(len(mats))], rot=(rnd.uniform(-0.015, 0.015), 0, 0), bevel=0.004)
    for (x, y) in ((x0, y0), (x1, y0), (x1, y1)):
        lib.box((x, y, (z0 + z1) / 2), (0.06, 0.06, z1 - z0 + 0.02), post, bevel=0.008)


def panel_slope(cx, y0, y1, xe, ze, xr, zr, frame, panels, iron, rnd, cols=2, rows=2):
    """One slope of a low roof (ridge along Y at (xr, zr), eave at (xe, ze)), made of square plank
    panels set in darker frames, with iron rivets at the panel corners."""
    from mathutils import Vector

    a = Vector((xr, 0, zr))
    b = Vector((xe, 0, ze))
    run = (b - a).length
    ang = math.atan2(ze - zr, xe - xr)
    mid = (a + b) / 2
    span = y1 - y0
    lib.box((mid.x, (y0 + y1) / 2, mid.z), (run, span, 0.035), frame, rot=(0, -ang, 0), bevel=0.006)
    n = Vector((-(ze - zr), 0, xe - xr)).normalized()
    if n.z < 0:
        n = -n
    for r in range(rows):
        for c in range(cols):
            t = (r + 0.5) / rows
            p = a + (b - a) * t + n * 0.028
            y = y0 + (c + 0.5) * span / cols
            lib.box((p.x, y, p.z), (run / rows * 0.78, span / cols * 0.8, 0.025), panels[rnd.randrange(len(panels))],
                    rot=(0, -ang, rnd.uniform(-0.02, 0.02)), bevel=0.005)
            for dt in (-0.33, 0.33):
                for dy in (-0.36, 0.36):
                    q = a + (b - a) * (t + dt / rows) + n * 0.05
                    lib.sphere((q.x, y + dy * span / cols, q.z), 0.016, iron, subdiv=2)


def build_sawmill():
    """After the Settlers 4 sawmill: all dark wood. A low front block with a door, under a low roof of
    square plank panels with rivets; behind it a taller block with two glass windows facing the
    camera and a nearly flat plank roof; on the right the great log drum (logs along its axis, bound
    by two iron hoops), its axis running towards the camera's lower right."""
    B = _b()
    logs, ends, beam = logs_mat(), ends_mat(), beam_mat()
    planks = [lib.mat_grain(f'swplank{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.7) for k, (a, b) in enumerate((
        ((0.3, 0.15, 0.06), (0.56, 0.33, 0.15)),
        ((0.36, 0.2, 0.08), (0.64, 0.4, 0.19)),
        ((0.26, 0.13, 0.05), (0.48, 0.28, 0.12)),
    ))]
    panels = [lib.mat_grain(f'swpanel{k}', a, b, scale=5, stretch=(1, 7, 1), bump=0.6) for k, (a, b) in enumerate((
        ((0.36, 0.22, 0.09), (0.62, 0.44, 0.2)),
        ((0.42, 0.28, 0.12), (0.7, 0.52, 0.26)),
    ))]
    frame = lib.mat_grain('swframe', (0.18, 0.09, 0.04), (0.32, 0.18, 0.08), scale=5, stretch=(1, 1, 8), bump=0.5)
    core = lib.mat_flat('swcore', (0.16, 0.09, 0.05))
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    glass = lib.mat_flat('glass', (0.62, 0.78, 0.92), rough=0.15)
    iron = lib.mat_flat('iron', (0.34, 0.35, 0.38), rough=0.35)
    drum_logs = lib.mat_grain('drumlogs', (0.4, 0.16, 0.07), (0.72, 0.36, 0.17), scale=6, stretch=(1, 1, 7), bump=0.9)
    rnd = random.Random(7)
    earth_pad((0.08, -0.15, 0), 0.98, 1.0, seed=8)
    lib.tag(0)

    # Front block (door on −Y), tall block behind it, drum on the +X side.
    fx0, fx1, fy0, fy1, fH, frh = -0.9, -0.15, -0.95, -0.2, 0.62, 0.24
    tx0, tx1, ty0, ty1, tH = -0.9, -0.1, -0.25, 0.6, 1.25
    dcx, dcy, dr, dl = 0.42, 0.12, 0.46, 0.92  # drum centre (x, y), radius, length along X
    corner_stakes(fx0, dcx + dl / 2, fy0, ty1)
    lib.tag(0, until=0)

    B.timber_frame((fx0 + fx1) / 2, (fy0 + fy1) / 2, fx1 - fx0, fy1 - fy0, fH, frh, beam, axis='y')
    B.timber_frame((tx0 + tx1) / 2, (ty0 + ty1) / 2, tx1 - tx0, ty1 - ty0, tH, 0.05, beam, axis='y')
    for x in (dcx - dl / 2 + 0.12, dcx + dl / 2 - 0.12):  # the drum's cradle
        lib.box((x, dcy, dr * 0.45), (0.08, dr * 1.4, 0.08), beam)
        for sy in (-1, 1):
            lib.box((x, dcy + sy * dr * 0.6, dr * 0.3), (0.07, 0.07, dr * 0.6), beam)
    lib.tag(1, until=3)

    plank_walls(fx0, fx1, fy0, fy1, 0.0, fH, planks, core, frame, rnd)
    plank_walls(tx0, tx1, ty0, ty1, 0.0, tH * 0.5, planks, core, frame, rnd, faces=('x',))
    lib.tag(2)
    plank_walls(tx0, tx1, ty0, ty1, tH * 0.5, tH, planks, core, frame, rnd)
    lib.gable(((fx0 + fx1) / 2, (fy0 + fy1) / 2, fH), fx1 - fx0, frh, fy0 + 0.01, planks[0], along='y')
    # Door with a dark opening and a frame; a small window on the +X side of the front block.
    dxm = (fx0 + fx1) / 2
    lib.box((dxm, fy0 - 0.012, 0.21), (0.28, 0.03, 0.42), dark)
    for sgn in (-1, 1):
        lib.box((dxm + sgn * 0.16, fy0 - 0.03, 0.22), (0.05, 0.04, 0.46), frame, bevel=0.006)
    lib.box((dxm, fy0 - 0.03, 0.45), (0.38, 0.05, 0.05), frame, bevel=0.006)
    window(fx1 + 0.02, (fy0 + fy1) / 2, 0.3, 0.14, 0.13, frame, dark, face='x')
    # Two glass windows on the tall block's front, above the front block's roof.
    for wx in (tx0 + 0.24, tx0 + 0.52):
        window(wx, ty0 - 0.02, fH + frh + 0.24, 0.17, 0.2, frame, glass)
    # The drum: logs along X round a cylinder, an end showing the dark inside.
    n = 18
    for k in range(n):
        a = k / n * math.tau
        y = dcy + math.cos(a) * dr
        z = dr + 0.02 + math.sin(a) * dr
        lib.cylinder((dcx + rnd.uniform(-0.03, 0.03), y, z), 0.068, dl + rnd.uniform(-0.05, 0.05), drum_logs,
                     rot=(0, math.pi / 2, 0), verts=10)
        lib.cylinder((dcx + dl / 2 + 0.002, y, z), 0.063, 0.008, ends, rot=(0, math.pi / 2, 0), verts=10)
    lib.cylinder((dcx, dcy, dr + 0.02), dr - 0.05, dl - 0.04, drum_logs, rot=(0, math.pi / 2, 0), verts=28)
    for ring, count in ((0.0, 1), (0.13, 6), (0.26, 11)):
        for k in range(count):
            a = k / count * math.tau + ring
            lib.cylinder((dcx + dl / 2 - 0.01, dcy + math.cos(a) * ring, dr + 0.02 + math.sin(a) * ring), 0.065, 0.02,
                         ends, rot=(0, math.pi / 2, 0), verts=10)
    lib.tag(None, split=lambda o: 2 if o.location.z < fH * 0.5 else 3)

    for x in (dcx - dl * 0.27, dcx + dl * 0.27):
        torus((x, dcy, dr + 0.02), dr + 0.07, 0.03, iron, rot=(0, math.pi / 2, 0))
    # Roofs: the front block's low gable of riveted panels, the tall block's nearly flat planks.
    fcx = (fx0 + fx1) / 2
    for sgn in (-1, 1):
        panel_slope(fcx, fy0 - 0.08, fy1 + 0.02, fcx + sgn * ((fx1 - fx0) / 2 + 0.1), fH - 0.03,
                    fcx, fH + frh + 0.02, frame, panels, iron, rnd)
    lib.tag(None, split=lambda o: 3 if o.location.x > fcx else 4)
    for k in range(7):
        x = tx0 - 0.06 + (k + 0.5) * (tx1 - tx0 + 0.12) / 7
        lib.box((x + rnd.uniform(-0.01, 0.01), (ty0 + ty1) / 2, tH + 0.03 + (x - tx0) * -0.05),
                ((tx1 - tx0 + 0.12) / 7 * 0.88, ty1 - ty0 + 0.12 + rnd.uniform(-0.04, 0.04), 0.035),
                planks[rnd.randrange(len(planks))], rot=(rnd.uniform(-0.03, 0.03), 0.05, rnd.uniform(-0.03, 0.03)),
                bevel=0.006)
    lib.box(((tx0 + tx1) / 2, ty0 - 0.06, tH + 0.02), (tx1 - tx0 + 0.14, 0.05, 0.06), frame, bevel=0.008)
    lib.tag(4)


# ------------------------------------------------------------------------------------- stonecutter

def wedge(x0, x1, y0, y1, z0, zh, mat):
    """A solid whose top slopes along X: height zh at x0 down to z0 at x1 (a mono-pitch wall top)."""
    verts = [(x0, y0, z0), (x1, y0, z0), (x0, y0, zh), (x0, y1, z0), (x1, y1, z0), (x0, y1, zh)]
    faces = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (0, 2, 5, 3), (1, 4, 5, 2)]
    mesh = bpy.data.meshes.new('wedge')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('wedge', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def coping_line(a, b, mats, rnd, size=0.16):
    """A row of big, rugged coping stones from point a to point b, along a wall top."""
    ax, ay, az = a
    bx, by, bz = b
    length = math.dist(a, b)
    n = max(2, round(length / (size * 0.92)))
    yaw = math.atan2(by - ay, bx - ax)
    pitch = -math.atan2(bz - az, math.hypot(bx - ax, by - ay))
    for k in range(n):
        t = (k + 0.5) / n
        sz = size * rnd.uniform(0.85, 1.15)
        lib.box((ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t + sz * 0.3),
                (sz * 0.9, sz * 1.05, sz * 0.7), mats[rnd.randrange(len(mats))],
                rot=(rnd.uniform(-0.1, 0.1), pitch + rnd.uniform(-0.1, 0.1), yaw + rnd.uniform(-0.12, 0.12)),
                bevel=0.03)


def build_stonecutter():
    """After the Settlers 4 stonecutter: a squat box of big rough stone blocks under a mono-pitch roof
    of wide warm-brown boards (along the ridge, dark gaps between), its wall tops edged all round with
    chunky coping stones; a big irregular arch fills most of the front wall; on the low side an open
    timber shed continues the roof down."""
    rnd = random.Random(11)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    boards = [lib.mat_grain(f'sboard{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.8) for k, (a, b) in enumerate((
        ((0.42, 0.24, 0.08), (0.74, 0.5, 0.2)),
        ((0.34, 0.19, 0.07), (0.62, 0.38, 0.15)),
        ((0.5, 0.32, 0.11), (0.82, 0.6, 0.28)),
    ))]
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    floor = lib.mat_grain('archfloor', (0.3, 0.24, 0.17), (0.48, 0.4, 0.3), scale=10, stretch=(1, 1, 1), bump=0.6)
    earth_pad((0.05, -0.2, 0), 1.0, 1.12, seed=12)
    lib.tag(0)

    # The roof falls from the −X wall (high) to the +X wall (low), where the shed continues it.
    cx, cy, L, W = -0.22, 0.12, 0.92, 1.0
    Hh, Hl = 1.2, 0.86
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    sx1 = x1 + 0.5  # shed's outer edge
    corner_stakes(x0, sx1, y0, y1)
    lib.tag(0, until=0)

    lib.box((cx, cy, 0.05), (L + 0.08, W + 0.08, 0.1), blocks[1], bevel=0.02)
    lib.tag(1)
    for x in (x0 - 0.07, x1 + 0.07):
        for y in (y0 - 0.07, y1 + 0.07):
            lib.cylinder((x, y, 0.5), 0.025, 1.0, beam, verts=8)
    lib.tag(1, until=3)

    def top_at(x):
        return Hh + (Hl - Hh) * (x - x0) / L

    # Walls: a core, then rugged blocks on the two visible faces; above Hl only the part of the
    # front wall that is still under the sloping top.
    half = Hl / 2
    lib.box((cx, cy, 0.1 + (half - 0.1) / 2), (L, W, half - 0.1), walls)
    stone_course(x0, x1, y0, y1, 0.1, half, blocks, rnd, block=0.24, depth=0.09)
    lib.tag(2)
    lib.box((cx, cy, half + half / 2), (L, W, half), walls)
    stone_course(x0, x1, y0, y1, half, Hl, blocks, rnd, block=0.24, depth=0.09)
    wedge(x0, x1, y0, y1, Hl, Hh, walls)
    band = 0.15
    z = Hl
    while z < Hh - 0.04:
        zt = min(Hh, z + band)
        xr = x0 + (Hh - zt) / (Hh - Hl) * L  # where the slope is above this band
        if xr - x0 > 0.08:
            stone_course(x0, xr, y0, y0, z, zt, blocks, rnd, block=0.24, depth=0.09)
        z = zt
    # The big arch: a deep dark opening with a floor, framed by irregular chunky stones.
    ax, ar, az = cx - 0.02, 0.23, 0.34
    fy = y0 - 0.1
    lib.box((ax, y0 + 0.12, az / 2 + 0.05), (ar * 2, 0.5, az + 0.05), dark)
    lib.cylinder((ax, y0 + 0.12, az + 0.04), ar, 0.5, dark, rot=(math.pi / 2, 0, 0), verts=24)
    lib.box((ax, y0 + 0.12, 0.11), (ar * 2 - 0.02, 0.48, 0.02), floor)
    lib.box((ax, fy + 0.02, az / 2 + 0.05), (ar * 2, 0.08, az + 0.05), dark)
    lib.cylinder((ax, fy + 0.02, az + 0.04), ar, 0.08, dark, rot=(math.pi / 2, 0, 0), verts=24)
    for k in range(9):
        a = math.pi * k / 8
        sz = rnd.uniform(0.11, 0.15)
        lib.box((ax + math.cos(a) * (ar + 0.06), fy - 0.02, az + 0.04 + math.sin(a) * (ar + 0.06)), (sz, 0.12, sz * 1.1),
                blocks[rnd.randrange(len(blocks))], rot=(rnd.uniform(-0.1, 0.1), -a + math.pi / 2 + rnd.uniform(-0.15, 0.15), 0),
                bevel=0.025)
    for z in (0.16, 0.32):
        for sgn in (-1, 1):
            lib.box((ax + sgn * (ar + 0.07), fy - 0.02, z), (0.14, 0.12, 0.15), blocks[rnd.randrange(len(blocks))],
                    rot=(0, rnd.uniform(-0.1, 0.1), rnd.uniform(-0.1, 0.1)), bevel=0.025)
    lib.tag(3)

    # Roof: wide boards along Y on the slope, from the high wall down past the low one.
    ang = math.atan2(Hh - Hl, L)
    slope = math.hypot(L + 0.08, (Hh - Hl) * (L + 0.08) / L)
    n = 6
    made = []
    for k in range(n):
        t = (k + 0.5) / n
        x = x0 - 0.04 + (L + 0.08) * t
        zr = top_at(x) + 0.04
        b = lib.box((x, cy + rnd.uniform(-0.02, 0.02), zr + rnd.uniform(-0.006, 0.006)),
                    (slope / n * 0.8, W - 0.14 + rnd.uniform(-0.03, 0.02), 0.04), boards[rnd.randrange(len(boards))],
                    rot=(rnd.uniform(-0.03, 0.03), ang, rnd.uniform(-0.03, 0.03)), bevel=0.006)
        made.append((b, t))
    lib.tag(None, split=lambda o: next((3 if t < 0.5 else 4 for b, t in made if b == o), 4))
    # Coping stones all round the wall tops.
    coping_line((x0, y0, Hh), (x0, y1, Hh), blocks, rnd)
    coping_line((x0, y0, Hh), (x1 + 0.02, y0, Hl), blocks, rnd)
    coping_line((x0, y1, Hh), (x1 + 0.02, y1, Hl), blocks, rnd)
    lib.tag(3)

    # Open shed: posts and rails, a board roof running down the slope, the dark inside showing.
    sh_lo = 0.5
    for y in (y0 + 0.08, cy, y1 - 0.08):
        lib.box((sx1 - 0.03, y, sh_lo / 2), (0.06, 0.06, sh_lo), beam, bevel=0.008)
    lib.box((sx1 - 0.03, cy, sh_lo - 0.02), (0.07, W - 0.1, 0.06), beam, bevel=0.008)
    lib.box((sx1 - 0.03, cy, 0.12), (0.05, W - 0.1, 0.05), beam, bevel=0.008)
    # Braces in the open front of the shed.
    for y in (y0 + 0.08, y1 - 0.08):
        lib.box(((x1 + sx1) / 2, y, (sh_lo + Hl) / 2 - 0.12), (sx1 - x1, 0.05, 0.05), beam,
                rot=(0, math.atan2(Hl - sh_lo, sx1 - x1), 0), bevel=0.006)
    lib.box(((x1 + sx1) / 2, cy, 0.03), (sx1 - x1 - 0.06, W - 0.16, 0.02), lib.mat_flat('shed-floor', (0.12, 0.09, 0.06)))
    tilt = math.atan2(Hl - sh_lo, sx1 - x1)
    run = math.hypot(sx1 - x1 + 0.08, Hl - sh_lo)
    m = 6
    for k in range(m):
        y = y0 + 0.02 + (k + 0.5) * (W - 0.04) / m
        lib.box(((x1 + sx1) / 2 + 0.02, y, (Hl + sh_lo) / 2 + 0.03),
                (run, (W - 0.04) / m * 0.84, 0.035), boards[rnd.randrange(len(boards))],
                rot=(rnd.uniform(-0.03, 0.03), tilt, rnd.uniform(-0.04, 0.04)), bevel=0.006)
    lib.tag(4)


# ------------------------------------------------------------------------------------- tower

def quoins(x0, x1, y0, y1, z0, z1, mats, rnd, block=0.26, row=0.2):
    """Staggered corner stones on the three visible vertical edges: each course a big block that runs
    long along one face, the next along the other, standing a little proud of both faces."""
    rows = max(1, round((z1 - z0) / row))
    h = (z1 - z0) / rows
    for r in range(rows):
        z = z0 + (r + 0.5) * h
        long_x = r % 2 == 0
        for (x, y) in ((x0, y0), (x1, y0), (x1, y1)):
            sx = -1 if x == x0 else 1
            sy = -1 if y == y0 else 1
            lx = block * rnd.uniform(0.9, 1.15) if long_x else block * 0.55
            ly = block * 0.55 if long_x else block * rnd.uniform(0.9, 1.15)
            lib.box((x - sx * lx / 2 + sx * 0.035, y - sy * ly / 2 + sy * 0.035, z), (lx, ly, h * 0.9),
                    mats[rnd.randrange(len(mats))],
                    rot=(rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), rnd.uniform(-0.03, 0.03)), bevel=0.025)


def rod(a, b, r, mat, verts=10):
    """A round beam from point a to point b."""
    from mathutils import Vector

    a, b = Vector(a), Vector(b)
    d = b - a
    obj = lib.cylinder(tuple((a + b) / 2), r, d.length, mat, verts=verts)
    obj.rotation_euler = d.to_track_quat('Z', 'Y').to_euler()
    return obj


def build_tower():
    """After the Settlers 4 small tower: a tall square stone tower (about twice as high as wide),
    big rugged blocks with staggered quoins, a strapped plank door, a dark lookout opening high on
    the right face; on top an overhanging timber platform with a box railing of thick round beams,
    X-braced on every side. The owner's banner is drawn by the game at ART3D_BANNERS['tower']."""
    rnd = random.Random(21)
    walls = stone_walls()
    blocks = block_mats()
    wood = lib.mat_grain('railwood', (0.5, 0.32, 0.12), (0.8, 0.58, 0.28), scale=5, stretch=(1, 1, 8), bump=0.6)
    plank = lib.mat_grain('plank', (0.42, 0.26, 0.1), (0.66, 0.46, 0.2), scale=4, stretch=(1, 9, 1), bump=0.7)
    door = lib.mat_grain('door', (0.3, 0.17, 0.07), (0.5, 0.31, 0.13), scale=4, stretch=(1, 1, 9), bump=0.7)
    iron = lib.mat_flat('iron', (0.42, 0.44, 0.48), rough=0.3)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    beam = beam_mat()
    earth_pad((0.12, -0.18, 0), 0.82, 0.92, seed=21)
    lib.tag(0)

    cx, cy, s0, s1, H = 0.05, 0.05, 1.22, 0.98, 1.75  # base width at the foot and the top, height
    corner_stakes(cx - s0 / 2, cx + s0 / 2, cy - s0 / 2, cy + s0 / 2)
    lib.tag(0, until=0)

    lib.box((cx, cy, 0.06), (s0 + 0.1, s0 + 0.1, 0.12), blocks[1], bevel=0.02)
    for x in (cx - s0 / 2 - 0.1, cx + s0 / 2 + 0.1):
        for y in (cy - s0 / 2 - 0.1, cy + s0 / 2 + 0.1):
            lib.cylinder((x, y, 0.8), 0.025, 1.6, beam, verts=8)
    lib.tag(1, until=3)

    # The shaft in courses narrowing a little upwards, dressed in big blocks with quoins.
    courses = 8
    for c in range(courses):
        t0, t1 = c / courses, (c + 1) / courses
        z0, z1 = 0.12 + (H - 0.12) * t0, 0.12 + (H - 0.12) * t1
        s = s0 + (s1 - s0) * (t0 + t1) / 2
        x0, x1, y0, y1 = cx - s / 2, cx + s / 2, cy - s / 2, cy + s / 2
        lib.box((cx, cy, (z0 + z1) / 2), (s, s, z1 - z0), walls)
        stone_course(x0, x1, y0, y1, z0, z1, blocks, rnd, block=0.3, depth=0.11)
        quoins(x0, x1, y0, y1, z0, z1, blocks, rnd)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)
    # Plank door with iron straps on the front-left face, under a stone lintel.
    fy = cy - s0 / 2 - 0.13
    dxc, dw, dh = cx - 0.04, 0.38, 0.62
    lib.box((dxc, fy - 0.03, 0.12 + dh / 2), (dw + 0.04, 0.04, dh + 0.02), dark)
    for k in range(4):
        lib.box((dxc - dw / 2 + (k + 0.5) * dw / 4, fy - 0.06, 0.12 + dh / 2), (dw / 4 * 0.92, 0.035, dh), door,
                bevel=0.006)
    for z in (0.24, 0.44):
        lib.box((dxc, fy - 0.085, z), (dw + 0.02, 0.012, 0.035), iron, bevel=0.004)
    lib.box((dxc, fy - 0.09, 0.12 + dh + 0.06), (dw + 0.16, 0.1, 0.12), blocks[2], bevel=0.025)
    # Dark lookout opening high on the right face.
    rx = cx + (s0 + s1) / 2 / 2 + 0.12
    lib.box((rx + 0.02, cy - 0.05, H - 0.42), (0.06, 0.26, 0.32), dark)
    lib.box((rx + 0.05, cy - 0.05, H - 0.25), (0.1, 0.36, 0.08), blocks[0], bevel=0.02)
    lib.box((rx + 0.05, cy - 0.05, H - 0.59), (0.1, 0.34, 0.06), blocks[3], bevel=0.02)
    lib.tag(3)

    # Overhanging timber platform: joists poking out, a plank floor, a box railing of round beams.
    top = H
    ps = s1 + 0.18
    for k in range(5):
        t = -ps / 2 + 0.06 + k * (ps - 0.12) / 4
        lib.box((cx + t, cy, top + 0.04), (0.08, ps + 0.14, 0.08), beam, bevel=0.01)
    for k in range(8):
        t = -ps / 2 + (k + 0.5) * ps / 8
        lib.box((cx, cy + t, top + 0.11), (ps, ps / 8 - 0.012, 0.04), plank,
                rot=(0, 0, rnd.uniform(-0.015, 0.015)), bevel=0.008)
    rail, r = 0.46, 0.055
    zb, zt = top + 0.16, top + 0.13 + rail
    corners = [(cx - ps / 2, cy - ps / 2), (cx + ps / 2, cy - ps / 2), (cx + ps / 2, cy + ps / 2), (cx - ps / 2, cy + ps / 2)]
    for (x, y) in corners:
        lib.cylinder((x, y, top + 0.1 + (rail + 0.08) / 2), r * 1.15, rail + 0.1, wood, verts=12)
    for k in range(4):
        (xa, ya), (xb, yb) = corners[k], corners[(k + 1) % 4]
        for z in (zb, zt):
            rod((xa, ya, z), (xb, yb, z), r, wood)
        # X-brace in the side, inset between the corner posts.
        ix, iy = (xb - xa) * 0.08, (yb - ya) * 0.08
        rod((xa + ix, ya + iy, zb + 0.03), (xb - ix, yb - iy, zt - 0.03), r * 0.75, wood)
        rod((xa + ix, ya + iy, zt - 0.03), (xb - ix, yb - iy, zb + 0.03), r * 0.75, wood)
    lib.tag(4)
    note_banner('tower', (cx, cy, top + 0.12))


# ------------------------------------------------------------------------------------- large house

def half_timber(x0, x1, y0, y1, z0, z1, plaster, beam, rnd):
    """Plaster walls framed by dark timbers on the two visible faces: posts, rails and braces."""
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0), plaster)
    t = 0.045
    for face in ('y', 'x'):
        a0, a1 = (x0, x1) if face == 'y' else (y0, y1)
        n = max(2, round((a1 - a0) / 0.32))
        for k in range(n + 1):
            a = a0 + k * (a1 - a0) / n
            loc = (a, y0 - 0.012, (z0 + z1) / 2) if face == 'y' else (x1 + 0.012, a, (z0 + z1) / 2)
            lib.box(loc, (t, 0.03, z1 - z0) if face == 'y' else (0.03, t, z1 - z0), beam)
            if k < n:
                # A diagonal brace in every other bay, alternating its lean.
                if k % 2 == 0:
                    length = math.hypot((a1 - a0) / n, z1 - z0)
                    ang = math.atan2(z1 - z0, (a1 - a0) / n) * (1 if k % 4 == 0 else -1)
                    mid = a + (a1 - a0) / n / 2
                    if face == 'y':
                        lib.box((mid, y0 - 0.014, (z0 + z1) / 2), (length, 0.03, t), beam, rot=(0, -ang, 0))
                    else:
                        lib.box((x1 + 0.014, mid, (z0 + z1) / 2), (0.03, length, t), beam, rot=(ang, 0, 0))
        for z in (z0 + 0.02, (z0 + z1) / 2, z1 - 0.02):
            if face == 'y':
                lib.box(((x0 + x1) / 2, y0 - 0.016, z), (x1 - x0 + 0.04, 0.03, t), beam)
            else:
                lib.box((x1 + 0.016, (y0 + y1) / 2, z), (0.03, y1 - y0 + 0.04, t), beam)


def scale_roof(cx, cy, L, W, H, rh, mats, ridge, axis='x', overhang=0.1, seed=3, size=0.13, shape='scale'):
    """Gable roof (ridge along `axis`; `L` along X, `W` along Y) covered row by row with rounded slate
    scales (`shape='scale'`, flattened discs) or square terracotta tiles (`shape='tile'`), each its
    own tone and a little askew, rows overlapping downhill, a round ridge cap on top."""
    rnd = random.Random(seed)
    along, across = (L, W) if axis == 'x' else (W, L)
    run = across / 2 + overhang
    drop = overhang * rh / (across / 2)
    rise = rh + drop
    angle = math.atan2(rise, run)
    slope = math.hypot(run, rise)
    rows = max(2, int(slope / (size * 0.62)))
    cols = max(2, int((along + 2 * overhang) / (size * 0.92)))
    lib.prism_roof((cx, cy, H), along, across, rh, mats[0], overhang=overhang, thickness=0.04, along=axis)
    for side in (-1, 1):
        for r in range(rows):
            d = slope * (r + 0.6) / rows  # distance down from the ridge
            h = H + rh - rise * d / slope + 0.03 + 0.012 * (r % 2)
            off = side * run * d / slope
            for k in range(cols + (r % 2)):
                t = -along / 2 - overhang + (k + 0.5 * (1 - r % 2)) * (along + 2 * overhang) / cols
                if abs(t) > along / 2 + overhang - size * 0.3:
                    continue
                t += rnd.uniform(-0.012, 0.012)
                mat = mats[rnd.randrange(len(mats))]
                tilt = side * angle + rnd.uniform(-0.06, 0.06)
                # Long downhill (across the ridge), so the rows overlap.
                down = (1.0, 1.25) if axis == 'x' else (1.25, 1.0)
                if shape == 'scale':
                    obj = lib.sphere((0, 0, 0), size * 0.55, mat, scale=(down[0], down[1], 0.22), subdiv=2)
                else:
                    obj = lib.box((0, 0, 0), (size * 0.9 * down[0] / 1.1, size * 0.9 * down[1] / 1.1, 0.03), mat,
                                  bevel=0.008)
                yaw = rnd.uniform(-0.12, 0.12)
                if axis == 'x':
                    obj.location = (cx + t, cy + off, h)
                    obj.rotation_euler = (-tilt, 0, yaw)
                else:
                    obj.location = (cx + off, cy + t, h)
                    obj.rotation_euler = (0, tilt, yaw)
    if axis == 'x':
        lib.cylinder((cx, cy, H + rh + 0.03), 0.05, along + 2 * overhang + 0.04, ridge, rot=(0, math.pi / 2, 0), verts=12)
    else:
        lib.cylinder((cx, cy, H + rh + 0.03), 0.05, along + 2 * overhang + 0.04, ridge, rot=(math.pi / 2, 0, 0), verts=12)


def mullion_window(x, y, z, w, h, frame, glass, face='y'):
    """A teal-framed window with a cross of mullions."""
    window(x, y, z, w, h, frame, glass, face=face)
    if face == 'y':
        lib.box((x, y - 0.03, z), (0.022, 0.02, h), frame)
        lib.box((x, y - 0.03, z), (w, 0.02, 0.022), frame)
    else:
        lib.box((x + 0.03, y, z), (0.02, 0.022, h), frame)
        lib.box((x + 0.03, y, z), (0.02, w, 0.022), frame)


def build_house_large():
    """After the Settlers 4 large residence, three joined blocks: on the left a two-storey
    half-timbered house (light plaster panels, dark timbers, teal mullioned windows) on stone corner
    piers under a steep roof of blue-grey slate scales; behind on the right a higher dark-stone block
    under orange terracotta tiles; in front a lower stone annex under blue slate."""
    rnd = random.Random(31)
    walls = stone_walls()
    blocks = block_mats()
    dark_blocks = [lib.mat_grain(f'dblocks{k}', a, b, scale=7, stretch=(1, 1, 1), bump=1.0) for k, (a, b) in enumerate((
        ((0.2, 0.21, 0.2), (0.42, 0.43, 0.4)),
        ((0.25, 0.26, 0.25), (0.5, 0.5, 0.47)),
        ((0.17, 0.18, 0.18), (0.36, 0.37, 0.36)),
    ))]
    plaster = lib.mat_stones('plaster', (0.88, 0.8, 0.66), (0.72, 0.64, 0.5), (0.6, 0.52, 0.4), scale=6, bump=0.3)
    beam = lib.mat_grain('timber', (0.24, 0.15, 0.06), (0.42, 0.28, 0.12), scale=5, stretch=(1, 1, 8), bump=0.6)
    slates = [lib.mat_grain(f'slate{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.2, 0.25, 0.34), (0.36, 0.42, 0.52)),
        ((0.26, 0.31, 0.42), (0.44, 0.5, 0.62)),
        ((0.15, 0.19, 0.27), (0.28, 0.33, 0.42)),
    ))]
    tiles = [lib.mat_grain(f'tile{k}', a, b, scale=9, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.66, 0.3, 0.12), (0.9, 0.5, 0.26)),
        ((0.58, 0.24, 0.09), (0.82, 0.42, 0.2)),
        ((0.72, 0.36, 0.16), (0.94, 0.58, 0.32)),
    ))]
    slate_ridge = lib.mat_flat('slate-ridge', (0.22, 0.29, 0.42))
    tile_ridge = lib.mat_flat('tile-ridge', (0.66, 0.32, 0.14))
    teal = lib.mat_flat('teal', (0.2, 0.5, 0.52), rough=0.5)
    glass = lib.mat_flat('glass', (0.36, 0.56, 0.62), rough=0.2)
    door = lib.mat_grain('door', (0.36, 0.2, 0.08), (0.56, 0.34, 0.14), scale=4, stretch=(1, 1, 9), bump=0.6)
    dark = lib.mat_flat('dark', (0.06, 0.05, 0.04))
    earth_pad((0.15, -0.3, 0), 1.42, 1.42, seed=31)
    lib.tag(0)

    # A: half-timbered house on the left, ridge along Y, its gable towards the camera (−Y).
    ax0, ax1, ay0, ay1, aH, arh = -1.35, -0.45, -1.2, 0.6, 1.3, 0.68
    # B: dark stone block behind on the right, ridge along X.
    bx0, bx1, by0, by1, bH, brh = -0.45, 0.95, 0.0, 1.2, 1.0, 0.48
    # C: stone annex in front of B, ridge along X.
    cx0, cx1, cy0, cy1, cH, crh = -0.45, 0.9, -1.2, 0.0, 0.62, 0.3
    corner_stakes(ax0, bx1, ay0, by1)
    lib.tag(0, until=0)

    B = _b()
    B.timber_frame((ax0 + ax1) / 2, (ay0 + ay1) / 2, ax1 - ax0, ay1 - ay0, aH, arh, beam, axis='y')
    lib.box(((bx0 + bx1) / 2, (by0 + by1) / 2, 0.05), (bx1 - bx0 + 0.06, by1 - by0 + 0.06, 0.1), dark_blocks[0], bevel=0.02)
    lib.box(((cx0 + cx1) / 2, (cy0 + cy1) / 2, 0.05), (cx1 - cx0 + 0.06, cy1 - cy0 + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.tag(1, until=3)

    # A: stone piers at the visible corners, plaster and timbers between, two storeys.
    for (x, y) in ((ax0, ay0), (ax1, ay0), (ax1, ay1)):
        for k in range(3):
            lib.box((x, y, 0.08 + k * 0.13), (0.14, 0.14, 0.12), blocks[rnd.randrange(len(blocks))],
                    rot=(0, 0, rnd.uniform(-0.1, 0.1)), bevel=0.02)
    half_timber(ax0, ax1, ay0, ay1, 0.0, aH * 0.5, plaster, beam, rnd)
    # B and C walls: rugged stone, dark on B.
    lib.box(((bx0 + bx1) / 2, (by0 + by1) / 2, bH / 2), (bx1 - bx0, by1 - by0, bH), walls)
    stone_course(bx0, bx1, by0, by1, 0.1, bH * 0.5, dark_blocks, rnd, block=0.22, depth=0.07)
    lib.box(((cx0 + cx1) / 2, (cy0 + cy1) / 2, cH / 2), (cx1 - cx0, cy1 - cy0, cH), walls)
    stone_course(cx0, cx1, cy0, cy1, 0.1, cH * 0.5, blocks, rnd, block=0.2, depth=0.06)
    lib.tag(2)
    half_timber(ax0 - 0.04, ax1 + 0.04, ay0 - 0.04, ay1, aH * 0.5, aH, plaster, beam, rnd)
    lib.gable(((ax0 + ax1) / 2, (ay0 + ay1) / 2, aH), ax1 - ax0 + 0.08, arh - 0.02, ay0 - 0.03, plaster, along='y')
    stone_course(bx0, bx1, by0, by1, bH * 0.5, bH, dark_blocks, rnd, block=0.22, depth=0.07)
    lib.gable(((bx0 + bx1) / 2, (by0 + by1) / 2, bH), by1 - by0, brh - 0.02, bx1 - 0.01, dark_blocks[1], along='x')
    stone_course(cx0, cx1, cy0, cy1, cH * 0.5, cH, blocks, rnd, block=0.2, depth=0.06)
    lib.gable(((cx0 + cx1) / 2, (cy0 + cy1) / 2, cH), cy1 - cy0, crh - 0.02, cx1 - 0.01, blocks[0], along='x')
    # Windows: two on each storey of A's gable front, one under its gable; door in the annex.
    for wz in (aH * 0.25, aH * 0.72):
        for wx in (ax0 + 0.24, ax1 - 0.24):
            mullion_window(wx, ay0 - 0.06, wz, 0.18, 0.2, teal, glass)
    mullion_window((ax0 + ax1) / 2, ay0 - 0.05, aH + arh * 0.38, 0.15, 0.15, teal, glass)
    mullion_window(ax1 + 0.04, (ay0 + ay1) / 2 + 0.2, aH * 0.72, 0.18, 0.2, teal, glass, face='x')
    lib.box((cx1 - 0.35, cy0 - 0.07, 0.22), (0.26, 0.04, 0.44), door, bevel=0.01)
    lib.box((cx1 - 0.35, cy0 - 0.09, 0.46), (0.34, 0.08, 0.07), blocks[2], bevel=0.015)
    mullion_window(cx1 + 0.08, (cy0 + cy1) / 2, cH * 0.55, 0.16, 0.16, teal, dark, face='x')
    lib.tag(3)

    scale_roof((ax0 + ax1) / 2, (ay0 + ay1) / 2, ax1 - ax0, ay1 - ay0, aH, arh, slates, slate_ridge, axis='y',
               overhang=0.12, seed=33, size=0.15)
    lib.tag(None, split=lambda o: 3 if o.location.x > (ax0 + ax1) / 2 else 4)
    scale_roof((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0, by1 - by0, bH, brh, tiles, tile_ridge, axis='x',
               overhang=0.1, seed=34, size=0.12, shape='tile')
    scale_roof((cx0 + cx1) / 2, (cy0 + cy1) / 2, cx1 - cx0, cy1 - cy0, cH, crh, slates, slate_ridge, axis='x',
               overhang=0.1, seed=35, size=0.14)
    lib.tag(4)
