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
        ((0.56, 0.56, 0.55), (0.86, 0.85, 0.82)),
        ((0.48, 0.49, 0.5), (0.74, 0.74, 0.74)),
        ((0.62, 0.6, 0.55), (0.9, 0.87, 0.8)),
        ((0.42, 0.43, 0.45), (0.66, 0.67, 0.69)),
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
                one((x + w / 2, y0 - d / 2, z + rnd.uniform(-0.01, 0.01)), (w - 0.022, d, h * rnd.uniform(0.78, 0.92)),
                    (rnd.uniform(-0.06, 0.06), rnd.uniform(-0.08, 0.08), rnd.uniform(-0.05, 0.05)))
            x += w
        y = y0 - shift
        while y < y1:
            w = min(block * rnd.uniform(0.65, 1.35), y1 - y)
            if w > 0.04:
                d = depth * rnd.uniform(0.6, 1.4)
                one((x1 + d / 2, y + w / 2, z + rnd.uniform(-0.01, 0.01)), (d, w - 0.022, h * rnd.uniform(0.78, 0.92)),
                    (rnd.uniform(-0.08, 0.08), rnd.uniform(-0.06, 0.06), rnd.uniform(-0.05, 0.05)))
            y += w


def slate_roof(cx, cy, L, W, H, rh, mats, axis='x', overhang=0.1, seed=3, size=0.11):
    """Gable roof of overlapping rounded slates in rows (ridge along `axis`), each slate a little
    tilted and of its own tone."""
    rnd = random.Random(seed)
    along, across = (L, W) if axis == 'x' else (W, L)
    run = across / 2 + overhang
    drop = overhang * rh / (across / 2)
    rise = rh + drop
    angle = math.atan2(rise, run)
    slope = math.hypot(run, rise)
    rows = int(slope / (size * 0.7))
    cols = int((along + 2 * overhang) / size)
    for side in (-1, 1):
        for r in range(rows):
            d = slope - (r + 0.5) * slope / rows  # distance down from the ridge
            h = H - drop + rise * (1 - d / slope) + 0.03
            off = side * run * d / slope
            for k in range(cols + (r % 2)):
                t = -along / 2 - overhang + (k + 0.5 * (r % 2)) * (along + 2 * overhang) / cols
                if abs(t) > along / 2 + overhang:
                    continue
                mat = mats[rnd.randrange(len(mats))]
                dims = (size * rnd.uniform(0.85, 1.0), size * 1.3, 0.018)
                tilt = side * angle + rnd.uniform(-0.05, 0.05)
                if axis == 'x':
                    lib.box((cx + t, cy + off, h), dims, mat, rot=(-tilt, rnd.uniform(-0.06, 0.06), 0), bevel=0.012)
                else:
                    lib.box((cx + off, cy + t, h), (dims[1], dims[0], dims[2]), mat, rot=(rnd.uniform(-0.06, 0.06), tilt, 0),
                            bevel=0.012)
    ridge = lib.mat_flat('ridge-slate', (0.24, 0.27, 0.33))
    if axis == 'x':
        lib.cylinder((cx, cy, H + rh + 0.04), 0.045, along + 2 * overhang, ridge, rot=(0, math.pi / 2, 0), verts=10)
    else:
        lib.cylinder((cx, cy, H + rh + 0.04), 0.045, along + 2 * overhang, ridge, rot=(math.pi / 2, 0, 0), verts=10)


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

def build_sawmill():
    """Log hall with a raised loft whose roof windows face the camera, and beside it the great drum
    of logs bound with iron hoops (the saw's housing in Settlers 4)."""
    B = _b()
    logs, ends, beam, boards = logs_mat(), ends_mat(), beam_mat(), boards_mats()
    dark = lib.mat_flat('dark', (0.07, 0.05, 0.04))
    glass = lib.mat_flat('glass', (0.55, 0.68, 0.82), rough=0.2)
    iron = lib.mat_flat('iron', (0.3, 0.31, 0.34), rough=0.35)
    earth_pad((0.05, -0.2, 0), 1.0, 1.12, seed=8)
    lib.tag(0)

    cx, cy, L, W, H, rh = -0.3, 0.15, 0.9, 0.95, 0.5, 0.36
    dx, dy, dr, dl = 0.42, 0.1, 0.32, 0.95  # drum centre, radius, length (axis along Y)
    corner_stakes(cx - L / 2, dx + dr, cy - W / 2, cy + W / 2)
    lib.tag(0, until=0)

    B.timber_frame(cx, cy, L, W, H, rh, beam, axis='x')
    for y in (dy - dl / 2 + 0.08, dy + dl / 2 - 0.08):  # the drum's cradle posts
        lib.box((dx, y, dr / 2), (0.06, 0.06, dr), beam)
    lib.tag(1, until=3)

    B.log_cabin(cx, cy, L, W, H, logs, ends, gable_h=rh, gable_axis='x', door=(cx + 0.15, 0.24, 0.36))
    # The drum: logs round a cylinder, lying along Y.
    n = 16
    for k in range(n):
        a = k / n * math.tau
        lib.cylinder((dx + math.cos(a) * dr, dy, dr + 0.02 + math.sin(a) * dr), 0.055, dl, logs,
                     rot=(math.pi / 2, 0, 0), verts=10)
        lib.cylinder((dx + math.cos(a) * dr, dy - dl / 2 - 0.002, dr + 0.02 + math.sin(a) * dr), 0.051, 0.006, ends,
                     rot=(math.pi / 2, 0, 0), verts=10)
    lib.cylinder((dx, dy - dl / 2 + 0.05, dr + 0.02), dr - 0.03, 0.04, dark, rot=(math.pi / 2, 0, 0), verts=24)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.5 else 3)

    for y in (dy - dl * 0.3, dy + dl * 0.3):
        torus((dx, y, dr + 0.02), dr + 0.05, 0.022, iron, rot=(math.pi / 2, 0, 0))
    # Raised loft over the hall's back half, roof windows facing the camera.
    lx, ly, lL, lW, lH = cx - 0.05, cy + 0.15, 0.6, 0.45, 0.4
    lz = H + 0.16  # rises through the hall's roof, windows above the front slope
    for row in range(int(lH / 0.083)):
        z = lz + 0.04 + row * 0.083
        lib.cylinder((lx, ly - lW / 2, z), 0.04, lL + 0.08, logs, rot=(0, math.pi / 2, 0), verts=10)
        lib.cylinder((lx + lL / 2, ly, z + 0.04), 0.04, lW + 0.08, logs, rot=(math.pi / 2, 0, 0), verts=10)
    lib.box((lx, ly, lz + lH / 2), (lL - 0.04, lW - 0.04, lH), logs)
    for wx in (lx - 0.14, lx + 0.12):
        window(wx, ly - lW / 2 - 0.03, lz + lH * 0.62, 0.13, 0.12, beam, glass)
    lib.tag(None, split=lambda o: 3 if o.location.z < lz + lH * 0.5 else 4)

    B.plank_roof(cx, cy, L, W, H, rh, boards, axis='x', seed=6)
    lib.tag(None, split=lambda o: 3 if o.location.y < cy - 0.05 else 4)
    B.plank_roof(lx, ly, lL, lW, lz + lH, 0.16, boards, axis='x', overhang=0.08, seed=9)
    # Door frame.
    lib.box((cx + 0.15, cy - W / 2 + 0.03, 0.18), (0.22, 0.06, 0.36), dark)
    for ddx in (-0.13, 0.13):
        lib.box((cx + 0.15 + ddx, cy - W / 2 - 0.04, 0.19), (0.04, 0.04, 0.38), boards[1])
    lib.box((cx + 0.15, cy - W / 2 - 0.04, 0.39), (0.32, 0.05, 0.04), boards[1])
    window(cx + L / 2 + 0.02, cy + 0.1, 0.3, 0.14, 0.12, beam, glass, face='x')
    lib.tag(4)


# ------------------------------------------------------------------------------------- stonecutter

def gable_blocks(cx, y, L, H, rh, mats, rnd, block=0.2, depth=0.06):
    """Rugged blocks over a gable triangle on the −Y face (ridge along Y), rows narrowing to the apex."""
    rows = max(1, round(rh / (block * 0.7)))
    h = rh / rows
    for r in range(rows):
        z = H + (r + 0.5) * h
        half = (L / 2) * (1 - (r + 0.5) / rows)
        x = cx - half - (r % 2) * block / 3
        while x < cx + half:
            w = min(block * rnd.uniform(0.7, 1.3), cx + half - x)
            if w > 0.05:
                d = depth * rnd.uniform(0.6, 1.4)
                lib.box((x + w / 2, y - d / 2, z), (w - 0.022, d, h * rnd.uniform(0.78, 0.92)),
                        mats[rnd.randrange(len(mats))],
                        rot=(rnd.uniform(-0.06, 0.06), rnd.uniform(-0.08, 0.08), rnd.uniform(-0.05, 0.05)), bevel=0.02)
            x += w


def coping(cx, y, L, H, rh, mats, rnd, size=0.15):
    """Big stones along both raking edges of a gable (ridge along Y), standing proud of the roof like a
    row of teeth, as on Settlers 4 stone huts."""
    half = L / 2 + 0.06
    run = math.hypot(half, rh)
    n = max(2, round(run / (size * 0.95)))
    ang = math.atan2(rh, half)
    for side in (-1, 1):
        for k in range(n):
            t = (k + 0.5) / n
            x = cx + side * half * (1 - t)
            z = H - 0.02 + rh * t + 0.05
            s = size * rnd.uniform(0.85, 1.15)
            lib.box((x, y + rnd.uniform(-0.01, 0.01), z), (s, s * 1.1, s * 0.75), mats[rnd.randrange(len(mats))],
                    rot=(rnd.uniform(-0.1, 0.1), side * ang + rnd.uniform(-0.12, 0.12), rnd.uniform(-0.1, 0.1)),
                    bevel=0.025)


def board_roof_along(cx, y0, y1, H, rh, half, boards, rnd, width=0.13, side=1, eave=0.06):
    """One slope of a roof whose wide boards lie parallel to the ridge (ridge along Y at x = cx),
    between the gable walls at y0 and y1: uneven tones and lie, dark gaps between the boards."""
    run = half + eave
    drop = eave * rh / half
    rise = rh + drop
    ang = math.atan2(rise, run)
    slope = math.hypot(run, rise)
    n = max(2, int(slope / width))
    made = []
    for k in range(n):
        t = (k + 0.5) / n  # 0 at the ridge, 1 at the eave
        x = cx + side * run * t
        z = H + rh - rise * t + 0.03
        length = (y1 - y0) * rnd.uniform(0.93, 1.0)
        ym = (y0 + y1) / 2 + rnd.uniform(-0.02, 0.02)
        b = lib.box((x, ym, z + rnd.uniform(-0.006, 0.006)), (slope / n * 0.8, length, 0.035),
                    boards[rnd.randrange(len(boards))],
                    rot=(rnd.uniform(-0.03, 0.03), side * ang, rnd.uniform(-0.03, 0.03)), bevel=0.005)
        made.append((b, t))
    return made


def build_stonecutter():
    """After the Settlers 4 stonecutter: a squat hut of big rough stone blocks, its stone gables
    standing proud of a roof of wide boards laid along the ridge and edged with a row of coping
    stones, a big round arch in the front gable, a plank shed on the side."""
    rnd = random.Random(11)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    # Warm, weathered red-brown boards, as on the original's roof.
    boards = [lib.mat_grain(f'sboard{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.8) for k, (a, b) in enumerate((
        ((0.42, 0.22, 0.08), (0.7, 0.44, 0.18)),
        ((0.34, 0.18, 0.07), (0.58, 0.34, 0.14)),
        ((0.5, 0.3, 0.11), (0.78, 0.54, 0.24)),
    ))]
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.05, -0.2, 0), 1.0, 1.12, seed=12)
    lib.tag(0)

    # Ridge along Y: the arched gable faces the camera's lower left (−Y, where the door tile is),
    # the visible roof slope faces +X, towards the shed.
    cx, cy, L, W, H, rh = -0.2, 0.12, 0.86, 1.0, 0.6, 0.44
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    corner_stakes(x0, x1 + 0.45, y0, y1)
    lib.tag(0, until=0)

    lib.box((cx, cy, 0.05), (L + 0.08, W + 0.08, 0.1), blocks[1], bevel=0.02)
    lib.tag(1)
    for x in (x0 - 0.07, x1 + 0.07):
        for y in (y0 - 0.07, y1 + 0.07):
            lib.cylinder((x, y, 0.45), 0.025, 0.9, beam, verts=8)
    lib.tag(1, until=3)

    half = H / 2
    lib.box((cx, cy, 0.1 + (half - 0.1) / 2), (L, W, half - 0.1), walls)
    stone_course(x0, x1, y0, y1, 0.1, half, blocks, rnd, block=0.21, depth=0.07)
    lib.tag(2)
    lib.box((cx, cy, half + half / 2), (L, W, half), walls)
    stone_course(x0, x1, y0, y1, half, H, blocks, rnd, block=0.21, depth=0.07)
    # Stone gables, front and back, the front one dressed in blocks.
    lib.gable((cx, cy, H), L, rh, y0 + 0.01, walls, along='y')
    lib.gable((cx, cy, H), L, rh, y1 - 0.01, walls, along='y')
    gable_blocks(cx, y0, L, H, rh, blocks, rnd)
    # The big round arch in the front gable wall: a deep dark opening framed by chunky voussoirs.
    ax, ar, az = cx - 0.02, 0.2, 0.3
    lib.box((ax, y0 - 0.06, az / 2 + 0.03), (ar * 2, 0.06, az), dark)
    lib.cylinder((ax, y0 - 0.06, az), ar, 0.06, dark, rot=(math.pi / 2, 0, 0), verts=24)
    for k in range(11):
        a = math.pi * k / 10
        lib.box((ax + math.cos(a) * (ar + 0.05), y0 - 0.11, az + math.sin(a) * (ar + 0.05)), (0.1, 0.09, 0.12),
                blocks[(k % 2) * 2], rot=(0, -a + math.pi / 2, 0), bevel=0.02)
    for z in (0.07, 0.2):
        for sgn in (-1, 1):
            lib.box((ax + sgn * (ar + 0.05), y0 - 0.11, z), (0.11, 0.09, 0.13), blocks[2], bevel=0.02)
    lib.tag(3)

    # Roof of wide boards along the ridge, sitting between the gables; coping stones on the gables.
    inner0, inner1 = y0 + 0.04, y1 - 0.04
    made = board_roof_along(cx, inner0, inner1, H, rh, L / 2, boards, rnd, side=1)
    made += board_roof_along(cx, inner0, inner1, H, rh, L / 2, boards, rnd, side=-1)
    lib.tag(None, split=lambda o: next((3 if t > 0.5 else 4 for b, t in made if b == o), 4))
    coping(cx, y0 + 0.02, L, H, rh, blocks, rnd)
    coping(cx, y1 - 0.02, L, H, rh, blocks, rnd)
    lib.tag(3)

    # Plank shed on the +X side: board walls, a roof of boards running down the slope.
    sx0, sx1, sy0, sy1 = x1 + 0.02, x1 + 0.4, y0 + 0.18, y1 - 0.04
    sh_hi, sh_lo = H - 0.04, 0.42
    for x, y in ((sx1, sy0), (sx1, sy1)):
        lib.box((x, y, sh_lo / 2), (0.05, 0.05, sh_lo), beam)
    n = 5
    for k in range(n):  # front wall boards (−Y face of the shed), upright
        x = sx0 + (k + 0.5) * (sx1 - sx0) / n
        hgt = sh_hi + (sh_lo - sh_hi) * (k + 0.5) / n
        lib.box((x, sy0, hgt / 2), ((sx1 - sx0) / n * 0.9, 0.03, hgt), boards[k % len(boards)],
                rot=(0, rnd.uniform(-0.02, 0.02), 0), bevel=0.004)
    for k in range(6):  # side wall boards (+X face), upright
        y = sy0 + (k + 0.5) * (sy1 - sy0) / 6
        lib.box((sx1, y, sh_lo / 2), (0.03, (sy1 - sy0) / 6 * 0.9, sh_lo), boards[(k + 1) % len(boards)], bevel=0.004)
    tilt = math.atan2(sh_hi - sh_lo, sx1 - sx0)
    for k in range(7):  # roof boards running down the slope
        y = sy0 - 0.04 + (k + 0.5) * (sy1 - sy0 + 0.08) / 7
        lib.box(((sx0 + sx1) / 2 + 0.03, y, (sh_hi + sh_lo) / 2 + 0.03),
                (math.hypot(sx1 - sx0, sh_hi - sh_lo) + 0.12, (sy1 - sy0 + 0.08) / 7 * 0.88, 0.03), boards[k % len(boards)],
                rot=(rnd.uniform(-0.03, 0.03), tilt, rnd.uniform(-0.04, 0.04)), bevel=0.005)
    lib.tag(4)


# ------------------------------------------------------------------------------------- tower

def build_tower():
    """Small tower: a tapering base of rough stone with a banded door, a timber platform on top with
    braced railings. The owner's banner is drawn by the game at BANNER_AT['tower']."""
    rnd = random.Random(21)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    plank = lib.mat_grain('plank', (0.6, 0.4, 0.17), (0.82, 0.62, 0.3), scale=4, stretch=(1, 9, 1), bump=0.5)
    door = lib.mat_grain('door', (0.36, 0.2, 0.08), (0.56, 0.34, 0.14), scale=4, stretch=(1, 1, 9), bump=0.6)
    iron = lib.mat_flat('iron', (0.28, 0.29, 0.32), rough=0.35)
    dark = lib.mat_flat('dark', (0.06, 0.05, 0.04))
    earth_pad((0.1, -0.25, 0), 0.95, 1.1, seed=21)
    lib.tag(0)

    cx, cy, s0, s1, H = 0.1, 0.0, 0.95, 0.8, 1.25  # base size at the foot and the top, height
    corner_stakes(cx - s0 / 2, cx + s0 / 2, cy - s0 / 2, cy + s0 / 2)
    lib.tag(0, until=0)

    lib.box((cx, cy, 0.06), (s0 + 0.08, s0 + 0.08, 0.12), blocks[1], bevel=0.02)
    for x in (cx - s0 / 2 - 0.08, cx + s0 / 2 + 0.08):
        for y in (cy - s0 / 2 - 0.08, cy + s0 / 2 + 0.08):
            lib.cylinder((x, y, 0.6), 0.025, 1.2, beam, verts=8)
    lib.tag(1, until=3)

    # Base in courses that narrow upwards.
    courses = 6
    for c in range(courses):
        t0, t1 = c / courses, (c + 1) / courses
        z0, z1 = 0.12 + (H - 0.12) * t0, 0.12 + (H - 0.12) * t1
        s = s0 + (s1 - s0) * (t0 + t1) / 2
        lib.box((cx, cy, (z0 + z1) / 2), (s, s, z1 - z0), walls)
        stone_course(cx - s / 2, cx + s / 2, cy - s / 2, cy + s / 2, z0, z1, blocks, rnd, block=0.2, depth=0.06)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)
    # Banded door and a slit window.
    y0 = cy - s0 / 2 + 0.02
    lib.box((cx + 0.15, y0 - 0.06, 0.24), (0.26, 0.04, 0.42), door, bevel=0.01)
    for z in (0.12, 0.34):
        lib.box((cx + 0.15, y0 - 0.085, z), (0.28, 0.015, 0.035), iron)
    lib.box((cx - 0.15, y0 - 0.05, 0.75), (0.06, 0.04, 0.18), dark)
    lib.box((cx + s1 / 2 + 0.05, cy + 0.1, 0.85), (0.04, 0.06, 0.18), dark)
    lib.tag(3)

    # Timber platform: beams poking out, a plank floor, corner posts and braced railings.
    top = H
    ps = s1 + 0.24
    for k in range(5):
        t = -ps / 2 + 0.05 + k * (ps - 0.1) / 4
        lib.box((cx + t, cy, top + 0.04), (0.07, ps + 0.12, 0.07), beam)
    for k in range(9):
        t = -ps / 2 + (k + 0.5) * ps / 9
        lib.box((cx, cy + t, top + 0.1), (ps, ps / 9 - 0.01, 0.03), plank, rot=(0, 0, rnd.uniform(-0.02, 0.02)))
    rail = 0.3
    for x in (cx - ps / 2, cx + ps / 2):
        for y in (cy - ps / 2, cy + ps / 2):
            lib.box((x, y, top + 0.1 + rail / 2), (0.07, 0.07, rail + 0.06), beam)
    for side in range(4):
        horiz = side % 2 == 0
        sgn = -1 if side < 2 else 1
        for z in (top + 0.12, top + 0.1 + rail):
            if horiz:
                lib.box((cx, cy + sgn * ps / 2, z), (ps, 0.05, 0.05), beam)
            else:
                lib.box((cx + sgn * ps / 2, cy, z), (0.05, ps, 0.05), beam)
        ang = math.atan2(rail, ps / 2)
        for half_ in (-1, 1):
            if horiz:
                lib.box((cx + half_ * ps / 4, cy + sgn * ps / 2, top + 0.11 + rail / 2), (math.hypot(ps / 2, rail), 0.04, 0.04),
                        beam, rot=(0, half_ * ang, 0))
            else:
                lib.box((cx + sgn * ps / 2, cy + half_ * ps / 4, top + 0.11 + rail / 2), (0.04, math.hypot(ps / 2, rail), 0.04),
                        beam, rot=(-half_ * ang, 0, 0))
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


def build_house_large():
    """Large house: a stone ground floor, a half-timbered upper floor and a steep roof of blue-grey
    slate; a lower wing with a red tile roof."""
    B = _b()
    rnd = random.Random(31)
    walls = stone_walls()
    blocks = block_mats()
    plaster = lib.mat_grain('plaster', (0.84, 0.76, 0.6), (0.94, 0.88, 0.74), scale=14, stretch=(1, 1, 1), bump=0.3)
    beam = lib.mat_grain('timber', (0.2, 0.11, 0.05), (0.34, 0.2, 0.09), scale=5, stretch=(1, 1, 8), bump=0.6)
    slates = [lib.mat_grain(f'slate{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.22, 0.27, 0.36), (0.36, 0.42, 0.52)),
        ((0.3, 0.35, 0.45), (0.46, 0.52, 0.62)),
        ((0.18, 0.22, 0.3), (0.3, 0.35, 0.44)),
    ))]
    tiles = lib.mat_tiles('tiles', (0.86, 0.42, 0.2), (0.72, 0.3, 0.14), (0.3, 0.12, 0.05), scale=6, along='y')
    door = lib.mat_grain('door', (0.36, 0.2, 0.08), (0.56, 0.34, 0.14), scale=4, stretch=(1, 1, 9), bump=0.6)
    glass = lib.mat_flat('glass', (0.45, 0.6, 0.72), rough=0.2)
    earth_pad((0.15, -0.35, 0), 1.45, 1.55, seed=31)
    lib.tag(0)

    cx, cy, L, W = -0.25, 0.15, 1.5, 1.15
    H1, H2, rh = 0.45, 0.42, 0.62
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    wx, wy, wL, wW, wH, wrh = 0.85, 0.0, 0.7, 0.9, 0.5, 0.32  # wing on the +X side
    corner_stakes(x0, wx + wL / 2, y0, y1)
    lib.tag(0, until=0)

    B.timber_frame(cx, cy, L, W, H1 + H2, rh, beam, axis='x')
    lib.box((cx, cy, 0.05), (L + 0.06, W + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.tag(1, until=3)

    lib.box((cx, cy, H1 / 2), (L, W, H1), walls)
    stone_course(x0, x1, y0, y1, 0.0, H1, blocks, rnd, block=0.19)
    lib.box((wx, wy, wH / 2), (wL, wW, wH), walls)
    stone_course(wx - wL / 2, wx + wL / 2, wy - wW / 2, wy + wW / 2, 0.0, wH, blocks, rnd, block=0.19)
    lib.gable((wx, wy, wH), wL - 0.02, wrh - 0.02, wy - wW / 2 + 0.01, blocks[0], along='y')
    lib.tag(2)
    half_timber(x0, x1, y0, y1, H1, H1 + H2, plaster, beam, rnd)
    lib.gable((cx, cy, H1 + H2), W - 0.02, rh - 0.02, x0 + 0.01, plaster, along='x')
    lib.gable((cx, cy, H1 + H2), W - 0.02, rh - 0.02, x1 - 0.01, plaster, along='x')
    for k in range(3):
        window(x0 + 0.3 + k * 0.45, y0 - 0.02, H1 + H2 * 0.5, 0.16, 0.16, beam, glass)
    window(x1 + 0.03, cy + 0.2, H1 + H2 * 0.5, 0.16, 0.16, beam, glass, face='x')
    lib.box((cx + 0.35, y0 - 0.03, 0.2), (0.24, 0.04, 0.4), door, bevel=0.01)
    lib.box((cx + 0.35, y0 - 0.05, 0.42), (0.32, 0.06, 0.05), blocks[2], bevel=0.01)
    window(x0 + 0.3, y0 - 0.02, 0.24, 0.14, 0.14, beam, glass)
    lib.tag(3)

    slate_roof(cx, cy, L, W, H1 + H2, rh, slates, axis='x', seed=33)
    lib.tag(None, split=lambda o: 3 if o.location.y < cy - 0.05 else 4)
    lib.prism_roof((wx, wy, wH), wW, wL, wrh, tiles, overhang=0.09, thickness=0.06, along='y')
    lib.box((wx, wy, wH + wrh + 0.02), (0.08, wW + 0.18, 0.06), lib.mat_flat('ridge', (0.55, 0.22, 0.1)), bevel=0.02)
    window(wx + wL / 2 + 0.03, wy, wH * 0.55, 0.14, 0.14, beam, glass, face='x')
    # Chimney.
    lib.box((cx - 0.4, cy + 0.3, H1 + H2 + rh * 0.7), (0.17, 0.17, 0.55), blocks[1], bevel=0.01)
    lib.tag(4)
