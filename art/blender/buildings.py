"""Settlers 4 style models of the starting buildings: sawmill, stonecutter, small tower, large house.

Each is tagged with construction stages like the woodcutter (`lib.tag`): 0 stakes on cleared earth,
1 frame or foundation, 2 lower walls, 3 walls and half the roof, 4 finished. Goods are never part of
a model (the game draws the real piles at the door).

World X is tile x, world Y is minus tile y; a 2×2 footprint spans ±1 around the origin and its door
tile is at (0.5, −1.5), a 3×3 one spans ±1.5 with the door at (1, −2), a 4×4 one ±2 with the door at
(1.5, −2.5). The camera sees the −Y and +X walls, so doors go on the −Y wall.

Heights follow Settlers 4 measured in settler heights (docs/PROPORTIONS.md): the small tower a little
taller than a small house, the big tower about 15 % over the small one, the lookout lower than the small
tower, the castle about two houses.

The shared helpers (log walls, board roofs, stakes, timber frames, materials) live in build.py, the
script Blender runs; they are reached through `__main__` at call time.
"""

import math
import os
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


# Where a military building's garrison is seen (Settlers 4): the archers on the top behind the parapet,
# the swordsmen looking out of windows in the stone. Screen points from the sprite anchor like
# BANNER_AT (art3d.ts copies them into ART3D_POSTS, `ranged` and `melee`); what stands before them —
# the walls round the windows, the near rails or merlons — is tagged `front` (`mark_front`) and rendered
# again on its own as `<name>-front.png`, which the game draws over the figures. A window's dark opening
# is tagged `window`: the front pass leaves a hole there, through which the swordsman shows.
POSTS = {}


#: How tall a figure on a building is (the game's settler at its `CREW_SCALE`), in world units: a
#: swordsman at a window stands this far below its top, so that his head shows under the lintel.
CREW_HEIGHT = 0.8


def note_posts(name, ranged, melee, at=lambda p: p):
    """Records (and prints) the garrison's posts, in sprite pixels from the anchor: the archers' on the
    top (world points), and for each window (`garrison_window`'s, before `at` maps the model to its
    final scale) where the swordsman's feet go and how far above them its sill is (`cut`, screen px)."""
    scene = bpy.context.scene
    ox, oy = lib.screen_point(scene, (0, 0, 0))

    def px(p):
        sx, sy = lib.screen_point(scene, p)
        return (round(sx - ox, 1), round(sy - oy, 1))

    windows = []
    for (x, y, top, sill) in melee:
        tx, ty, tz = at((x, y, top))
        feet = (tx, ty, tz - CREW_HEIGHT)
        sz = at((x, y, sill))[2]
        windows.append((*px(feet), round(px((tx, ty, sz))[1] * -1 + px(feet)[1], 1)))
    POSTS[name] = {'ranged': [px(at(p)) for p in ranged], 'melee': windows}
    print('posts', name, POSTS[name])


def mark_front(test):
    """Tags `front` the meshes standing before the garrison's posts: `test(centre, top)` on each
    object's world bounding box (its centre and highest z). Window openings never are (they are the
    holes the swordsmen look out of), nor the ground pad."""
    from mathutils import Vector

    bpy.context.view_layer.update()
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or obj.name == 'ShadowCatcher' or obj.get('window'):
            continue
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        centre = sum(corners, Vector()) / 8
        top = max(v.z for v in corners)
        if top > 0.05 and test(centre, top):
            obj['front'] = 1


def garrison_window(face, at, plane, zc, w, h, dark, stones, out=0.13):
    """A window a swordsman of the garrison looks out of, standing `out` proud of a −Y (face 'y', `plane`
    its y) or +X (face 'x', `plane` its x) wall at `at` along it, centred at height zc: a dark opening
    (tagged `window`) between stone jambs, under a lintel, on a sill. Returns the point just inside it
    with the heights of its top and sill (for `note_posts`)."""
    k = len(stones)
    if face == 'y':
        y = plane - out
        lib.box((at, y, zc), (w, 0.03, h), dark)['window'] = 1
        for sx in (-1, 1):
            lib.box((at + sx * (w / 2 + 0.035), y - 0.01, zc), (0.07, 0.07, h + 0.02), stones[(sx + 2) % k], bevel=0.015)
        lib.box((at, y - 0.015, zc + h / 2 + 0.045), (w + 0.16, 0.09, 0.09), stones[2 % k], bevel=0.02)
        lib.box((at, y - 0.025, zc - h / 2 - 0.03), (w + 0.12, 0.1, 0.06), stones[3 % k], bevel=0.02)
        return (at, y + 0.1, zc + h / 2, zc - h / 2)
    x = plane + out
    lib.box((x, at, zc), (0.03, w, h), dark)['window'] = 1
    for sy in (-1, 1):
        lib.box((x + 0.01, at + sy * (w / 2 + 0.035), zc), (0.07, 0.07, h + 0.02), stones[(sy + 2) % k], bevel=0.015)
    lib.box((x + 0.015, at, zc + h / 2 + 0.045), (0.09, w + 0.16, 0.09), stones[2 % k], bevel=0.02)
    lib.box((x + 0.025, at, zc - h / 2 - 0.03), (0.1, w + 0.12, 0.06), stones[3 % k], bevel=0.02)
    return (x - 0.1, at, zc + h / 2, zc - h / 2)


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


def stone_course(x0, x1, y0, y1, z0, z1, mats, rnd, block=0.16, depth=0.05, faces=('y', 'x'), holes=()):
    """Rugged blocks proud of a wall's two visible faces (−Y and +X, or those of them in `faces`),
    between heights z0 and z1: the lumpy masonry of Settlers 4 stone buildings. Every block gets its
    own tone, size, depth and tilt, with dark gaps between them. `holes` are openings left free of
    blocks, each (face, a0, a1, hz0, hz1): along X from a0 to a1 on face 'y', along Y on face 'x'."""
    if not isinstance(mats, list):
        mats = [mats]
    rows = max(1, round((z1 - z0) / (block * 0.7)))
    h = (z1 - z0) / rows

    def one(loc, size, rot):
        lib.box(loc, size, mats[rnd.randrange(len(mats))], rot=rot, bevel=0.02)

    def clip(p, w, cuts):  # (start, width) cut short before an opening; width 0 inside one
        for (a0, a1) in cuts:
            if a0 <= p < a1:
                return a1, 0.0
            if p < a0 < p + w:
                w = a0 - p
        return p, w

    for r in range(rows):
        z = z0 + (r + 0.5) * h
        shift = (r % 2) * block / 2
        cuts = {f: [(a0, a1) for (g, a0, a1, hz0, hz1) in holes if g == f and hz0 < z + h / 2 and hz1 > z - h / 2]
                for f in ('y', 'x')}
        x = x0 - shift
        while 'y' in faces and x < x1:
            w = min(block * rnd.uniform(0.65, 1.35), x1 - x)
            x, w = clip(x, w, cuts['y'])
            if w > 0.04:
                d = depth * rnd.uniform(0.6, 1.4)
                one((x + w / 2, y0 - d / 2, z + rnd.uniform(-0.01, 0.01)), (w - 0.035, d, h * rnd.uniform(0.74, 0.88)),
                    (rnd.uniform(-0.06, 0.06), rnd.uniform(-0.08, 0.08), rnd.uniform(-0.05, 0.05)))
            x += w
        y = y0 - shift
        while 'x' in faces and y < y1:
            w = min(block * rnd.uniform(0.65, 1.35), y1 - y)
            y, w = clip(y, w, cuts['x'])
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


def vboard_walls(x0, x1, y0, y1, z0, z1, mats, core, post, rnd, board=0.09, faces=('y', 'x'), skip=None):
    """Walls of vertical boards on the visible faces (−Y, +X) over a dark core, uneven at the top and
    bottom, with corner posts. `skip(face, a)` leaves out the boards where a door or window goes."""
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0), core)
    for face in faces:
        a0, a1 = (x0, x1) if face == 'y' else (y0, y1)
        n = max(2, round((a1 - a0) / board))
        w = (a1 - a0) / n
        for k in range(n):
            a = a0 + (k + 0.5) * w
            if skip and skip(face, a):
                continue
            lo, hi = z0 + rnd.uniform(0, 0.015), z1 - rnd.uniform(0, 0.02)
            off = rnd.uniform(0.006, 0.014)
            mat = mats[rnd.randrange(len(mats))]
            if face == 'y':
                lib.box((a, y0 - off, (lo + hi) / 2), (w * 0.88, 0.024, hi - lo), mat,
                        rot=(0, rnd.uniform(-0.015, 0.015), 0), bevel=0.005)
            else:
                lib.box((x1 + off, a, (lo + hi) / 2), (0.024, w * 0.88, hi - lo), mat,
                        rot=(rnd.uniform(-0.015, 0.015), 0, 0), bevel=0.005)
    for (x, y) in ((x0, y0), (x1, y0), (x1, y1)):
        lib.box((x, y, (z0 + z1) / 2), (0.065, 0.065, z1 - z0 + 0.02), post, bevel=0.008)


def vboard_gable(cx, y, half, H, rh, mats, rnd, board=0.09, face='x', x=None):
    """Vertical boards filling a gable triangle: on a +X gable at x (ridge along X, the triangle spans
    Y round `y`) or on a −Y gable at y (ridge along Y, spanning X round cx)."""
    n = max(2, round(2 * half / board))
    w = 2 * half / n
    for k in range(n):
        a = -half + (k + 0.5) * w
        top = H + rh * (1 - abs(a) / half) - 0.02
        if top - H < 0.03:
            continue
        mat = mats[rnd.randrange(len(mats))]
        if face == 'x':
            lib.box((x + 0.012, y + a, (H + top) / 2), (0.024, w * 0.88, top - H), mat, bevel=0.004)
        else:
            lib.box((cx + a, y - 0.012, (H + top) / 2), (w * 0.88, 0.024, top - H), mat, bevel=0.004)


def panel_face(e0, e1, r0, r1, frame, panels, iron, rnd, cols=3, rows=2, lift=0.03):
    """One roof face (eave e0→e1 up to ridge r0→r1) of square plank panels in darker frames, iron
    rivets at the panel corners: the Settlers 4 sawmill's roof."""
    from mathutils import Vector

    e0, e1, r0, r1 = (Vector(p) for p in (e0, e1, r0, r1))
    along, up = e1 - e0, r0.lerp(r1, 0.5) - e0.lerp(e1, 0.5)
    u = along.normalized()
    n = u.cross(up.normalized()).normalized()
    if n.z < 0:
        n = -n
    centre = e0.lerp(e1, 0.5) + up * 0.5
    place_on(lib.box((0, 0, 0), (along.length, up.length, 0.035), frame, bevel=0.006), centre, u, up)
    for r in range(rows):
        for c in range(cols):
            p = e0 + along * ((c + 0.5) / cols) + up * ((r + 0.5) / rows) + n * lift
            w, h = along.length / cols * 0.84, up.length / rows * 0.8
            place_on(lib.box((0, 0, 0), (w, h, 0.026), panels[rnd.randrange(len(panels))], bevel=0.005), p,
                     u + Vector((0, 0, rnd.uniform(-0.02, 0.02))), up)
            for da in (-0.38, 0.38):
                for db in (-0.36, 0.36):
                    q = p + along * (da / cols) + up * (db / rows) + n * 0.02
                    lib.sphere(tuple(q), 0.017, iron, subdiv=2)


def build_sawmill():
    """After the Settlers 4 Roman sawmill: all dark wood of vertical boards. A low front block under a
    gable roof of riveted square plank panels (ridge along X), a big doorway in a heavy light timber
    frame in its wall towards the camera's left; behind it a taller block — a second storey with a
    window of two blue panes over the front roof — under a flat roof of broad boards; on the right
    the great half-drum of logs lying along its axis, bound by two iron hoops, its open end ragged
    with log ends; a saw-horse in front."""
    rnd = random.Random(7)
    beam = beam_mat()
    ends = ends_mat()
    planks = grain_set('swplank', (((0.26, 0.13, 0.05), (0.5, 0.28, 0.12)), ((0.32, 0.17, 0.07), (0.58, 0.35, 0.16)),
                                   ((0.22, 0.11, 0.05), (0.42, 0.24, 0.1)), ((0.36, 0.2, 0.08), (0.64, 0.4, 0.18))),
                       scale=4, stretch=(1, 1, 9), bump=0.8)
    panels = grain_set('swpanel', (((0.4, 0.25, 0.1), (0.68, 0.48, 0.22)), ((0.46, 0.3, 0.12), (0.74, 0.54, 0.26)),
                                   ((0.36, 0.22, 0.09), (0.6, 0.42, 0.19))), scale=5, stretch=(1, 7, 1), bump=0.7)
    roofb = grain_set('swroof', (((0.32, 0.18, 0.08), (0.56, 0.36, 0.17)), ((0.4, 0.24, 0.1), (0.64, 0.44, 0.2)),
                                 ((0.28, 0.16, 0.07), (0.5, 0.32, 0.14))), scale=4, stretch=(9, 1, 1), bump=0.7)
    frame = lib.mat_grain('swframe', (0.18, 0.09, 0.04), (0.32, 0.18, 0.08), scale=5, stretch=(1, 1, 8), bump=0.5)
    jamb = lib.mat_grain('swjamb', (0.56, 0.38, 0.14), (0.82, 0.62, 0.28), scale=5, stretch=(1, 1, 8), bump=0.6)
    core = lib.mat_flat('swcore', (0.14, 0.08, 0.04))
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    glass = lib.mat_flat('glass', (0.5, 0.68, 0.9), rough=0.15)
    iron = lib.mat_flat('iron', (0.26, 0.27, 0.3), rough=0.35)
    drum_logs = lib.mat_grain('drumlogs', (0.42, 0.17, 0.07), (0.74, 0.38, 0.17), scale=6, stretch=(1, 1, 7), bump=0.9)
    earth_pad((0.05, -0.12, 0), 1.06, 1.06, seed=8)
    lib.tag(0)

    # Front block (door in its −Y wall), tall block behind it, half-drum on the +X side.
    fx0, fx1, fy0, fy1, fH, frh = -0.94, -0.16, -0.96, -0.3, 0.54, 0.3
    tx0, tx1, ty0, ty1, tH = -0.94, -0.08, -0.36, 0.66, 1.08
    dx0, dx1, dcy, dr = -0.08, 0.9, 0.14, 0.5  # drum from dx0 to dx1 along X, centre y, radius
    fcy = (fy0 + fy1) / 2
    corner_stakes(fx0, dx1, fy0, ty1)
    lib.tag(0, until=0)

    B = _b()
    B.timber_frame((fx0 + fx1) / 2, fcy, fx1 - fx0, fy1 - fy0, fH, frh, beam, axis='x')
    B.timber_frame((tx0 + tx1) / 2, (ty0 + ty1) / 2, tx1 - tx0, ty1 - ty0, tH, 0.04, beam, axis='x')
    for x in (dx0 + 0.2, dx1 - 0.16):  # the drum's arched ribs
        pts = [(x, dcy + math.cos(a) * (dr - 0.06), 0.02 + math.sin(a) * (dr - 0.06)) for a in
               [k / 8 * math.pi for k in range(9)]]
        for a, b in zip(pts, pts[1:]):
            rod(a, b, 0.03, beam, verts=6)
    lib.tag(1, until=3)

    # Walls of vertical boards; the doorway in the front block's −Y face.
    door_x, door_w, door_h = (fx0 + fx1) / 2 - 0.04, 0.34, 0.44
    gap = lambda face, a: face == 'y' and abs(a - door_x) < door_w / 2 + 0.02
    vboard_walls(fx0, fx1, fy0, fy1, 0.0, fH, planks, core, frame, rnd, skip=gap)
    vboard_walls(tx0, tx1, ty0, ty1, 0.0, fH, planks, core, frame, rnd, faces=('x',))
    lib.box((door_x, fy0 + 0.1, door_h / 2), (door_w, 0.22, door_h), dark)
    lib.tag(None, split=lambda o: 2 if o.location.z < fH * 0.6 else 3)
    vboard_walls(tx0, tx1, ty0, ty1, fH, tH, planks, core, frame, rnd)
    vboard_gable(0, fcy, (fy1 - fy0) / 2, fH, frh, planks, rnd, face='x', x=fx1)
    lib.gable(((fx0 + fx1) / 2, fcy, fH), fy1 - fy0, frh, fx1, core, along='x')
    # The doorway's heavy light frame: two posts, a lintel, a sill; a saw dim inside.
    for sgn in (-1, 1):
        lib.box((door_x + sgn * (door_w / 2 + 0.02), fy0 - 0.03, door_h / 2 + 0.01), (0.07, 0.07, door_h + 0.04), jamb,
                rot=(0, sgn * 0.03, 0), bevel=0.01)
    lib.box((door_x, fy0 - 0.035, door_h + 0.04), (door_w + 0.16, 0.08, 0.07), jamb, bevel=0.01)
    lib.box((door_x, fy0 - 0.04, 0.02), (door_w + 0.1, 0.1, 0.04), jamb, bevel=0.008)
    lib.box((door_x + 0.06, fy0 + 0.12, 0.2), (0.03, 0.03, 0.38), iron)
    lib.cylinder((door_x - 0.04, fy0 + 0.1, 0.16), 0.11, 0.01, lib.mat_flat('sawblade', (0.32, 0.34, 0.36), rough=0.3),
                 rot=(math.pi / 2, 0, 0), verts=20)
    window(fx1 + 0.02, fcy, 0.3, 0.15, 0.15, jamb, glass, face='x')
    # Two blue panes in a light frame on the upper storey, just over the front roof.
    wz, wx = fH + frh + 0.14, (tx0 + tx1) / 2 - 0.04
    lib.box((wx, ty0 - 0.03, wz), (0.34, 0.03, 0.2), jamb, bevel=0.008)
    for dx in (-0.08, 0.08):
        lib.box((wx + dx, ty0 - 0.05, wz), (0.12, 0.02, 0.14), glass)
    lib.box((wx, ty0 - 0.05, wz - 0.12), (0.4, 0.06, 0.04), jamb, bevel=0.006)
    # The half-drum: logs lying along X round a half circle, uneven at the open (+X) end, which
    # shows a dark inside behind the log ends.
    n = 13
    for k in range(n):
        a = (k + 0.5) / n * math.pi
        y = dcy + math.cos(a) * dr
        z = 0.03 + math.sin(a) * dr
        x_end = dx1 + rnd.uniform(-0.1, 0.06)
        lib.cylinder(((dx0 + x_end) / 2, y, z), 0.072, x_end - dx0, drum_logs,
                     rot=(rnd.uniform(-0.02, 0.02), math.pi / 2, 0), verts=10)
        lib.cylinder((x_end + 0.002, y, z), 0.066, 0.01, ends, rot=(0, math.pi / 2, 0), verts=10)
    lib.cylinder((dx1 - 0.14, dcy, 0.0), dr - 0.05, 0.04, lib.mat_flat('druminside', (0.12, 0.07, 0.04)),
                 rot=(0, math.pi / 2, 0), verts=24)
    for k in range(5):  # a few logs lying inside, ends showing
        y = dcy + (k - 2) * 0.13
        lib.cylinder((dx1 - 0.2, y, 0.06 + (k % 2) * 0.05), 0.06, 0.3, drum_logs, rot=(0, math.pi / 2, 0), verts=10)
        lib.cylinder((dx1 - 0.049, y, 0.06 + (k % 2) * 0.05), 0.055, 0.01, ends, rot=(0, math.pi / 2, 0), verts=10)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.3 else 3)

    # Roofs: the front block's riveted panels, the tall block's flat broad boards.
    fcx = (fx0 + fx1) / 2
    ov = 0.1
    drop = ov * frh / ((fy1 - fy0) / 2)
    for side in (-1, 1):
        ye = fcy + side * ((fy1 - fy0) / 2 + ov)
        panel_face((fx0 - 0.06, ye, fH - drop), (fx1 + 0.08, ye, fH - drop), (fx0 - 0.06, fcy, fH + frh + 0.01),
                   (fx1 + 0.08, fcy, fH + frh + 0.01), frame, panels, iron, rnd, cols=3, rows=2)
    lib.tag(None, split=lambda o: 3 if o.location.x > fcx else 4)
    nb = 7
    for k in range(nb):
        y = ty0 - 0.1 + (k + 0.5) * (ty1 - ty0 + 0.2) / nb
        z = tH + 0.03 + (y - ty0) * 0.06
        lib.box(((tx0 + tx1) / 2 + rnd.uniform(-0.03, 0.03), y, z),
                (tx1 - tx0 + 0.16 + rnd.uniform(-0.05, 0.03), (ty1 - ty0 + 0.2) / nb * 0.9, 0.035),
                roofb[rnd.randrange(len(roofb))], rot=(math.atan(0.06) + rnd.uniform(-0.02, 0.02), 0, rnd.uniform(-0.02, 0.02)),
                bevel=0.006)
    lib.box(((tx0 + tx1) / 2, ty0 - 0.08, tH + 0.0), (tx1 - tx0 + 0.18, 0.05, 0.06), frame, bevel=0.008)
    # The drum's iron hoops.
    for x in (dx0 + 0.3, dx0 + 0.7):
        pts = [(x, dcy + math.cos(a) * (dr + 0.075), 0.03 + math.sin(a) * (dr + 0.075)) for a in
               [-0.05 + k / 14 * (math.pi + 0.1) for k in range(15)]]
        for a, b in zip(pts, pts[1:]):
            rod(a, b, 0.024, iron, verts=6)
    # A saw-horse of crossed poles with a log on it.
    hx, hy = 0.42, -0.74
    for dx in (-0.16, 0.16):
        for sgn in (-1, 1):
            lib.box((hx + dx, hy, 0.13), (0.035, 0.035, 0.32), beam, rot=(sgn * 0.5, 0, 0), bevel=0.005)
    lib.cylinder((hx, hy, 0.22), 0.055, 0.5, drum_logs, rot=(0, math.pi / 2, 0), verts=10)
    for dx in (-0.25, 0.25):
        lib.cylinder((hx + dx, hy, 0.22), 0.05, 0.01, ends, rot=(0, math.pi / 2, 0), verts=10)
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


def gable_prism(cx, y0, y1, half, H, rh, mat):
    """A solid triangular gable wall (ridge along Y) between y0 and y1: base 2·half wide at height H,
    apex rh above it."""
    verts = [(cx - half, y0, H), (cx + half, y0, H), (cx, y0, H + rh),
             (cx - half, y1, H), (cx + half, y1, H), (cx, y1, H + rh)]
    faces = [(0, 1, 2), (3, 5, 4), (0, 3, 4, 1), (1, 4, 5, 2), (2, 5, 3, 0)]
    mesh = bpy.data.meshes.new('gprism')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('gprism', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def gable_blocks(cx, half, y, H, rh, mats, rnd, block=0.2, depth=0.07, band=0.13):
    """Rugged blocks on the −Y face (at y) of a triangular gable over H: rows shrinking with height."""
    z = H
    while z < H + rh - 0.06:
        zt = min(H + rh, z + band)
        hw = half * (1 - (zt - H) / rh) + 0.02
        if hw > 0.06:
            stone_course(cx - hw, cx + hw, y, y, z, zt, mats, rnd, block=block, depth=depth, faces=('y',))
        z = zt


def board_slope(e0, e1, r0, r1, mats, rnd, width=0.13, thick=0.035, gap=0.022, out=0.0, sag=0.012):
    """One roof slope of wide loose boards running from the eave edge e0→e1 up to the ridge edge
    r0→r1 (boards down the slope), each its own tone, length and lie, with dark gaps between."""
    from mathutils import Vector

    e0, e1, r0, r1 = (Vector(p) for p in (e0, e1, r0, r1))
    along = (e1 - e0)
    n = max(2, round(along.length / width))
    made = []
    for k in range(n):
        t = (k + 0.5) / n
        a, b = e0.lerp(e1, t), r0.lerp(r1, t)
        up = b - a
        u = along.normalized()
        nrm = u.cross(up.normalized()).normalized()
        if nrm.z < 0:
            nrm = -nrm
        ln = up.length + out + rnd.uniform(-0.05, 0.04)
        mid = a + up * 0.5 + nrm * (thick / 2 + rnd.uniform(0, sag)) - up.normalized() * (out / 2)
        board = lib.box((0, 0, 0), (along.length / n - gap, ln, thick), mats[rnd.randrange(len(mats))], bevel=0.006)
        jit = Vector((rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), 0))
        place_on(board, mid, u + jit * 0.5, up)
        made.append(board)
    return made


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


def frustum(cx, cy, z0, z1, x0, x1, y0, y1, t0, t1, mat, sides=(1, 1, 1, 1)):
    """A block whose sides lean in: the rectangle x0..x1 × y0..y1 at z0, each side (x0, x1, y0, y1 flags
    in `sides`) moved in by t0 at z0 and by t1 at z1 (a battered wall core). Its origin is its centre,
    so stage splits by height work."""
    zc = (z0 + z1) / 2
    verts = []
    for (z, t) in ((z0, t0), (z1, t1)):
        ax, bx, ay, by = (x0 + t * sides[0], x1 - t * sides[1], y0 + t * sides[2], y1 - t * sides[3])
        for (x, y) in ((ax, ay), (bx, ay), (bx, by), (ax, by)):
            verts.append((x - cx, y - cy, z - zc))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    mesh = bpy.data.meshes.new('frustum')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('frustum', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (cx, cy, zc)
    obj.data.materials.append(mat)
    return obj


def battered_courses(x0, x1, y0, y1, z0, z1, lean, walls, blocks, rnd, courses, block=0.28, depth=0.1, sides=None,
                     faces=('y', 'x')):
    """Masonry whose faces lean back as it rises (Settlers 4's battered tower walls): `lean(z)` is how
    far a face has moved in at height z; each course is a slice of the core with rugged blocks and
    quoins on its visible faces, as wide as the core at the course's middle. `sides` (x0, x1, y0, y1
    flags) says which faces lean; the others stay plumb. `faces` are the visible faces dressed in blocks
    (`stone_course`)."""
    sides = sides or (1, 1, 1, 1)
    for c in range(courses):
        za, zb = z0 + (z1 - z0) * c / courses, z0 + (z1 - z0) * (c + 1) / courses
        lm = lean((za + zb) / 2)
        xa, xb, ya, yb = x0 + lm * sides[0], x1 - lm * sides[1], y0 + lm * sides[2], y1 - lm * sides[3]
        frustum((x0 + x1) / 2, (y0 + y1) / 2, za, zb, x0, x1, y0, y1, lean(za), lean(zb), walls, sides)
        stone_course(xa, xb, ya, yb, za, zb, blocks, rnd, block=block, depth=depth, faces=faces)
        quoins(xa, xb, ya, yb, za, zb, blocks, rnd, block=block * 0.95, row=zb - za)


def leaning(obj_list, angle, axis):
    """Tilts objects about their own centres so they lie on a battered face: a −Y face (axis 'x')
    or a +X face (axis 'y') leaning back by `angle`."""
    for o in obj_list:
        if axis == 'x':
            o.rotation_euler.x -= angle
        else:
            o.rotation_euler.y -= angle


def plank_door(x, y, z0, w, h, door, dark, iron, lintel, angle=0.0):
    """A strapped plank door in a −Y wall (its face at y at the door's mid height), under a stone
    lintel, leaning back with the wall by `angle`."""
    zc = z0 + h / 2
    parts = [lib.box((x, y + 0.03, zc), (w + 0.04, 0.04, h + 0.02), dark)]
    for k in range(4):
        parts.append(lib.box((x - w / 2 + (k + 0.5) * w / 4, y, zc), (w / 4 * 0.92, 0.035, h), door, bevel=0.006))
    for z in (z0 + 0.1, z0 + h * 0.58):
        parts.append(lib.box((x, y - 0.025, z), (w + 0.02, 0.012, 0.035), iron, bevel=0.004))
    for o in parts:
        # Lean about the door's middle: points above it move back into the wall.
        dz = o.location.z - zc
        o.location.y += dz * math.tan(angle)
    leaning(parts, angle, 'x')
    top = lib.box((x, y - 0.03 + h / 2 * math.tan(angle), z0 + h + 0.06), (w + 0.16, 0.1, 0.12), lintel, bevel=0.025)
    for sx in (-1, 1):
        lib.box((x + sx * (w / 2 + 0.05), y - 0.02, zc), (0.09, 0.1, h + 0.04), lintel, rot=(-angle, 0, 0), bevel=0.02)
    return top


# Archers' posts on the top (model units from the top's centre), one per archer slot of the garrison;
# none right behind the banner, whose cloth would hide them. The swordsmen's are the windows.
TOWER_POSTS = ((-0.12, -0.36), (0.36, 0.12))
BIGTOWER_POSTS = ((-0.15, -0.55), (0.55, 0.15), (0.42, -0.42))


def build_tower():
    """After the Settlers 4 small tower: a square stone shaft clearly higher than wide that narrows
    towards the top (battered walls: about two thirds as wide under the platform as at its foot; ≈ 4.4
    settler heights with its platform), standing on a stepped plinth, big rugged blocks with staggered
    quoins, a strapped plank door, a dark lookout opening high on the right face; on top an overhanging
    timber platform on corner struts with a box railing of thick round beams, X-braced on every side.
    The owner's banner is drawn by the game at ART3D_BANNERS['tower']."""
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

    # Foot and top width of the shaft, where it starts (on the plinth) and where the platform sits.
    cx, cy, s0, s1, Z0, H = 0.05, 0.05, 0.96, 0.62, 0.14, 1.3
    corner_stakes(cx - s0 / 2 - 0.05, cx + s0 / 2 + 0.05, cy - s0 / 2 - 0.05, cy + s0 / 2 + 0.05)
    lib.tag(0, until=0)

    def width(z):
        return s0 + (s1 - s0) * (z - Z0) / (H - Z0)

    def face(z):  # how far a face has moved in from the foot's
        return (s0 - width(z)) / 2

    batter = math.atan((s0 - s1) / 2 / (H - Z0))
    # A stepped plinth, wider than the shaft's foot.
    lib.box((cx, cy, 0.04), (s0 + 0.2, s0 + 0.2, 0.08), blocks[1], bevel=0.02)
    lib.box((cx, cy, 0.11), (s0 + 0.1, s0 + 0.1, 0.07), blocks[3], bevel=0.02)
    for x in (cx - s0 / 2 - 0.14, cx + s0 / 2 + 0.14):
        for y in (cy - s0 / 2 - 0.14, cy + s0 / 2 + 0.14):
            lib.cylinder((x, y, 0.85), 0.025, 1.7, beam, verts=8)
    lib.tag(1, until=3)

    # The shaft: courses of rugged blocks with quoins over a core that leans in on every side.
    x0, x1, y0, y1 = cx - s0 / 2, cx + s0 / 2, cy - s0 / 2, cy + s0 / 2
    battered_courses(x0, x1, y0, y1, Z0, H - 0.12, face, walls, blocks, rnd, courses=7, block=0.28, depth=0.1)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)
    # Plank door with iron straps on the front-left face, leaning back with the wall.
    dh = 0.48
    zc = Z0 + dh / 2
    plank_door(cx - 0.04, y0 + face(zc) - 0.12, Z0, 0.34, dh, door, dark, iron, blocks[2], batter)
    # The swordsman's window high on the right face (Settlers 4: he looks out of the stone, the archers
    # stand on the platform).
    wz = H - 0.47
    window_at = garrison_window('x', cy - 0.04, x1 - face(wz), wz, 0.3, 0.38, dark, blocks, out=0.14)
    lib.tag(3)

    # Corbelled top: the last course of the shaft steps out under the platform.
    cs = s1 + 0.16
    lib.box((cx, cy, H - 0.06), (cs - 0.04, cs - 0.04, 0.12), walls)
    stone_course(cx - cs / 2, cx + cs / 2, cy - cs / 2, cy + cs / 2, H - 0.12, H, blocks, rnd, block=0.2, depth=0.06)
    lib.tag(3)

    # Overhanging timber platform on two layers of joists poking out on every side, a plank floor, a
    # box railing of round beams.
    top = H
    ps = 1.0
    for k in range(4):
        t = -cs / 2 + 0.07 + k * (cs - 0.14) / 3
        lib.box((cx, cy + t, top - 0.04), (ps + 0.16, 0.08, 0.08), beam, bevel=0.01)
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
    # The archers on the platform left and right of the banner pole behind the near rails; the swordsman
    # at his window, behind the shaft's walls.
    floor = top + 0.13
    mark_front(lambda c, z: z < floor - 0.03 or (z > floor + 0.05 and (c.y < cy - ps / 2 + 0.12 or c.x > cx + ps / 2 - 0.12)))
    note_posts('tower', [(cx + dx, cy + dy, floor) for (dx, dy) in TOWER_POSTS], [window_at])


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


# ------------------------------------------------------------------------------------- effect anchors

# Screen-space points (relative to the sprite anchor) of a building's live effects — chimney mouths
# for smoke, the mill's sail hub — recorded while rendering; art3d.ts copies them into ART3D_FX.
FX_AT = {}


def note_fx(name, kind, point):
    scene = bpy.context.scene
    sx, sy = lib.screen_point(scene, point)
    ox, oy = lib.screen_point(scene, (0, 0, 0))
    FX_AT.setdefault(name, {}).setdefault(kind, []).append((round(sx - ox, 1), round(sy - oy, 1)))
    print('fx', name, kind, FX_AT[name][kind][-1])


# ------------------------------------------------------------------------------------- shared pieces

def straw_mat(name='straw'):
    """Golden thatch: streaky straw running downhill."""
    return lib.mat_grain(name, (0.62, 0.46, 0.14), (0.92, 0.78, 0.36), scale=9, stretch=(1, 1, 14), bump=1.0)


def terracotta_mats(prefix='tc'):
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=9, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.66, 0.26, 0.1), (0.9, 0.46, 0.22)),
        ((0.58, 0.2, 0.08), (0.82, 0.38, 0.18)),
        ((0.72, 0.32, 0.14), (0.95, 0.54, 0.28)),
    ))]


def shingle_mats(prefix='sh'):
    """Weathered wooden shingles: warm browns and a few silvered ones."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=10, stretch=(1, 4, 1), bump=0.7) for k, (a, b) in enumerate((
        ((0.42, 0.28, 0.12), (0.66, 0.48, 0.24)),
        ((0.5, 0.34, 0.15), (0.74, 0.56, 0.3)),
        ((0.46, 0.4, 0.3), (0.64, 0.58, 0.46)),
    ))]


def door_mat():
    return lib.mat_grain('door', (0.36, 0.2, 0.08), (0.56, 0.34, 0.14), scale=4, stretch=(1, 1, 9), bump=0.6)


def stone_house(x0, x1, y0, y1, z1, rnd, walls, blocks, z0=0.0, block=0.18):
    """A stone box from z0 to z1: a dark core with rugged blocks on the two visible faces."""
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), (x1 - x0, y1 - y0, z1 - z0), walls)
    stone_course(x0, x1, y0, y1, z0 + 0.04, z1, blocks, rnd, block=block, depth=0.055)


def chimney(x, y, zb, zt, blocks, rnd, name=None):
    """A square stone chimney from zb to zt; records its mouth for smoke when `name` is given."""
    z, k = zb, 0
    while z < zt:
        lib.box((x + rnd.uniform(-0.006, 0.006), y + rnd.uniform(-0.006, 0.006), z + 0.045), (0.17, 0.17, 0.085),
                blocks[k % len(blocks)], rot=(0, 0, rnd.uniform(-0.06, 0.06)), bevel=0.012)
        z += 0.09
        k += 1
    lib.box((x, y, zt + 0.03), (0.21, 0.21, 0.05), blocks[0], bevel=0.012)
    if name:
        note_fx(name, 'smoke', (x, y, zt + 0.08))


def arch_door(x, y, z0, w, h, door, stones, face='y'):
    """A plank door with a round top and a ring of voussoirs, set in the −Y wall at x."""
    r = w / 2
    lib.box((x, y - 0.04, z0 + (h - r) / 2), (w, 0.04, h - r), door, bevel=0.008)
    lib.cylinder((x, y - 0.04, z0 + h - r), r, 0.04, door, rot=(math.pi / 2, 0, 0), verts=20)
    for k in range(9):
        a = math.pi * k / 8
        lib.box((x + math.cos(a) * (r + 0.045), y - 0.07, z0 + h - r + math.sin(a) * (r + 0.045)), (0.07, 0.06, 0.08),
                stones[k % len(stones)], rot=(0, -a + math.pi / 2, 0), bevel=0.012)


# ------------------------------------------------------------------------------------- S4 shapes
# Barrel roofs of shingles, turned (lathe) bodies, nets, sheep and a horseman: the pieces of the
# Settlers 4 Roman farm buildings (farm, sheep farm, mill, slaughterhouse, fisher, market, lookout).

def grey_blocks(prefix='gb'):
    """Blue-grey squared stone of the Settlers 4 Roman walls, a few tones."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=7, stretch=(1, 1, 1), bump=1.0) for k, (a, b) in enumerate((
        ((0.3, 0.32, 0.36), (0.52, 0.55, 0.6)),
        ((0.36, 0.37, 0.4), (0.6, 0.61, 0.64)),
        ((0.25, 0.27, 0.3), (0.44, 0.46, 0.5)),
        ((0.42, 0.42, 0.43), (0.66, 0.66, 0.66)),
    ))]


def thatch_mat(name='thatch'):
    """Bright golden thatch, streaky along local Z."""
    return lib.mat_grain(name, (0.7, 0.52, 0.1), (0.98, 0.84, 0.32), scale=10, stretch=(1, 1, 16), bump=1.2)


def barrel_shingles(prefix='bsh'):
    """Wooden shingles of the barrel roofs: browns, a silvered one and the odd orange-red."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=10, stretch=(1, 4, 1), bump=0.8) for k, (a, b) in enumerate((
        ((0.36, 0.22, 0.1), (0.58, 0.4, 0.2)),
        ((0.46, 0.3, 0.13), (0.68, 0.48, 0.24)),
        ((0.46, 0.38, 0.28), (0.64, 0.56, 0.42)),
        ((0.42, 0.26, 0.11), (0.62, 0.42, 0.2)),
        ((0.6, 0.26, 0.1), (0.84, 0.44, 0.2)),
    ))]


def shingle_mix(mats):
    """Mostly brown shingles, the orange-red one (the last) about one in nine."""
    return mats[:4] * 2 + mats[4:]


def barrel_frame(cx, cy, H, axis):
    """Maps (t along the ridge, a across it, u up from the eaves) of a barrel roof to world points;
    a = +c is the eave the camera sees (−Y for a ridge along X, +X for one along Y)."""
    if axis == 'x':
        return (lambda t, a, u: (cx + t, cy - a, H + u)), (1.0, 0.0, 0.0)
    return (lambda t, a, u: (cx + a, cy + t, H + u)), (0.0, 1.0, 0.0)


def arc_points(c, s, th0, th1, n):
    return [(c * math.cos(th0 + (th1 - th0) * k / n), s * math.sin(th0 + (th1 - th0) * k / n)) for k in range(n + 1)]


def barrel_roof(cx, cy, H, length, c, s, mats, core, rim, rnd, axis='x', overhang=0.1, size=0.13, upto=0.62,
                ends=(True, True)):
    """A barrel (round-vaulted) roof as on the Settlers 4 Roman farm and sheep farm: a half-elliptic
    vault (half-width `c`, rise `s`) over walls of height H, ridge along `axis`, covered row by row
    with square wooden shingles (each its own tone, askew, the lower edge proud), up to `upto` of the
    arc on the camera's side, and a thick plank rim along each end arch (`ends`: −t, +t)."""
    from mathutils import Vector

    at, along = barrel_frame(cx, cy, H, axis)
    along = Vector(along)
    half = length / 2 + overhang
    # The vault: a solidified half-elliptic shell a little outside the walls, its eaves below the top.
    cc, ss = c + 0.07, s + 0.04
    prof = arc_points(cc, ss, -0.1, math.pi + 0.1, 28)
    verts = []
    for t in (-half, half):
        verts += [at(t, a, u) for a, u in prof]
    m = len(prof)
    faces = [(i, i + 1, m + i + 1, m + i) for i in range(m - 1)]
    mesh = bpy.data.meshes.new('vault')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('vault', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.05
    obj.data.materials.append(core)
    obj['stage'], obj['until'] = 4, 99  # the solid vault only with the finished roof: stage 3 shows the ribs
    # Shingles: walk the arc by length, a row every ~0.6 size.
    th_end = math.pi * upto
    dense = arc_points(cc + 0.025, ss + 0.025, -0.1, th_end, 400)
    acc, rows, last = 0.0, [], None
    for k, p in enumerate(dense):
        if last is not None:
            acc += math.hypot(p[0] - last[0], p[1] - last[1])
        last = p
        if not rows or acc - rows[-1][0] >= size * 0.6:
            th = -0.1 + (th_end + 0.1) * k / 400
            rows.append((acc, th))
    cols = max(2, int(2 * half / (size * 0.92)))
    for r, (_, th) in enumerate(rows):
        a, u = (cc + 0.025) * math.cos(th), (ss + 0.025) * math.sin(th)
        tan = (Vector(at(0, -cc * math.sin(th), ss * math.cos(th))) - Vector(at(0, 0, 0))).normalized()
        n = along.cross(tan).normalized()
        for k in range(cols + (r % 2)):
            t = -half + (k + 0.5 * (1 - r % 2)) * 2 * half / cols
            if abs(t) > half - size * 0.3:
                continue
            p = Vector(at(t + rnd.uniform(-0.012, 0.012), a, u)) + n * (0.012 * (r % 2))
            jitter = Vector((rnd.uniform(-0.07, 0.07), rnd.uniform(-0.07, 0.07), rnd.uniform(-0.07, 0.07)))
            # Downhill edge proud: tip the piece's up direction a little into the roof.
            place_on(roof_piece(mats[rnd.randrange(len(mats))], size, 'tile'), p, along + jitter, tan - n * 0.18)
    # Plank rims along the end arches.
    rim_prof = arc_points(cc + 0.04, ss + 0.04, -0.08, math.pi + 0.08, 22)
    for end, on in zip((-1, 1), ends):
        if not on:
            continue
        t = end * (half + 0.01)
        for (a0, u0), (a1, u1) in zip(rim_prof, rim_prof[1:]):
            p0, p1 = Vector(at(t, a0, u0)), Vector(at(t, a1, u1))
            seg = lib.box((0, 0, 0), ((p1 - p0).length + 0.012, 0.075, 0.06), rim, bevel=0.008)
            place_on(seg, (p0 + p1) / 2, p1 - p0, along)
    return at


def arch_infill(at, t, c, s, mat, thickness=0.04):
    """A solid half-elliptic slab closing a barrel vault's end at `t` (frame from `barrel_frame`)."""
    prof = arc_points(c, s, 0, math.pi, 24)
    verts = [at(t, a, u) for a, u in prof]
    mesh = bpy.data.meshes.new('infill')
    mesh.from_pydata(verts, [], [tuple(range(len(verts)))])
    obj = bpy.data.objects.new('infill', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.modifiers.new('Solid', 'SOLIDIFY').thickness = thickness
    obj.data.materials.append(mat)
    return obj


def arch_boards(at, t, c, s, mats, rnd, axis, width=0.11, out=0.02):
    """Upright boards filling a barrel vault's end arch at `t`, each cut to the arch."""
    n = max(3, int(2 * c / width))
    for k in range(n):
        a = -c + (k + 0.5) * 2 * c / n
        h = s * math.sqrt(max(0.0, 1 - (a / c) ** 2)) - 0.02
        if h < 0.05:
            continue
        x, y, z = at(t, a, h / 2)
        if axis == 'x':
            lib.box((x + out, y, z), (0.03, 2 * c / n - 0.012, h), mats[k % len(mats)], bevel=0.004,
                    rot=(rnd.uniform(-0.01, 0.01), 0, 0))
        else:
            lib.box((x, y - out, z), (2 * c / n - 0.012, 0.03, h), mats[k % len(mats)], bevel=0.004,
                    rot=(0, rnd.uniform(-0.01, 0.01), 0))


def barrel_ribs(at, along_len, c, s, beam, count=4, battens=5):
    """The bare skeleton of a barrel vault (construction stage): arched ribs and battens."""
    from mathutils import Vector

    prof = arc_points(c + 0.02, s + 0.02, 0, math.pi, 16)
    for j in range(count):
        t = -along_len / 2 + j * along_len / (count - 1)
        for (a0, u0), (a1, u1) in zip(prof, prof[1:]):
            p0, p1 = Vector(at(t, a0, u0)), Vector(at(t, a1, u1))
            seg = lib.box((0, 0, 0), ((p1 - p0).length + 0.02, 0.045, 0.045), beam)
            place_on(seg, (p0 + p1) / 2, p1 - p0, Vector(at(1, 0, 0)) - Vector(at(0, 0, 0)))
    for k in range(battens):
        th = math.pi * (k + 0.5) / battens
        a, u = (c + 0.05) * math.cos(th), (s + 0.05) * math.sin(th)
        rod(at(-along_len / 2 - 0.05, a, u), at(along_len / 2 + 0.05, a, u), 0.018, beam, verts=6)


def lathe(cx, cy, prof, mat, segs=48, a0=0.0, a1=math.tau, smooth=True, z=0.0):
    """A surface of revolution about the vertical through (cx, cy): `prof` lists (radius, height)
    from the outer bottom up; `a0`..`a1` limits it to a sector (an apse, the camera's half)."""
    full = abs(a1 - a0 - math.tau) < 1e-6
    n = segs if full else segs + 1
    verts, faces = [], []
    for j in range(n):
        a = a0 + (a1 - a0) * j / segs
        for (r, h) in prof:
            verts.append((r * math.cos(a), r * math.sin(a), h + z))
    m = len(prof)
    for j in range(segs):
        j2 = (j + 1) % n if full else j + 1
        for i in range(m - 1):
            faces.append((j * m + i, j2 * m + i, j2 * m + i + 1, j * m + i + 1))
    mesh = bpy.data.meshes.new('lathe')
    mesh.from_pydata(verts, [], faces)
    for p in mesh.polygons:
        p.use_smooth = smooth
    obj = bpy.data.objects.new('lathe', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (cx, cy, 0)
    obj.data.materials.append(mat)
    return obj


def shaggy(obj, strength=0.03, scale=0.08, seed=0):
    """Roughens a surface (thatch) with a displacement along its normals."""
    sub = obj.modifiers.new('Sub', 'SUBSURF')
    sub.levels = 1
    sub.render_levels = 1
    tex = bpy.data.textures.new(f'shag{seed}', 'CLOUDS')
    tex.noise_scale = scale
    tex.noise_depth = 2
    mod = obj.modifiers.new('Displace', 'DISPLACE')
    mod.texture = tex
    mod.strength = strength
    mod.mid_level = 0.5
    mod.texture_coords = 'GLOBAL'
    return obj


def lathe_tiles(cx, cy, prof, mats, rnd, size=0.11, shape='tile', lift=0.025, far=-0.35, z=0.0):
    """Rings of tiles or scales over a turned roof (`prof` as for `lathe`, bottom up), on the half
    the camera sees."""
    from mathutils import Vector

    dense = []
    for (r0, h0), (r1, h1) in zip(prof, prof[1:]):
        for k in range(20):
            f = k / 20
            dense.append((r0 + (r1 - r0) * f, h0 + (h1 - h0) * f))
    dense.append(prof[-1])
    acc, last, rows = 0.0, None, []
    for i, p in enumerate(dense):
        if last is not None:
            acc += math.hypot(p[0] - last[0], p[1] - last[1])
        last = p
        if not rows or acc - rows[-1][0] >= size * 0.62:
            q = dense[min(i + 1, len(dense) - 1)]
            pr = dense[max(i - 1, 0)]
            rows.append((acc, p, (q[0] - pr[0], q[1] - pr[1])))
    for k, (_, (r, h), (dr, dh)) in enumerate(rows):
        if r < size * 0.4:
            continue
        L = math.hypot(dr, dh) or 1.0
        dr, dh = dr / L, dh / L
        n = max(3, int(r * math.tau / (size * 0.9)))
        for j in range(n):
            a = (j + 0.5 * (k % 2)) / n * math.tau + rnd.uniform(-0.03, 0.03)
            if math.cos(a + math.pi / 4) < far:
                continue
            u = Vector((-math.sin(a), math.cos(a), 0))
            v = Vector((dr * math.cos(a), dr * math.sin(a), dh))
            nn = u.cross(v).normalized()
            p = Vector((cx + math.cos(a) * r, cy + math.sin(a) * r, h + z)) + nn * lift
            jitter = Vector((rnd.uniform(-0.06, 0.06), rnd.uniform(-0.06, 0.06), 0))
            place_on(roof_piece(mats[rnd.randrange(len(mats))], size * min(1.0, r / 0.3 + 0.3), shape), p, u + jitter,
                     v - nn * 0.15)


def mat_net(name, color=(0.94, 0.93, 0.88), cells=1.0, line=0.16):
    """Knotted net: a diamond mesh of white cord, transparent between (UV space, one cell per unit)."""
    mat, nodes, links, bsdf = lib._principled(name)
    bsdf.inputs['Base Color'].default_value = (*lib.lin(color), 1)
    bsdf.inputs['Roughness'].default_value = 0.9
    uv = nodes.new('ShaderNodeUVMap')
    sep = nodes.new('ShaderNodeSeparateXYZ')
    links.new(uv.outputs['UV'], sep.inputs['Vector'])

    def math_node(op, a, b=None, value=None):
        nd = nodes.new('ShaderNodeMath')
        nd.operation = op
        links.new(a, nd.inputs[0])
        if b is not None:
            links.new(b, nd.inputs[1])
        elif value is not None:
            nd.inputs[1].default_value = value
        return nd.outputs['Value']

    def cord(sock):
        f = math_node('FRACT', math_node('MULTIPLY', sock, value=cells))
        d = math_node('ABSOLUTE', math_node('SUBTRACT', f, value=0.5))
        return math_node('GREATER_THAN', d, value=0.5 - line)

    s1 = math_node('ADD', sep.outputs['X'], sep.outputs['Y'])
    s2 = math_node('SUBTRACT', sep.outputs['X'], sep.outputs['Y'])
    alpha = math_node('MAXIMUM', cord(s1), cord(s2))
    links.new(alpha, bsdf.inputs['Alpha'])
    return mat


def net_sheet(corners, mat, cells=(10, 8), sag=0.06, res=8):
    """A net hung between four points (a quad, corners in order), sagging in the middle."""
    from mathutils import Vector

    c0, c1, c2, c3 = (Vector(c) for c in corners)
    verts, faces, uvs = [], [], []
    for j in range(res + 1):
        for i in range(res + 1):
            s, t = i / res, j / res
            p = c0.lerp(c1, s).lerp(c3.lerp(c2, s), t)
            p.z -= sag * math.sin(math.pi * s) * math.sin(math.pi * t)
            verts.append(p)
    for j in range(res):
        for i in range(res):
            a = j * (res + 1) + i
            faces.append((a, a + 1, a + res + 2, a + res + 1))
    mesh = bpy.data.meshes.new('net')
    mesh.from_pydata(verts, [], faces)
    layer = mesh.uv_layers.new(name='UVMap')
    for poly in mesh.polygons:
        for li in poly.loop_indices:
            vi = mesh.loops[li].vertex_index
            i, j = vi % (res + 1), vi // (res + 1)
            layer.data[li].uv = (i / res * cells[0], j / res * cells[1])
    obj = bpy.data.objects.new('net', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def sheep(x, y, a, wool, black, s=1.0, seed=0):
    """A white woolly sheep with a black face and legs, at (x, y) facing angle `a`."""
    c, si = math.cos(a), math.sin(a)
    at = lambda f, g, z: (x + (c * f - si * g) * s, y + (si * f + c * g) * s, z * s)
    body = lib.lumpy(at(0, 0, 0.15), 0.095 * s, wool, scale=(1.4, 1.0, 0.9), strength=0.35, noise=2.2, seed=seed,
                     subdiv=3)
    body.rotation_euler = (0, 0, a)
    head = lib.sphere(at(0.175, 0, 0.18), 0.048 * s, black, scale=(1.5, 0.78, 0.85))
    head.rotation_euler = (0, 0.5, a)
    lib.sphere(at(0.13, 0, 0.2), 0.045 * s, wool, scale=(0.8, 1.0, 0.8))
    for g in (0.045, -0.045):
        ear = lib.box(at(0.15, g, 0.215), (0.045 * s, 0.02 * s, 0.012 * s), black)
        ear.rotation_euler = (0, 0, a + (0.7 if g > 0 else -0.7))
    for f, g in ((0.07, 0.045), (0.07, -0.045), (-0.07, 0.045), (-0.07, -0.045)):
        lib.cylinder(at(f, g, 0.05), 0.013 * s, 0.1 * s, black, verts=6)


def horseman(x, y, z0, heading, stone, s=1.0):
    """A stone equestrian statue: a horse with one foreleg raised, its rider holding up a sword."""
    c, si = math.cos(heading), math.sin(heading)

    def at(f, g, z):
        return (x + (c * f - si * g) * s, y + (si * f + c * g) * s, z0 + z * s)

    def limb(p, q, r):
        rod(at(*p), at(*q), r * s, stone, verts=8)

    body = lib.sphere(at(0, 0, 0.56), 0.3 * s, stone, scale=(1.0, 0.42, 0.48), subdiv=3)
    body.rotation_euler = (0, -0.08, heading)
    lib.sphere(at(-0.2, 0, 0.56), 0.15 * s, stone, scale=(1.0, 0.95, 1.0))
    lib.sphere(at(0.2, 0, 0.6), 0.15 * s, stone, scale=(1.0, 0.9, 1.05))
    # Legs: hind pair and one foreleg standing, the other foreleg raised and bent.
    for g in (0.075, -0.075):
        limb((-0.22, g, 0.5), (-0.26, g, 0.22), 0.045)
        limb((-0.26, g, 0.22), (-0.22, g, 0.0), 0.032)
    limb((0.2, -0.075, 0.5), (0.22, -0.075, 0.22), 0.042)
    limb((0.22, -0.075, 0.22), (0.21, -0.075, 0.0), 0.03)
    limb((0.2, 0.075, 0.52), (0.36, 0.075, 0.4), 0.042)
    limb((0.36, 0.075, 0.4), (0.34, 0.075, 0.24), 0.03)
    # Neck and head, mane, tail.
    limb((0.24, 0, 0.66), (0.4, 0, 0.92), 0.08)
    head = lib.sphere(at(0.46, 0, 0.9), 0.1 * s, stone, scale=(1.5, 0.55, 0.62))
    head.rotation_euler = (0, 0.75, heading)
    for g in (0.03, -0.03):
        limb((0.4, g, 1.0), (0.39, g, 1.08), 0.016)
    limb((0.18, 0, 0.74), (0.36, 0, 1.0), 0.03)
    limb((-0.3, 0, 0.6), (-0.4, 0, 0.32), 0.03)
    # Rider: legs down the flanks, torso, head with a crested helmet, sword arm raised.
    for g in (0.12, -0.12):
        limb((0.0, g * 0.6, 0.78), (0.08, g, 0.62), 0.04)
        limb((0.08, g, 0.62), (0.04, g, 0.44), 0.032)
    lib.cylinder(at(0.0, 0, 0.92), 0.075 * s, 0.3 * s, stone, verts=12, radius2=0.085 * s)
    lib.sphere(at(0.01, 0, 1.12), 0.06 * s, stone)
    lib.sphere(at(0.0, 0, 1.15), 0.062 * s, stone, scale=(1.0, 1.0, 0.7))
    limb((-0.03, 0, 1.19), (0.03, 0, 1.2), 0.02)
    limb((0.0, -0.09, 1.02), (0.12, -0.1, 0.9), 0.026)
    limb((0.0, 0.09, 1.02), (0.04, 0.14, 1.2), 0.026)
    limb((0.04, 0.14, 1.2), (0.08, 0.15, 1.36), 0.022)
    lib.box(at(0.11, 0.15, 1.56), (0.025 * s, 0.012 * s, 0.36 * s), stone, rot=(0.0, 0.18, heading))
    lib.box(at(0.08, 0.15, 1.38), (0.09 * s, 0.02 * s, 0.02 * s), stone, rot=(0, 0, heading))


# ------------------------------------------------------------------------------------- farm (3×3)

def build_farm():
    """The Settlers 4 Roman grain farm: a long hall of dark fieldstone under a tall barrel roof of
    wooden shingles (a dormer with a little tiled roof, a stone chimney), ending at +X in a round
    stave apse with a thick straw skirt and a plank half-cone roof inside the vault's end arch; at −X
    an open timber barn under deep golden thatch with hay inside. Stages after the original: low
    walls and the apse frame, full walls, the bare vault ribs, then the roof."""
    rnd = random.Random(41)
    walls = stone_walls()
    gb = grey_blocks('fgb')
    beam = beam_mat()
    straw = thatch_mat()
    sh = shingle_mix(barrel_shingles('fsh'))
    planks = boards_mats()
    staves = lib.mat_grain('staves', (0.36, 0.2, 0.08), (0.6, 0.38, 0.16), scale=5, stretch=(1, 1, 9), bump=0.6)
    hay = lib.mat_grain('hay', (0.72, 0.56, 0.16), (0.96, 0.84, 0.4), scale=14, stretch=(1, 1, 1), bump=1.0)
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.4)
    red = lib.mat_flat('red', (0.62, 0.1, 0.06), rough=0.6)
    glass = lib.mat_flat('glass', (0.82, 0.8, 0.72), rough=0.4)
    tc = terracotta_mats('ftc')
    door = door_mat()
    dark = lib.mat_flat('dark', (0.06, 0.05, 0.04))
    earth_pad((0.05, -0.3, 0), 1.55, 1.6, seed=41)
    lib.tag(0)
    corner_stakes(-1.45, 1.45, -1.3, 1.0)
    lib.tag(0, until=0)

    # The hall: ridge along X, the stone front with the door facing −Y.
    hx0, hx1, hy0, hy1, Hw = -0.72, 0.78, -0.78, 0.5, 0.72
    cy = (hy0 + hy1) / 2
    c, s = (hy1 - hy0) / 2, 0.84
    lib.box(((hx0 + hx1) / 2, cy, 0.05), (hx1 - hx0 + 0.06, hy1 - hy0 + 0.06, 0.1), gb[1], bevel=0.02)
    stone_house(hx0, hx1, hy0, hy1, Hw * 0.4, rnd, walls, gb, block=0.2)
    lib.tag(1)
    stone_house(hx0, hx1, hy0, hy1, Hw, rnd, walls, gb, z0=Hw * 0.4, block=0.2)
    lib.box((0.42, hy0 - 0.05, 0.23), (0.24, 0.04, 0.46), door, bevel=0.01)
    lib.box((0.42, hy0 - 0.08, 0.48), (0.34, 0.07, 0.07), beam, bevel=0.01)
    for dx in (-0.14, 0.14):
        lib.box((0.42 + dx, hy0 - 0.07, 0.24), (0.05, 0.05, 0.48), beam, bevel=0.008)
    window(-0.3, hy0 - 0.04, 0.4, 0.15, 0.16, beam, dark)
    lib.tag(2)
    at = barrel_frame((hx0 + hx1) / 2, cy, Hw, 'x')[0]
    barrel_ribs(at, hx1 - hx0, c, s, beam, count=4, battens=5)
    lib.tag(3, until=3)
    arch_infill(at, -(hx1 - hx0) / 2 - 0.02, c, s, walls)
    arch_boards(at, (hx1 - hx0) / 2, c, s, planks, rnd, 'x')
    lib.tag(3)
    barrel_roof((hx0 + hx1) / 2, cy, Hw, hx1 - hx0, c, s, sh, lib.mat_grain('fvault', (0.3, 0.18, 0.08), (0.46, 0.3, 0.14),
                scale=6, stretch=(1, 1, 1), bump=0.4), beam, rnd, axis='x', overhang=0.1, size=0.17, upto=0.6)
    # The lower rows of the camera's slope go on in stage 3.
    lib.tag(None, split=lambda o: 3 if o.location.z < Hw + s * 0.45 and o.location.y < cy - c * 0.5 else 4)
    # Dormer on the front slope, above the door, under a little tiled gable.
    dx_, th = 0.28, 0.3 * math.pi
    da, du = (c + 0.1) * math.cos(th), (s + 0.1) * math.sin(th)
    dy0 = cy - da
    lib.box((dx_, dy0 + 0.12, Hw + du), (0.26, 0.3, 0.24), walls, bevel=0.01)
    stone_course(dx_ - 0.13, dx_ + 0.13, dy0 - 0.03, dy0 + 0.2, Hw + du - 0.12, Hw + du + 0.12, gb, rnd, block=0.11,
                 depth=0.03, faces=('y',))
    window(dx_, dy0 - 0.05, Hw + du + 0.01, 0.12, 0.12, red, glass)
    lib.box((dx_, dy0 - 0.075, Hw + du + 0.01), (0.02, 0.02, 0.12), red)
    lib.box((dx_, dy0 - 0.075, Hw + du + 0.01), (0.12, 0.02, 0.02), red)
    lib.prism_roof((dx_, dy0 + 0.12, Hw + du + 0.12), 0.36, 0.3, 0.13, tc[1], overhang=0.04, thickness=0.03, along='y')
    for k in range(4):
        for side in (-1, 1):
            lib.box((dx_ + side * 0.085, dy0 - 0.05 + k * 0.09, Hw + du + 0.2), (0.15, 0.1, 0.022), tc[(k + side) % 3],
                    rot=(0, side * -0.72, 0), bevel=0.006)
    chimney(-0.32, cy + 0.12, Hw + s - 0.3, Hw + s + 0.32, gb, rnd, name='farm')
    lib.tag(4)

    # Apse at the +X end: a half-round drum of staves with iron hoops and a red-framed window.
    ax, ar, Hd = hx1, c - 0.02, Hw
    lib.cylinder((ax, cy, 0.05), ar + 0.05, 0.1, gb[1], verts=32)
    for k in range(7):
        a = -math.pi / 2 + k * math.pi / 6
        lib.box((ax + math.cos(a) * ar, cy + math.sin(a) * ar, Hd / 2), (0.06, 0.06, Hd), beam, rot=(0, 0, a))
    torus((ax, cy, Hd - 0.02), ar, 0.025, beam)
    lib.tag(1, until=1)
    lib.cylinder((ax, cy, Hd / 2 + 0.04), ar - 0.03, Hd - 0.02, staves, verts=32)
    n = 24
    for k in range(n + 1):
        a = -math.pi / 2 + k * math.pi / n
        lib.box((ax + math.cos(a) * ar, cy + math.sin(a) * ar, Hd / 2 + 0.04), (0.035, ar * math.pi / n * 1.02, Hd),
                planks[k % len(planks)] if k % 3 else staves, rot=(0, 0, a), bevel=0.005)
    for z in (0.16, Hd - 0.06):
        torus((ax, cy, z), ar + 0.022, 0.014, iron)
    wa = -0.55
    wx, wy = ax + math.cos(wa) * (ar + 0.03), cy + math.sin(wa) * (ar + 0.03)
    lib.box((wx, wy, 0.34), (0.03, 0.17, 0.17), glass, rot=(0, 0, wa))
    for (bw, bh) in ((0.03, 0.2), (0.2, 0.03)):
        lib.box((wx + math.cos(wa) * 0.012, wy + math.sin(wa) * 0.012, 0.34), (0.03, bw, bh), red, rot=(0, 0, wa))
    lib.tag(2)
    # Rafters of the apse roof (stage 3), then its planks and the straw skirt.
    for k in range(7):
        a = -math.pi / 2 + k * math.pi / 6
        rod((ax + math.cos(a) * (ar + 0.05), cy + math.sin(a) * (ar + 0.05), Hd), (ax, cy, Hd + 0.5), 0.022, beam, verts=6)
    lib.tag(3, until=3)
    lathe(ax, cy, [(ar + 0.04, Hd + 0.02), (0.02, Hd + 0.52)], planks[1], segs=12, a0=-math.pi / 2, a1=math.pi / 2,
          smooth=False)
    for k in range(13):
        a = -math.pi / 2 + (k + 0.5) * math.pi / 13
        p0 = (ax + math.cos(a) * (ar + 0.02), cy + math.sin(a) * (ar + 0.02), Hd + 0.05)
        rod(p0, (ax + math.cos(a) * 0.05, cy + math.sin(a) * 0.05, Hd + 0.54), 0.02, planks[k % len(planks)], verts=4)
    skirt = lathe(ax, cy, [(ar + 0.2, Hd - 0.16), (ar + 0.18, Hd - 0.08), (ar + 0.1, Hd + 0.06), (ar - 0.02, Hd + 0.14),
                           (ar - 0.1, Hd + 0.12)], straw, segs=28, a0=-math.pi / 2 - 0.15, a1=math.pi / 2 + 0.15)
    shaggy(skirt, 0.035, 0.06, seed=41)
    lib.tag(4)

    # Open barn at −X under deep thatch (ridge along Y), with hay inside.
    bx0, bx1, by0, by1, bH, bR = -1.5, hx0 + 0.05, -1.22, 0.42, 0.46, 1.08
    bcx = (bx0 + bx1) / 2
    for (x, y) in ((bx0, by0), (bx1 - 0.04, by0), (bx0, by1), (bx0, (by0 + by1) / 2)):
        lib.box((x, y, bH / 2), (0.07, 0.07, bH), beam, bevel=0.008)
    lib.tag(1)
    lib.box((bx0 + 0.02, (by0 + by1) / 2, bH / 2), (0.04, by1 - by0, bH), planks[3], bevel=0.005)
    lib.box((bcx, by0, bH), (bx1 - bx0 + 0.08, 0.07, 0.07), beam)
    for side in (-1, 1):
        rod((bcx + side * (bx1 - bx0) / 2, by0, bH), (bcx, by0, bR), 0.03, beam, verts=6)
    rod((bcx, by0, bH), (bcx, by0, bR), 0.025, beam, verts=6)
    lib.tag(2)
    for k in range(5):
        lib.lumpy((bx0 + 0.25 + (k % 2) * 0.22, by0 + 0.3 + k * 0.26, 0.14), 0.18, hay, scale=(1.1, 1, 0.8),
                  strength=0.35, noise=0.9, seed=k)
    lib.tag(3)
    run = math.hypot((bx1 - bx0) / 2 + 0.16, bR - bH + 0.1)
    tilt = math.atan2(bR - bH + 0.1, (bx1 - bx0) / 2 + 0.16)
    for side in (-1, 1):
        for k in range(2):
            slab = lib.box((bcx + side * ((bx1 - bx0) / 4 + 0.06), (by0 + by1) / 2 - 0.06,
                            (bH + bR) / 2 + 0.04 - 0.05 * k), (run - 0.06 * k, by1 - by0 + 0.36, 0.16), straw,
                           rot=(0, side * tilt, 0), bevel=0.07)
            shaggy(slab, 0.025, 0.05, seed=50 + k + side)
    lib.tag(4)


# ------------------------------------------------------------------------------------- mill (2×2)

#: The mill's tower and cap (shared by `build_mill`, `mill_hub` and the sails).
MILL = {'cx': -0.02, 'cy': 0.3, 'R': 0.5, 'body': 1.3, 'eave': 1.18, 'cap_r': 0.98, 'top': 2.26, 'hub_z': 1.6,
        'hub_out': 0.98}


def mill_cap_profile():
    """(radius, height) of the mill's straw cap: a flared, thick eave, then a broad cone of thatch laid
    in courses (each a little proud of the one above) up to a rounded crown."""
    m = MILL
    r0, z0, top = m['cap_r'], m['eave'], m['top']
    prof = [(r0 - 0.08, z0 - 0.06), (r0 + 0.03, z0 - 0.02), (r0 + 0.04, z0 + 0.04)]
    courses = 4
    crown = top - 0.18
    def dome(f):
        return r0 * (1 - 0.78 * f ** 2.0), z0 + 0.04 + (crown - z0 - 0.04) * f

    for k in range(courses):
        f0, f1 = k / courses, (k + 1) / courses
        (ra, za), (rb, zb) = dome(f0), dome(f1)
        rm, zm = dome((f0 + f1) / 2)
        prof.append((ra - 0.015, za + 0.02))
        prof.append((rm - 0.01, zm))
        prof.append((rb + 0.015, zb - 0.01))
        prof.append((rb + 0.02, zb + 0.01))
    rc = r0 * 0.22
    for k in range(1, 7):
        a = k / 6 * math.pi / 2
        prof.append((rc * math.cos(a), crown + 0.01 + (top - crown) * math.sin(a)))
    return prof


def build_mill():
    """The Settlers 4 Roman windmill: a stout round tower — a drum of dark boards in a timber frame at
    the foot, rugged grey stone above — under a huge golden straw cap, a timber porch at the door and
    a low round annex at the side: stone footing, lattice-framed walls of pale panels, a plank deck
    with a rail on top, ivy. The sails are not modelled: the game flips the pre-rendered sail frames
    (`render_mill_sails`) over the hub recorded here (FX_AT['mill'])."""
    rnd = random.Random(51)
    gb = grey_blocks('mgb')
    walls = stone_walls()
    beam = beam_mat()
    straw = thatch_mat()
    planks = boards_mats()
    boards = grain_set('mboard', (((0.24, 0.14, 0.07), (0.4, 0.26, 0.13)), ((0.3, 0.18, 0.08), (0.48, 0.32, 0.16)),
                                  ((0.2, 0.13, 0.08), (0.36, 0.24, 0.14))), scale=4, stretch=(1, 1, 9), bump=0.6)
    panel = lib.mat_grain('mpanel', (0.78, 0.66, 0.4), (0.94, 0.84, 0.58), scale=6, stretch=(1, 1, 1), bump=0.3)
    ivy = lib.mat_leaves('mivy', (0.04, 0.14, 0.03), (0.12, 0.34, 0.07), (0.32, 0.56, 0.14))
    door = door_mat()
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.0, -0.25, 0), 1.0, 1.1, seed=51)
    lib.tag(0)
    corner_stakes(-0.9, 0.85, -0.85, 0.9)
    lib.tag(0, until=0)

    m = MILL
    cx, cy, R = m['cx'], m['cy'], m['R']
    DH = 0.6  # the board drum at the foot
    lib.cylinder((cx, cy, 0.05), R + 0.06, 0.1, gb[1], verts=32)
    for k in range(8):
        a = k / 8 * math.tau
        lib.box((cx + math.cos(a) * (R + 0.02), cy + math.sin(a) * (R + 0.02), DH / 2 + 0.05), (0.07, 0.07, DH),
                beam, rot=(0, 0, a))
    lib.tag(1)
    lib.cylinder((cx, cy, DH / 2 + 0.05), R - 0.01, DH, boards[0], verts=32)
    n = 30
    for k in range(n):
        a = k / n * math.tau
        if math.cos(a + math.pi / 4) < -0.5:
            continue
        lib.box((cx + math.cos(a) * R, cy + math.sin(a) * R, DH / 2 + 0.05), (0.03, R * math.tau / n * 1.02, DH - 0.02),
                boards[k % len(boards)], rot=(0, 0, a), bevel=0.004)
    for z in (0.12, DH * 0.55, DH + 0.04):
        torus((cx, cy, z), R + 0.03, 0.028, beam)
    # Door towards the door tile, framed by a small timber porch with a step.
    da = -1.25
    dxp, dyp = cx + math.cos(da) * (R + 0.03), cy + math.sin(da) * (R + 0.03)
    lib.box((dxp, dyp, 0.27), (0.03, 0.22, 0.4), dark, rot=(0, 0, da))
    lib.box((dxp + math.cos(da) * 0.01, dyp + math.sin(da) * 0.01, 0.26), (0.03, 0.19, 0.37), door, rot=(0, 0, da),
            bevel=0.006)
    ox, oy = math.cos(da), math.sin(da)
    tx, ty = -math.sin(da), math.cos(da)
    for side in (-1, 1):
        px, py = dxp + ox * 0.2 + tx * side * 0.17, dyp + oy * 0.2 + ty * side * 0.17
        lib.box((px, py, 0.3), (0.06, 0.06, 0.6), beam, rot=(0, 0, da), bevel=0.006)
        rod((px, py, 0.6), (px - ox * 0.2, py - oy * 0.2, 0.62), 0.025, beam, verts=6)
        rod((px, py, 0.42), (px - ox * 0.16, py - oy * 0.16, 0.58), 0.018, beam, verts=6)
    lib.box((dxp + ox * 0.2, dyp + oy * 0.2, 0.6), (0.07, 0.42, 0.06), beam, rot=(0, 0, da))
    lib.box((dxp + ox * 0.12, dyp + oy * 0.12, 0.03), (0.22, 0.34, 0.06), planks[1], rot=(0, 0, da), bevel=0.008)
    lib.tag(2)
    # Stone above the boards, a little narrower, up into the cap.
    top = m['body']
    rows = 6
    rh = (top - DH - 0.05) / rows
    for r in range(rows):
        z = DH + 0.07 + (r + 0.5) * rh
        rr = R - 0.03 - 0.03 * r / rows
        lib.cylinder((cx, cy, z), rr - 0.04, rh + 0.01, walls, verts=24)
        nb = 13
        for k in range(nb):
            a = (k + 0.5 * (r % 2)) / nb * math.tau + rnd.uniform(-0.05, 0.05)
            if math.cos(a + math.pi / 4) < -0.45:
                continue
            lib.box((cx + math.cos(a) * rr, cy + math.sin(a) * rr, z + rnd.uniform(-0.01, 0.01)),
                    (0.08, rr * math.tau / nb * rnd.uniform(0.78, 0.95), rh * rnd.uniform(0.78, 0.9)),
                    gb[rnd.randrange(len(gb))], rot=(rnd.uniform(-0.05, 0.05), 0, a), bevel=0.014)
    lib.tag(None, split=lambda o: 2 if o.location.z < DH + 0.3 else 3)
    # The cap: a thick straw dome overhanging far, a knob on top.
    cap = lathe(cx, cy, mill_cap_profile(), straw, segs=48)
    shaggy(cap, 0.045, 0.07, seed=51)
    lib.lumpy((cx, cy, m['top'] - 0.02), 0.09, straw, scale=(1, 1, 0.8), strength=0.4, noise=2.0, seed=52)
    lib.cylinder((cx, cy, m['top'] + 0.1), 0.02, 0.2, beam, verts=6)
    # The hub on the camera's right of the cap, where the game turns the sails.
    a = MILL_HUB_AXIS
    hx, hy, hz = mill_hub()
    lib.box((hx - math.cos(a) * 0.16, hy - math.sin(a) * 0.16, hz), (0.3, 0.16, 0.16), beam, rot=(0, 0, a),
            bevel=0.02)
    lib.cylinder((hx, hy, hz), 0.06, 0.1, beam, rot=(math.pi / 2, 0, a + math.pi / 2), verts=12)
    note_fx('mill', 'hub', (hx + math.cos(a) * 0.09, hy + math.sin(a) * 0.09, hz))
    lib.tag(4)

    # Low round annex at the side: stone footing, lattice frames with pale panels, a railed deck.
    nx, ny, nr, nH = -0.6, -0.38, 0.36, 0.56
    lib.cylinder((nx, ny, 0.09), nr + 0.04, 0.18, walls, verts=28)
    for k in range(16):
        a = k / 16 * math.tau
        lib.box((nx + math.cos(a) * (nr + 0.03), ny + math.sin(a) * (nr + 0.03), 0.09),
                (0.06, (nr + 0.03) * math.tau / 16 * 0.9, 0.15), gb[rnd.randrange(len(gb))], rot=(0, 0, a),
                bevel=0.012)
    lib.tag(1)
    lib.cylinder((nx, ny, (0.18 + nH) / 2), nr - 0.01, nH - 0.18, panel, verts=28)
    for k in range(12):
        a = k / 12 * math.tau
        lib.box((nx + math.cos(a) * nr, ny + math.sin(a) * nr, (0.18 + nH) / 2), (0.045, 0.045, nH - 0.18), beam,
                rot=(0, 0, a))
    for z in (0.2, 0.38, nH):
        torus((nx, ny, z), nr + 0.005, 0.02, beam)
    for k in range(24):
        a = (k + 0.5) / 24 * math.tau
        lib.box((nx + math.cos(a) * (nr + 0.01), ny + math.sin(a) * (nr + 0.01), (0.2 + 0.38) / 2), (0.012, 0.012, 0.18),
                beam, rot=(0, 0, a))
    lib.tag(2)
    for k in range(7):
        t = -nr - 0.04 + (k + 0.5) * (2 * nr + 0.08) / 7
        w = math.sqrt(max(0.0, (nr + 0.05) ** 2 - t ** 2)) * 2
        lib.box((nx + t, ny, nH + 0.03), ((2 * nr + 0.08) / 7 - 0.012, w, 0.035), planks[k % len(planks)],
                rot=(0, 0, rnd.uniform(-0.01, 0.01)), bevel=0.005)
    for k in range(12):
        a = k / 12 * math.tau
        if math.cos(a + math.pi / 4) < -0.6:
            continue
        lib.cylinder((nx + math.cos(a) * (nr + 0.02), ny + math.sin(a) * (nr + 0.02), nH + 0.12), 0.018, 0.18, beam,
                     verts=6)
    torus((nx, ny, nH + 0.2), nr + 0.02, 0.02, beam)
    lib.tag(3)
    for (a, z, rr) in ((-2.4, 0.3, 0.1), (-2.0, 0.18, 0.09), (-2.8, 0.42, 0.08), (2.9, 0.2, 0.09)):
        lib.lumpy((nx + math.cos(a) * (nr + 0.03), ny + math.sin(a) * (nr + 0.03), z), rr, ivy, scale=(1, 1, 1.4),
                  strength=0.5, noise=3.0, seed=int(z * 100))
    lib.tag(4)


#: Where the mill's sails turn: their shaft points this way (between +X and the camera, as on the
#: original, so the sails face the screen's lower right).
MILL_HUB_AXIS = -0.38
#: Sail frames over a quarter turn (four arms repeat every 90°).
SAIL_FRAMES = 12


def mill_hub():
    m = MILL
    a = MILL_HUB_AXIS
    return (m['cx'] + math.cos(a) * m['hub_out'], m['cy'] + math.sin(a) * m['hub_out'], m['hub_z'])


def build_mill_sails():
    """Four sail arms on the mill's hub, as on the Settlers 4 mill: a timber stock carrying a lattice
    of laths on one side, with weathered grey boards set in it. Built around an empty whose local X
    is the shaft, so a frame is just the empty turned about X (see `render_mill_sails`)."""
    beam = beam_mat()
    laths = lib.mat_grain('laths', (0.42, 0.28, 0.14), (0.62, 0.44, 0.24), scale=5, stretch=(1, 1, 8), bump=0.4)
    cloth = lib.mat_grain('cloth', (0.52, 0.5, 0.46), (0.76, 0.74, 0.68), scale=6, stretch=(1, 6, 1), bump=0.5)
    hub = bpy.data.objects.new('sails', None)
    bpy.context.scene.collection.objects.link(hub)
    hub.location = mill_hub()
    hub.rotation_mode = 'XYZ'
    hub.rotation_euler = (0, 0, MILL_HUB_AXIS)
    bpy.context.view_layer.update()
    parts = []
    parts.append(lib.cylinder((0.05, 0, 0), 0.06, 0.12, beam, rot=(0, math.pi / 2, 0), verts=12))
    length, w = 1.0, 0.32
    for k in range(4):
        t = k * math.pi / 2
        c, s_ = math.cos(t), math.sin(t)

        def P(along, side, x=0.1):
            # Local YZ plane: radial direction (c, s) in (Y, Z), the side across it; X towards the camera.
            return (x, c * along - s_ * side, s_ * along + c * side)

        rot = (t, 0, 0)
        parts.append(lib.box(P(length / 2, 0), (0.04, length, 0.045), beam, rot=rot, bevel=0.006))
        for side in (0.03, w):
            parts.append(lib.box(P(0.18 + (length - 0.18) / 2, side), (0.022, length - 0.18, 0.018), laths, rot=rot))
        for j in range(8):
            along = 0.22 + j * (length - 0.26) / 7
            parts.append(lib.box(P(along, (0.03 + w) / 2), (0.022, 0.014, w), laths, rot=rot))
        # Boards in the lattice, slightly behind it, with a gap here and there.
        for j in range(7):
            if j == 5:
                continue
            a0 = 0.23 + j * (length - 0.26) / 7
            parts.append(lib.box(P(a0 + (length - 0.26) / 14, (0.03 + w) / 2, 0.075),
                                 (0.008, (length - 0.26) / 7 - 0.02, w - 0.035), cloth, rot=rot))
    for o in parts:
        world = o.matrix_world.copy()
        o.parent = hub
        o.matrix_world = hub.matrix_world @ world
    return hub


def render_mill_sails(out_dir, tmp_dir, w, h, ax, ay, save_strip):
    """Renders `SAIL_FRAMES` frames of the sails turning through 90° on the mill's canvas (so a frame
    lines up with the mill sprite) and saves them as one strip `millsails.png`."""
    import numpy as np

    scene = lib.reset_scene()
    bpy.data.objects['ShadowCatcher'].hide_render = True
    lib.setup_camera(scene, w, h, ax, ay)
    hub = build_mill_sails()
    frames = []
    for k in range(SAIL_FRAMES):
        hub.rotation_euler = (k / SAIL_FRAMES * math.pi / 2, 0, MILL_HUB_AXIS)
        bpy.context.view_layer.update()
        path = os.path.join(tmp_dir, f'sails_{k}.png')
        lib.render_to(scene, path)
        img = bpy.data.images.load(path)
        px = np.empty(len(img.pixels), dtype=np.float32)
        img.pixels.foreach_get(px)
        frames.append(px.reshape(img.size[1], img.size[0], 4))
        bpy.data.images.remove(img)
    save_strip(frames, os.path.join(out_dir, 'millsails.png'))  # rows stay in Blender's bottom-up order


# ------------------------------------------------------------------------------------- waterworks (2×2)

def build_waterworks():
    """Our waterworks: a small stone pump house under terracotta, a timber water wheel on its right
    wall, and a stone trough of water under a little tiled lean-to in front."""
    rnd = random.Random(71)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = boards_mats()
    tiles = terracotta_mats()
    ridge = lib.mat_flat('tc-ridge', (0.62, 0.26, 0.1))
    water = lib.mat_flat('water', (0.24, 0.56, 0.72), rough=0.1)
    iron = lib.mat_flat('iron', (0.22, 0.22, 0.24), rough=0.4)
    door = door_mat()
    earth_pad((0.1, -0.3, 0), 1.0, 1.1, seed=71)
    lib.tag(0)

    x0, x1, y0, y1, H, rh = -0.7, 0.45, -0.6, 0.85, 0.66, 0.4
    corner_stakes(x0, x1 + 0.3, y0 - 0.45, y1)
    lib.tag(0, until=0)
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.05), (x1 - x0 + 0.06, y1 - y0 + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.tag(1)
    stone_house(x0, x1, y0, y1, H * 0.5, rnd, walls, blocks)
    lib.tag(2)
    stone_house(x0, x1, y0, y1, H, rnd, walls, blocks, z0=H * 0.5)
    lib.gable(((x0 + x1) / 2, (y0 + y1) / 2, H), x1 - x0, rh - 0.02, y0 + 0.01, walls, along='y')
    lib.box((0.2, y0 - 0.05, 0.2), (0.22, 0.04, 0.38), door, bevel=0.008)
    lib.box((0.2, y0 - 0.07, 0.41), (0.3, 0.06, 0.05), beam)
    lib.tag(3)
    scale_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, tiles, ridge, axis='y',
               overhang=0.1, seed=72, size=0.12, shape='tile')
    lib.tag(None, split=lambda o: 3 if o.location.x > (x0 + x1) / 2 else 4)

    # Water wheel on the +X wall: two rims, spokes, paddles, an iron axle.
    wx, wy, wz, wr = x1 + 0.15, 0.25, 0.36, 0.34
    for dx in (-0.06, 0.06):
        torus((wx + dx, wy, wz), wr, 0.02, beam, rot=(0, math.pi / 2, 0))
    for k in range(4):
        lib.box((wx, wy, wz), (0.03, wr * 2, 0.03), beam, rot=(k / 4 * math.pi, 0, 0))
    for k in range(16):
        a = k / 16 * math.tau
        lib.box((wx, wy + math.cos(a) * wr, wz + math.sin(a) * wr), (0.16, 0.025, 0.09), planks[k % len(planks)],
                rot=(a, 0, 0), bevel=0.004)
    lib.cylinder((wx - 0.06, wy, wz), 0.035, 0.22, iron, rot=(0, math.pi / 2, 0), verts=10)
    lib.tag(4)

    # Stone trough with water under a lean-to, in front of the house on the left.
    tx0, tx1, ty0, ty1 = -0.78, -0.12, -1.08, -0.68
    lib.box(((tx0 + tx1) / 2, (ty0 + ty1) / 2, 0.09), (tx1 - tx0, ty1 - ty0, 0.18), blocks[2], bevel=0.015)
    lib.box(((tx0 + tx1) / 2, (ty0 + ty1) / 2, 0.175), (tx1 - tx0 - 0.08, ty1 - ty0 - 0.08, 0.02), water)
    lib.tag(3)
    for x in (tx0, tx1):
        lib.box((x, ty0 - 0.02, 0.24), (0.04, 0.04, 0.48), beam)
    tilt = math.atan2(0.15, ty1 - ty0 + 0.1)
    for k in range(5):
        x = tx0 - 0.04 + (k + 0.5) * (tx1 - tx0 + 0.08) / 5
        lib.box((x, (ty0 + ty1) / 2 + 0.02, 0.5), ((tx1 - tx0 + 0.08) / 5 * 0.9, ty1 - ty0 + 0.26, 0.025),
                tiles[k % len(tiles)], rot=(-tilt, 0, 0), bevel=0.005)
    lib.tag(4)


# ------------------------------------------------------------------------------------- generic roof pieces

def place_on(obj, origin, u, v):
    """Orients `obj` so its local X runs along `u` and its local Y along `v` (re-orthogonalised), its Z
    along their normal, at `origin`."""
    from mathutils import Matrix, Vector

    u, v = Vector(u).normalized(), Vector(v).normalized()
    n = u.cross(v).normalized()
    v = n.cross(u).normalized()
    obj.matrix_world = Matrix(((u.x, v.x, n.x, origin[0]), (u.y, v.y, n.y, origin[1]), (u.z, v.z, n.z, origin[2]),
                               (0, 0, 0, 1)))
    return obj


def roof_piece(mat, size, shape):
    if shape == 'scale':
        return lib.sphere((0, 0, 0), size * 0.55, mat, scale=(1.0, 1.25, 0.22), subdiv=2)
    return lib.box((0, 0, 0), (size * 0.82, size, 0.03), mat, bevel=0.008)


def tile_face(e0, e1, r0, r1, mats, rnd, size=0.13, shape='scale', lift=0.03):
    """Covers one roof face — a quad (a triangle when r0 == r1) from the eave edge e0→e1 up to the
    ridge edge r0→r1 — row by row with slate scales or square tiles, each its own tone and a little
    askew, alternate rows offset. Serves gable, hipped and lean-to faces alike."""
    from mathutils import Vector

    e0, e1, r0, r1 = (Vector(p) for p in (e0, e1, r0, r1))
    up = r0.lerp(r1, 0.5) - e0.lerp(e1, 0.5)
    rows = max(2, int(up.length / (size * 0.62)))
    for r in range(rows):
        t = (r + 0.4) / rows  # 0 at the eave, 1 at the ridge
        a, b = e0.lerp(r0, t), e1.lerp(r1, t)
        width = (b - a).length
        cols = max(1, int(width / (size * 0.92)))
        u = (b - a).normalized() if width > 1e-4 else (e1 - e0).normalized()
        n = u.cross(up.normalized()).normalized()
        shift = 0.25 if r % 2 else -0.25
        # Keep whole tiles inside the face, so hips and verges stay clean instead of toothed.
        margin = min(0.5, size * 0.45 / width) if width > 1e-4 else 0.5
        for k in range(cols):
            s = (k + 0.5 + shift) / cols
            if s < margin or s > 1 - margin:
                s = min(1 - margin, max(margin, s))
                if cols > 1 and (k == 0 or k == cols - 1) and abs(shift) > 0 and (s == margin or s == 1 - margin):
                    continue
            p = a.lerp(b, s) + n * (lift + 0.01 * (r % 2))
            jitter = Vector((rnd.uniform(-0.08, 0.08), rnd.uniform(-0.08, 0.08), 0))
            place_on(roof_piece(mats[rnd.randrange(len(mats))], size, shape), p, u + jitter, up)


def hip_faces(cx, cy, L, W, H, rh, overhang=0.1, ridge_frac=0.4):
    """The four slopes of a hipped roof over an L×W block at height H (ridge along the longer side,
    `ridge_frac` of it; 0 makes a pyramid), each as (eave start, eave end, ridge start, ridge end) the
    way `tile_face` takes them, plus the two ridge ends."""
    x0, x1, y0, y1 = cx - L / 2 - overhang, cx + L / 2 + overhang, cy - W / 2 - overhang, cy + W / 2 + overhang
    z0, zr = H - overhang * 0.5, H + rh
    if L >= W:
        h = (L / 2) * ridge_frac
        ra, rb = (cx - h, cy, zr), (cx + h, cy, zr)
    else:
        h = (W / 2) * ridge_frac
        ra, rb = (cx, cy - h, zr), (cx, cy + h, zr)
    c00, c10, c11, c01 = (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0)
    if L >= W:
        faces = [(c00, c10, ra, rb), (c10, c11, rb, rb), (c11, c01, rb, ra), (c01, c00, ra, ra)]
    else:
        faces = [(c00, c10, ra, ra), (c10, c11, ra, rb), (c11, c01, rb, rb), (c01, c00, rb, ra)]
    return faces, ra, rb


def hip_roof(cx, cy, L, W, H, rh, mats, ridge_mat, rnd, overhang=0.1, size=0.13, shape='scale', ridge_frac=0.4):
    """A hipped roof — four slopes over an L×W block at height H, a ridge along the longer side
    (`ridge_frac` of it; 0 makes a pyramid) — as a solid body, the two slopes the camera sees (−Y,
    +X) covered in scales or tiles."""
    faces, ra, rb = hip_faces(cx, cy, L, W, H, rh, overhang, ridge_frac)
    zr = H + rh
    verts, polys = [], []
    for (a, b, p, q) in faces:
        i = len(verts)
        if p == q:
            verts += [a, b, p]
            polys.append((i, i + 1, i + 2))
        else:
            verts += [a, b, q, p]
            polys.append((i, i + 1, i + 2, i + 3))
    mesh = bpy.data.meshes.new('hip')
    mesh.from_pydata(verts, [], polys)
    obj = bpy.data.objects.new('hip', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.04
    obj.data.materials.append(mats[0])
    for (a, b, p, q) in faces:
        if (a[1] + b[1]) / 2 < cy - 0.01 or (a[0] + b[0]) / 2 > cx + 0.01:
            tile_face(a, b, p, q, mats, rnd, size=size, shape=shape)
    if ra != rb:
        rod(ra, rb, 0.045, ridge_mat)
    lib.sphere((ra[0], ra[1], zr + 0.03) if ra == rb else rb, 0.05, ridge_mat)
    return obj


def cone_tiles(cx, cy, z0, r, h, mats, rnd, size=0.12, shape='tile'):
    """A conical roof: a solid cone under rings of tiles or slate scales on the camera's half."""
    from mathutils import Vector

    lib.cylinder((cx, cy, z0 + h / 2), r, h, mats[0], radius2=0.01, verts=24)
    rows = max(2, int(math.hypot(r, h) / (size * 0.62)))
    for k in range(rows):
        t = (k + 0.4) / rows
        rr = r * (1 - t) + 0.02
        n = max(3, int(rr * math.tau / (size * 0.9)))
        for j in range(n):
            a = (j + 0.5 * (k % 2)) / n * math.tau
            if math.cos(a + math.pi / 4) < -0.35:  # the far side
                continue
            p = (cx + math.cos(a) * rr, cy + math.sin(a) * rr, z0 + h * t + 0.01)
            u = Vector((-math.sin(a), math.cos(a), 0))
            v = Vector((-math.cos(a) * r, -math.sin(a) * r, h))
            place_on(roof_piece(mats[rnd.randrange(len(mats))], size * min(1.0, rr / r + 0.35), shape), p, u, v)


def slate_mats(prefix='sl'):
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.2, 0.25, 0.34), (0.36, 0.42, 0.52)),
        ((0.26, 0.31, 0.42), (0.44, 0.5, 0.62)),
        ((0.15, 0.19, 0.27), (0.28, 0.33, 0.42)),
    ))]


def round_tower(tx, ty, tr, z0, z1, walls, blocks, rnd, rows=4):
    """A round tower of rugged blocks on its camera half, over a dark core, from z0 to z1."""
    lib.cylinder((tx, ty, (z0 + z1) / 2), tr, z1 - z0, walls, verts=24)
    rh = (z1 - z0) / rows
    for r in range(rows):
        z = z0 + (r + 0.5) * rh
        for k in range(12):
            a = (k + 0.5 * (r % 2)) / 12 * math.tau
            if math.cos(a + math.pi / 4) < -0.4:
                continue
            lib.box((tx + math.cos(a) * tr, ty + math.sin(a) * tr, z), (tr * math.tau / 12 * 0.9, 0.06, rh * 0.84),
                    blocks[rnd.randrange(len(blocks))], rot=(0, 0, a + math.pi / 2), bevel=0.014)


def stepped_gable_y(cx, y, W, H, rh, mats, rnd, steps=3):
    """Crow-stepped stones along both raking edges of a gable wall standing at `y` (ridge along Y; the
    gable spans X, centred on cx, width W)."""
    for side in (-1, 1):
        for k in range(steps):
            t = (k + 0.5) / steps
            lib.box((cx + side * (W / 2) * (1 - t), y, H + rh * t + 0.06), (0.17, 0.13, 0.15),
                    mats[rnd.randrange(len(mats))], rot=(0, 0, rnd.uniform(-0.05, 0.05)), bevel=0.02)
    lib.box((cx, y, H + rh + 0.08), (0.18, 0.13, 0.16), mats[0], bevel=0.02)


def stepped_gable_x(cy, x, W, H, rh, mats, rnd, steps=4):
    """The same for a gable at `x` with the ridge along X (spanning Y, centred on cy)."""
    for side in (-1, 1):
        for k in range(steps):
            t = (k + 0.5) / steps
            lib.box((x, cy + side * (W / 2) * (1 - t), H + rh * t + 0.06), (0.13, 0.17, 0.15),
                    mats[rnd.randrange(len(mats))], rot=(0, 0, rnd.uniform(-0.05, 0.05)), bevel=0.02)
    lib.box((x, cy, H + rh + 0.08), (0.13, 0.18, 0.16), mats[0], bevel=0.02)


# ------------------------------------------------------------------------------------- mines (2×2, on mountains)

def rock_pad(loc, hx, hy, seed, tone, light):
    """Rocky, gritty mountain ground under a mine instead of trodden earth."""
    mat = lib.mat_grain(f'rockground{seed}', tone, light, scale=18, stretch=(1, 1, 1), bump=1.2, detail=12)
    lib.pad(loc, hx, hy, mat, jitter=0.12, seed=seed)


def grain_set(prefix, pairs, scale=7, stretch=(1, 1, 1), bump=1.0):
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=scale, stretch=stretch, bump=bump) for k, (a, b) in enumerate(pairs)]


def rubble(rnd, centre, n, r, mats, size=0.07):
    for k in range(n):
        a = rnd.uniform(0, math.tau)
        d = rnd.uniform(0, r)
        lib.lumpy((centre[0] + math.cos(a) * d, centre[1] + math.sin(a) * d, 0.02), size * rnd.uniform(0.6, 1.3),
                  mats[rnd.randrange(len(mats))], scale=(1.2, 1, 0.7), strength=0.4, noise=0.9, seed=k, subdiv=1,
                  flat=True)


def rails(x0, y0, x1, y1, wood, iron):
    """A short mine-cart track: sleepers and two rails from (x0, y0) to (x1, y1)."""
    length = math.hypot(x1 - x0, y1 - y0)
    ang = math.atan2(y1 - y0, x1 - x0)
    px, py = -math.sin(ang), math.cos(ang)
    n = max(2, int(length / 0.11))
    for k in range(n):
        t = (k + 0.5) / n
        lib.box((x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 0.015), (0.04, 0.2, 0.025), wood, rot=(0, 0, ang))
    for s in (-0.065, 0.065):
        lib.box(((x0 + x1) / 2 + px * s, (y0 + y1) / 2 + py * s, 0.04), (length, 0.018, 0.022), iron, rot=(0, 0, ang))


def adit(x, y, w, h, beam, dark, rnd, depth=0.5):
    """A timbered tunnel mouth facing −Y: a dark opening into the hill, two posts and a lintel."""
    lib.box((x, y + depth / 2, h / 2), (w, depth, h), dark)
    for sx in (-1, 1):
        lib.box((x + sx * (w / 2 + 0.03), y - 0.02, h / 2), (0.07, 0.07, h + 0.02), beam, rot=(0, sx * 0.05, 0),
                bevel=0.01)
    lib.box((x, y - 0.02, h + 0.03), (w + 0.2, 0.08, 0.08), beam, rot=(0, rnd.uniform(-0.04, 0.04), 0), bevel=0.01)


def hill(rnd, centre, size, mats, seed=1):
    """A mound of the mountain behind a mine, the tunnel driven into it."""
    cx, cy = centre
    lib.lumpy((cx, cy, 0.0), size, mats[0], scale=(1.15, 1.0, 0.62), strength=0.3, noise=0.7, seed=seed, subdiv=3)
    for k in range(5):
        a = rnd.uniform(0, math.tau)
        lib.lumpy((cx + math.cos(a) * size * 0.75, cy + math.sin(a) * size * 0.7, size * 0.18), size * 0.38,
                  mats[rnd.randrange(len(mats))], scale=(1.1, 1, 0.7), strength=0.45, noise=0.9, seed=seed + k + 1,
                  subdiv=2, flat=True)


def buffer_stop(x, y, wood, rnd):
    """The wooden stop at the end of a mine track (facing −Y): a cross beam on two blocks."""
    for sx in (-0.07, 0.07):
        lib.box((x + sx, y, 0.05), (0.07, 0.09, 0.1), wood, rot=(0, 0, rnd.uniform(-0.05, 0.05)), bevel=0.012)
    lib.box((x, y - 0.01, 0.12), (0.3, 0.08, 0.07), wood, rot=(0, rnd.uniform(-0.05, 0.05), 0), bevel=0.012)


def timber_portal(x, y0, y1, w, h, beam, dark, rnd, lintel_over=0.08):
    """A tunnel portal of rough square timbers facing −Y: two frames of posts and lintels from y0 (the
    mouth) back to y1, joined by head beams, with a dark opening between."""
    lib.box((x, (y0 + y1) / 2 + 0.03, h / 2), (w, y1 - y0, h), dark)
    for y in (y0, y1):
        for sx in (-1, 1):
            lib.box((x + sx * (w / 2 + 0.04), y, h / 2), (0.085, 0.085, h), beam,
                    rot=(rnd.uniform(-0.03, 0.03), rnd.uniform(-0.03, 0.03), 0), bevel=0.012)
        lib.box((x, y, h + 0.045), (w + 0.08 + 2 * lintel_over, 0.095, 0.095), beam,
                rot=(0, rnd.uniform(-0.03, 0.03), 0), bevel=0.012)
    for sx in (-1, 1):
        lib.box((x + sx * (w / 2 + 0.04), (y0 + y1) / 2, h + 0.045), (0.08, y1 - y0 + 0.1, 0.08), beam, bevel=0.012)
    # Boards over the head beams.
    k = 0
    t = y0 - 0.06
    while t < y1 + 0.04:
        lib.box((x, t + 0.045, h + 0.11), (w + 0.2, 0.08, 0.03), beam, rot=(0, rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04)),
                bevel=0.006)
        t += 0.09
        k += 1
    # A diagonal strut on the near side keeps the frame square.
    rod((x + w / 2 + 0.04, y0 + 0.03, h * 0.35), (x + w / 2 + 0.04, y1 - 0.03, h - 0.02), 0.03, beam, verts=8)


def tarp(x0, x1, y0, y1, zb, peak, H, mat, rnd, n=36, sag=0.22):
    """A heavy cloth (or hide) draped over a pole frame like a tent: a pyramid from the rectangle's
    edges at height zb up to `peak` (x, y) at H, its faces sagging between the corner poles and
    creased by a few soft folds."""
    px, py = peak
    folds = [(rnd.uniform(0, math.tau), rnd.randint(5, 11), rnd.uniform(0.02, 0.04)) for _ in range(5)]
    verts, faces = [], []
    for j in range(n + 1):
        for i in range(n + 1):
            x = x0 + (x1 - x0) * i / n
            y = y0 + (y1 - y0) * j / n
            u = (x - px) / ((x1 - px) if x > px else (px - x0))
            v = (y - py) / ((y1 - py) if y > py else (py - y0))
            d = max(abs(u), abs(v))
            f = 1 - d
            # Sag: between the corner poles (|u| ≈ |v| at the corners) the cloth hangs lower.
            corner = min(abs(u), abs(v)) / max(d, 1e-6)
            z = zb + (H - zb) * f - sag * d * (1 - corner) ** 1.5 * (1 - d) * 2.4
            a = math.atan2(v, u)
            z += sum(amp * math.sin(k * a + ph) for ph, k, amp in folds) * d * (1 - d) * 3
            verts.append((x, y, max(zb, z)))
    for j in range(n):
        for i in range(n):
            k = j * (n + 1) + i
            faces.append((k, k + 1, k + n + 2, k + n + 1))
    mesh = bpy.data.meshes.new('tarp')
    mesh.from_pydata(verts, [], faces)
    obj = bpy.data.objects.new('tarp', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = (0, 0, 0)
    mod = obj.modifiers.new('Solid', 'SOLIDIFY')
    mod.thickness = 0.03
    obj.data.materials.append(mat)
    for p in mesh.polygons:
        p.use_smooth = True
    # Crumples: a soft cloud displacement over the folds.
    tex = bpy.data.textures.new('tarpcrumple', 'CLOUDS')
    tex.noise_scale = 0.3
    disp = obj.modifiers.new('Crumple', 'DISPLACE')
    disp.texture = tex
    disp.texture_coords = 'GLOBAL'
    disp.strength = 0.11
    disp.direction = 'Z'
    obj.modifiers.move(1, 0)
    return obj


def build_coalmine():
    """After the Settlers 4 Roman coal mine: a heavy, sooty blue-black hide draped like a tent over a
    pole frame, nailed down at its edges onto a footing of pale stones, a portal of rough square timbers
    standing out of its front with a short track on sleepers running out to a wooden stop."""
    rnd = random.Random(91)
    hide = lib.mat_grain('hide', (0.14, 0.13, 0.2), (0.4, 0.38, 0.52), scale=6, stretch=(1, 1, 1.6), bump=1.4,
                         detail=10)
    pale = grain_set('footing', (((0.5, 0.47, 0.42), (0.82, 0.78, 0.68)), ((0.44, 0.42, 0.38), (0.72, 0.7, 0.62)),
                                 ((0.56, 0.5, 0.4), (0.86, 0.8, 0.66))))
    beam = lib.mat_grain('minebeam', (0.32, 0.18, 0.06), (0.62, 0.42, 0.18), scale=5, stretch=(1, 1, 8), bump=0.8)
    sleeper = lib.mat_grain('sleeper', (0.5, 0.26, 0.1), (0.78, 0.46, 0.22), scale=5, stretch=(8, 1, 1), bump=0.6)
    iron = lib.mat_flat('iron', (0.42, 0.44, 0.48), rough=0.35)
    stud = lib.mat_flat('stud', (0.72, 0.72, 0.74), rough=0.35)
    dark = lib.mat_flat('dark', (0.02, 0.02, 0.025))
    rock_pad((0.05, -0.2, 0), 0.8, 0.88, 91, (0.2, 0.2, 0.19), (0.42, 0.41, 0.38))
    lib.tag(0)
    x0, x1, y0, y1 = -0.78, 0.66, -0.5, 0.78
    corner_stakes(x0, x1, y0, y1)
    lib.tag(0, until=0)
    # The footing: a ring of pale blocks the hide is pegged down onto.
    for (a, b, fixed, along_x) in ((x0, x1, y0, True), (x0, x1, y1, True), (y0, y1, x0, False), (y0, y1, x1, False)):
        t = a
        while t < b - 0.05:
            w = min(rnd.uniform(0.16, 0.26), b - t)
            loc = (t + w / 2, fixed, 0.055) if along_x else (fixed, t + w / 2, 0.055)
            size = (w - 0.03, 0.15, 0.11) if along_x else (0.15, w - 0.03, 0.11)
            lib.box(loc, size, pale[rnd.randrange(len(pale))], rot=(0, 0, rnd.uniform(-0.06, 0.06)), bevel=0.02)
            t += w
    lib.tag(1)
    # The pole frame under the hide (stage 2 only shows it bare).
    px, py, H = -0.22, 0.3, 1.25
    for (cx, cy) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        rod((cx, cy, 0.1), (px, py, H - 0.04), 0.03, beam, verts=8)
    lib.cylinder((px, py, H / 2), 0.035, H, beam, verts=8)
    lib.tag(2, until=2)
    mx, mw, mh = 0.28, 0.36, 0.64
    timber_portal(mx, y0 - 0.2, y0 + 0.42, mw, mh, beam, dark, rnd)
    lib.tag(2)
    tarp(x0 - 0.04, x1 + 0.04, y0 - 0.04, y1 + 0.04, 0.1, (px, py), H, hide, rnd)
    lib.tag(3)
    # Pale nail heads round the hem and at the poles' tips.
    for (cx, cy) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        lib.sphere((cx - 0.02 * (1 if cx > 0 else -1), cy - 0.02 * (1 if cy > 0 else -1), 0.13), 0.028, stud, subdiv=2)
    for t in (0.33, 0.66):
        lib.sphere((x0 + (x1 - x0) * t, y0 - 0.04, 0.13), 0.024, stud, subdiv=2)
        lib.sphere((x1 + 0.04, y0 + (y1 - y0) * t, 0.13), 0.024, stud, subdiv=2)
    lib.sphere((px, py, H + 0.02), 0.035, stud, subdiv=2)
    # The track runs out of the portal to a stop.
    rails(mx, y0 + 0.1, mx, -1.22, sleeper, iron)
    buffer_stop(mx, -1.24, sleeper, rnd)
    lib.tag(4)


def build_stonemine():
    """Our stone mine: a tall crib of square timbers filled with pale quarried blocks under a slanted
    plank roof, an open lean-to beside it, the tunnel in a pale rocky hill behind."""
    rnd = random.Random(101)
    rock = grain_set('stonerock', (((0.42, 0.4, 0.36), (0.7, 0.68, 0.62)), ((0.5, 0.48, 0.44), (0.8, 0.78, 0.72)),
                                   ((0.36, 0.35, 0.33), (0.6, 0.59, 0.56))))
    pale = grain_set('pale', (((0.66, 0.64, 0.6), (0.92, 0.9, 0.86)), ((0.58, 0.57, 0.55), (0.84, 0.83, 0.8)),
                              ((0.7, 0.66, 0.58), (0.94, 0.9, 0.82))))
    beam = lib.mat_grain('minebeam', (0.24, 0.15, 0.07), (0.44, 0.3, 0.16), scale=5, stretch=(1, 1, 8), bump=0.7)
    planks = boards_mats()
    dark = lib.mat_flat('dark', (0.04, 0.035, 0.03))
    rock_pad((0.05, -0.15, 0), 1.0, 1.08, 101, (0.4, 0.34, 0.26), (0.68, 0.6, 0.48))
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    hill(rnd, (0.3, 0.5), 0.68, rock, seed=102)
    adit(0.55, -0.02, 0.3, 0.36, beam, dark, rnd, depth=0.4)
    lib.tag(1)
    x0, x1, y0, y1, H = -0.72, 0.0, -0.55, 0.25, 1.05
    for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        lib.box((x, y, H / 2), (0.08, 0.08, H), beam, bevel=0.01)
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, H * 0.25), (x1 - x0 - 0.02, y1 - y0 - 0.02, H * 0.5), dark)
    stone_course(x0 + 0.04, x1 - 0.04, y0 + 0.04, y1 - 0.04, 0.04, H * 0.48, pale, rnd, block=0.17, depth=0.05)
    lib.tag(2)
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, H * 0.75), (x1 - x0 - 0.02, y1 - y0 - 0.02, H * 0.5), dark)
    stone_course(x0 + 0.04, x1 - 0.04, y0 + 0.04, y1 - 0.04, H * 0.52, H - 0.04, pale, rnd, block=0.17, depth=0.05)
    for z in (0.04, H * 0.5, H - 0.03):
        lib.box(((x0 + x1) / 2, y0, z), (x1 - x0 + 0.06, 0.07, 0.07), beam, bevel=0.008)
        lib.box((x1, (y0 + y1) / 2, z), (0.07, y1 - y0 + 0.06, 0.07), beam, bevel=0.008)
    lib.tag(3)
    tilt = math.atan2(0.22, x1 - x0 + 0.2)
    for k in range(7):
        y = y0 - 0.08 + (k + 0.5) * (y1 - y0 + 0.16) / 7
        lib.box(((x0 + x1) / 2, y, H + 0.1), (x1 - x0 + 0.3, (y1 - y0 + 0.16) / 7 * 0.88, 0.035), planks[k % len(planks)],
                rot=(rnd.uniform(-0.03, 0.03), tilt, rnd.uniform(-0.04, 0.04)), bevel=0.005)
    lx0, lx1, ly0, ly1 = x1, x1 + 0.42, -0.55, -0.05
    for y in (ly0, ly1):
        lib.box((lx1, y, 0.3), (0.06, 0.06, 0.6), beam)
    for k in range(5):
        y = ly0 - 0.04 + (k + 0.5) * (ly1 - ly0 + 0.08) / 5
        lib.box(((lx0 + lx1) / 2 + 0.03, y, 0.68), (lx1 - lx0 + 0.16, (ly1 - ly0 + 0.08) / 5 * 0.88, 0.03),
                planks[k % len(planks)], rot=(0, math.atan2(0.2, lx1 - lx0), 0), bevel=0.005)
    rubble(rnd, (-0.55, -0.85), 5, 0.15, pale, size=0.06)
    lib.tag(4)


def windlass(x, y, z, length, wood, rope, beam):
    """A pale wooden winding drum on two little trestles, the rope wound round it (over a shaft)."""
    for sx in (-1, 1):
        lib.box((x + sx * length / 2, y, z / 2), (0.05, 0.06, z), beam, bevel=0.008)
    lib.cylinder((x, y, z), 0.075, length, wood, rot=(0, math.pi / 2, 0), verts=16)
    lib.cylinder((x, y, z), 0.082, length * 0.55, rope, rot=(0, math.pi / 2, 0), verts=16)
    lib.box((x + length / 2 + 0.06, y, z + 0.06), (0.03, 0.03, 0.14), beam)


def build_ironmine():
    """After the Settlers 4 Roman iron mine: a narrow timber head frame under a steep gable of big
    blue-grey slates over the shaft, its open gable towards the camera showing a pale windlass in the
    dark; against its back a tall square pier of rough grey stone bound by timber posts at its corners;
    a short track out of the mouth to a wooden stop."""
    rnd = random.Random(111)
    blocks = grain_set('ironpier', (((0.46, 0.45, 0.42), (0.78, 0.76, 0.7)), ((0.4, 0.4, 0.38), (0.68, 0.67, 0.63)),
                                    ((0.52, 0.49, 0.44), (0.84, 0.8, 0.72)), ((0.34, 0.34, 0.33), (0.58, 0.58, 0.56))))
    walls = stone_walls()
    beam = lib.mat_grain('minebeam', (0.24, 0.13, 0.05), (0.48, 0.3, 0.13), scale=5, stretch=(1, 1, 8), bump=0.8)
    planks = grain_set('ironplank', (((0.3, 0.18, 0.08), (0.52, 0.34, 0.16)), ((0.36, 0.22, 0.1), (0.58, 0.4, 0.2)),
                                     ((0.26, 0.17, 0.09), (0.46, 0.32, 0.18))), scale=4, stretch=(1, 1, 9), bump=0.7)
    slates = [lib.mat_grain(f'islate{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.6) for k, (a, b) in enumerate((
        ((0.3, 0.33, 0.38), (0.56, 0.6, 0.66)), ((0.24, 0.27, 0.32), (0.46, 0.5, 0.56)),
        ((0.36, 0.38, 0.42), (0.62, 0.65, 0.7))))]
    sleeper = lib.mat_grain('sleeper', (0.5, 0.26, 0.1), (0.78, 0.46, 0.22), scale=5, stretch=(8, 1, 1), bump=0.6)
    drum = lib.mat_grain('drum', (0.62, 0.56, 0.44), (0.88, 0.84, 0.72), scale=6, stretch=(1, 1, 6), bump=0.5)
    rope = lib.mat_grain('rope', (0.5, 0.42, 0.28), (0.72, 0.64, 0.46), scale=30, stretch=(1, 1, 1), bump=0.8)
    iron = lib.mat_flat('iron', (0.42, 0.44, 0.48), rough=0.35)
    dark = lib.mat_flat('dark', (0.02, 0.02, 0.02))
    rock_pad((0.05, -0.2, 0), 0.8, 0.88, 111, (0.2, 0.2, 0.19), (0.42, 0.41, 0.38))
    lib.tag(0)
    corner_stakes(-0.62, 0.72, -0.6, 0.72)
    lib.tag(0, until=0)
    # Head frame over the shaft (ridge along Y, open gable facing −Y) and the pier behind its right side.
    sx0, sx1, sy0, sy1, H, rh = -0.5, 0.18, -0.5, 0.42, 0.62, 0.52
    qx0, qx1, qy0, qy1, QH = 0.1, 0.68, 0.05, 0.66, 1.32
    lib.box(((sx0 + sx1) / 2, (sy0 + sy1) / 2, 0.03), (sx1 - sx0 + 0.08, sy1 - sy0 + 0.08, 0.06), blocks[3], bevel=0.015)
    lib.box(((qx0 + qx1) / 2, (qy0 + qy1) / 2, 0.05), (qx1 - qx0 + 0.1, qy1 - qy0 + 0.1, 0.1), blocks[1], bevel=0.02)
    lib.tag(1)
    lib.box(((qx0 + qx1) / 2, (qy0 + qy1) / 2, (0.1 + QH) / 2), (qx1 - qx0, qy1 - qy0, QH - 0.1), walls)
    stone_course(qx0, qx1, qy0, qy1, 0.1, QH, blocks, rnd, block=0.2, depth=0.07)
    for (x, y) in ((qx0, qy0), (qx1, qy0), (qx1, qy1)):
        lib.box((x + (0.03 if x == qx1 else -0.03), y - (0.03 if y == qy0 else -0.03), (QH + 0.12) / 2),
                (0.08, 0.08, QH + 0.02), beam, rot=(rnd.uniform(-0.02, 0.02), rnd.uniform(-0.02, 0.02), 0), bevel=0.012)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.6 else 3)
    # Cap of the pier: a timber ring and a few blocks.
    for (a, b, fixed, along_x) in ((qx0, qx1, qy0, True), (qx0, qx1, qy1, True), (qy0, qy1, qx0, False), (qy0, qy1, qx1, False)):
        loc = ((a + b) / 2, fixed, QH + 0.04) if along_x else (fixed, (a + b) / 2, QH + 0.04)
        size = (b - a + 0.14, 0.08, 0.08) if along_x else (0.08, b - a + 0.14, 0.08)
        lib.box(loc, size, beam, bevel=0.01)
    coping_line((qx0 + 0.08, qy0 + 0.1, QH + 0.12), (qx1 - 0.08, qy0 + 0.1, QH + 0.12), blocks, rnd, size=0.15)
    coping_line((qx1 - 0.1, qy0 + 0.25, QH + 0.12), (qx1 - 0.1, qy1 - 0.08, QH + 0.12), blocks, rnd, size=0.15)
    lib.tag(4)
    # The head frame: posts, sills and plates, a dark inside, plank side walls.
    for (x, y) in ((sx0, sy0), (sx1, sy0), (sx1, sy1), (sx0, sy1)):
        lib.box((x, y, H / 2 + 0.03), (0.085, 0.085, H), beam, rot=(rnd.uniform(-0.02, 0.02), rnd.uniform(-0.02, 0.02), 0),
                bevel=0.012)
    lib.tag(2)
    lib.box(((sx0 + sx1) / 2, (sy0 + sy1) / 2 + 0.05, H / 2), (sx1 - sx0 - 0.04, sy1 - sy0 - 0.1, H), dark)
    for y in (sy0, sy1):
        lib.box(((sx0 + sx1) / 2, y, H + 0.04), (sx1 - sx0 + 0.12, 0.09, 0.09), beam, bevel=0.012)
    for x in (sx0, sx1):
        lib.box((x, (sy0 + sy1) / 2, H + 0.04), (0.09, sy1 - sy0 + 0.12, 0.09), beam, bevel=0.012)
    n = 6
    for k in range(n):
        y = sy0 + 0.06 + (k + 0.5) * (sy1 - sy0 - 0.12) / n
        lib.box((sx1 + 0.02, y, H / 2 + 0.03), (0.025, (sy1 - sy0 - 0.12) / n * 0.92, H - 0.06), planks[k % len(planks)],
                rot=(rnd.uniform(-0.02, 0.02), 0, 0), bevel=0.005)
    windlass((sx0 + sx1) / 2, sy0 + 0.12, 0.3, sx1 - sx0 - 0.16, drum, rope, beam)
    lib.tag(3)
    # Steep gable roof of big slates; the open gable boarded above a tie beam.
    cx, cy = (sx0 + sx1) / 2, (sy0 + sy1) / 2
    W, L, ov = sx1 - sx0, sy1 - sy0, 0.1
    lib.prism_roof((cx, cy, H + 0.08), L, W, rh, slates[1], overhang=ov, thickness=0.04, along='y')
    for side in (-1, 1):
        e0 = (cx + side * (W / 2 + ov), sy0 - ov, H + 0.08 - ov * rh / (W / 2))
        e1 = (cx + side * (W / 2 + ov), sy1 + ov, H + 0.08 - ov * rh / (W / 2))
        r0, r1 = (cx, sy0 - ov, H + 0.08 + rh), (cx, sy1 + ov, H + 0.08 + rh)
        if side > 0:
            tile_face(e0, e1, r0, r1, slates, rnd, size=0.17, shape='tile', lift=0.035)
        else:
            tile_face(e1, e0, r1, r0, slates, rnd, size=0.17, shape='tile', lift=0.035)
    lib.gable((cx, cy, H + 0.08), W, rh, sy0 + 0.02, planks[0], along='y')
    rod((cx, sy0 - ov - 0.02, H + 0.08 + rh + 0.03), (cx, sy1 + ov + 0.02, H + 0.08 + rh + 0.03), 0.035, beam)
    # The track out of the mouth to its stop.
    rails(cx + 0.02, sy0 + 0.05, cx + 0.02, -1.2, sleeper, iron)
    buffer_stop(cx + 0.02, -1.22, sleeper, rnd)
    lib.tag(4)


def checker_face(e0, e1, r0, r1, dark, light, rnd, size=0.17, lift=0.035):
    """A roof face (eave e0→e1 up to ridge r0→r1) of big square tiles laid in a chequer of two sets of
    materials — Settlers 4's gold mine roof, dark slate and gilded tiles by turns."""
    from mathutils import Vector

    e0, e1, r0, r1 = (Vector(p) for p in (e0, e1, r0, r1))
    up = r0.lerp(r1, 0.5) - e0.lerp(e1, 0.5)
    rows = max(2, round(up.length / size))
    cols = max(2, round((e1 - e0).length / size))
    for r in range(rows):
        t = (r + 0.5) / rows
        a, b = e0.lerp(r0, t), e1.lerp(r1, t)
        u = (b - a).normalized()
        n = u.cross(up.normalized()).normalized()
        for k in range(cols):
            p = a.lerp(b, (k + 0.5) / cols) + n * (lift + 0.008 * (r % 2))
            mats = light if (r + k) % 2 else dark
            tile = lib.box((0, 0, 0), ((b - a).length / cols * 0.9, up.length / rows * 1.04, 0.035),
                           mats[rnd.randrange(len(mats))], bevel=0.008)
            jitter = Vector((rnd.uniform(-0.04, 0.04), rnd.uniform(-0.04, 0.04), 0))
            place_on(tile, p, u + jitter, up)


def build_goldmine():
    """After the Settlers 4 Roman gold mine: a tall timber head frame on a low stone plinth, its sides
    X-braced over dark plank walls, its open gable towards the camera under broad barge boards, a steep
    roof of big square tiles chequered dark slate and gold; a short track out of the mouth to a stop."""
    rnd = random.Random(121)
    blocks = grain_set('goldplinth', (((0.46, 0.45, 0.42), (0.78, 0.76, 0.7)), ((0.4, 0.4, 0.38), (0.68, 0.67, 0.63)),
                                      ((0.52, 0.49, 0.44), (0.84, 0.8, 0.72))))
    timber = lib.mat_grain('goldtimber', (0.4, 0.22, 0.07), (0.7, 0.46, 0.18), scale=5, stretch=(1, 1, 8), bump=0.8)
    planks = grain_set('goldplank', (((0.14, 0.1, 0.07), (0.3, 0.22, 0.14)), ((0.18, 0.12, 0.08), (0.34, 0.24, 0.15)),
                                     ((0.12, 0.09, 0.07), (0.26, 0.2, 0.14))), scale=4, stretch=(1, 1, 9), bump=0.7)
    slate = [lib.mat_grain(f'gslate{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.6) for k, (a, b) in enumerate((
        ((0.16, 0.18, 0.18), (0.32, 0.35, 0.34)), ((0.2, 0.22, 0.2), (0.38, 0.4, 0.37))))]
    gold = [lib.mat_grain(f'gtile{k}', a, b, scale=8, stretch=(1, 1, 1), bump=0.4) for k, (a, b) in enumerate((
        ((0.74, 0.6, 0.2), (0.98, 0.88, 0.46)), ((0.68, 0.54, 0.16), (0.95, 0.82, 0.38))))]
    sleeper = lib.mat_grain('sleeper', (0.5, 0.26, 0.1), (0.78, 0.46, 0.22), scale=5, stretch=(8, 1, 1), bump=0.6)
    iron = lib.mat_flat('iron', (0.42, 0.44, 0.48), rough=0.35)
    dark = lib.mat_flat('dark', (0.02, 0.02, 0.02))
    rock_pad((0.05, -0.2, 0), 0.8, 0.88, 121, (0.2, 0.2, 0.19), (0.42, 0.41, 0.38))
    lib.tag(0)
    x0, x1, y0, y1, Z0, H, rh = -0.42, 0.42, -0.52, 0.56, 0.1, 0.86, 0.5
    corner_stakes(x0 - 0.08, x1 + 0.08, y0 - 0.08, y1 + 0.08)
    lib.tag(0, until=0)
    lib.box((0, (y0 + y1) / 2, Z0 / 2), (x1 - x0 + 0.12, y1 - y0 + 0.12, Z0), dark)
    stone_course(x0 - 0.06, x1 + 0.06, y0 - 0.06, y1 + 0.06, 0.0, Z0, blocks, rnd, block=0.2, depth=0.05)
    lib.tag(1)
    # The frame, then the dark inside and plank walls on the sides.
    for (x, y) in ((x0, y0), (x1, y0), (x1, y1), (x0, y1)):
        lib.box((x, y, (Z0 + H) / 2), (0.085, 0.085, H - Z0), timber, rot=(rnd.uniform(-0.015, 0.015), 0, 0), bevel=0.012)
    for x in (x0, x1):
        lib.box((x, (y0 + y1) / 2, Z0 + 0.04), (0.09, y1 - y0 + 0.08, 0.08), timber, bevel=0.012)
    lib.tag(2)
    lib.box((0, (y0 + y1) / 2 + 0.04, (Z0 + H) / 2), (x1 - x0 - 0.04, y1 - y0 - 0.08, H - Z0), dark)
    n = 7
    for k in range(n):
        y = y0 + 0.05 + (k + 0.5) * (y1 - y0 - 0.1) / n
        lib.box((x1 + 0.005, y, (Z0 + H) / 2), (0.022, (y1 - y0 - 0.1) / n * 0.9, H - Z0 - 0.1), planks[k % len(planks)],
                bevel=0.004)
    # X-braces and a middle post in the side wall; plates on top.
    ym = (y0 + y1) / 2
    lib.box((x1 + 0.03, ym, (Z0 + H) / 2), (0.07, 0.07, H - Z0), timber, bevel=0.01)
    for (ya, yb) in ((y0, ym), (ym, y1)):
        rod((x1 + 0.04, ya + 0.04, Z0 + 0.08), (x1 + 0.04, yb - 0.04, H - 0.06), 0.03, timber, verts=8)
        rod((x1 + 0.04, ya + 0.04, H - 0.06), (x1 + 0.04, yb - 0.04, Z0 + 0.08), 0.03, timber, verts=8)
    for y in (y0, y1):
        lib.box((0, y, H + 0.03), (x1 - x0 + 0.12, 0.09, 0.09), timber, bevel=0.012)
    for x in (x0, x1):
        lib.box((x, (y0 + y1) / 2, H + 0.03), (0.09, y1 - y0 + 0.12, 0.09), timber, bevel=0.012)
    lib.tag(3)
    # Steep roof, ridge along Y, chequered; the gable boarded above a tie beam, broad barge boards.
    W, L, ov = x1 - x0, y1 - y0, 0.12
    zr = H + 0.08
    lib.prism_roof((0, ym, zr), L, W, rh, slate[0], overhang=ov, thickness=0.04, along='y')
    lib.tag(3)
    for side in (-1, 1):
        e0 = (side * (W / 2 + ov), y0 - ov, zr - ov * rh / (W / 2))
        e1 = (side * (W / 2 + ov), y1 + ov, zr - ov * rh / (W / 2))
        r0, r1 = (0, y0 - ov, zr + rh), (0, y1 + ov, zr + rh)
        if side > 0:
            checker_face(e0, e1, r0, r1, slate, gold, rnd)
        else:
            checker_face(e1, e0, r1, r0, slate, gold, rnd)
    lib.gable((0, ym, zr), W, rh, y0 + 0.01, planks[1], along='y')
    for side in (-1, 1):
        a = (side * (W / 2 + ov), y0 - ov - 0.02, zr - ov * rh / (W / 2) - 0.01)
        b = (0, y0 - ov - 0.02, zr + rh + 0.02)
        mid = ((a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2)
        ln = math.hypot(b[0] - a[0], b[2] - a[2])
        lib.box(mid, (ln + 0.04, 0.05, 0.1), timber, rot=(0, -math.atan2(b[2] - a[2], b[0] - a[0]), 0), bevel=0.01)
    rod((0, y0 - ov - 0.03, zr + rh + 0.04), (0, y1 + ov + 0.03, zr + rh + 0.04), 0.035, timber)
    lib.tag(None, split=lambda o: 3 if o.location.x < -0.05 else 4)
    rails(0.05, y0 + 0.1, 0.05, -1.2, sleeper, iron)
    buffer_stop(0.05, -1.22, sleeper, rnd)
    lib.tag(4)


# ------------------------------------------------------------------------------------- smelters, smithy (2×2)

def rivet_dome(cx, cy, r, h, plates, band, rivet, rnd, stretch=1.0, z0=0.0):
    """A smelting furnace after Settlers 4's: a beehive of riveted metal (half an ellipsoid of radius r,
    height h, `stretch` times longer along Y) cut into panels by ribs from foot to crown and girt with
    bands, rivets along both; the panels bulge a little between the ribs."""
    from mathutils import Vector

    core = lib.sphere((cx, cy, z0), 1.0, plates[0], scale=(r, r * stretch, h), subdiv=4)
    ribs = 12

    def at(a, el, out=0.0):
        rr = r * math.cos(el) + out
        return (cx + math.cos(a) * rr, cy + math.sin(a) * rr * stretch, z0 + (h + out) * math.sin(el))

    # Bulging panels: one flattened ellipsoid per panel, between two ribs and two bands.
    els = (math.radians(3), math.radians(30), math.radians(58))
    for j in range(ribs):
        a = (j + 0.5) / ribs * math.tau
        if math.cos(a + math.pi / 4) < -0.5:
            continue
        for k in range(len(els) - 1):
            el = (els[k] + els[k + 1]) / 2
            p = at(a, el)
            span = r * math.cos(el) * math.tau / ribs * 0.46
            tall = (els[k + 1] - els[k]) * math.hypot(r, h) * 0.46
            panel = lib.sphere(p, 1.0, plates[rnd.randrange(len(plates))], scale=(span, tall, 0.045), subdiv=3)
            u = Vector((-math.sin(a) * stretch, math.cos(a), 0))
            v = Vector((-math.cos(a) * math.sin(el) * r, -math.sin(a) * math.sin(el) * r * stretch, math.cos(el) * h))
            place_on(panel, p, u, v)
    for j in range(ribs):
        a = j / ribs * math.tau
        if math.cos(a + math.pi / 4) < -0.55:
            continue
        pts = [at(a, math.radians(e), 0.012) for e in range(2, 84, 9)]
        for p, q in zip(pts, pts[1:]):
            rod(p, q, 0.02, band, verts=6)
        for e in (12, 24, 40, 52):
            lib.sphere(at(a, math.radians(e), 0.03), 0.015, rivet, subdiv=1)
    for e in (6, 32, 60):
        el = math.radians(e)
        ring = torus((cx, cy, z0 + h * math.sin(el)), r * math.cos(el) + 0.015, 0.026, band)
        ring.scale = (1, stretch, 1)
        n = max(8, int(22 * math.cos(el)))
        for j in range(n):
            a = (j + 0.5) / n * math.tau
            if math.cos(a + math.pi / 4) < -0.5:
                continue
            lib.sphere(at(a, el, 0.04), 0.017, rivet, subdiv=1)
    lib.cylinder((cx, cy, z0 + h - 0.01), r * 0.32, 0.06, band, verts=16)
    return core


def furnace_mouth(x, y, z, w, h, frame, fire, dark, iron, name):
    """The fire door in a furnace's front (−Y): a glowing opening behind a dark frame and an iron grate;
    records the glow for the game's flicker."""
    lib.box((x, y, z), (w + 0.08, 0.08, h + 0.08), frame, bevel=0.01)
    lib.box((x, y - 0.03, z), (w, 0.06, h), dark)
    lib.box((x, y - 0.045, z - h * 0.15), (w * 0.86, 0.05, h * 0.6), fire)
    for k in range(4):
        lib.box((x - w / 2 + (k + 0.5) * w / 4, y - 0.075, z), (0.018, 0.02, h), iron)
    note_fx(name, 'glow', (x, y - 0.1, z - h * 0.1))


def chute(a, b, metal, block):
    """The pouring trough out of a furnace: a pale tilted channel from a to b onto a stone block."""
    rod(a, b, 0.055, metal, verts=10)
    lib.box((b[0], b[1], 0.07), (0.2, 0.2, 0.14), block, bevel=0.02)


def furnace_chimney(x, y, zb, zt, blocks, rnd, name, r=0.1):
    """A round stone stack rising out of a furnace's crown; records its mouth for the smoke."""
    lib.cylinder((x, y, (zb + zt) / 2), r * 0.92, zt - zb, blocks[0], verts=16)
    rows = max(2, round((zt - zb) / 0.08))
    for k in range(rows):
        z = zb + (k + 0.5) * (zt - zb) / rows
        for j in range(8):
            a = (j + 0.5 * (k % 2)) / 8 * math.tau
            lib.box((x + math.cos(a) * r, y + math.sin(a) * r, z), (r * 0.72, 0.045, (zt - zb) / rows * 0.82),
                    blocks[rnd.randrange(len(blocks))], rot=(0, 0, a + math.pi / 2), bevel=0.01)
    lib.cylinder((x, y, zt + 0.025), r + 0.035, 0.05, blocks[1], verts=16)
    lib.cylinder((x, y, zt + 0.03), r * 0.7, 0.05, lib.mat_flat('soot', (0.03, 0.03, 0.03)), verts=12)
    note_fx(name, 'smoke', (x, y, zt + 0.08))


def paving(rnd, pts, mats):
    """A few loose pale flagstones on the trodden earth in front of a workshop."""
    for k, (x, y) in enumerate(pts):
        lib.box((x, y, 0.012), (rnd.uniform(0.1, 0.15), rnd.uniform(0.1, 0.15), 0.025), mats[k % len(mats)],
                rot=(0, 0, rnd.uniform(-0.4, 0.4)), bevel=0.008)


def battened_roof(cx, cy, L, W, H, rh, boards, batten, axis, overhang, seed, bars=(0.36, 0.72)):
    """A board roof (`plank_roof`) held down by dark battens laid across the boards at fractions of
    each visible slope (Settlers 4's smelters)."""
    _b().plank_roof(cx, cy, L, W, H, rh, boards, axis=axis, overhang=overhang, seed=seed)
    along = (L if axis == 'x' else W) + 2 * overhang
    run = (W if axis == 'x' else L) / 2 + overhang
    drop = overhang * rh / ((W if axis == 'x' else L) / 2)
    ang = math.atan2(rh + drop, run)
    for side in (-1, 1):
        if (axis == 'x' and side > 0) or (axis == 'y' and side < 0):
            continue  # the far slope
        for t in bars:
            off = side * run * (1 - t)
            z = H - drop + (rh + drop) * t + 0.05
            if axis == 'x':
                lib.box((cx, cy + off, z), (along + 0.02, 0.05, 0.035), batten, rot=(-side * ang, 0, 0), bevel=0.006)
            else:
                lib.box((cx + off, cy, z), (0.05, along + 0.02, 0.035), batten, rot=(0, side * ang, 0), bevel=0.006)


def build_ironsmelter():
    """After the Settlers 4 Roman iron smelter: a big beehive furnace of riveted steel plates in front,
    a round stone stack out of its crown, a fire door and a pale pouring trough towards the camera;
    behind it to the right a workshop on a stone footing, timber posts and plank walls under a board
    roof with dark battens, its gable and door towards the camera; flagstones on the earth."""
    rnd = random.Random(131)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = boards_mats()
    wallplanks = grain_set('ismplank', (((0.3, 0.18, 0.08), (0.5, 0.34, 0.16)), ((0.36, 0.22, 0.1), (0.56, 0.38, 0.18)),
                                        ((0.26, 0.17, 0.09), (0.44, 0.3, 0.16))), scale=4, stretch=(1, 1, 9), bump=0.7)
    plates = grain_set('iplate', (((0.36, 0.38, 0.42), (0.66, 0.69, 0.74)), ((0.3, 0.32, 0.36), (0.56, 0.59, 0.64)),
                                  ((0.42, 0.43, 0.46), (0.74, 0.75, 0.78))), scale=12, bump=0.4)
    band = lib.mat_flat('band', (0.24, 0.25, 0.28), rough=0.35)
    rivet = lib.mat_flat('rivet', (0.82, 0.84, 0.88), rough=0.25)
    pale = lib.mat_flat('trough', (0.78, 0.78, 0.76), rough=0.4)
    fire = lib.mat_flat('fire', (1.0, 0.55, 0.12), rough=0.6)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.35)
    door = door_mat()
    earth_pad((0.05, -0.2, 0), 0.9, 0.98, seed=131)
    paving(rnd, ((-0.1, -0.95), (0.12, -1.05), (0.35, -0.9), (0.55, -1.0), (-0.32, -1.05)), blocks)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    # The workshop (ridge along Y, gable towards the camera) and the furnace's base.
    sx0, sx1, sy0, sy1, sH, srh = 0.02, 0.84, -0.55, 0.78, 0.66, 0.4
    fx, fy, fr, fh = -0.36, -0.22, 0.48, 0.8
    lib.box(((sx0 + sx1) / 2, (sy0 + sy1) / 2, 0.05), (sx1 - sx0 + 0.06, sy1 - sy0 + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.cylinder((fx, fy, 0.06), fr + 0.1, 0.12, blocks[3], verts=24)
    lib.tag(1)
    stone_house(sx0, sx1, sy0, sy1, 0.24, rnd, walls, blocks, z0=0.0)
    for (x, y) in ((sx0, sy0), (sx1, sy0), (sx1, sy1)):
        lib.box((x, y, (0.24 + sH) / 2), (0.08, 0.08, sH - 0.24 + 0.02), beam, bevel=0.01)
    rivet_dome(fx, fy, fr, fh * 0.5, plates, band, rivet, rnd, stretch=1.12, z0=0.12)
    lib.tag(2)
    plank_walls(sx0, sx1, sy0, sy1, 0.24, sH, wallplanks, walls, beam, rnd)
    lib.box((0.5, sy0 - 0.03, 0.4), (0.24, 0.04, 0.42), door, bevel=0.008)
    lib.box((0.5, sy0 - 0.05, 0.63), (0.34, 0.06, 0.06), beam)
    lib.tag(3)
    rivet_dome(fx, fy, fr, fh, plates, band, rivet, rnd, stretch=1.12, z0=0.12)
    furnace_mouth(fx + 0.02, fy - fr * 1.12 + 0.04, 0.3, 0.2, 0.18, band, fire, dark, iron, 'ironsmelter')
    chute((fx + 0.06, fy - fr * 1.12 + 0.02, 0.26), (fx + 0.2, fy - fr * 1.12 - 0.3, 0.14), pale, blocks[2])
    lib.tag(3)
    lib.gable(((sx0 + sx1) / 2, (sy0 + sy1) / 2, sH), sx1 - sx0, srh, sy0 - 0.02, wallplanks[0], along='y')
    battened_roof((sx0 + sx1) / 2, (sy0 + sy1) / 2, sx1 - sx0, sy1 - sy0, sH, srh, planks, beam, 'y', 0.1, 133)
    furnace_chimney(fx - 0.06, fy + 0.12, 0.12 + fh * 0.8, 1.3, blocks, rnd, 'ironsmelter')
    lib.tag(4)


def build_goldsmelter():
    """After the Settlers 4 Roman gold smelter: a tall house of rough grey stone under a roof of
    orange boards with dark battens, a low lean-to under red terracotta along its front; on its right
    a beehive furnace of riveted brass plates with a round stone stack out of its crown, a fire door and
    a pale pouring trough towards the camera; flagstones on the earth."""
    rnd = random.Random(141)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = [lib.mat_grain(f'gboard{k}', a, b, scale=4, stretch=(1, 9, 1), bump=0.6) for k, (a, b) in enumerate((
        ((0.56, 0.3, 0.1), (0.86, 0.54, 0.22)), ((0.5, 0.26, 0.08), (0.78, 0.46, 0.18)),
        ((0.62, 0.36, 0.14), (0.9, 0.62, 0.3)), ((0.46, 0.28, 0.12), (0.7, 0.46, 0.22))))]
    tiles = terracotta_mats('gtc')
    brass = grain_set('brass', (((0.6, 0.44, 0.16), (0.92, 0.74, 0.34)), ((0.54, 0.38, 0.12), (0.86, 0.66, 0.28)),
                                ((0.66, 0.5, 0.2), (0.96, 0.8, 0.42))), scale=12, bump=0.4)
    band = lib.mat_flat('band', (0.44, 0.3, 0.12), rough=0.35)
    rivet = lib.mat_flat('rivet', (0.95, 0.82, 0.45), rough=0.25)
    pale = lib.mat_flat('trough', (0.82, 0.82, 0.8), rough=0.4)
    fire = lib.mat_flat('fire', (1.0, 0.6, 0.15), rough=0.6)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.35)
    door = door_mat()
    earth_pad((0.05, -0.2, 0), 0.9, 0.98, seed=141)
    paving(rnd, ((0.2, -0.95), (0.45, -1.02), (0.68, -0.88), (0.0, -1.05), (0.82, -0.6)), blocks)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    # The house (ridge along X), its front lean-to, and the furnace's base on the right.
    x0, x1, y0, y1, H, rh = -0.8, 0.2, -0.3, 0.8, 0.92, 0.42
    ly0, lH = -0.75, 0.48
    fx, fy, fr, fh = 0.5, -0.2, 0.44, 0.72
    lib.box(((x0 + x1) / 2, (ly0 + y1) / 2, 0.05), (x1 - x0 + 0.06, y1 - ly0 + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.cylinder((fx, fy, 0.06), fr + 0.1, 0.12, blocks[3], verts=24)
    lib.tag(1)
    stone_house(x0, x1, y0, y1, H * 0.5, rnd, walls, blocks, z0=0.1)
    stone_house(x0, x1, ly0, y0, lH * 0.8, rnd, walls, blocks, z0=0.1)
    rivet_dome(fx, fy, fr, fh * 0.5, brass, band, rivet, rnd, z0=0.12)
    lib.tag(2)
    stone_house(x0, x1, y0, y1, H, rnd, walls, blocks, z0=H * 0.5)
    lib.box(((x0 + x1) / 2 - 0.05, ly0, lH * 0.85), (x1 - x0 + 0.02, 0.06, 0.06), beam)
    arch_door(-0.05, ly0 - 0.01, 0.1, 0.24, 0.36, door, blocks)
    rivet_dome(fx, fy, fr, fh, brass, band, rivet, rnd, z0=0.12)
    furnace_mouth(fx - 0.02, fy - fr + 0.04, 0.3, 0.18, 0.16, band, fire, dark, iron, 'goldsmelter')
    chute((fx + 0.06, fy - fr + 0.02, 0.26), (fx + 0.26, fy - fr - 0.3, 0.14), pale, blocks[2])
    lib.tag(3)
    lib.gable((x1 + 0.01, (y0 + y1) / 2, H), y1 - y0, rh, x1 + 0.01, walls, along='x')
    stone_course(x1 - 0.02, x1, y0 + 0.2, y1 - 0.2, H, H + rh * 0.45, blocks, rnd, block=0.16, depth=0.05, faces=('x',))
    battened_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, planks, beam, 'x', 0.1, 143)
    # The lean-to: red tiles from the house wall down over the front.
    ov = 0.08
    tile_face((x0 - ov, ly0 - ov, lH - 0.02), (x1 + ov, ly0 - ov, lH - 0.02), (x0 - ov, y0, H * 0.78),
              (x1 + ov, y0, H * 0.78), tiles, rnd, size=0.12, shape='tile', lift=0.02)
    lib.box(((x0 + x1) / 2, (ly0 + y0) / 2 - 0.02, (lH + H * 0.78) / 2 - 0.02),
            (x1 - x0 + 2 * ov, math.hypot(y0 - ly0 + ov, H * 0.78 - lH) + 0.02, 0.03), tiles[1],
            rot=(math.atan2(H * 0.78 - lH, y0 - ly0 + ov), 0, 0))
    furnace_chimney(fx + 0.05, fy + 0.1, 0.12 + fh * 0.8, 1.22, blocks, rnd, 'goldsmelter')
    lib.tag(4)


def build_weaponsmith():
    """Our weaponsmith: a smithy with a fieldstone ground floor and a half-timbered upper floor under
    planks, a glazed half-moon window of three coloured fans in its gable; a round forge tower on its
    right under a cone of terracotta with the chimney through its top; an anvil by the door."""
    rnd = random.Random(151)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = boards_mats()
    tiles = terracotta_mats('wtc')
    plaster = lib.mat_stones('wplaster', (0.86, 0.78, 0.64), (0.7, 0.62, 0.48), (0.58, 0.5, 0.38), scale=6, bump=0.3)
    glass = [lib.mat_flat('wglass0', (0.32, 0.5, 0.56), rough=0.15), lib.mat_flat('wglass1', (0.4, 0.58, 0.46), rough=0.15),
             lib.mat_flat('wglass2', (0.46, 0.5, 0.62), rough=0.15)]
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.35)
    door = door_mat()
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.1, -0.2, 0), 0.98, 1.08, seed=151)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    x0, x1, y0, y1, H, rh = -0.82, 0.05, -0.55, 0.8, 0.8, 0.42
    tx, ty, tr, tH = 0.42, -0.05, 0.34, 0.74
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.05), (x1 - x0 + 0.06, y1 - y0 + 0.06, 0.1), blocks[1], bevel=0.02)
    lib.cylinder((tx, ty, 0.05), tr + 0.05, 0.1, blocks[2], verts=24)
    lib.tag(1)
    stone_house(x0, x1, y0, y1, H * 0.45, rnd, walls, blocks)
    round_tower(tx, ty, tr, 0.1, tH * 0.5, walls, blocks, rnd, rows=2)
    lib.tag(2)
    half_timber(x0, x1, y0, y1, H * 0.45, H, plaster, beam, rnd)
    lib.gable(((x0 + x1) / 2, (y0 + y1) / 2, H), x1 - x0, rh - 0.02, y0 + 0.01, plaster, along='y')
    gx, gz, gr = (x0 + x1) / 2, H + 0.03, 0.19
    lib.cylinder((gx, y0 - 0.02, gz), gr + 0.03, 0.04, beam, rot=(math.pi / 2, 0, 0), verts=24)
    for k in range(3):
        a = k / 3 * math.pi + math.pi / 6
        lib.box((gx + math.cos(a) * gr * 0.5, y0 - 0.045, gz + math.sin(a) * gr * 0.5), (gr * 0.9, 0.02, gr * 0.5),
                glass[k], rot=(0, -a, 0))
    lib.box((gx, y0 - 0.04, gz - 0.02), (2 * gr + 0.08, 0.05, 0.05), beam)
    lib.box((-0.22, y0 - 0.04, 0.2), (0.24, 0.04, 0.4), door, bevel=0.008)
    lib.box((-0.22, y0 - 0.06, 0.42), (0.32, 0.06, 0.05), beam)
    round_tower(tx, ty, tr, tH * 0.5, tH, walls, blocks, rnd, rows=2)
    lib.box((tx, ty - tr - 0.01, 0.17), (0.2, 0.05, 0.24), dark)
    note_fx('weaponsmith', 'glow', (tx, ty - tr - 0.05, 0.17))
    lib.tag(3)
    _b().plank_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, planks, axis='y', overhang=0.1, seed=153)
    cone_tiles(tx, ty, tH, tr + 0.08, 0.42, tiles, rnd, size=0.11)
    chimney(tx, ty, tH + 0.2, tH + 0.64, blocks, rnd, name='weaponsmith')
    lib.box((0.28, -0.86, 0.1), (0.14, 0.14, 0.2), planks[1], bevel=0.01)
    lib.box((0.28, -0.86, 0.24), (0.22, 0.1, 0.07), iron, bevel=0.01)
    lib.box((0.4, -0.86, 0.25), (0.08, 0.05, 0.03), iron)
    lib.tag(4)


# ------------------------------------------------------------------------------------- houses

def scale_scene(k, keep=('ShadowCatcher',), kz=None):
    """Scales every object of the model built so far about the world origin by k across and `kz`
    (default k) in height — object-space textures grow with them; construction-stage tags stay on the
    objects. Returns the same mapping for world points (banner and effect anchors)."""
    root = bpy.data.objects.new('scale-root', None)
    bpy.context.scene.collection.objects.link(root)
    bpy.context.view_layer.update()
    for obj in list(bpy.context.scene.objects):
        if obj is root or obj.name in keep or obj.type not in ('MESH', 'EMPTY') or obj.parent is not None:
            continue
        world = obj.matrix_world.copy()
        obj.parent = root
        obj.matrix_world = world
    kz = k if kz is None else kz
    root.scale = (k, k, kz)
    bpy.context.view_layer.update()
    return lambda p: (p[0] * k, p[1] * k, p[2] * kz)


def build_house_small():
    """The small residence: a squat fieldstone cottage, ridge along Y, its gable towards the camera
    half-timbered above the stone ground floor, crow-stepped gable edges, a roof of blue-grey slate
    scales, teal windows and a plank door."""
    rnd = random.Random(161)
    walls = stone_walls()
    blocks = block_mats()
    beam = lib.mat_grain('timber', (0.24, 0.15, 0.06), (0.42, 0.28, 0.12), scale=5, stretch=(1, 1, 8), bump=0.6)
    plaster = lib.mat_stones('plaster', (0.88, 0.8, 0.66), (0.72, 0.64, 0.5), (0.6, 0.52, 0.4), scale=6, bump=0.3)
    slates = slate_mats()
    teal = lib.mat_flat('teal', (0.2, 0.5, 0.52), rough=0.5)
    glass = lib.mat_flat('glass', (0.36, 0.56, 0.62), rough=0.2)
    door = door_mat()
    earth_pad((0.1, -0.2, 0), 0.92, 1.02, seed=161)
    lib.tag(0)
    x0, x1, y0, y1, H, rh = -0.6, 0.42, -0.6, 0.68, 0.56, 0.48
    corner_stakes(x0, x1, y0, y1)
    lib.tag(0, until=0)
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.05), (x1 - x0 + 0.06, y1 - y0 + 0.06, 0.1), blocks[1], bevel=0.02)
    _b().timber_frame((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, beam, axis='y')
    lib.tag(1, until=3)
    stone_house(x0, x1, y0, y1, H * 0.55, rnd, walls, blocks, block=0.19)
    quoins(x0, x1, y0, y1, 0.02, H * 0.55, blocks, rnd, block=0.22, row=0.16)
    lib.tag(2)
    stone_house(x0, x1, y0 + 0.05, y1, H, rnd, walls, blocks, z0=H * 0.55, block=0.19)
    half_timber(x0, x1, y0, y0 + 0.06, H * 0.55, H, plaster, beam, rnd)
    lib.gable(((x0 + x1) / 2, (y0 + y1) / 2, H), x1 - x0, rh - 0.02, y0 - 0.005, plaster, along='y')
    lib.box(((x0 + x1) / 2, y0 - 0.03, H + rh * 0.45), (0.04, 0.03, rh * 0.9), beam)
    mullion_window(x0 + 0.24, y0 - 0.04, H * 0.78, 0.15, 0.16, teal, glass)
    mullion_window((x0 + x1) / 2, y0 - 0.03, H + rh * 0.33, 0.11, 0.11, teal, glass)
    lib.box((0.2, y0 - 0.05, 0.21), (0.22, 0.04, 0.42), door, bevel=0.01)
    lib.box((0.2, y0 - 0.07, 0.44), (0.3, 0.06, 0.06), blocks[2], bevel=0.015)
    mullion_window(x1 + 0.05, 0.1, H * 0.45, 0.15, 0.15, teal, glass, face='x')
    lib.tag(3)
    scale_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, slates, lib.mat_flat('sl-ridge', (0.22, 0.29, 0.42)),
               axis='y', overhang=0.08, seed=162, size=0.13)
    lib.tag(None, split=lambda o: 3 if o.location.x > (x0 + x1) / 2 else 4)
    stepped_gable_y((x0 + x1) / 2, y0 - 0.02, x1 - x0 + 0.1, H, rh, blocks, rnd, steps=3)
    lib.tag(4)


# ------------------------------------------------------------------------------------- toolsmith (2×2)

def build_toolsmith():
    """Our toolsmith, deliberately unlike our weaponsmith: an open-sided timber workshop on a stone
    footing under a hipped roof of wooden shingles, a square brick hearth inside with a tapering stone
    hood and chimney rising through the roof, a closed stone storeroom at the back; outside a
    grindstone on its frame, a rack of finished tools and a water barrel."""
    rnd = random.Random(191)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = boards_mats()
    sh = shingle_mats('tsh')
    bricks = grain_set('brick', (((0.46, 0.2, 0.12), (0.7, 0.34, 0.2)), ((0.4, 0.18, 0.1), (0.62, 0.3, 0.18))), scale=9)
    iron = lib.mat_flat('iron', (0.3, 0.31, 0.34), rough=0.3)
    stone = lib.mat_grain('grind', (0.6, 0.56, 0.48), (0.82, 0.78, 0.7), scale=10, stretch=(1, 1, 1), bump=0.6)
    water = lib.mat_flat('water', (0.24, 0.5, 0.62), rough=0.1)
    fire = lib.mat_flat('fire', (1.0, 0.5, 0.1), rough=0.6)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.1, -0.2, 0), 0.98, 1.08, seed=191)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    x0, x1, y0, y1, H = -0.75, 0.6, -0.5, 0.75, 0.62
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.06), (x1 - x0 + 0.06, y1 - y0 + 0.06, 0.12), blocks[1], bevel=0.02)
    lib.tag(1)
    # Storeroom: a closed stone room along the back (+Y) third.
    sy0 = y1 - 0.42
    stone_house(x0, x1, sy0, y1, H, rnd, walls, blocks, z0=0.12, block=0.18)
    # Open hall in front: posts and plates.
    for x in (x0 + 0.03, (x0 + x1) / 2, x1 - 0.03):
        lib.box((x, y0 + 0.03, 0.12 + (H - 0.12) / 2), (0.07, 0.07, H - 0.12), beam, bevel=0.01)
    lib.box((x1 - 0.03, (y0 + sy0) / 2, 0.12 + (H - 0.12) / 2), (0.07, 0.07, H - 0.12), beam, bevel=0.01)
    lib.box(((x0 + x1) / 2, y0 + 0.03, H), (x1 - x0 + 0.06, 0.07, 0.07), beam)
    lib.box((x1 - 0.03, (y0 + y1) / 2, H), (0.07, y1 - y0 + 0.06, 0.07), beam)
    for x in (x0 + 0.03 + 0.2, x1 - 0.03 - 0.2):
        lib.box((x, y0 + 0.03, H - 0.12), (0.32, 0.05, 0.05), beam, rot=(0, 0.6 if x < 0 else -0.6, 0))
    lib.tag(2)
    # Brick hearth with a stone hood and chimney, glowing coals.
    hx, hy = x0 + 0.35, sy0 - 0.2
    lib.box((hx, hy, 0.24), (0.42, 0.36, 0.24), bricks[0], bevel=0.015)
    lib.box((hx, hy - 0.05, 0.37), (0.26, 0.18, 0.03), fire)
    lib.cylinder((hx, hy + 0.04, 0.62), 0.24, 0.3, walls, radius2=0.11, verts=4, rot=(0, 0, math.pi / 4))
    note_fx('toolsmith', 'glow', (hx, hy - 0.22, 0.38))
    # The anvil in the hall and a quench trough.
    lib.box((0.12, y0 + 0.3, 0.2), (0.12, 0.12, 0.16), planks[1], bevel=0.01)
    lib.box((0.12, y0 + 0.3, 0.31), (0.22, 0.09, 0.06), iron, bevel=0.01)
    lib.tag(3)
    hip_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, 0.38, sh, lib.mat_flat('tsh-r', (0.36, 0.24, 0.12)), rnd,
             overhang=0.12, size=0.12, shape='tile', ridge_frac=0.55)
    chimney(hx, hy + 0.04, 0.78, H + 0.62, bricks, rnd, name='toolsmith')
    lib.tag(None, split=lambda o: 4)
    # Outside: grindstone on a frame, a tool rack, a water barrel.
    gx, gy = 0.7, -0.85
    for dy in (-0.07, 0.07):
        lib.box((gx, gy + dy, 0.13), (0.05, 0.03, 0.26), beam, rot=(0.12 if dy > 0 else -0.12, 0, 0))
    lib.cylinder((gx, gy, 0.24), 0.15, 0.06, stone, rot=(math.pi / 2, 0, 0), verts=24)
    lib.cylinder((gx, gy, 0.24), 0.02, 0.22, iron, rot=(math.pi / 2, 0, 0), verts=8)
    rx, ry = -0.85, -0.5
    lib.box((rx, ry, 0.26), (0.04, 0.5, 0.04), beam)
    for dy in (-0.22, 0.22):
        lib.box((rx, ry + dy, 0.15), (0.04, 0.04, 0.3), beam)
    for k in range(4):
        y = ry - 0.15 + k * 0.1
        lib.box((rx - 0.02, y, 0.16), (0.015, 0.015, 0.22), beam, rot=(0.15, 0, 0))
        head = (0.07, 0.03, 0.04) if k % 2 else (0.03, 0.08, 0.03)
        lib.box((rx - 0.02, y, 0.05), head, iron)
    lib.cylinder((-0.3, -0.9, 0.11), 0.1, 0.22, planks[1], verts=16)
    lib.cylinder((-0.3, -0.9, 0.215), 0.09, 0.01, water, verts=16)
    for z in (0.04, 0.18):
        torus((-0.3, -0.9, z), 0.102, 0.008, iron)
    lib.tag(4)


# ----------------------------------------------------------------------------------- sheep farm (3×3)

def build_sheepfarm():
    """The Settlers 4 Roman sheep farm: a barn of grey
    fieldstone under a barrel roof of wooden shingles, its arched front gable boarded with a round
    window and a small door, a stone chimney on the ridge; beside it a low stone shed under deep
    golden thatch, open towards a strawy yard with a trough and a flock of white, black-faced sheep.
    Modelled at its 3×3 size."""
    rnd = random.Random(201)
    walls = stone_walls()
    gb = grey_blocks('pgb')
    beam = beam_mat()
    straw = thatch_mat()
    sh = shingle_mix(barrel_shingles('psh'))
    gable_planks = grain_set('pgable', (((0.4, 0.17, 0.08), (0.6, 0.3, 0.14)), ((0.46, 0.22, 0.1), (0.66, 0.36, 0.18)),
                                        ((0.36, 0.16, 0.08), (0.54, 0.28, 0.14))), scale=4, stretch=(1, 1, 9), bump=0.6)
    planks = boards_mats()
    yard = lib.mat_grain('pyard', (0.5, 0.36, 0.16), (0.78, 0.62, 0.3), scale=22, stretch=(1, 1, 1), bump=0.8)
    wool = lib.mat_grain('wool', (0.84, 0.84, 0.8), (0.98, 0.98, 0.95), scale=30, stretch=(1, 1, 1), bump=0.6)
    black = lib.mat_flat('sheep-black', (0.08, 0.07, 0.07), rough=0.6)
    teal = lib.mat_grain('trough', (0.12, 0.36, 0.32), (0.2, 0.5, 0.44), scale=8, stretch=(1, 1, 6), bump=0.4)
    water = lib.mat_flat('water', (0.3, 0.5, 0.56), rough=0.1)
    glass = lib.mat_flat('pglass', (0.62, 0.66, 0.62), rough=0.3)
    door = door_mat()
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.05, -0.25, 0), 1.55, 1.6, seed=201)
    lib.tag(0)
    corner_stakes(-1.4, 1.45, -1.45, 1.0)
    lib.tag(0, until=0)

    # Barn: ridge along Y, its arched gable towards the camera's left (−Y).
    bx0, bx1, by0, by1, Hw = -1.38, 0.0, -0.95, 0.95, 0.58
    bcx = (bx0 + bx1) / 2
    c, s = (bx1 - bx0) / 2, 0.82
    lib.box((bcx, 0, 0.05), (bx1 - bx0 + 0.06, by1 - by0 + 0.06, 0.1), gb[1], bevel=0.02)
    stone_house(bx0, bx1, by0, by1, Hw * 0.4, rnd, walls, gb, block=0.2)
    lib.tag(1)
    stone_house(bx0, bx1, by0, by1, Hw, rnd, walls, gb, z0=Hw * 0.4, block=0.2)
    # A small door in the gable wall, the wide dark doorway to the yard in the side wall.
    lib.box((bx0 + 0.36, by0 - 0.05, 0.2), (0.2, 0.04, 0.4), door, bevel=0.008)
    lib.box((bx0 + 0.36, by0 - 0.08, 0.42), (0.28, 0.06, 0.06), beam)
    lib.box((bx1 + 0.02, -0.32, 0.27), (0.04, 0.42, 0.54), dark)
    for dy in (-0.23, 0.23):
        lib.box((bx1 + 0.05, -0.32 + dy, 0.28), (0.05, 0.05, 0.56), beam)
    lib.box((bx1 + 0.05, -0.32, 0.56), (0.06, 0.52, 0.06), beam)
    lib.tag(2)
    at = barrel_frame(bcx, 0.0, Hw, 'y')[0]
    barrel_ribs(at, by1 - by0, c, s, beam, count=4, battens=5)
    lib.tag(3, until=3)
    arch_infill(at, -(by1 - by0) / 2 + 0.01, c - 0.01, s, walls)
    arch_boards(at, -(by1 - by0) / 2, c - 0.01, s, gable_planks, rnd, 'y', width=0.12, out=0.04)
    # Round window with spokes in the gable.
    wz = Hw + s * 0.42
    lib.cylinder((bcx, by0 - 0.07, wz), 0.13, 0.03, beam, rot=(math.pi / 2, 0, 0), verts=20)
    lib.cylinder((bcx, by0 - 0.08, wz), 0.1, 0.03, glass, rot=(math.pi / 2, 0, 0), verts=20)
    for k in range(4):
        lib.box((bcx, by0 - 0.095, wz), (0.2, 0.012, 0.018), beam, rot=(0, k * math.pi / 4, 0))
    lib.tag(3)
    barrel_roof(bcx, 0.0, Hw, by1 - by0, c, s, sh, lib.mat_grain('pvault', (0.3, 0.18, 0.08), (0.46, 0.3, 0.14),
                scale=6, stretch=(1, 1, 1), bump=0.4), beam, rnd, axis='y', overhang=0.1, size=0.16, upto=0.6)
    lib.tag(None, split=lambda o: 3 if o.location.z < Hw + s * 0.45 and o.location.x > bcx + c * 0.5 else 4)
    chimney(bcx + 0.12, 0.25, Hw + s - 0.25, Hw + s + 0.24, gb, rnd)
    lib.tag(4)

    # Shed: ridge along X, stone back and end walls, open to the yard (−Y), deep thatch.
    sx0, sx1, sy0, sy1, sH, sR = bx1, 1.42, -0.12, 0.92, 0.46, 0.96
    scy = (sy0 + sy1) / 2
    lib.box(((sx0 + sx1) / 2, scy, 0.04), (sx1 - sx0, sy1 - sy0, 0.08), gb[3], bevel=0.02)
    lib.tag(1)
    lib.box(((sx0 + sx1) / 2, sy1 - 0.08, sH / 2), (sx1 - sx0, 0.16, sH), walls)
    lib.box(((sx0 + sx1) / 2, scy, 0.1), (sx1 - sx0 - 0.1, sy1 - sy0 - 0.2, 0.02), dark)
    stone_house(sx1 - 0.16, sx1, sy0, sy1, sH, rnd, walls, gb, block=0.18)
    lib.gable((sx1 - 0.08, scy, sH), sy1 - sy0, sR - sH - 0.02, sx1 - 0.01, walls, along='x')
    stone_course(sx1 - 0.16, sx1, sy0, sy1, sH, sH + (sR - sH) * 0.45, gb, rnd, block=0.16, depth=0.04, faces=('x',))
    for x in (sx0 + 0.5, sx0 + 0.98):
        lib.box((x, sy0 + 0.02, sH / 2), (0.07, 0.07, sH), beam, bevel=0.008)
    lib.box(((sx0 + sx1) / 2, sy0 + 0.02, sH), (sx1 - sx0, 0.08, 0.07), beam)
    lib.tag(2)
    run = math.hypot((sy1 - sy0) / 2 + 0.2, sR - sH + 0.08)
    tilt = math.atan2(sR - sH + 0.08, (sy1 - sy0) / 2 + 0.2)
    for side in (-1, 1):
        slab = lib.box(((sx0 + sx1) / 2 + 0.04, scy + side * ((sy1 - sy0) / 4 + 0.07), (sH + sR) / 2 + 0.04),
                       (sx1 - sx0 + 0.26, run, 0.16), straw, rot=(-side * tilt, 0, 0), bevel=0.07)
        shaggy(slab, 0.025, 0.05, seed=210 + side)
    lib.tag(None, split=lambda o: 3 if o.location.y < scy else 4)

    # The yard: trodden straw, a trough, the flock.
    lib.pad((0.72, -0.78, 0.004), 0.72, 0.62, yard, jitter=0.18, seed=203, core=0.75, reach=1.15)
    lib.box((1.02, -0.62, 0.06), (0.16, 0.5, 0.1), teal, bevel=0.012, rot=(0, 0, 0.2))
    lib.box((1.02, -0.62, 0.105), (0.1, 0.44, 0.01), water, rot=(0, 0, 0.2))
    flock = ((0.32, -0.82, 2.3), (0.62, -1.08, 1.6), (0.18, -1.2, 0.6), (0.6, -0.55, 2.8), (0.95, -1.22, 1.2),
             (0.28, -0.4, 3.6))
    for k, (x, y, a) in enumerate(flock):
        sheep(x, y, a, wool, black, s=1.45, seed=230 + k)
    lib.tag(4)


# ------------------------------------------------------------------------------------- pig farm (3×3)

def build_pigfarm():
    """The pig farm (Settlers 4: the Vikings'; the Romans keep sheep, `build_sheepfarm`, and do not
    build it — `BuildingDef.races`): a low half-timbered sty with a deep thatched roof running down
    to the yard side, a small fieldstone house with a wooden-shingle roof and a chimney at its end,
    and a fenced muddy yard in front with a feeding trough and a few pigs. 3×3 as the sheep farm:
    modelled at 2×2 and scaled to 3×3, a little less in height."""
    rnd = random.Random(201)
    walls = stone_walls()
    blocks = block_mats()
    beam = beam_mat()
    planks = boards_mats()
    straw = straw_mat()
    sh = shingle_mats('psh')
    plaster = lib.mat_stones('pplaster', (0.86, 0.8, 0.66), (0.72, 0.64, 0.5), (0.6, 0.52, 0.4), scale=6, bump=0.3)
    mud = lib.mat_grain('mud', (0.26, 0.17, 0.09), (0.44, 0.3, 0.17), scale=14, stretch=(1, 1, 1), bump=0.9)
    pig = lib.mat_grain('pig', (0.86, 0.6, 0.54), (0.96, 0.74, 0.68), scale=20, stretch=(1, 1, 1), bump=0.2)
    door = door_mat()
    earth_pad((0.1, -0.2, 0), 0.98, 1.08, seed=201)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    # Stone house at the back left.
    hx0, hx1, hy0, hy1, H, rh = -0.85, -0.2, 0.05, 0.85, 0.6, 0.36
    lib.box(((hx0 + hx1) / 2, (hy0 + hy1) / 2, 0.05), (hx1 - hx0 + 0.06, hy1 - hy0 + 0.06, 0.1), blocks[1], bevel=0.02)
    # Sty along the back right.
    sx0, sx1, sy0, sy1, sH = -0.2, 0.75, 0.15, 0.8, 0.42
    lib.box(((sx0 + sx1) / 2, (sy0 + sy1) / 2, 0.04), (sx1 - sx0, sy1 - sy0, 0.08), blocks[3], bevel=0.02)
    lib.tag(1)
    stone_house(hx0, hx1, hy0, hy1, H * 0.5, rnd, walls, blocks, block=0.18)
    half_timber(sx0, sx1, sy0, sy1, 0.08, sH, plaster, beam, rnd)
    lib.tag(2)
    stone_house(hx0, hx1, hy0, hy1, H, rnd, walls, blocks, z0=H * 0.5, block=0.18)
    lib.gable(((hx0 + hx1) / 2, (hy0 + hy1) / 2, H), hx1 - hx0, rh - 0.02, hy0 + 0.01, walls, along='y')
    lib.box((hx0 + 0.42, hy0 - 0.05, 0.2), (0.2, 0.04, 0.38), door, bevel=0.008)
    window(hx0 + 0.15, hy0 - 0.04, 0.42, 0.12, 0.13, beam, lib.mat_flat('dark', (0.05, 0.04, 0.03)))
    for k in range(3):  # low half-doors of the sty
        lib.box((sx0 + 0.18 + k * 0.3, sy0 - 0.03, 0.17), (0.16, 0.03, 0.18), planks[k % len(planks)], bevel=0.006)
    lib.tag(3)
    scale_roof((hx0 + hx1) / 2, (hy0 + hy1) / 2, hx1 - hx0, hy1 - hy0, H, rh, sh, lib.mat_flat('psh-r', (0.36, 0.24, 0.12)),
               axis='y', overhang=0.08, seed=202, size=0.11, shape='tile')
    chimney((hx0 + hx1) / 2, hy1 - 0.15, H, H + rh + 0.18, blocks, rnd)
    # Deep thatch over the sty, a lean-to sloping towards the yard (−Y).
    tz_hi, tz_lo = sH + 0.34, sH - 0.06
    lib.box(((sx0 + sx1) / 2, (sy0 + sy1) / 2 - 0.04, (tz_hi + tz_lo) / 2),
            (sx1 - sx0 + 0.16, math.hypot(sy1 - sy0 + 0.22, tz_hi - tz_lo), 0.1), straw,
            rot=(math.atan2(tz_hi - tz_lo, sy1 - sy0 + 0.22), 0, 0), bevel=0.03)
    lib.tag(None, split=lambda o: 3 if o.location.x > 0.3 else 4)
    # Fenced yard in front with mud, a trough and pigs.
    lib.pad((0.25, -0.38, 0.004), 0.55, 0.36, mud, jitter=0.15, seed=203, core=0.8, reach=1.1)
    fx0, fx1, fy0, fy1 = -0.4, 0.82, -0.85, sy0
    for (xa, ya, xb, yb) in ((fx0, fy0, fx1, fy0), (fx1, fy0, fx1, fy1), (fx0, fy0, fx0, fy1 - 0.1)):
        n = max(2, int(math.hypot(xb - xa, yb - ya) / 0.22))
        for k in range(n + 1):
            t = k / n
            lib.box((xa + (xb - xa) * t, ya + (yb - ya) * t, 0.1), (0.035, 0.035, 0.2), beam)
        for z in (0.08, 0.16):
            rod((xa, ya, z), (xb, yb, z), 0.014, beam, verts=6)
    lib.box((0.1, -0.2, 0.05), (0.42, 0.12, 0.08), planks[1], bevel=0.01)
    for k, (x, y, a) in enumerate(((0.45, -0.5, 0.4), (-0.05, -0.55, 2.0), (0.6, -0.15, -1.2))):
        body = lib.sphere((x, y, 0.09), 0.08, pig, scale=(1.5, 0.95, 0.9))
        body.rotation_euler = (0, 0, a)
        lib.sphere((x + math.cos(a) * 0.13, y + math.sin(a) * 0.13, 0.1), 0.05, pig, scale=(1.2, 1, 1))
        for dx, dy in ((0.07, 0.04), (0.07, -0.04), (-0.07, 0.04), (-0.07, -0.04)):
            c, s = math.cos(a), math.sin(a)
            lib.cylinder((x + c * dx - s * dy, y + s * dx + c * dy, 0.025), 0.015, 0.05, pig, verts=6)
    lib.tag(4)
    scale_scene(1.45, kz=1.3)


# ------------------------------------------------------------------------------------- forester (2×2)

def build_forester():
    """Our forester's lodge: a small low hut of round logs with a moss-grown plank roof, a rectangular
    sign board carved with a young fir on a post, a fenced bed of seedlings and a few young firs."""
    rnd = random.Random(211)
    B = _b()
    logs = lib.mat_grain('flogs', (0.3, 0.17, 0.08), (0.52, 0.32, 0.15), scale=7, stretch=(1, 1, 6), bump=1.0)
    ends = ends_mat()
    boards = grain_set('fboard', (((0.34, 0.24, 0.12), (0.52, 0.38, 0.2)), ((0.3, 0.26, 0.16), (0.46, 0.4, 0.28)),
                                  ((0.26, 0.2, 0.1), (0.44, 0.32, 0.18))), scale=4, stretch=(1, 9, 1), bump=0.7)
    moss = lib.mat_leaves('moss', (0.1, 0.22, 0.06), (0.22, 0.4, 0.1), (0.4, 0.56, 0.16), scale=22)
    needles = lib.mat_leaves('needles', (0.04, 0.16, 0.08), (0.1, 0.32, 0.14), (0.24, 0.48, 0.2), scale=18)
    bark = lib.mat_grain('fbark', (0.24, 0.14, 0.07), (0.4, 0.26, 0.14), scale=8, stretch=(1, 1, 5), bump=0.8)
    soil = lib.mat_grain('soil', (0.2, 0.12, 0.06), (0.36, 0.24, 0.12), scale=16, stretch=(1, 1, 1), bump=1.0)
    signwood = lib.mat_grain('signwood', (0.62, 0.48, 0.26), (0.8, 0.66, 0.4), scale=6, stretch=(1, 6, 1), bump=0.4)
    green = lib.mat_flat('carved', (0.16, 0.36, 0.14), rough=0.6)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.1, -0.2, 0), 0.95, 1.05, seed=211)
    lib.tag(0)
    corner_stakes(-0.7, 0.6, -0.55, 0.75)
    lib.tag(0, until=0)
    cx, cy, L, W, H, rh = -0.1, 0.25, 0.85, 0.75, 0.42, 0.3
    B.log_cabin(cx, cy, L, W, H, logs, ends, r=0.045, gable_h=rh, gable_axis='x', door=(cx + 0.18, 0.22, 0.32))
    lib.box((cx + 0.18, cy - W / 2 + 0.03, 0.16), (0.2, 0.06, 0.32), dark)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.5 else 3)
    B.plank_roof(cx, cy, L, W, H, rh, boards, axis='x', overhang=0.1, seed=212)
    lib.tag(None, split=lambda o: 3 if o.location.y < cy else 4)
    for k in range(6):  # moss patches on the roof
        x = cx + rnd.uniform(-L / 2, L / 2)
        y = cy - W / 4 + rnd.uniform(-0.1, 0.1)
        lib.lumpy((x, y, H + rh * 0.45 + 0.05), 0.06, moss, scale=(1.4, 1, 0.4), strength=0.4, noise=0.6, seed=k, subdiv=1)
    # Sign: a rectangular board on a post, carved with a young fir (our own emblem).
    px, py = 0.7, -0.55
    lib.box((px, py, 0.3), (0.04, 0.04, 0.6), bark)
    lib.box((px - 0.02, py, 0.48), (0.03, 0.26, 0.2), signwood, bevel=0.01)
    for k, (w, z) in enumerate(((0.14, 0.42), (0.1, 0.47), (0.06, 0.52))):
        lib.box((px - 0.04, py, z), (0.01, w, 0.045), green)
    lib.box((px - 0.04, py, 0.4), (0.01, 0.02, 0.03), dark)
    # Seedling bed with a little fence.
    bx, by = 0.35, -0.45
    lib.box((bx, by, 0.02), (0.4, 0.34, 0.04), soil)
    for k in range(6):
        x = bx - 0.13 + (k % 3) * 0.13
        y = by - 0.08 + (k // 3) * 0.16
        lib.cylinder((x, y, 0.07), 0.04, 0.09, needles, radius2=0.004, verts=8)
    for (xa, ya, xb, yb) in ((bx - 0.22, by - 0.19, bx + 0.22, by - 0.19), (bx + 0.22, by - 0.19, bx + 0.22, by + 0.19)):
        for k in range(4):
            t = k / 3
            lib.box((xa + (xb - xa) * t, ya + (yb - ya) * t, 0.06), (0.02, 0.02, 0.12), bark)
        rod((xa, ya, 0.1), (xb, yb, 0.1), 0.01, bark, verts=6)
    # Young firs around the lodge.
    for k, (x, y, s) in enumerate(((-0.75, -0.4, 0.8), (-0.7, 0.75, 1.0), (0.55, 0.75, 0.75))):
        lib.cylinder((x, y, 0.1 * s), 0.025 * s, 0.2 * s, bark, verts=8)
        for j in range(3):
            lib.cylinder((x, y, (0.2 + j * 0.16) * s + 0.08 * s), (0.2 - j * 0.05) * s, 0.22 * s, needles, radius2=0.01,
                         verts=12)
    lib.tag(4)


# ------------------------------------------------------------------------------------- market (2×2)

def donkey(x, y, a, coat, belly, dark, s=1.0, pack=None):
    """A small grey donkey standing at (x, y) facing angle `a`: barrel body, neck and head with long
    ears, four legs; with `pack` (a material) a pair of panniers over its back."""
    c, si = math.cos(a), math.sin(a)
    at = lambda f, g, z: (x + (c * f - si * g) * s, y + (si * f + c * g) * s, z * s)
    body = lib.sphere(at(0, 0, 0.17), 0.1 * s, coat, scale=(1.55, 0.95, 0.9))
    body.rotation_euler = (0, 0, a)
    belly_o = lib.sphere(at(0, 0, 0.14), 0.085 * s, belly, scale=(1.3, 0.85, 0.6))
    belly_o.rotation_euler = (0, 0, a)
    for f, g in ((0.09, 0.045), (0.09, -0.045), (-0.09, 0.045), (-0.09, -0.045)):
        lib.cylinder(at(f, g, 0.055), 0.016 * s, 0.11 * s, coat, verts=6)
        lib.cylinder(at(f, g, 0.008), 0.018 * s, 0.016 * s, dark, verts=6)
    neck = lib.cylinder(at(0.15, 0, 0.26), 0.035 * s, 0.13 * s, coat, verts=8, rot=(0, 0.7, a))
    neck.rotation_euler = (0, 0.7, a)
    head = lib.sphere(at(0.21, 0, 0.31), 0.045 * s, coat, scale=(1.5, 0.8, 0.8))
    head.rotation_euler = (0, 0.5, a)
    lib.sphere(at(0.265, 0, 0.29), 0.03 * s, belly, scale=(1.1, 0.9, 0.8))
    for g in (0.02, -0.02):
        ear = lib.cylinder(at(0.18, g, 0.38), 0.012 * s, 0.09 * s, coat, verts=6, radius2=0.004 * s)
        ear.rotation_euler = (0.25 * (1 if g > 0 else -1), -0.3, a)
    lib.cylinder(at(-0.17, 0, 0.16), 0.008 * s, 0.1 * s, dark, verts=6)  # tail
    if pack is not None:
        for g in (0.07, -0.07):
            p = lib.box(at(0, g, 0.17), (0.12 * s, 0.05 * s, 0.09 * s), pack, bevel=0.012)
            p.rotation_euler = (0, 0, a)


def build_market():
    """The Settlers 4 Roman marketplace: a round plaza of mossy flagstones edged with a ring of big
    pale kerbstones, and in its middle a stone horseman — the rider holding up his sword — on a round
    pedestal inside a blue wrought-iron railing. No hall, no stalls: the donkeys and the goods piles
    the game draws make the market."""
    rnd = random.Random(221)
    floor = lib.mat_stones('mfloor', (0.72, 0.72, 0.66), (0.5, 0.52, 0.46), (0.36, 0.42, 0.22), scale=7, bump=0.5)
    kerb = grain_set('mkerb', (((0.56, 0.56, 0.52), (0.82, 0.82, 0.78)), ((0.5, 0.5, 0.48), (0.74, 0.74, 0.7)),
                               ((0.6, 0.58, 0.52), (0.86, 0.84, 0.78))), scale=6)
    moss = lib.mat_leaves('mmoss', (0.16, 0.26, 0.06), (0.34, 0.48, 0.12), (0.56, 0.66, 0.24), scale=30)
    stone = lib.mat_grain('mstatue', (0.42, 0.42, 0.4), (0.7, 0.69, 0.65), scale=9, stretch=(1, 1, 1), bump=0.6)
    plinth_m = lib.mat_grain('mplinth', (0.62, 0.6, 0.54), (0.84, 0.82, 0.74), scale=7, stretch=(1, 1, 1), bump=0.5)
    blue = lib.mat_flat('mblue', (0.14, 0.18, 0.5), rough=0.35)
    earth_pad((0.0, -0.1, 0), 1.1, 1.1, seed=221)
    lib.tag(0)
    cx, cy, R = 0.02, -0.05, 1.12
    corner_stakes(cx - R, cx + R, cy - R, cy + R)
    lib.tag(0, until=0)
    lib.cylinder((cx, cy, 0.02), R - 0.06, 0.04, floor, verts=64)
    n = 30
    for k in range(n):
        a = k / n * math.tau + rnd.uniform(-0.03, 0.03)
        rr = R + rnd.uniform(-0.02, 0.02)
        lib.lumpy((cx + math.cos(a) * rr, cy + math.sin(a) * rr, 0.06), 0.11, kerb[k % len(kerb)],
                  scale=(1.0, 1.25 * (0.85 + 0.3 * rnd.random()), 0.55), strength=0.25, noise=1.2, seed=k,
                  subdiv=2, flat=True).rotation_euler = (0, 0, a)
    lib.tag(1)
    for k in range(14):
        a, rr = rnd.uniform(0, math.tau), rnd.uniform(0.35, R - 0.2)
        lib.lumpy((cx + math.cos(a) * rr, cy + math.sin(a) * rr, 0.03), rnd.uniform(0.06, 0.13), moss,
                  scale=(1.4, 1.0, 0.12), strength=0.5, noise=2.0, seed=40 + k, subdiv=2)
    # Pedestal: a round drum with a moulded base and cap.
    pz = 0.46
    lib.cylinder((cx, cy, 0.07), 0.36, 0.1, plinth_m, verts=32, bevel=0.01)
    lib.cylinder((cx, cy, 0.14), 0.32, 0.06, plinth_m, verts=32)
    lib.tag(2)
    lib.cylinder((cx, cy, (0.17 + pz - 0.06) / 2), 0.27, pz - 0.23, plinth_m, verts=32)
    lib.cylinder((cx, cy, pz - 0.04), 0.33, 0.08, plinth_m, verts=32, bevel=0.012)
    # The railing round it.
    rr = 0.5
    for k in range(20):
        a = k / 20 * math.tau
        x, y = cx + math.cos(a) * rr, cy + math.sin(a) * rr
        lib.cylinder((x, y, 0.2), 0.012, 0.36, blue, verts=6)
        lib.sphere((x, y, 0.39), 0.022, blue, subdiv=1)
    for z in (0.1, 0.3):
        torus((cx, cy, z), rr, 0.012, blue)
    lib.tag(3)
    horseman(cx + 0.02, cy + 0.04, pz, 3.6, stone, s=1.1)
    lib.tag(4)


def build_donkeyranch():
    """After the Settlers 4 Roman donkey ranch: a big house of grey rubble with light quoins under a
    steep roof of large wooden shingles (ridge along Y), thick dark barge boards on its gable towards
    the camera's left, an arched door and a stone chimney under a little board hood; beside it, joined
    by an open timber frame where a donkey stands, a stable on four stone piers, open at the front over
    a plank ramp, its roof of broad orange boards on the near slope and golden thatch heaped over the
    far one; a yard of trodden straw with a trough, buckets and donkeys. Modelled at its 3×3 size."""
    rnd = random.Random(231)
    walls = stone_walls()
    gb = grey_blocks('dgb')
    light = block_mats('dlb')
    beam = beam_mat()
    planks = boards_mats()
    sh = grain_set('dsh', (((0.42, 0.24, 0.1), (0.66, 0.44, 0.2)), ((0.52, 0.34, 0.14), (0.76, 0.56, 0.28)),
                           ((0.58, 0.3, 0.12), (0.84, 0.5, 0.22)), ((0.46, 0.38, 0.26), (0.66, 0.58, 0.42)),
                           ((0.36, 0.22, 0.1), (0.56, 0.38, 0.18))), scale=10, stretch=(1, 4, 1), bump=0.9)
    sh = sh[:2] * 2 + sh[3:] * 2 + sh[2:3]  # the orange one about one in seven
    barge = lib.mat_grain('dbarge', (0.24, 0.12, 0.05), (0.4, 0.22, 0.1), scale=5, stretch=(9, 1, 1), bump=0.6)
    oboards = grain_set('dob', (((0.52, 0.24, 0.08), (0.84, 0.46, 0.18)), ((0.46, 0.2, 0.07), (0.76, 0.4, 0.16)),
                                ((0.58, 0.3, 0.1), (0.88, 0.54, 0.24))), scale=4, stretch=(1, 9, 1), bump=0.8)
    straw = thatch_mat('dthatch')
    yard = lib.mat_grain('dyard', (0.5, 0.36, 0.16), (0.76, 0.6, 0.3), scale=22, stretch=(1, 1, 1), bump=0.8)
    hay = lib.mat_grain('dhay', (0.6, 0.46, 0.14), (0.86, 0.74, 0.34), scale=14, stretch=(1, 1, 1), bump=1.0)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    door = door_mat()
    iron = lib.mat_flat('diron', (0.2, 0.2, 0.22), rough=0.4)
    water = lib.mat_flat('rwater', (0.2, 0.5, 0.68), rough=0.12)
    coat = lib.mat_grain('dcoat', (0.42, 0.4, 0.38), (0.56, 0.54, 0.5), scale=24, stretch=(1, 1, 1), bump=0.3)
    coat2 = lib.mat_grain('dcoat2', (0.36, 0.28, 0.22), (0.5, 0.4, 0.32), scale=24, stretch=(1, 1, 1), bump=0.3)
    belly = lib.mat_flat('dbelly', (0.82, 0.78, 0.72))
    hoof = lib.mat_flat('dhoof', (0.12, 0.1, 0.08))
    earth_pad((0.02, -0.2, 0), 1.55, 1.62, seed=231)
    lib.tag(0)
    corner_stakes(-1.44, 1.44, -1.0, 1.14)
    lib.tag(0, until=0)

    # The house: ridge along Y, its gable (door, chimney) towards −Y.
    x0, x1, y0, y1, H, rh = -1.44, -0.04, -0.98, 1.12, 0.66, 0.66
    cx, cy, half = (x0 + x1) / 2, (y0 + y1) / 2, (x1 - x0) / 2
    lib.box((cx, cy, 0.05), (x1 - x0 + 0.08, y1 - y0 + 0.08, 0.1), gb[1], bevel=0.02)
    stone_house(x0, x1, y0, y1, H * 0.4, rnd, walls, gb, block=0.2)
    quoins(x0, x1, y0, y1, 0.04, H * 0.4, light, rnd, block=0.24, row=0.17)
    lib.tag(1)
    stone_house(x0, x1, y0, y1, H, rnd, walls, gb, z0=H * 0.4, block=0.2)
    quoins(x0, x1, y0, y1, H * 0.4, H, light, rnd, block=0.24, row=0.17)
    gable_prism(cx, y0, y0 + 0.12, half, H, rh, walls)
    gable_blocks(cx, half, y0, H, rh, gb, rnd, block=0.2, depth=0.055)
    arch_door(cx + 0.36, y0, 0.02, 0.28, 0.46, door, [light[0], light[2]])
    window(cx - 0.3, y0 - 0.04, 0.38, 0.14, 0.15, beam, dark)
    window(cx, y0 - 0.04, H + rh * 0.4, 0.12, 0.13, beam, dark)
    window(x1 + 0.04, 0.5, 0.4, 0.14, 0.15, beam, dark, face='x')
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.75 else 3)
    ov = 0.14
    scale_roof(cx, cy, x1 - x0, y1 - y0, H, rh, sh, lib.mat_flat('dridge', (0.3, 0.16, 0.07)), axis='y',
               overhang=ov, seed=232, size=0.2, shape='tile')
    lib.tag(None, split=lambda o: 3 if o.location.x > cx + 0.05 and o.location.y < cy else 4)
    # Thick barge boards along the gable's raking edges, a board hood on the chimney.
    drop = ov * rh / half
    for side in (-1, 1):
        a = (cx + side * (half + ov), y0 - ov - 0.02, H - drop + 0.02)
        b = (cx, y0 - ov - 0.02, H + rh + 0.06)
        place_on(lib.box((0, 0, 0), (0.07, math.dist(a, b) + 0.06, 0.12), barge, bevel=0.012),
                 ((a[0] + b[0]) / 2, a[1], (a[2] + b[2]) / 2), (0, 1, 0), (b[0] - a[0], 0, b[2] - a[2]))
    chx, chy, ztop = cx - 0.02, y0 + 0.26, H + rh + 0.26
    chimney(chx, chy, H + rh - 0.3, ztop, light, rnd)
    for sx in (-1, 1):
        for sy in (-1, 1):
            lib.box((chx + sx * 0.08, chy + sy * 0.08, ztop + 0.1), (0.025, 0.025, 0.14), beam)
        lib.box((chx + sx * 0.07, chy, ztop + 0.2), (0.17, 0.28, 0.025), planks[1], rot=(0, sx * 0.6, 0), bevel=0.004)
    lib.tag(4)

    # The stable: four stone piers, a stone back wall, boards on its +X side, open at the front.
    sx0, sx1, sy0, sy1, sH, srh = 0.42, 1.44, -0.86, 0.96, 0.6, 0.46
    scx, scy, shalf = (sx0 + sx1) / 2, (sy0 + sy1) / 2, (sx1 - sx0) / 2
    lib.box((scx, scy, 0.06), (sx1 - sx0, sy1 - sy0, 0.12), planks[3], bevel=0.01)  # raised plank floor
    lib.box((scx, scy, 0.125), (sx1 - sx0 - 0.1, sy1 - sy0 - 0.1, 0.01), dark)
    for (px, py) in ((sx0 + 0.1, sy0 + 0.1), (sx1 - 0.1, sy0 + 0.1), (sx1 - 0.1, sy1 - 0.1), (sx0 + 0.1, sy1 - 0.1)):
        z = 0.0
        k = 0
        while z < sH - 0.02:
            hgt = min(0.13, sH - z)
            long_x = k % 2 == 0
            lib.box((px + rnd.uniform(-0.01, 0.01), py + rnd.uniform(-0.01, 0.01), z + hgt / 2),
                    (0.24 if long_x else 0.19, 0.19 if long_x else 0.24, hgt * 0.92), (light + gb)[rnd.randrange(8)],
                    rot=(0, 0, rnd.uniform(-0.05, 0.05)), bevel=0.02)
            z += hgt
            k += 1
    lib.tag(1)
    lib.box((scx, sy1 - 0.08, sH / 2), (sx1 - sx0 - 0.2, 0.12, sH), walls)
    lib.box((sx1 - 0.06, scy, sH * 0.25), (0.1, sy1 - sy0 - 0.2, sH * 0.5), walls)
    stone_course(sx1 - 0.06, sx1 - 0.06, sy0 + 0.2, sy1 - 0.2, 0.0, sH * 0.5, gb, rnd, block=0.18, depth=0.05, faces=('x',))
    lib.tag(2)
    vboard_walls(sx1 - 0.1, sx1 - 0.06, sy0 + 0.2, sy1 - 0.2, sH * 0.5, sH, planks, dark, beam, rnd, board=0.1,
                 faces=('x',))
    for y in (sy0 + 0.2, sy1 - 0.2):
        lib.box((sx1 - 0.04, y, sH * 0.75), (0.06, 0.06, sH * 0.5), beam)
    lib.box((scx, sy0 + 0.1, sH + 0.03), (sx1 - sx0, 0.09, 0.08), beam, bevel=0.008)  # lintel over the opening
    lib.box((sx0 + 0.1, scy, sH + 0.03), (0.09, sy1 - sy0, 0.08), beam, bevel=0.008)
    lib.box((sx1 - 0.1, scy, sH + 0.03), (0.09, sy1 - sy0, 0.08), beam, bevel=0.008)
    vboard_gable(scx, sy0 + 0.1, shalf - 0.02, sH + 0.07, srh - 0.06, planks, rnd, board=0.1, face='y')
    lib.gable((scx, scy, sH + 0.07), sx1 - sx0 - 0.04, srh - 0.06, sy0 + 0.11, dark, along='y')
    lib.lumpy((scx + 0.15, sy1 - 0.4, 0.2), 0.24, hay, scale=(1.5, 1.1, 0.6), strength=0.3, noise=2.5, seed=235, subdiv=2)
    # A plank ramp up into the stable.
    rl = 0.34
    for k in range(6):
        t = (k + 0.5) / 6
        lib.box((scx + 0.05, sy0 - rl + t * rl, 0.12 * t + 0.01), (0.46, rl / 6 * 0.86, 0.03), planks[k % len(planks)],
                rot=(math.atan2(0.12, rl), 0, rnd.uniform(-0.04, 0.04)), bevel=0.004)
    for sgn in (-1, 1):
        lib.box((scx + 0.05 + sgn * 0.21, sy0 - rl / 2, 0.05), (0.04, rl + 0.04, 0.04), beam,
                rot=(math.atan2(0.12, rl), 0, 0))
    lib.tag(None, split=lambda o: 2 if o.location.z < sH * 0.5 else 3)
    # Roof: broad orange boards on the near (+X) slope, nailed; golden thatch heaped over the far one,
    # spilling over the ridge.
    sov = 0.12
    sdrop = sov * srh / shalf
    zr = sH + srh + 0.05
    made = board_slope((scx + shalf + sov, sy0 - 0.06, sH - sdrop + 0.05), (scx + shalf + sov, sy1 + 0.06, sH - sdrop + 0.05),
                       (scx, sy0 - 0.06, zr), (scx, sy1 + 0.06, zr), oboards, rnd, width=0.16, thick=0.04)
    from mathutils import Vector

    for b in made:
        for t in (-0.3, 0.3):
            lib.sphere(tuple(b.matrix_world @ Vector((0, t * b.dimensions[1], 0.025))), 0.016, iron, subdiv=1)
    lib.tag(None, split=lambda o: 3 if o.location.y < scy else 4)
    lib.prism_roof((scx, scy, sH), sy1 - sy0, sx1 - sx0, srh, oboards[1], overhang=sov, thickness=0.04, along='y')
    lib.tag(4)

    # The open timber frame joining house and stable, a donkey under it.
    for y in (sy0 + 0.1, 0.1, sy1 - 0.1):
        lib.box((sx0 - 0.02, y, sH / 2), (0.08, 0.08, sH), beam, bevel=0.008)
    lib.box(((x1 + sx0) / 2, sy0 + 0.1, sH - 0.02), (sx0 - x1 + 0.1, 0.08, 0.08), beam, bevel=0.008)
    for y in (sy0 + 0.1, 0.1, sy1 - 0.1):
        rod((x1 + 0.02, y, H + 0.04), (sx0 + 0.05, y, sH + 0.04), 0.035, beam, verts=8)
    lib.box((x1 + 0.12, sy0 + 0.1, sH * 0.6), (0.05, 0.05, sH * 1.1), beam, rot=(0, 0.5, 0))
    lib.tag(3)
    # The passage's roof: a low, thick thatch reaching under the eaves on both sides.
    pcx, phalf, pz, prise = (x1 + sx0) / 2, (sx0 - x1) / 2 + 0.16, sH + 0.1, 0.14
    ptilt = math.atan2(prise, phalf)
    for side in (-1, 1):
        slab = lib.box((pcx + side * phalf / 2, scy - 0.02, pz + prise / 2), (math.hypot(phalf, prise) + 0.06,
                       sy1 - sy0 + 0.16, 0.14), straw, rot=(0, side * ptilt, 0), bevel=0.06)
        shaggy(slab, 0.03, 0.05, seed=240 + side)
    lib.tag(4)
    donkey((x1 + sx0) / 2, -0.2, 4.4, coat, belly, hoof, s=1.04)

    # The yard: trodden straw, a trough, buckets, hay and donkeys.
    lib.pad((-0.2, -1.2, 0.004), 1.1, 0.4, yard, jitter=0.18, seed=233, core=0.75, reach=1.15)
    lib.box((-0.98, -1.22, 0.07), (0.56, 0.16, 0.12), planks[1], bevel=0.012)
    lib.box((-0.98, -1.22, 0.125), (0.5, 0.1, 0.01), water)
    for (bx, by) in ((-0.32, -1.32), (-0.18, -1.42)):
        lib.cylinder((bx, by, 0.06), 0.06, 0.12, planks[0], verts=12, radius2=0.07)
        lib.cylinder((bx, by, 0.115), 0.058, 0.01, water, verts=12)
        torus((bx, by, 0.08), 0.066, 0.006, iron)
    lib.lumpy((0.2, -1.38, 0.1), 0.13, hay, scale=(1.2, 1, 0.8), strength=0.3, noise=2.5, seed=234, subdiv=2)
    donkey(-0.62, -1.3, 0.4, coat, belly, hoof, s=1.04)
    donkey(0.62, -1.25, 2.7, coat2, belly, hoof, s=1.0)
    lib.tag(4)


# ------------------------------------------------------------------------------------- eyecatchers (1×1, fountain 2×2)

def weathered():
    """Pale, weathered limestone with mossy grime, and a dark bronze."""
    stone = lib.mat_grain('lime', (0.62, 0.6, 0.54), (0.88, 0.86, 0.8), scale=9, stretch=(1, 1, 1), bump=0.7)
    old = lib.mat_grain('limeold', (0.5, 0.52, 0.44), (0.74, 0.74, 0.66), scale=9, stretch=(1, 1, 1), bump=0.8)
    moss = lib.mat_leaves('emoss', (0.12, 0.26, 0.08), (0.24, 0.42, 0.12), (0.42, 0.58, 0.18), scale=24)
    bronze = lib.mat_grain('bronze', (0.3, 0.42, 0.34), (0.56, 0.5, 0.3), scale=12, stretch=(1, 1, 1), bump=0.3)
    return stone, old, moss, bronze


def plinth(size, h, stone, old):
    lib.box((0, 0, h * 0.3), (size, size, h * 0.6), old, bevel=0.02)
    lib.box((0, 0, h * 0.75), (size * 0.85, size * 0.85, h * 0.3), stone, bevel=0.02)


def mossy(rnd, moss, n, r, z):
    for k in range(n):
        a = rnd.uniform(0, math.tau)
        lib.lumpy((math.cos(a) * r, math.sin(a) * r, z), 0.04, moss, scale=(1.4, 1, 0.5), strength=0.4, noise=0.6, seed=k,
                  subdiv=1)


def build_flowerbed():
    """A raised octagonal bed of stone kerbs with a small clipped shrub and flowers of three colours."""
    rnd = random.Random(221)
    stone, old, moss, _ = weathered()
    soil = lib.mat_grain('bedsoil', (0.22, 0.13, 0.06), (0.36, 0.24, 0.12), scale=16, stretch=(1, 1, 1), bump=1.0)
    leaves = lib.mat_leaves('bedleaves', (0.06, 0.2, 0.04), (0.16, 0.42, 0.08), (0.36, 0.62, 0.16), scale=20)
    petals = [lib.mat_flat('pet0', (0.9, 0.3, 0.32)), lib.mat_flat('pet1', (0.96, 0.82, 0.3)),
              lib.mat_flat('pet2', (0.62, 0.42, 0.86))]
    lib.tag(1)
    for k in range(8):
        a = k / 8 * math.tau
        lib.box((math.cos(a) * 0.36, math.sin(a) * 0.36, 0.07), (0.3, 0.07, 0.14), [stone, old][k % 2],
                rot=(0, 0, a + math.pi / 2), bevel=0.015)
    lib.cylinder((0, 0, 0.1), 0.34, 0.06, soil, verts=16)
    lib.tag(2)
    lib.lumpy((0, 0, 0.24), 0.14, leaves, scale=(1, 1, 1.2), strength=0.4, noise=0.6, seed=1, subdiv=2)
    for k in range(18):
        a = rnd.uniform(0, math.tau)
        d = rnd.uniform(0.16, 0.3)
        lib.cylinder((math.cos(a) * d, math.sin(a) * d, 0.16), 0.006, 0.08, leaves, verts=5)
        lib.sphere((math.cos(a) * d, math.sin(a) * d, 0.21), 0.03, petals[k % 3], scale=(1, 1, 0.6), subdiv=1)
    mossy(rnd, moss, 3, 0.36, 0.12)
    lib.tag(4)


def build_column():
    """A single fluted column of weathered stone on a stepped base, a simple capital crowned by a
    bronze brazier bowl; ivy at its foot."""
    rnd = random.Random(231)
    stone, old, moss, bronze = weathered()
    lib.tag(1)
    plinth(0.62, 0.22, stone, old)
    lib.tag(2)
    H = 1.35
    lib.cylinder((0, 0, 0.22 + H / 2), 0.13, H, stone, radius2=0.115, verts=20)
    for k in range(12):
        a = k / 12 * math.tau
        lib.box((math.cos(a) * 0.125, math.sin(a) * 0.125, 0.22 + H / 2), (0.018, 0.018, H * 0.96), old,
                rot=(0, 0, a))
    lib.tag(3)
    lib.box((0, 0, 0.22 + H + 0.04), (0.32, 0.32, 0.08), stone, bevel=0.02)
    lib.cylinder((0, 0, 0.22 + H + 0.1), 0.16, 0.06, old, radius2=0.12, verts=20)
    lib.cylinder((0, 0, 0.22 + H + 0.18), 0.17, 0.1, bronze, radius2=0.08, verts=20)
    mossy(rnd, moss, 5, 0.22, 0.25)
    lib.tag(4)


def build_statue():
    """A bronze stag standing on a tall stone pedestal (our own figure), its antlers raised; a little
    moss on the steps."""
    rnd = random.Random(241)
    stone, old, moss, bronze = weathered()
    lib.tag(1)
    plinth(0.6, 0.24, stone, old)
    lib.box((0, 0, 0.24 + 0.32), (0.42, 0.42, 0.64), stone, bevel=0.03)
    lib.box((0, 0, 0.24 + 0.66), (0.48, 0.48, 0.06), old, bevel=0.015)
    lib.tag(2)
    z = 0.93
    lib.sphere((0, 0, z + 0.26), 0.14, bronze, scale=(1.6, 0.8, 0.9))  # body, along X (towards the camera's right)
    for dx in (-0.13, 0.13):
        for dy in (-0.06, 0.06):
            lib.cylinder((dx, dy, z + 0.1), 0.025, 0.22, bronze, verts=8)
    rod((0.18, 0, z + 0.32), (0.28, 0, z + 0.5), 0.05, bronze)  # neck
    lib.sphere((0.3, 0, z + 0.53), 0.06, bronze, scale=(1.4, 0.8, 0.9))  # head
    for side in (-1, 1):  # antlers
        rod((0.28, side * 0.03, z + 0.58), (0.24, side * 0.12, z + 0.78), 0.012, bronze, verts=6)
        rod((0.25, side * 0.09, z + 0.7), (0.34, side * 0.15, z + 0.78), 0.01, bronze, verts=6)
        rod((0.25, side * 0.07, z + 0.64), (0.18, side * 0.16, z + 0.72), 0.01, bronze, verts=6)
    lib.tag(3)
    mossy(rnd, moss, 4, 0.3, 0.2)
    lib.tag(4)


def build_obelisk():
    """A tall tapering obelisk of weathered stone on a stepped base, plain faces with two carved bands
    and a bronze cap; moss creeping up its foot."""
    rnd = random.Random(251)
    stone, old, moss, bronze = weathered()
    lib.tag(1)
    plinth(0.62, 0.26, stone, old)
    lib.tag(2)
    H = 1.6
    lib.cylinder((0, 0, 0.26 + H / 2), 0.17, H, stone, radius2=0.1, verts=4, rot=(0, 0, math.pi / 4))
    for z in (0.26 + H * 0.25, 0.26 + H * 0.6):
        t = (z - 0.26) / H
        r = 0.17 + (0.1 - 0.17) * t
        lib.cylinder((0, 0, z), r + 0.012, 0.035, old, verts=4, rot=(0, 0, math.pi / 4))
    lib.tag(3)
    lib.cylinder((0, 0, 0.26 + H + 0.07), 0.1, 0.14, bronze, radius2=0.005, verts=4, rot=(0, 0, math.pi / 4))
    mossy(rnd, moss, 5, 0.24, 0.28)
    lib.tag(4)


def build_fountain():
    """A round fountain (2×2): a stone basin of curved kerb blocks full of water, a fluted pillar in the
    middle carrying a smaller bowl that spills into it, a bronze finial."""
    rnd = random.Random(261)
    stone, old, moss, bronze = weathered()
    water = lib.mat_flat('fwater', (0.3, 0.6, 0.74), rough=0.05)
    paving = grain_set('fpave', (((0.46, 0.44, 0.4), (0.68, 0.66, 0.6)), ((0.52, 0.5, 0.46), (0.74, 0.72, 0.66))), scale=8,
                       bump=0.7)
    earth_pad((0.0, -0.1, 0), 1.0, 1.05, seed=261)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.85, 0.85)
    lib.tag(0, until=0)
    for k in range(24):
        a = k / 24 * math.tau
        lib.box((math.cos(a) * 0.86, math.sin(a) * 0.86, 0.02), (0.26, 0.2, 0.03), paving[k % 2], rot=(0, 0, a + math.pi / 2),
                bevel=0.01)
    lib.tag(1)
    R = 0.7
    lib.cylinder((0, 0, 0.06), R, 0.08, old, verts=40)
    for k in range(20):
        a = k / 20 * math.tau
        lib.box((math.cos(a) * R, math.sin(a) * R, 0.16), (R * math.tau / 20 * 0.96, 0.12, 0.24), [stone, old][k % 2],
                rot=(0, 0, a + math.pi / 2), bevel=0.02)
    lib.tag(2)
    lib.cylinder((0, 0, 0.22), R - 0.06, 0.02, water, verts=40)
    lib.cylinder((0, 0, 0.5), 0.09, 0.6, stone, radius2=0.075, verts=16)
    lib.cylinder((0, 0, 0.82), 0.28, 0.08, stone, radius2=0.12, verts=24)
    lib.cylinder((0, 0, 0.86), 0.25, 0.015, water, verts=24)
    lib.tag(3)
    lib.cylinder((0, 0, 0.96), 0.05, 0.2, bronze, radius2=0.02, verts=12)
    lib.sphere((0, 0, 1.08), 0.04, bronze)
    for k in range(3):  # thin spills from the small bowl's lip
        a = k / 3 * math.tau + 0.4
        rod((math.cos(a) * 0.27, math.sin(a) * 0.27, 0.84), (math.cos(a) * 0.33, math.sin(a) * 0.33, 0.24), 0.008, water,
            verts=6)
    mossy(rnd, moss, 6, R + 0.02, 0.28)
    lib.tag(4)


# ------------------------------------------------------------------------------------- fisher (2×2)

def boat_shell(cx, cy, L, B, D, planks, keel, rib, rnd, strakes=7, door_gap=None):
    """An upturned clinker hull lying keel-up along Y (bow at −Y): a smooth shell (planking along the
    hull in the material, `planks[0]`), clinker edges as thin laths from stem to stern, a keel and
    stems, a few dark ribs over it. `door_gap` = (u0, u1, a1): the stretch u0..u1 along the hull left
    open on the +X side from the ground up to the angle a1 (radians from the gunwale), a doorway."""
    nu, na = 24, 18

    def point(u, a):
        taper = math.sin(max(0.0, min(1.0, u)) * math.pi) ** 0.5
        return (cx + B / 2 * math.cos(a) * taper, cy - L / 2 + u * L, D * math.sin(a) * (0.72 + 0.28 * taper))

    def open_at(u, a):
        return bool(door_gap) and door_gap[0] <= u <= door_gap[1] and a < door_gap[2]

    verts, faces = [], []
    for i in range(nu + 1):
        for j in range(na + 1):
            verts.append(point(0.01 + 0.98 * i / nu, math.pi * j / na))
    for i in range(nu):
        for j in range(na):
            um, am = 0.01 + 0.98 * (i + 0.5) / nu, math.pi * (j + 0.5) / na
            if open_at(um, am):
                continue
            a = i * (na + 1) + j
            faces.append((a, a + na + 1, a + na + 2, a + 1))
    mesh = bpy.data.meshes.new('hull')
    mesh.from_pydata(verts, [], faces)
    for p in mesh.polygons:
        p.use_smooth = True
    obj = bpy.data.objects.new('hull', mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.035
    obj.data.materials.append(planks[0])
    obj.location = (0, 0, 0)
    obj['stage'], obj['until'] = 2, 99
    # Clinker edges: laths along the hull at each strake's lower edge, lighter and darker by turns.
    for k in range(1, strakes):
        a = math.pi / 2 * k / strakes
        for side in (0, 1):
            aa = a if side == 0 else math.pi - a
            pts = [point(0.03 + 0.94 * i / 12, aa) for i in range(13)]
            for i, (p, q) in enumerate(zip(pts, pts[1:])):
                um = 0.03 + 0.94 * (i + 0.5) / 12
                if open_at(um, aa):
                    continue
                n = (math.cos(aa), 0, math.sin(aa))
                lift = 0.02
                rod((p[0] + n[0] * lift, p[1], p[2] + n[2] * lift), (q[0] + n[0] * lift, q[1], q[2] + n[2] * lift),
                    0.014, planks[1 + (k % (len(planks) - 1))], verts=6)
    rod((cx, cy - L / 2 - 0.02, D * 0.73), (cx, cy + L / 2 + 0.02, D * 0.73), 0.04, keel)
    for end in (-1, 1):
        rod((cx, cy + end * L / 2, 0.0), (cx, cy + end * (L / 2 + 0.1), D * 0.86), 0.036, keel)
    for um in (0.22, 0.75):
        pts = [point(um, math.pi * j / 10) for j in range(11)]
        for j, (p, q) in enumerate(zip(pts, pts[1:])):
            if open_at(um, math.pi * (j + 0.5) / 10):
                continue
            n0 = (math.cos(math.pi * j / 10), math.sin(math.pi * j / 10))
            rod((p[0] + n0[0] * 0.03, p[1], p[2] + n0[1] * 0.03), (q[0] + n0[0] * 0.03, q[1], q[2] + n0[1] * 0.03), 0.02,
                rib, verts=6)


def build_fisher():
    """The Settlers 4 Roman fisherman's hut: a big upturned boat of orange clinker planks with dark
    ribs, lying keel-up on stone footings with a doorway cut in its side; long poles lean over it and
    hold a white net stretched out to dry, another net hangs at the bow."""
    rnd = random.Random(271)
    gb = grey_blocks('fgb')
    planks = [lib.mat_grain('shell', (0.6, 0.28, 0.08), (0.9, 0.54, 0.2), scale=5, stretch=(12, 0.7, 12), bump=0.8)]
    planks += grain_set('hull', (((0.42, 0.18, 0.06), (0.62, 0.32, 0.12)), ((0.72, 0.4, 0.14), (0.94, 0.62, 0.3))),
                        scale=4, stretch=(1, 9, 1), bump=0.7)
    keel = lib.mat_grain('keel', (0.24, 0.12, 0.05), (0.4, 0.22, 0.1), scale=5, stretch=(1, 1, 8), bump=0.6)
    pole = lib.mat_grain('pole', (0.6, 0.42, 0.2), (0.8, 0.62, 0.34), scale=6, stretch=(1, 1, 8), bump=0.5)
    net = mat_net('net')
    fish = lib.mat_flat('fish', (0.3, 0.62, 0.66), rough=0.3)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    door = door_mat()
    earth_pad((0.05, -0.2, 0), 1.0, 1.1, seed=271)
    lib.tag(0)
    corner_stakes(-0.85, 0.85, -0.9, 0.85)
    lib.tag(0, until=0)
    cx, cy, L, B, D = 0.05, 0.02, 1.9, 1.2, 0.95
    for y in (cy - 0.5, cy, cy + 0.5):
        for x in (cx - B / 2 * 0.95, cx + B / 2 * 0.95):
            lib.box((x, y, 0.05), (0.16, 0.16, 0.1), gb[rnd.randrange(len(gb))], bevel=0.02)
    lib.box((cx, cy, 0.03), (B * 0.9, L * 0.7, 0.06), dark)
    lib.tag(1)
    gap = (0.36, 0.52, 1.0)
    boat_shell(cx, cy, L, B, D, planks, keel, keel, rnd, door_gap=gap)
    lib.tag(None, split=lambda o: 2 if o.location.z < D * 0.5 else 3)
    # The doorway: a dark opening with a plank door set back, a step.
    dy = cy - L / 2 + (gap[0] + gap[1]) / 2 * L
    lib.box((cx + B / 2 * 0.5, dy, 0.3), (0.04, 0.32, 0.6), dark)
    lib.box((cx + B / 2 * 0.56, dy + 0.02, 0.26), (0.03, 0.22, 0.5), door, bevel=0.006)
    lib.box((cx + B / 2 + 0.04, dy, 0.03), (0.16, 0.32, 0.05), planks[2], bevel=0.008)
    lib.tag(3)
    # Poles leaning over the boat, a net stretched between their tops, another hanging at the bow.
    tops = [(cx - 0.62, cy - 0.62, 0.72), (cx + 0.32, cy - 0.38, 1.08), (cx + 0.5, cy + 0.75, 1.3), (cx - 0.5, cy + 0.6, 0.92)]
    feet = [(cx - 0.9, cy - 0.78, 0.0), (cx + 0.62, cy - 0.62, 0.0), (cx + 0.75, cy + 0.85, 0.0), (cx - 0.85, cy + 0.7, 0.0)]
    for f, t in zip(feet, tops):
        tip = (t[0] + (t[0] - f[0]) * 0.12, t[1] + (t[1] - f[1]) * 0.12, t[2] + (t[2] - f[2]) * 0.12)
        rod(f, tip, 0.032, pole, verts=8)
        lib.sphere(t, 0.03, pole, subdiv=1)
    net_sheet(tops, net, cells=(11, 9), sag=0.1)
    bow = (cx, cy - L / 2 - 0.02)
    net_sheet([(bow[0] - 0.24, bow[1] - 0.12, 0.5), (bow[0] + 0.2, bow[1] - 0.18, 0.56), (bow[0] + 0.26, bow[1] - 0.26, 0.0),
               (bow[0] - 0.3, bow[1] - 0.2, 0.0)], net, cells=(3, 4), sag=-0.04)
    lib.sphere((bow[0] - 0.05, bow[1] - 0.2, 0.32), 0.045, fish, scale=(1.8, 0.5, 0.6))
    lib.tag(4)


# ------------------------------------------------------------------------------------- last batch
# Castle, fortress, big tower, lookout, infirmary, hunter, slaughterhouse: our own designs in the
# established style (rugged pale stone, timber, terracotta and slate); no original sprites copied.

def battlements(x0, x1, y0, y1, z, mats, rnd, size=0.17, h=0.17, faces=('y0', 'x1', 'y1', 'x0')):
    """Merlons every other slot along the chosen edges of a square top at height z."""
    def run(a, b, fixed, along_x):
        n = max(2, int(abs(b - a) / size))
        for k in range(0, n, 2):
            t = a + (k + 0.5) * (b - a) / n
            loc = (t, fixed, z + h / 2) if along_x else (fixed, t, z + h / 2)
            sz = (abs(b - a) / n * 0.95, 0.13, h) if along_x else (0.13, abs(b - a) / n * 0.95, h)
            lib.box(loc, sz, mats[rnd.randrange(len(mats))], rot=(0, 0, rnd.uniform(-0.03, 0.03)), bevel=0.018)
    if 'y0' in faces:
        run(x0, x1, y0, True)
    if 'y1' in faces:
        run(x0, x1, y1, True)
    if 'x0' in faces:
        run(y0, y1, x0, False)
    if 'x1' in faces:
        run(y0, y1, x1, False)


def square_keep(cx, cy, s, z0, z1, walls, blocks, rnd, block=0.24):
    """A square stone block with rugged facing and quoins; returns its bounds."""
    x0, x1, y0, y1 = cx - s / 2, cx + s / 2, cy - s / 2, cy + s / 2
    lib.box((cx, cy, (z0 + z1) / 2), (s, s, z1 - z0), walls)
    stone_course(x0, x1, y0, y1, z0, z1, blocks, rnd, block=block, depth=0.08)
    quoins(x0, x1, y0, y1, z0, z1, blocks, rnd, block=block * 1.05)
    return x0, x1, y0, y1


def slit(x, y, z, face, dark, stone):
    """An arrow slit with a stone lintel in the −Y (face 'y') or +X (face 'x') wall."""
    if face == 'y':
        lib.box((x, y - 0.03, z), (0.07, 0.04, 0.24), dark)
        lib.box((x, y - 0.05, z + 0.15), (0.16, 0.06, 0.06), stone, bevel=0.012)
    else:
        lib.box((x + 0.03, y, z), (0.04, 0.07, 0.24), dark)
        lib.box((x + 0.05, y, z + 0.15), (0.06, 0.16, 0.06), stone, bevel=0.012)


def gate(x, y, z0, w, h, door, stones, iron):
    """A big arched gate in the −Y wall: plank leaves under voussoirs, iron bands."""
    arch_door(x, y, z0, w, h, door, stones)
    for z in (z0 + 0.12, z0 + h * 0.45):
        lib.box((x, y - 0.065, z), (w * 0.96, 0.012, 0.035), iron, bevel=0.004)


def scaffold(x0, x1, y0, y1, h, beam):
    for x in (x0, x1):
        for y in (y0, y1):
            lib.cylinder((x, y, h / 2), 0.025, h, beam, verts=8)


def build_castle():
    """The player's seat, the biggest building (4×4, as the Settlers 4 castle): a curtain wall with four
    round corner towers under terracotta cones, a gatehouse in the front wall, and a tall square keep
    under a pyramid roof rising behind; the owner's banner flies from the keep. Modelled at the old 3×3
    size and scaled up to the 4×4 footprint (a little more in height: ≈ 7.8 settler heights)."""
    rnd = random.Random(81)
    walls, blocks = stone_walls(), block_mats()
    tiles = terracotta_mats('ctc')
    door, iron = door_mat(), lib.mat_flat('iron', (0.36, 0.37, 0.4), rough=0.35)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    ridge = lib.mat_flat('ridge', (0.55, 0.2, 0.08))
    beam = beam_mat()
    earth_pad((0.05, -0.15, 0), 1.55, 1.6, seed=81)
    lib.tag(0)
    corner_stakes(-1.35, 1.35, -1.35, 1.35)
    lib.tag(0, until=0)

    R, WH, T = 1.15, 0.6, 0.16  # half size of the curtain, wall height, wall thickness
    lib.box((0, 0, 0.05), (2 * R + 0.1, 2 * R + 0.1, 0.1), blocks[1], bevel=0.02)
    lib.tag(1)
    scaffold(-R - 0.12, R + 0.12, -R - 0.12, R + 0.12, 1.8, beam)
    lib.tag(1, until=3)
    for (x0, x1, y0, y1) in ((-R, R, -R, -R + T), (R - T, R, -R, R), (-R, R, R - T, R), (-R, -R + T, -R, R)):
        stone_house(x0, x1, y0, y1, WH, rnd, walls, blocks, z0=0.1, block=0.2)
    for (tx, ty) in ((-R, -R), (R, -R), (R, R), (-R, R)):
        round_tower(tx, ty, 0.3, 0.1, WH + 0.5, walls, blocks, rnd, rows=5)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.45 else 3)
    battlements(-R, R, -R - 0.02, R + 0.02, WH, blocks, rnd, faces=('y0', 'x1'))
    for (tx, ty) in ((-R, -R), (R, -R), (R, R), (-R, R)):
        slit(tx + 0.21, ty - 0.21, WH * 0.75, 'y', dark, blocks[2])
    # Gatehouse in the front wall.
    gx = 0.15
    square_keep(gx, -R + 0.1, 0.62, 0.1, WH + 0.35, walls, blocks, rnd, block=0.2)
    gate(gx, -R - 0.2, 0.1, 0.36, 0.52, door, blocks, iron)
    battlements(gx - 0.31, gx + 0.31, -R - 0.21, -R + 0.41, WH + 0.35, blocks, rnd, size=0.14, faces=('y0', 'x1'))
    lib.tag(3)
    for (tx, ty) in ((-R, -R), (R, -R), (R, R), (-R, R)):
        cone_tiles(tx, ty, WH + 0.5, 0.38, 0.55, tiles, rnd, size=0.11)
    lib.tag(4)
    # The keep behind the gate.
    kx, ky, ks, KH = -0.2, 0.25, 1.0, 1.75
    kx0, kx1, ky0, ky1 = square_keep(kx, ky, ks, 0.1, KH, walls, blocks, rnd)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.7 else 3)
    for z in (0.95, 1.4):
        slit(kx - 0.15, ky0, z, 'y', dark, blocks[2])
        slit(kx + 0.25, ky0, z, 'y', dark, blocks[2])
        slit(kx1, ky - 0.2, z, 'x', dark, blocks[2])
    lib.tag(3)
    hip_roof(kx, ky, ks, ks, KH, 0.62, tiles, ridge, rnd, overhang=0.1, size=0.12, shape='tile', ridge_frac=0.0)
    lib.tag(4)
    at = scale_scene(4 / 3, kz=1.5)
    note_banner('castle', at((kx, ky, KH + 0.66)))


def cage(cx, cy, ps, top, wood, plank, beam, rnd, rail=0.42):
    """A Settlers 4 fighting platform: joists poking out in two layers over a tower's top, a plank floor
    and a box railing of round beams on corner and middle posts, X-braced in every panel. Returns the
    floor's height."""
    for k in range(4):
        t = -ps / 2 + 0.1 + k * (ps - 0.2) / 3
        lib.box((cx, cy + t, top - 0.04), (ps + 0.14, 0.08, 0.08), beam, bevel=0.01)
    for k in range(5):
        t = -ps / 2 + 0.06 + k * (ps - 0.12) / 4
        lib.box((cx + t, cy, top + 0.04), (0.08, ps + 0.12, 0.08), beam, bevel=0.01)
    n = 9
    for k in range(n):
        t = -ps / 2 + (k + 0.5) * ps / n
        lib.box((cx, cy + t, top + 0.11), (ps, ps / n - 0.012, 0.04), plank, rot=(0, 0, rnd.uniform(-0.015, 0.015)),
                bevel=0.008)
    r = 0.05
    zb, zt = top + 0.16, top + 0.13 + rail
    corners = [(cx - ps / 2, cy - ps / 2), (cx + ps / 2, cy - ps / 2), (cx + ps / 2, cy + ps / 2), (cx - ps / 2, cy + ps / 2)]
    for k in range(4):
        (xa, ya), (xb, yb) = corners[k], corners[(k + 1) % 4]
        xm, ym = (xa + xb) / 2, (ya + yb) / 2
        for (x, y) in ((xa, ya), (xm, ym)):
            lib.cylinder((x, y, top + 0.1 + (rail + 0.08) / 2), r * 1.15, rail + 0.1, wood, verts=12)
        for z in (zb, zt):
            rod((xa, ya, z), (xb, yb, z), r, wood)
        for (pa, pb) in (((xa, ya), (xm, ym)), ((xm, ym), (xb, yb))):
            ix, iy = (pb[0] - pa[0]) * 0.1, (pb[1] - pa[1]) * 0.1
            rod((pa[0] + ix, pa[1] + iy, zb + 0.03), (pb[0] - ix, pb[1] - iy, zt - 0.03), r * 0.75, wood)
            rod((pa[0] + ix, pa[1] + iy, zt - 0.03), (pb[0] - ix, pb[1] - iy, zb + 0.03), r * 0.75, wood)
    return top + 0.13


def buttress(x, y, sx, sy, h, blocks, rnd):
    """Settlers 4's stepped corner buttress: a pier of big rough blocks at a tower's corner (x, y),
    standing out diagonally (signs sx, sy), each course smaller and further in than the one below."""
    steps = 3
    for k in range(steps):
        t = k / steps
        size = 0.36 * (1 - t * 0.45)
        out = 0.12 * (1 - t)
        z0, z1 = h * k / steps, h * (k + 1) / steps
        lib.box((x + sx * (out - size / 2 + 0.16), y + sy * (out - size / 2 + 0.16), (z0 + z1) / 2),
                (size, size, z1 - z0 - 0.02), blocks[rnd.randrange(len(blocks))],
                rot=(rnd.uniform(-0.03, 0.03), rnd.uniform(-0.03, 0.03), rnd.uniform(-0.05, 0.05)), bevel=0.03)
        # A slanted cap stone on each step.
        lib.box((x + sx * (out - size / 2 + 0.17), y + sy * (out - size / 2 + 0.17), z1 - 0.01),
                (size * 0.9, size * 0.9, 0.05), blocks[rnd.randrange(len(blocks))], rot=(sy * 0.15, -sx * 0.15, 0),
                bevel=0.015)


def chain(a, b, iron, links=9):
    """An iron chain of small links from point a to point b, sagging a little."""
    for k in range(links):
        t = (k + 0.5) / links
        x = a[0] + (b[0] - a[0]) * t
        y = a[1] + (b[1] - a[1]) * t
        z = a[2] + (b[2] - a[2]) * t - 0.04 * math.sin(t * math.pi)
        torus((x, y, z), 0.022, 0.007, iron, rot=(0 if k % 2 else math.pi / 2, math.pi / 2, math.atan2(b[1] - a[1], b[0] - a[0])))


def stair(a, b, width, wood, plank, beam, rnd, rail=0.36):
    """A wooden stair from a (top) down to b: two stringers, treads across them, posts down to the
    ground and a hand rail on each side."""
    from mathutils import Vector

    a, b = Vector(a), Vector(b)
    d = b - a
    flat = Vector((d.x, d.y, 0))
    yaw = math.atan2(d.y, d.x)
    side = Vector((-math.sin(yaw), math.cos(yaw), 0)) * (width / 2)
    for s in (-1, 1):
        rod(a + side * s, b + side * s, 0.035, beam, verts=8)
    n = max(4, int(flat.length / 0.12))
    for k in range(n):
        p = a + d * ((k + 0.5) / n)
        lib.box((p.x, p.y, p.z + 0.03), (0.1, width + 0.06, 0.03), plank, rot=(0, 0, yaw + rnd.uniform(-0.03, 0.03)),
                bevel=0.006)
    for k in range(1, 4):
        p = a + d * (k / 4)
        for s in (-1, 1):
            q = p + side * s
            lib.box((q.x, q.y, q.z / 2), (0.06, 0.06, q.z), beam, bevel=0.008)
            rod((q.x, q.y, q.z), (q.x, q.y, q.z + rail), 0.03, wood, verts=8)
    for s in (-1, 1):
        rod(a + side * s + Vector((0, 0, rail)), b + side * s + Vector((0, 0, rail)), 0.03, wood, verts=8)


# Archers' posts on the fortress: (tower, dx, dy) from that tower's centre — two on the back tower,
# flanking its banner, one on each of the others. The swordsmen's are the four windows.
FORTRESS_POSTS = (('back', -0.14, -0.4), ('back', 0.4, 0.14), ('left', 0.02, -0.06), ('right', 0.06, -0.02),
                  ('front', 0.02, 0.0))


def build_fortress():
    """The Settlers 4 Roman castle (4×4, «Замок»): four square towers of rough grey stone at the corners,
    battered and propped by stepped buttresses, each topped by a railed timber fighting platform — the
    front one lowest, the back one highest with the owner's banner —, curtain walls between them with a
    strapped plank gate (and its drawbridge chains) in the front-left wall, a stone hall under big grey
    shingles along the back with shuttered windows and the crossed-swords shield, and a wooden stair
    from the back tower's platform down into the court. Archers stand on the platforms, swordsmen look
    out of windows high in the towers. ≈ 7.2 settler heights."""
    rnd = random.Random(91)
    walls, blocks = stone_walls(), block_mats()
    door, iron = door_mat(), lib.mat_flat('iron', (0.3, 0.31, 0.34), rough=0.35)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    beam = beam_mat()
    wood = lib.mat_grain('frail', (0.5, 0.32, 0.12), (0.8, 0.58, 0.28), scale=5, stretch=(1, 1, 8), bump=0.6)
    plank = lib.mat_grain('fplank', (0.42, 0.26, 0.1), (0.66, 0.46, 0.2), scale=4, stretch=(1, 9, 1), bump=0.7)
    shingles = [lib.mat_grain(f'fsh{k}', a, b, scale=8, stretch=(1, 3, 1), bump=0.6) for k, (a, b) in enumerate((
        ((0.42, 0.36, 0.36), (0.7, 0.6, 0.58)), ((0.36, 0.33, 0.34), (0.6, 0.56, 0.56)),
        ((0.48, 0.4, 0.38), (0.78, 0.66, 0.6))))]
    teal = lib.mat_grain('shutter', (0.16, 0.34, 0.36), (0.3, 0.52, 0.52), scale=4, stretch=(1, 1, 9), bump=0.5)
    steel = lib.mat_flat('steel', (0.74, 0.76, 0.8), rough=0.25)
    red = lib.mat_flat('shield', (0.62, 0.12, 0.08), rough=0.6)
    flags = [lib.mat_grain(f'fflag{k}', a, b, scale=6, stretch=(1, 1, 1), bump=0.8) for k, (a, b) in enumerate((
        ((0.42, 0.4, 0.37), (0.66, 0.63, 0.57)), ((0.36, 0.35, 0.33), (0.58, 0.56, 0.52))))]
    earth_pad((0.05, -0.08, 0), 1.45, 1.42, seed=91)
    lib.tag(0)
    corner_stakes(-1.9, 1.9, -1.9, 1.9)
    lib.tag(0, until=0)

    s, at, lean_total = 1.06, 1.32, 0.05
    towers = {
        'front': (at, -at, 1.15),
        'left': (-at, -at, 1.42),
        'right': (at, at, 1.38),
        'back': (-at, at, 1.64),
    }
    WH, T = 1.05, 0.22
    inner = at - s / 2  # where the curtain walls meet the towers
    # Foundations.
    for (cx, cy, H) in towers.values():
        lib.box((cx, cy, 0.04), (s + 0.16, s + 0.16, 0.08), blocks[1], bevel=0.02)
    for (x0, x1, y0, y1) in ((-inner, inner, -at - 0.43, -at - 0.43 + T), (at + 0.43 - T, at + 0.43, -inner, inner),
                             (-at - 0.43, -at - 0.43 + T, -inner, inner), (-inner, inner, 0.25, at + 0.43)):
        lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.03), (x1 - x0 + 0.08, y1 - y0 + 0.08, 0.06), blocks[3], bevel=0.015)
    # The court's flagstones.
    for i in range(9):
        for j in range(8):
            x = -inner + (j + 0.5 + 0.5 * (i % 2)) * (2 * inner) / 8
            y = -at - 0.2 + (i + 0.5) * (at + 0.45) / 9
            if x < inner:
                lib.box((x, y, 0.012), (2 * inner / 8 - 0.02, (at + 0.45) / 9 - 0.02, 0.025), flags[(i + j) % 2],
                        rot=(0, 0, rnd.uniform(-0.04, 0.04)), bevel=0.006)
    lib.tag(1)
    scaffold(-2.0, 2.0, -2.0, 2.0, 2.3, beam)
    lib.tag(1, until=3)

    def lean(H):
        return lambda z: lean_total * z / H

    # The towers: battered masonry with quoins, stepped buttresses at their outer corners.
    for name, (cx, cy, H) in towers.items():
        x0, x1, y0, y1 = cx - s / 2, cx + s / 2, cy - s / 2, cy + s / 2
        battered_courses(x0, x1, y0, y1, 0.08, H - 0.1, lean(H), walls, blocks, rnd, courses=max(4, round(H / 0.26)),
                         block=0.26, depth=0.09)
        sxo, syo = (1 if cx > 0 else -1), (1 if cy > 0 else -1)
        corners = [(x0, y0, -1, -1), (x1, y0, 1, -1), (x1, y1, 1, 1), (x0, y1, -1, 1)]
        for (x, y, sx, sy) in corners:
            # Outer corners and those the camera sees get a buttress; never into the court.
            if (sx == sxo or sy == syo) and not (sx == -1 and sy == 1 and name != 'back'):
                buttress(x, y, sx, sy, H * 0.42, blocks, rnd)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.7 else 3)

    # Curtain walls between the towers, a coping on top.
    wy0 = -at - 0.43
    stone_house(-inner, inner, wy0, wy0 + T, WH, rnd, walls, blocks, z0=0.0, block=0.2)
    stone_house(at + 0.43 - T, at + 0.43, -inner, inner, WH, rnd, walls, blocks, z0=0.0, block=0.2)
    stone_house(-at - 0.43, -at - 0.43 + T, -inner, inner, WH, rnd, walls, blocks, z0=0.0, block=0.2)
    lib.tag(None, split=lambda o: 2 if o.location.z < 0.5 else 3)
    coping_line((-inner + 0.05, wy0 + T / 2, WH), (inner - 0.05, wy0 + T / 2, WH), blocks, rnd, size=0.17)
    coping_line((at + 0.43 - T / 2, -inner + 0.05, WH), (at + 0.43 - T / 2, inner - 0.05, WH), blocks, rnd, size=0.17)
    coping_line((-at - 0.43 + T / 2, -inner + 0.05, WH), (-at - 0.43 + T / 2, inner - 0.05, WH), blocks, rnd, size=0.17)
    # The gate: strapped plank leaves under a stone lintel, the drawbridge chains up to the wall top.
    gx, gw, gh = 0.3, 0.7, 0.76
    plank_door(gx, wy0 - 0.02, 0.0, gw, gh, door, dark, iron, blocks[2])
    for sx in (-1, 1):
        chain((gx + sx * gw * 0.42, wy0 - 0.06, gh * 0.55), (gx + sx * gw * 0.62, wy0 - 0.02, WH - 0.04), iron)
        lib.cylinder((gx + sx * gw * 0.62, wy0 - 0.05, WH - 0.04), 0.04, 0.05, iron, rot=(math.pi / 2, 0, 0), verts=12)
    lib.tag(3)

    # The hall along the back: stone walls, shuttered windows, the shield with crossed swords.
    hx0, hx1, hy0, hy1, hH, hrh = -0.25, inner + 0.02, 0.05, at + 0.43, 1.55, 0.44
    hall_before = set(bpy.context.scene.objects)
    stone_house(hx0, hx1, hy0, hy1, 0.7, rnd, walls, blocks, z0=0.0, block=0.2)
    lib.tag(2)
    stone_house(hx0, hx1, hy0, hy1, hH, rnd, walls, blocks, z0=0.7, block=0.2)
    lib.tag(3)
    for wx in (-0.02, 0.6):
        lib.box((wx, hy0 - 0.03, 1.27), (0.18, 0.04, 0.32), dark)
        lib.box((wx, hy0 - 0.06, 1.45), (0.3, 0.07, 0.07), blocks[2], bevel=0.015)
        lib.box((wx, hy0 - 0.06, 1.09), (0.28, 0.08, 0.05), blocks[0], bevel=0.015)
        for sx in (-1, 1):
            lib.box((wx + sx * 0.15, hy0 - 0.07, 1.27), (0.1, 0.025, 0.32), teal, rot=(0, 0, sx * 0.35), bevel=0.005)
    ex = 0.29
    lib.cylinder((ex, hy0 - 0.05, 1.32), 0.14, 0.04, red, rot=(math.pi / 2, 0, 0), verts=24)
    torus((ex, hy0 - 0.07, 1.32), 0.14, 0.016, iron, rot=(math.pi / 2, 0, 0))
    for sx in (-1, 1):
        lib.box((ex, hy0 - 0.1, 1.32), (0.03, 0.015, 0.44), steel, rot=(0, sx * 0.75, 0), bevel=0.004)
        lib.box((ex + sx * 0.12, hy0 - 0.11, 1.19), (0.09, 0.02, 0.025), iron, rot=(0, sx * 0.75, 0))
    lib.tag(3)
    # Its roof: big grey shingles, ridge along X; the camera's slope tiled.
    hcy = (hy0 + hy1) / 2
    ov = 0.1
    hcx = (hx0 + hx1) / 2
    lib.prism_roof((hcx, hcy, hH), hx1 - hx0, hy1 - hy0, hrh, shingles[1], overhang=ov, thickness=0.05, along='x')
    lib.gable((hcx, hcy, hH), hy1 - hy0, hrh, hx0 - 0.01, walls, along='x')
    drop = ov * hrh / ((hy1 - hy0) / 2)
    tile_face((hx0 - ov, hy0 - ov, hH - drop), (hx1 + ov, hy0 - ov, hH - drop), (hx0 - ov, hcy, hH + hrh),
              (hx1 + ov, hcy, hH + hrh), shingles, rnd, size=0.22, shape='tile', lift=0.035)
    rod((hx0 - ov, hcy, hH + hrh + 0.04), (hx1 + ov, hcy, hH + hrh + 0.04), 0.045, beam)
    hall = set(bpy.context.scene.objects) - hall_before
    lib.tag(4)

    # Swordsmen's windows high in the towers' outer faces.
    windows = []
    for (name, face, along) in (('left', 'y', -0.1), ('front', 'y', -0.06), ('front', 'x', 0.05), ('right', 'x', -0.1)):
        cx, cy, H = towers[name]
        zc = H - 0.44
        if face == 'y':
            windows.append(garrison_window('y', cx + along, cy - s / 2 + lean(H)(zc), zc, 0.26, 0.34, dark, blocks,
                                           out=0.12))
        else:
            windows.append(garrison_window('x', cy + along, cx + s / 2 - lean(H)(zc), zc, 0.26, 0.34, dark, blocks,
                                           out=0.12))
    lib.tag(3)
    # Corbelled tops and the fighting platforms.
    floors = {}
    for name, (cx, cy, H) in towers.items():
        cs = s - 2 * lean_total + 0.1
        lib.box((cx, cy, H - 0.06), (cs - 0.04, cs - 0.04, 0.12), walls)
        stone_course(cx - cs / 2, cx + cs / 2, cy - cs / 2, cy + cs / 2, H - 0.12, H, blocks, rnd, block=0.2, depth=0.06)
    lib.tag(3)
    for name, (cx, cy, H) in towers.items():
        floors[name] = cage(cx, cy, s + 0.1, H, wood, plank, beam, rnd)
    # The stair from the back platform's near corner down to a landing behind the gate.
    bx, by, bH = towers['back']
    ps = s + 0.1
    top = (bx + ps / 2 - 0.12, by - ps / 2 + 0.12, floors['back'] - 0.02)
    lx0, lx1, ly0, ly1 = -0.35, 0.2, wy0 + T, wy0 + T + 0.5
    for (x, y) in ((lx0, ly1), (lx1, ly1)):
        lib.box((x, y, WH / 2), (0.07, 0.07, WH), beam, bevel=0.008)
    for k in range(5):
        lib.box(((lx0 + lx1) / 2, ly0 + (k + 0.5) * (ly1 - ly0) / 5, WH + 0.02), (lx1 - lx0 + 0.06, (ly1 - ly0) / 5 - 0.01, 0.035),
                plank, bevel=0.006)
    stair(top, ((lx0 + lx1) / 2 - 0.05, ly1 - 0.02, WH + 0.04), 0.46, wood, plank, beam, rnd)
    lib.tag(4)

    note_banner('fortress', (bx - 0.12, by + 0.12, floors['back']))
    ranged = []
    for (name, dx, dy) in FORTRESS_POSTS:
        cx, cy, H = towers[name]
        ranged.append((cx + dx, cy + dy, floors[name]))
    # What stands before the posts: each tower's masonry below its platform (the windows are holes in
    # it) and its platform's near rails; the hall never (archers on the right tower stand before it).
    from mathutils import Vector

    bpy.context.view_layer.update()
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH' or obj.name == 'ShadowCatcher' or obj.get('window') or obj in hall:
            continue
        corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        c = sum(corners, Vector()) / 8
        z = max(v.z for v in corners)
        if z <= 0.05:
            continue
        for name, (cx, cy, H) in towers.items():
            fl = floors[name]
            if abs(c.x - cx) > ps / 2 + 0.25 or abs(c.y - cy) > ps / 2 + 0.25:
                continue
            if z < fl - 0.03 or (z > fl + 0.05 and (c.y < cy - ps / 2 + 0.12 or c.x > cx + ps / 2 - 0.12)):
                obj['front'] = 1
    note_posts('fortress', ranged, windows)


def gate_arch(x0, x1, y, zs, face, mats, rnd, ring=0.13, depth=0.2, top=None, filler=None):
    """A round stone arch spanning x0..x1 in a wall plane at y, springing at zs: voussoirs round the
    opening with a proud keystone, facing −Y (`face` −1, its front at y) or +Y (`face` 1), and — with
    `top` — rugged spandrel stones filling the corners up to that height (`filler` their core)."""
    r = (x1 - x0) / 2
    ax = (x0 + x1) / 2
    yc = y - face * depth / 2
    n = 11
    for k in range(n):
        a = math.pi * (k + 0.5) / n
        key = k == n // 2
        rm = r + ring / 2 + (0.02 if key else 0)
        lib.box((ax + math.cos(a) * rm, yc + (-face * 0.025 if key else 0), zs + math.sin(a) * rm),
                (ring + (0.05 if key else 0), depth + (0.05 if key else 0), math.pi * rm / n * (1.15 if key else 0.9)),
                mats[rnd.randrange(len(mats))], rot=(0, -a, 0), bevel=0.015)
    # Imposts: a projecting stone under each springing.
    for sx in (-1, 1):
        lib.box((ax + sx * (r + 0.02), yc - face * 0.015, zs - 0.035), (0.16, depth + 0.03, 0.07), mats[2 % len(mats)],
                bevel=0.012)
    if top is None:
        return
    R = r + ring
    cols = 9
    for k in range(cols):
        xa, xb = x0 + (x1 - x0) * k / cols, x0 + (x1 - x0) * (k + 1) / cols
        dx = max(abs(xa - ax), abs(xb - ax))
        z0 = zs + math.sqrt(max(R * R - dx * dx, 0)) - 0.05
        if z0 < top - 0.01:
            lib.box(((xa + xb) / 2, yc + face * 0.02, (z0 + top) / 2), (xb - xa, depth - 0.04, top - z0), filler)
            lib.box(((xa + xb) / 2, yc - face * 0.01, (z0 + top) / 2 + 0.01), (xb - xa - 0.02, depth - 0.02, top - z0 - 0.02),
                    mats[rnd.randrange(len(mats))], rot=(0, rnd.uniform(-0.05, 0.05), 0), bevel=0.012)


def build_bigtower():
    """The big tower after Settlers 4's: two stone piers — a broad one with the door and a narrow one,
    their outer faces leaning in a little as they rise — with a passage right through between them,
    under one wide timber fighting platform laid across both, railed on corner and middle posts with
    X-braces. The passage reads from the camera: a round stone arch with a keystone at its mouth, a
    paved floor running in from an apron before it, the narrow pier's inner wall receding into the
    shade under the platform's joists. The archers stand on the platform, the swordsmen look out of
    windows in the piers; the owner's banner stands in its middle. A small house plus 20–30 % (≈ 5
    settler heights, ≈ 15 % over the small tower) and broader than the small tower."""
    rnd = random.Random(31)
    walls, blocks = stone_walls(), block_mats()
    door, iron = door_mat(), lib.mat_flat('iron', (0.36, 0.37, 0.4), rough=0.35)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    beam = beam_mat()
    wood = lib.mat_grain('brail', (0.5, 0.32, 0.12), (0.8, 0.58, 0.28), scale=5, stretch=(1, 1, 8), bump=0.6)
    plank = lib.mat_grain('bplank', (0.42, 0.26, 0.1), (0.66, 0.46, 0.2), scale=4, stretch=(1, 9, 1), bump=0.7)
    flags = [lib.mat_grain(f'flag{k}', a, b, scale=6, stretch=(1, 1, 1), bump=0.8) for k, (a, b) in enumerate((
        ((0.55, 0.52, 0.46), (0.82, 0.79, 0.7)),
        ((0.48, 0.46, 0.42), (0.72, 0.7, 0.64)),
        ((0.6, 0.56, 0.48), (0.86, 0.82, 0.72)),
    ))]
    earth_pad((0.1, -0.2, 0), 1.05, 1.12, seed=31)
    lib.tag(0)
    corner_stakes(-0.9, 0.9, -0.9, 0.9)
    lib.tag(0, until=0)

    Z0, H = 0.12, 1.2
    y0, y1 = -0.8, 0.82
    (na, nb), (ba, bb) = (-0.9, -0.36), (0.3, 0.92)  # the narrow pier, the passage between, the broad one

    def lean(z):  # how far a pier's outer faces have moved in at height z
        return 0.07 * (z - Z0) / (H - Z0)

    batter = math.atan(0.07 / (H - Z0))
    for (a, b) in ((na, nb), (ba, bb)):
        lib.box(((a + b) / 2, (y0 + y1) / 2, 0.06), (b - a + 0.1, y1 - y0 + 0.1, 0.12), blocks[1], bevel=0.02)
    # The passage's paved floor, running out into an apron before its mouth.
    fx0, fx1, fy0, fy1 = nb + 0.02, ba - 0.02, y0 - 0.34, y1 + 0.04
    rows, cols = 13, 4
    for i in range(rows):
        for j in range(cols):
            w, d = (fx1 - fx0) / cols, (fy1 - fy0) / rows
            off = (i % 2) * w / 2
            x = fx0 + off + (j + 0.5) * w
            if x + w / 2 > fx1 + 0.01:
                x -= w / 2
                ww = w / 2
            else:
                ww = w
            lib.box((x, fy0 + (i + 0.5) * d, 0.015), (ww - 0.02, d - 0.02, 0.03 + rnd.uniform(0, 0.012)),
                    flags[rnd.randrange(len(flags))], rot=(0, 0, rnd.uniform(-0.04, 0.04)), bevel=0.008)
    lib.tag(1)
    scaffold(-0.95, 1.0, y0 - 0.1, y1 + 0.1, 1.7, beam)
    lib.tag(1, until=3)
    # The piers: their outer faces lean in, the faces on the passage stay plumb under the arch.
    battered_courses(na, nb, y0, y1, Z0, H, lean, walls, blocks, rnd, courses=6, block=0.26, depth=0.09,
                     sides=(1, 0, 1, 1), faces=('y',))
    # Inside the passage the narrow pier's wall is in the platform's shade: dark, rough stone behind the
    # quoins of its jamb, so the opening reads as an opening and not as more of the front.
    shade = lib.mat_stones('passage', (0.2, 0.2, 0.2), (0.11, 0.11, 0.12), (0.03, 0.03, 0.03), scale=9, bump=0.9)
    lib.box((nb + 0.01, (y0 + 0.16 + y1) / 2, (Z0 + H) / 2), (0.02, y1 - y0 - 0.16, H - Z0), shade)
    battered_courses(ba, bb, y0, y1, Z0, H, lean, walls, blocks, rnd, courses=6, block=0.26, depth=0.09,
                     sides=(0, 1, 1, 1))
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)
    # Round arches at both mouths of the passage, carrying the platform between the piers.
    zs = 0.54
    gate_arch(nb, ba, y0 + 0.02, zs, -1, blocks, rnd, depth=0.28, top=H, filler=walls)
    gate_arch(nb, ba, y1 - 0.02, zs, 1, blocks, rnd, depth=0.28, top=H, filler=walls)
    # Strapped plank door in the broad pier's front, leaning back with the wall.
    dh = 0.46
    dx = 0.61
    plank_door(dx, y0 + lean(Z0 + dh / 2) - 0.11, Z0, 0.3, dh, door, dark, iron, blocks[2], batter)
    # Windows for the swordsmen: the narrow pier's front, above the door, the broad pier's side.
    windows = [
        garrison_window('y', (na + nb) / 2 - 0.02, y0 + lean(0.88), 0.88, 0.28, 0.36, dark, blocks, out=0.12),
        garrison_window('y', dx, y0 + lean(0.98), 0.98, 0.26, 0.32, dark, blocks, out=0.12),
        garrison_window('x', 0.1, bb - lean(0.88), 0.88, 0.28, 0.36, dark, blocks, out=0.12),
    ]
    lib.tag(3)

    # The platform: cross beams over both piers and the passage, joists across them poking out, a plank
    # floor, a railing on posts.
    px0, px1, py0, py1 = -0.98, 1.02, y0 - 0.15, y1 + 0.1
    for k in range(5):
        y = y0 + 0.08 + k * (y1 - y0 - 0.16) / 4
        lib.box(((px0 + px1) / 2, y, H - 0.04), (px1 - px0 + 0.14, 0.09, 0.08), beam, bevel=0.01)
    for k in range(7):
        x = px0 + 0.06 + k * (px1 - px0 - 0.12) / 6
        lib.box((x, (py0 + py1) / 2, H + 0.04), (0.08, py1 - py0 + 0.14, 0.08), beam, bevel=0.01)
    n = 11
    for k in range(n):
        y = py0 + (k + 0.5) * (py1 - py0) / n
        lib.box(((px0 + px1) / 2, y, H + 0.11), (px1 - px0, (py1 - py0) / n - 0.012, 0.04), plank,
                rot=(0, 0, rnd.uniform(-0.01, 0.01)), bevel=0.008)
    rail, r = 0.44, 0.055
    zb, zt = H + 0.16, H + 0.13 + rail
    corners = [(px0, py0), (px1, py0), (px1, py1), (px0, py1)]
    for k in range(4):
        (xa, ya), (xb, yb) = corners[k], corners[(k + 1) % 4]
        xm, ym = (xa + xb) / 2, (ya + yb) / 2
        for (x, y) in ((xa, ya), (xm, ym)):
            lib.cylinder((x, y, H + 0.1 + (rail + 0.08) / 2), r * 1.15, rail + 0.1, wood, verts=12)
        for z in (zb, zt):
            rod((xa, ya, z), (xb, yb, z), r, wood)
        for (pa, pb) in (((xa, ya), (xm, ym)), ((xm, ym), (xb, yb))):
            ix, iy = (pb[0] - pa[0]) * 0.1, (pb[1] - pa[1]) * 0.1
            rod((pa[0] + ix, pa[1] + iy, zb + 0.03), (pb[0] - ix, pb[1] - iy, zt - 0.03), r * 0.75, wood)
            rod((pa[0] + ix, pa[1] + iy, zt - 0.03), (pb[0] - ix, pb[1] - iy, zb + 0.03), r * 0.75, wood)
    lib.tag(4)
    floor = H + 0.13
    cx, cy = (px0 + px1) / 2, (py0 + py1) / 2
    note_banner('bigtower', (cx, cy + 0.1, floor))
    mark_front(lambda c, z: z < floor - 0.03 or (z > floor + 0.05 and (c.y < py0 + 0.12 or c.x > px1 - 0.12)))
    note_posts('bigtower', [(cx + dx, cy + dy, floor) for (dx, dy) in BIGTOWER_POSTS], windows)


def build_lookout():
    """The Settlers 4 Roman lookout tower: a slim square tower — dark blue-grey squared stone with pale
    corner stones and a plank door at the foot, a storey of horizontal planks with a slit, an open
    belfry on corner posts with a brass bell, under a pyramid roof grown over with green leaves. Lower
    than the small tower (≈ 3.8 settler heights). No garrison — vision only."""
    rnd = random.Random(41)
    walls = stone_walls()
    dark_blocks = grain_set('ldb', (((0.2, 0.22, 0.27), (0.36, 0.39, 0.45)), ((0.24, 0.26, 0.3), (0.42, 0.44, 0.5)),
                                    ((0.17, 0.19, 0.23), (0.32, 0.34, 0.4))), scale=7)
    pale = grain_set('lpale', (((0.66, 0.66, 0.64), (0.9, 0.9, 0.86)), ((0.6, 0.6, 0.58), (0.84, 0.84, 0.8))), scale=7)
    planks = grain_set('lplank', (((0.3, 0.2, 0.1), (0.5, 0.36, 0.2)), ((0.36, 0.24, 0.12), (0.56, 0.4, 0.22)),
                                  ((0.26, 0.18, 0.1), (0.44, 0.32, 0.18))), scale=4, stretch=(1, 9, 1), bump=0.6)
    beam = beam_mat()
    brass = lib.mat_flat('brass', (0.82, 0.62, 0.22), rough=0.25)
    leaves = lib.mat_leaves('lleaves', (0.04, 0.16, 0.03), (0.14, 0.42, 0.08), (0.42, 0.7, 0.18), scale=18)
    door = door_mat()
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.1, -0.15, 0), 0.8, 0.9, seed=41)
    lib.tag(0)
    cx, cy, h = 0.05, 0.12, 0.38  # half-side of the shaft
    x0, x1, y0, y1 = cx - h, cx + h, cy - h, cy + h
    corner_stakes(x0 - 0.1, x1 + 0.1, y0 - 0.1, y1 + 0.1)
    lib.tag(0, until=0)
    S1, S2, S3, S4 = 0.48, 0.84, 1.38, 1.44  # stone top, plank top, belfry top, roof base
    lib.box((cx, cy, 0.05), (2 * h + 0.1, 2 * h + 0.1, 0.1), dark_blocks[0], bevel=0.02)
    lib.box((cx, cy, S1 * 0.25), (2 * h, 2 * h, S1 * 0.5), walls)
    stone_course(x0, x1, y0, y1, 0.08, S1 * 0.5, dark_blocks, rnd, block=0.16, depth=0.04)
    lib.tag(1)
    lib.box((cx, cy, S1 * 0.75), (2 * h, 2 * h, S1 * 0.5), walls)
    stone_course(x0, x1, y0, y1, S1 * 0.5, S1, dark_blocks, rnd, block=0.16, depth=0.04)
    quoins(x0, x1, y0, y1, 0.06, S1, pale, rnd, block=0.14, row=0.12)
    lib.box((cx - 0.08, y0 - 0.04, 0.22), (0.22, 0.04, 0.4), dark)
    lib.box((cx - 0.08, y0 - 0.055, 0.21), (0.18, 0.03, 0.38), door, bevel=0.006)
    lib.box((cx - 0.08, y0 - 0.07, 0.43), (0.28, 0.05, 0.05), pale[0], bevel=0.01)
    lib.tag(2)
    # Plank storey, a little wider, with corner posts and a slit window.
    hp = h + 0.03
    lib.box((cx, cy, (S1 + S2) / 2), (2 * hp - 0.04, 2 * hp - 0.04, S2 - S1), planks[0])
    rows = 7
    rh = (S2 - S1) / rows
    for r in range(rows):
        z = S1 + (r + 0.5) * rh
        lib.box((cx + rnd.uniform(-0.01, 0.01), y0 - 0.03 - rnd.uniform(0, 0.01), z), (2 * hp + 0.04, 0.03, rh * 0.9),
                planks[rnd.randrange(len(planks))], rot=(0, rnd.uniform(-0.02, 0.02), 0), bevel=0.005)
        lib.box((x1 + 0.03 + rnd.uniform(0, 0.01), cy + rnd.uniform(-0.01, 0.01), z), (0.03, 2 * hp + 0.04, rh * 0.9),
                planks[rnd.randrange(len(planks))], rot=(rnd.uniform(-0.02, 0.02), 0, 0), bevel=0.005)
    for (x, y) in ((x0 - 0.03, y0 - 0.03), (x1 + 0.03, y0 - 0.03), (x1 + 0.03, y1 + 0.03), (x0 - 0.03, y1 + 0.03)):
        lib.box((x, y, (S1 + S3) / 2 + 0.02), (0.08, 0.08, S3 - S1 + 0.04), beam, bevel=0.008)
    lib.box((cx + 0.06, y0 - 0.06, S1 + (S2 - S1) * 0.6), (0.3, 0.03, 0.06), dark)
    lib.box((x1 + 0.06, cy, S1 + (S2 - S1) * 0.6), (0.03, 0.3, 0.06), dark)
    lib.box((cx, cy, S2 + 0.02), (2 * hp + 0.14, 2 * hp + 0.14, 0.05), beam, bevel=0.01)
    lib.tag(3)
    # Open belfry: a rail, the bell hanging from a beam, the leafy pyramid roof.
    for (x, y) in ((cx, y0 - 0.04), (x1 + 0.04, cy)):
        if y != cy:
            lib.box((x, y, S2 + 0.14), (2 * hp + 0.08, 0.03, 0.04), beam)
        else:
            lib.box((x, y, S2 + 0.14), (0.03, 2 * hp + 0.08, 0.04), beam)
    lib.box((cx, cy, S3 - 0.04), (2 * hp + 0.08, 0.05, 0.05), beam)
    lib.cylinder((cx, cy, S3 - 0.11), 0.012, 0.08, beam, verts=6)
    bell = lathe(cx, cy, [(0.22, S2 + 0.12), (0.21, S2 + 0.16), (0.15, S2 + 0.24), (0.12, S2 + 0.34), (0.1, S3 - 0.11),
                          (0.0, S3 - 0.09)], brass, segs=24)
    bell.modifiers.new('Solid', 'SOLIDIFY').thickness = 0.01
    lib.sphere((cx, cy, S2 + 0.18), 0.025, brass, subdiv=1)
    lib.box((cx, cy, S3 + 0.02), (2 * hp + 0.14, 2 * hp + 0.14, 0.05), beam, bevel=0.01)
    roof = hip_roof(cx, cy, 2 * hp + 0.06, 2 * hp + 0.06, S4, 0.36, [leaves], beam, rnd, overhang=0.1, size=0.12,
                    shape='scale', ridge_frac=0.0)
    for k in range(16):
        a = rnd.uniform(0, math.tau)
        f = rnd.uniform(0.2, 0.9)
        rr = (hp + 0.12) * (1 - f)
        lib.lumpy((cx + math.cos(a) * rr, cy + math.sin(a) * rr, S4 + 0.04 + 0.36 * f), rnd.uniform(0.05, 0.08), leaves,
                  scale=(1.2, 1.2, 0.7), strength=0.5, noise=3.0, seed=60 + k, subdiv=2)
    lib.cylinder((cx, cy, S4 + 0.46), 0.016, 0.22, beam, verts=6)
    lib.tag(4)


def healer_column(x, y, H, z_cut, shaft, stone, band, red, dark, face, part):
    """A round stone column at a corner of the healer's house, built in two parts: 'low' two rings
    for a base and the shaft up to `z_cut`; 'high' the rest of the shaft, a capital under the eaves
    and, high up, a white band with a red cross turned to `face` (radians in the ground plane)."""
    r = 0.084
    if part == 'low':
        lib.cylinder((x, y, 0.095), r + 0.045, 0.05, stone, verts=28, bevel=0.012)
        lib.cylinder((x, y, 0.14), r + 0.025, 0.04, stone, verts=28, bevel=0.01)
        lib.cylinder((x, y, (0.16 + z_cut) / 2), r, z_cut - 0.16, shaft, verts=24)
        return
    lib.cylinder((x, y, (z_cut + H) / 2), r, H - z_cut, shaft, verts=24)
    lib.cylinder((x, y, H - 0.075), r + 0.02, 0.03, stone, verts=28, bevel=0.008)
    lib.box((x, y, H - 0.03), (0.23, 0.23, 0.06), stone, bevel=0.014)
    zb0, zb1 = H * 0.55, H * 0.73
    lib.cylinder((x, y, zb0 - 0.012), r + 0.007, 0.024, dark, verts=24)
    lib.cylinder((x, y, (zb0 + zb1) / 2), r + 0.008, zb1 - zb0, band, verts=24)
    zc, rc = (zb0 + zb1) / 2, r + 0.016
    lib.box((x + math.cos(face) * rc, y + math.sin(face) * rc, zc), (0.036, 0.012, (zb1 - zb0) * 0.8), red,
            rot=(0, 0, face + math.pi / 2))
    for da in (-0.36, 0.0, 0.36):
        a = face + da
        lib.box((x + math.cos(a) * rc, y + math.sin(a) * rc, zc), (0.033, 0.012, 0.036), red, rot=(0, 0, a + math.pi / 2))


def wall_basin(x, y, z, stone, water, dark):
    """A stone wash basin on the wall: a flared bowl with a rounded lip and water in it, on a
    tapering bracket."""
    lib.cylinder((x, y, z - 0.05), 0.055, 0.1, stone, radius2=0.1, verts=28)
    torus((x, y, z), 0.098, 0.015, stone)
    lib.cylinder((x, y, z - 0.01), 0.09, 0.01, water, verts=28)
    lib.cylinder((x, y + 0.03, z - 0.17), 0.012, 0.15, dark, radius2=0.045, verts=12)


def checker_floor(x0, x1, y0, y1, keep, black, white, z, s=0.07):
    """Square black and white floor tiles between x0..x1, y0..y1 wherever `keep(x, y)` holds."""
    nx, ny = max(1, round((x1 - x0) / s)), max(1, round((y1 - y0) / s))
    sx, sy = (x1 - x0) / nx, (y1 - y0) / ny
    for i in range(nx):
        for j in range(ny):
            px, py = x0 + (i + 0.5) * sx, y0 + (j + 0.5) * sy
            if keep(px, py):
                lib.box((px, py, z), (sx - 0.005, sy - 0.005, 0.014), black if (i + j) % 2 else white)


def rounded_outline(x0, x1, yf, yb, r, step):
    """Points (x, y, tangent angle) every `step` along a U from (x0, yb) down to the front yf, round
    the front corners (radius r) and back up to (x1, yb): where a curb's stones go."""
    pts = []
    segs = (('line', (x0, yb), (x0, yf + r)), ('arc', (x0 + r, yf + r), math.pi, 1.5 * math.pi),
            ('line', (x0 + r, yf), (x1 - r, yf)), ('arc', (x1 - r, yf + r), 1.5 * math.pi, 2 * math.pi),
            ('line', (x1, yf + r), (x1, yb)))
    for seg in segs:
        if seg[0] == 'line':
            (ax, ay), (bx, by) = seg[1], seg[2]
            n = max(1, round(math.hypot(bx - ax, by - ay) / step))
            ang = math.atan2(by - ay, bx - ax)
            pts += [(ax + (bx - ax) * (k + 0.5) / n, ay + (by - ay) * (k + 0.5) / n, ang) for k in range(n)]
        else:
            (ox, oy), a0, a1 = seg[1], seg[2], seg[3]
            n = max(1, round(r * (a1 - a0) / step))
            for k in range(n):
                a = a0 + (a1 - a0) * (k + 0.5) / n
                pts.append((ox + math.cos(a) * r, oy + math.sin(a) * r, a + math.pi / 2))
    return pts


def build_infirmary():
    """The Settlers 4 Roman healer's house: a long block of small grey-brown squared stones under a
    steep hipped roof of big azure slates, a raised lantern along the ridge (a strip of pale stone
    under its own little hipped roof); a round stone column at each corner, a white band with a red
    cross high on it; in the long wall the doorway in a chunky stone frame, a curb of blue-grey stone
    round a black-and-white chequered threshold before it, a stone wash basin on the wall either side;
    an arched, shuttered window in the short wall."""
    import goods

    rnd = random.Random(61)
    walls = stone_walls()
    blocks = grain_set('ifw', (((0.42, 0.38, 0.34), (0.68, 0.63, 0.56)), ((0.48, 0.43, 0.38), (0.75, 0.69, 0.61)),
                               ((0.36, 0.33, 0.31), (0.6, 0.56, 0.52)), ((0.5, 0.46, 0.41), (0.78, 0.73, 0.66))),

                       scale=7, bump=1.0)
    pale = pale_blocks('ifp')
    slates = grain_set('ifs', (((0.27, 0.4, 0.57), (0.5, 0.65, 0.84)), ((0.33, 0.47, 0.63), (0.6, 0.75, 0.9)),
                               ((0.2, 0.3, 0.45), (0.38, 0.5, 0.66)), ((0.38, 0.5, 0.64), (0.68, 0.79, 0.9))),
                       scale=10, bump=0.5)
    ridge = lib.mat_flat('ifs-r', (0.26, 0.38, 0.52))
    shaft = lib.mat_grain('if-shaft', (0.56, 0.53, 0.48), (0.8, 0.77, 0.71), scale=6, stretch=(1, 1, 6), bump=0.5)
    blue = grain_set('ifb', (((0.36, 0.42, 0.5), (0.6, 0.67, 0.76)), ((0.42, 0.48, 0.56), (0.68, 0.74, 0.82)),
                             ((0.3, 0.35, 0.42), (0.52, 0.58, 0.66))), scale=7, bump=0.8)
    white = lib.mat_flat('if-white', (0.92, 0.91, 0.87), rough=0.6)
    black = lib.mat_flat('if-black', (0.07, 0.07, 0.08), rough=0.5)
    red = lib.mat_flat('if-red', (0.8, 0.06, 0.05), rough=0.6)
    darkstone = lib.mat_flat('if-dark', (0.16, 0.16, 0.18), rough=0.7)
    water = lib.mat_flat('if-water', (0.36, 0.62, 0.52), rough=0.15)
    inside = lib.mat_flat('if-inside', (0.3, 0.46, 0.42), rough=0.8)
    shutter = grain_set('ifsh', (((0.58, 0.44, 0.26), (0.8, 0.66, 0.44)), ((0.52, 0.38, 0.22), (0.74, 0.6, 0.38))),
                        scale=4, stretch=(1, 1, 9), bump=0.6)
    beam = beam_mat()
    earth_pad((0.0, -0.22, 0), 1.05, 1.15, seed=61)
    lib.tag(0)

    cx, cy, L, W, H, rh = -0.05, 0.08, 1.62, 0.98, 0.96, 0.6
    x0, x1, y0, y1 = cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2
    dx, dw, dh, rec = 0.05, 0.34, 0.58, 0.1        # the doorway and how deep it goes in
    wy, wzs, ww, wr = cy + 0.08, 0.56, 0.24, 0.12   # the side window: centre, springing, width, arch
    px0, px1, pyf, pr = dx - 0.34, dx + 0.34, y0 - 0.42, 0.16  # the threshold's curb
    hz = H * 0.48                                   # where the walls stand at stage 2
    cols = ((x0 - 0.04, y0 - 0.04, -1.4), (x1 + 0.04, y0 - 0.04, -math.pi / 4), (x1 + 0.04, y1 + 0.04, -0.2),
            (x0 - 0.04, y1 + 0.04, -math.pi / 4))
    corner_stakes(x0 - 0.05, x1 + 0.05, y0 - 0.05, y1 + 0.05)
    lib.tag(0, until=0)

    # Stage 1: footing, the curb's base, the column plinths, a timber frame to raise the walls round.
    lib.box((cx, cy, 0.03), (L + 0.08, W + 0.08, 0.06), blocks[2], bevel=0.015)

    def slab(grow, z0, z1, mat):  # the threshold's rounded slab, `grow` wider than the curb
        a, b, f, rr = px0 - grow, px1 + grow, pyf - grow, pr + grow
        outline = [(a, y0)]
        for ccx, a0 in ((a + rr, math.pi), (b - rr, 1.5 * math.pi)):
            outline += [(ccx + math.cos(a0 + k * math.pi / 24) * rr, f + rr + math.sin(a0 + k * math.pi / 24) * rr)
                        for k in range(13)]
        outline.append((b, y0))
        goods.prism(outline, z0, z1, mat, bevel=0.01)  # one mesh: a box and corner cylinders rendered black


    slab(0.06, 0.0, 0.05, blue[2])
    for (x, y, _) in cols:
        lib.box((x, y, 0.035), (0.25, 0.25, 0.07), blue[1], bevel=0.016)
    lib.tag(1)
    _b().timber_frame(cx, cy, L, W, H, rh, beam, axis='x')
    lib.tag(1, until=2)

    # Stage 2: the walls half up, the curb and the chequered threshold, the columns' bases.
    door_hole = ('y', dx - dw / 2 - 0.04, dx + dw / 2 + 0.04, 0.0, dh + 0.06)
    win_hole = ('x', wy - ww / 2 - 0.05, wy + ww / 2 + 0.05, wzs - 0.26, wzs + wr + 0.05)
    lib.box((cx, (y0 + rec + y1) / 2, hz / 2), (L, y1 - y0 - rec, hz), walls)
    for (a, b) in ((x0, dx - dw / 2), (dx + dw / 2, x1)):
        lib.box(((a + b) / 2, y0 + rec / 2, hz / 2), (b - a, rec, hz), walls)
    stone_course(x0, x1, y0, y1, 0.06, hz, blocks, rnd, block=0.105, depth=0.032, holes=(door_hole, win_hole))
    slab(0.0, 0.05, 0.075, blue[0])
    for (x, y, a) in rounded_outline(px0 + 0.035, px1 - 0.035, pyf + 0.035, y0 - 0.02, pr - 0.035, 0.085):
        lib.box((x, y, 0.1), (0.082, 0.075, 0.06), blue[rnd.randrange(len(blue))],
                rot=(0, 0, a + rnd.uniform(-0.05, 0.05)), bevel=0.014)

    def on_floor(x, y):
        if y > y0:  # in the doorway
            return dx - dw / 2 + 0.01 < x < dx + dw / 2 - 0.01
        if x < px0 + 0.07 or x > px1 - 0.07 or y < pyf + 0.07:
            return False
        for ccx in (px0 + pr, px1 - pr):
            outer = x < ccx if ccx < dx else x > ccx
            if y < pyf + pr and outer and math.hypot(x - ccx, y - pyf - pr) > pr - 0.07:
                return False
        return True
    checker_floor(px0 + 0.07, px1 - 0.07, pyf + 0.07, y0 + rec, on_floor, black, white, 0.082)
    lib.box((dx, y0 + rec - 0.004, dh / 2 + 0.04), (dw, 0.008, dh), inside)
    for (x, y, face) in cols:
        healer_column(x, y, H, hz, shaft, blue[0], white, red, darkstone, face, 'low')
    lib.tag(2)

    # Stage 3: the walls to the eaves, doorway, window, basins, the columns, the roof's rafters.
    lib.box((cx, (y0 + rec + y1) / 2, (hz + H) / 2), (L, y1 - y0 - rec, H - hz), walls)
    for (a, b) in ((x0, dx - dw / 2), (dx + dw / 2, x1)):
        lib.box(((a + b) / 2, y0 + rec / 2, (hz + H) / 2), (b - a, rec, H - hz), walls)
    lib.box((dx, y0 + rec / 2, (dh + 0.06 + H) / 2), (dw, rec, H - dh - 0.06), walls)
    stone_course(x0, x1, y0, y1, hz, H, blocks, rnd, block=0.105, depth=0.032, holes=(door_hole, win_hole))
    # The doorway: chunky light jambs, a lintel, the reveals.
    for s_ in (-1, 1):
        jx = dx + s_ * (dw / 2 + 0.035)
        lib.box((jx, y0 - 0.01, (dh + 0.06) / 2 + 0.04), (0.075, 0.1, dh + 0.02), pale[s_ % 2],
                rot=(0, s_ * 0.025, 0), bevel=0.014)
        lib.box((dx + s_ * (dw / 2 - 0.005), y0 + rec / 2, dh / 2 + 0.06), (0.012, rec, dh), walls)
    lib.box((dx, y0 - 0.015, dh + 0.1), (dw + 0.22, 0.11, 0.09), pale[0], rot=(0, -0.02, 0), bevel=0.016)
    lib.box((dx, y0 - 0.025, dh + 0.165), (dw + 0.14, 0.08, 0.04), pale[3], bevel=0.01)
    # The wash basins either side of the door.
    wall_basin((x0 + dx - dw / 2 - 0.07) / 2, y0 - 0.12, 0.42, pale[0], water, darkstone)
    wall_basin((dx + dw / 2 + 0.07 + x1) / 2, y0 - 0.12, 0.42, pale[0], water, darkstone)
    # The side window: shutters of light boards under a round head, jambs, voussoirs and a sill.
    nb = 4
    for k in range(nb):
        u = -ww / 2 + (k + 0.5) * ww / nb
        top = wzs + math.sqrt(max(wr * wr - u * u, 0.0))
        z0 = wzs - 0.22
        lib.box((x1 + 0.012, wy + u, (z0 + top) / 2), (0.02, ww / nb - 0.01, top - z0), shutter[k % 2], bevel=0.004)
    lib.box((x1 + 0.024, wy, wzs - 0.1), (0.01, ww, 0.02), beam)
    for s_ in (-1, 1):
        for k, z in enumerate((wzs - 0.18, wzs - 0.07)):
            lib.box((x1 + 0.03, wy + s_ * (ww / 2 + 0.04), z), (0.08, 0.08, 0.1), pale[(k + s_) % 4], bevel=0.012)
    for k in range(7):
        a = math.pi * k / 6
        R = wr + 0.04
        lib.box((x1 + 0.03, wy + math.cos(a) * R, wzs + math.sin(a) * R), (0.08, 0.075, 0.085), pale[k % 4],
                rot=(a - math.pi / 2, 0, 0), bevel=0.012)
    lib.box((x1 + 0.05, wy, wzs - 0.25), (0.1, ww + 0.16, 0.05), pale[0], bevel=0.012)
    for (x, y, face) in cols:
        healer_column(x, y, H, hz, shaft, blue[0], white, red, darkstone, face, 'high')
    lib.tag(3)
    faces, _, _ = hip_faces(cx, cy, L, W, H, rh, overhang=0.15, ridge_frac=0.42)
    for (a, b, p, q) in faces:
        face_rafters(a, b, p, q, beam)
    lib.tag(3, until=3)

    # Stage 4: the slate roof and the lantern on its ridge.
    hip_roof(cx, cy, L, W, H, rh, slates, ridge, rnd, overhang=0.15, size=0.15, shape='tile', ridge_frac=0.42)
    zr = H + rh
    lcx, lL, lw, Hl = cx - 0.06, 0.92, 0.5, zr + 0.06
    lib.box((lcx, cy, (zr - 0.36 + Hl) / 2), (lL, lw, Hl - zr + 0.36), walls)
    stone_course(lcx - lL / 2, lcx + lL / 2, cy - lw / 2, cy + lw / 2, zr - 0.34, Hl, pale, rnd, block=0.1,
                 depth=0.03)
    hip_roof(lcx, cy, lL, lw, Hl, 0.2, slates, ridge, rnd, overhang=0.07, size=0.14, shape='tile', ridge_frac=0.45)

    lib.tag(4)


def build_hunter():
    """A small timber hunting lodge: log walls under a plank roof, antlers over the door, hides
    stretched on a drying frame, a rack with bows and spears, a stump with a quiver."""
    B = _b()
    rnd = random.Random(71)
    logs, ends = logs_mat(), ends_mat()
    boards, beam = boards_mats(), beam_mat()
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    bone = lib.mat_flat('antler', (0.88, 0.82, 0.68), 0.6)
    hide = lib.mat_grain('hide', (0.5, 0.32, 0.18), (0.72, 0.52, 0.32), scale=8, stretch=(1, 1, 1), bump=0.5)
    fur = lib.mat_grain('fur', (0.32, 0.22, 0.14), (0.5, 0.36, 0.22), scale=24, stretch=(1, 1, 2), bump=0.9)
    string = lib.mat_flat('bstring', (0.9, 0.86, 0.72))
    earth_pad((0.05, -0.2, 0), 1.0, 1.1, seed=71)
    lib.tag(0)
    cx, cy, L, W, H, rh = -0.2, 0.2, 0.9, 0.8, 0.5, 0.36
    corner_stakes(cx - L / 2, cx + L / 2, cy - W / 2, cy + W / 2)
    lib.tag(0, until=0)
    B.timber_frame(cx, cy, L, W, H, rh, beam, axis='x')
    lib.tag(1, until=3)
    B.log_cabin(cx, cy, L, W, H, logs, ends, r=0.042, gable_h=rh, gable_axis='x', door=(cx + 0.1, 0.22, 0.34))
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.45 else 3)
    lib.box((cx + 0.1, cy - W / 2 + 0.03, 0.17), (0.2, 0.06, 0.34), dark)
    lib.tag(3)
    B.plank_roof(cx, cy, L, W, H, rh, boards, axis='x', seed=72)
    lib.tag(None, split=lambda o: 3 if o.location.y < cy - 0.05 else 4)
    # Antlers over the door: a skull plate and two branched beams.
    ax_, ay_, az = cx + 0.1, cy - W / 2 - 0.05, 0.47
    lib.sphere((ax_, ay_, az), 0.045, bone, scale=(1, 0.6, 1.2))
    for side in (-1, 1):
        a = (ax_ + side * 0.03, ay_, az + 0.03)
        b = (ax_ + side * 0.16, ay_ - 0.02, az + 0.16)
        rod(a, b, 0.012, bone)
        for t in (0.45, 0.8):
            p = (a[0] + (b[0] - a[0]) * t, a[1], a[2] + (b[2] - a[2]) * t)
            rod(p, (p[0] + side * 0.02, p[1] - 0.01, p[2] + 0.07), 0.009, bone)
    # Drying frame with two stretched hides, right of the lodge.
    fx, fy = cx + L / 2 + 0.38, cy - 0.15
    for dy in (-0.32, 0.32):
        lib.cylinder((fx, fy + dy, 0.3), 0.022, 0.6, beam, verts=8)
    rod((fx, fy - 0.32, 0.58), (fx, fy + 0.32, 0.58), 0.02, beam)
    for k, dy in enumerate((-0.15, 0.15)):
        lib.box((fx, fy + dy, 0.38), (0.02, 0.24, 0.3), hide if k else fur, rot=(rnd.uniform(-0.08, 0.08), 0, 0),
                bevel=0.01)
    # Rack of bows and spears by the door.
    rx, ry = cx - L / 2 - 0.02, cy - W / 2 - 0.3
    rod((rx - 0.2, ry, 0.36), (rx + 0.2, ry, 0.36), 0.018, beam)
    for x in (rx - 0.2, rx + 0.2):
        lib.cylinder((x, ry, 0.19), 0.018, 0.38, beam, verts=6)
    for k in range(3):
        bx = rx - 0.12 + k * 0.12
        torus((bx, ry - 0.02, 0.22), 0.15, 0.009, beam, rot=(math.pi / 2, 0, 0))
        rod((bx, ry - 0.025, 0.08), (bx, ry - 0.025, 0.36), 0.004, string)
    for k in range(2):
        rod((rx + 0.25 + k * 0.05, ry + 0.02, 0.0), (rx + 0.22 + k * 0.05, ry - 0.02, 0.55), 0.01, beam)
    # Stump with a quiver.
    lib.cylinder((cx + 0.45, cy - W / 2 - 0.35, 0.08), 0.09, 0.16, logs, verts=12)
    lib.cylinder((cx + 0.45, cy - W / 2 - 0.35, 0.163), 0.085, 0.006, ends, verts=12)
    lib.cylinder((cx + 0.47, cy - W / 2 - 0.33, 0.28), 0.04, 0.22, hide, rot=(0.2, 0.15, 0), verts=10)
    lib.tag(4)


def build_slaughterhouse():
    """The Settlers 4 Roman butcher's: a squat round house of squared blue-grey stone under a bulging
    skirt of red tiles that rises to a broad wooden top — a plank lid in a thick rim, crossed by two
    beams round a hatch. An arched stone porch with a wooden arch shelters the door; a small window
    at the side, a chopping block outside."""
    rnd = random.Random(101)
    walls = stone_walls()
    gb = grey_blocks('sgb')
    tiles = terracotta_mats('stc')
    door, beam = door_mat(), beam_mat()
    boards = boards_mats()
    logs, ends = logs_mat(), ends_mat()
    iron = lib.mat_flat('iron', (0.36, 0.37, 0.4), rough=0.35)
    glass = lib.mat_flat('sglass', (0.34, 0.46, 0.62), rough=0.2)
    lid = grain_set('slid', (((0.62, 0.4, 0.18), (0.86, 0.62, 0.32)), ((0.56, 0.36, 0.16), (0.8, 0.56, 0.28)),
                             ((0.66, 0.46, 0.22), (0.9, 0.68, 0.38))), scale=4, stretch=(1, 9, 1), bump=0.6)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    earth_pad((0.05, -0.2, 0), 1.0, 1.1, seed=101)
    lib.tag(0)
    cx, cy, R, H = 0.0, 0.18, 0.66, 0.5
    corner_stakes(cx - R, cx + R, cy - R, cy + R)
    lib.tag(0, until=0)
    lib.cylinder((cx, cy, 0.05), R + 0.05, 0.1, gb[1], verts=32)
    lib.tag(1)
    lib.cylinder((cx, cy, H / 2), R - 0.04, H, walls, verts=32)
    rows = 4
    rh = (H - 0.08) / rows
    for r in range(rows):
        z = 0.1 + (r + 0.5) * rh
        nb = 22
        for k in range(nb):
            a = (k + 0.5 * (r % 2)) / nb * math.tau + rnd.uniform(-0.03, 0.03)
            if math.cos(a + math.pi / 4) < -0.45:
                continue
            lib.box((cx + math.cos(a) * R, cy + math.sin(a) * R, z), (0.07, R * math.tau / nb * rnd.uniform(0.8, 0.94),
                    rh * rnd.uniform(0.8, 0.9)), gb[rnd.randrange(len(gb))], rot=(0, 0, a), bevel=0.012)
    lib.tag(None, split=lambda o: 2 if o.location.z < H * 0.55 else 3)
    # Window and the porch towards the door tile.
    wa = -0.35
    wx, wy = cx + math.cos(wa) * (R + 0.04), cy + math.sin(wa) * (R + 0.04)
    lib.box((wx, wy, 0.3), (0.03, 0.15, 0.13), glass, rot=(0, 0, wa))
    lib.box((wx + math.cos(wa) * 0.01, wy + math.sin(wa) * 0.01, 0.385), (0.04, 0.22, 0.04), gb[3], rot=(0, 0, wa))
    lib.box((wx + math.cos(wa) * 0.01, wy + math.sin(wa) * 0.01, 0.215), (0.04, 0.22, 0.04), gb[3], rot=(0, 0, wa))
    pa = -1.62
    ox, oy, tx, ty = math.cos(pa), math.sin(pa), -math.sin(pa), math.cos(pa)
    px, py = cx + ox * (R + 0.1), cy + oy * (R + 0.1)
    for side in (-1, 1):
        for k in range(3):
            lib.box((px + tx * side * 0.17, py + ty * side * 0.17, 0.07 + k * 0.1), (0.24, 0.1, 0.09),
                    gb[(k + side) % len(gb)], rot=(0, 0, pa), bevel=0.014)
    lib.box((px + ox * 0.02, py + oy * 0.02, 0.18), (0.06, 0.26, 0.34), dark, rot=(0, 0, pa))
    lib.box((px - ox * 0.08, py - oy * 0.08, 0.17), (0.03, 0.2, 0.32), door, rot=(0, 0, pa), bevel=0.006)
    for k in range(9):
        a = math.pi * k / 8
        r0 = 0.2
        u = (-math.sin(a) * tx, -math.sin(a) * ty, math.cos(a))
        for depth, size, mats in ((0.1, (0.08, 0.075, 0.06), boards), (-0.02, (0.08, 0.16, 0.07), gb)):
            p = (px + ox * depth + tx * math.cos(a) * r0, py + oy * depth + ty * math.cos(a) * r0, 0.34 + math.sin(a) * r0)
            place_on(lib.box((0, 0, 0), size, mats[k % len(mats)], bevel=0.01), p, u, (ox, oy, 0))
    lib.tag(3)
    # Bulging tile skirt up to the wooden top.
    prof = [(R + 0.1, H - 0.04), (R + 0.12, H + 0.06), (R + 0.06, H + 0.2), (R - 0.06, H + 0.3), (R - 0.18, H + 0.36)]
    lathe(cx, cy, prof, tiles[1], segs=40)
    lathe_tiles(cx, cy, prof, tiles, rnd, size=0.1, shape='tile', lift=0.02)
    tr = R - 0.15
    lib.tag(None, split=lambda o: 3 if o.location.z < H + 0.14 else 4)
    lib.cylinder((cx, cy, H + 0.38), tr + 0.04, 0.09, beam, verts=40)
    torus((cx, cy, H + 0.43), tr + 0.02, 0.035, boards[0])
    for k in range(7):
        t = -tr + (k + 0.5) * 2 * tr / 7
        w = 2 * math.sqrt(max(0.0, tr ** 2 - t ** 2)) - 0.02
        lib.box((cx + t * 0.7071, cy - t * 0.7071, H + 0.43), (2 * tr / 7 - 0.022, w, 0.025), lid[k % len(lid)],
                rot=(0, 0, -math.pi / 4), bevel=0.004)
    for ang in (math.pi / 4 + 0.35, math.pi / 4 - 0.35):
        lib.box((cx, cy, H + 0.465), (2 * tr, 0.06, 0.04), beam, rot=(0, 0, ang), bevel=0.006)
    lib.box((cx, cy, H + 0.48), (0.2, 0.16, 0.04), boards[2], rot=(0, 0, math.pi / 4), bevel=0.006)
    lib.box((cx, cy, H + 0.505), (0.04, 0.12, 0.02), iron, rot=(0, 0, math.pi / 4))
    lib.tag(4)
    # Chopping block with a cleaver.
    bx, by = cx + 0.62, cy - R - 0.3
    lib.cylinder((bx, by, 0.08), 0.1, 0.16, logs, verts=12)
    lib.cylinder((bx, by, 0.163), 0.095, 0.006, ends, verts=12)
    lib.box((bx + 0.01, by - 0.02, 0.21), (0.11, 0.015, 0.07), iron, rot=(0, 0.3, 0.4))
    lib.tag(4)



# ------------------------------------------------------------------------------------- Roman houses, bakery,
# yard and barracks after the original's cut-outs (third pass): the medium and large residences, the
# bakery, the storage yard and the barracks. Own models after the impression of the Settlers 4 Romans.

def face_rafters(e0, e1, r0, r1, beam, step=0.24, r=0.017, battens=(0.3, 0.64)):
    """The bare skeleton of one roof face (eave e0→e1 up to ridge r0→r1, as `tile_face` takes it):
    rafters every `step` and battens across them — a roof under construction."""
    from mathutils import Vector

    e0, e1, r0, r1 = (Vector(p) for p in (e0, e1, r0, r1))
    n = max(2, round((e1 - e0).length / step))
    for k in range(n + 1):
        s = k / n
        rod(e0.lerp(e1, s), r0.lerp(r1, s), r, beam, verts=6)
    for t in battens:
        a, b = e0.lerp(r0, t), e1.lerp(r1, t)
        if (b - a).length > 0.05:
            rod(a, b, r * 0.8, beam, verts=6)


def gable_faces(cx, cy, L, W, H, rh, axis='x', overhang=0.1):
    """The two slopes of a gable roof (ridge along `axis`) as (eave start, eave end, ridge start, ridge
    end), the way `tile_face` and `face_rafters` take them."""
    along, across = (L, W) if axis == 'x' else (W, L)
    a, c = along / 2 + overhang, across / 2 + overhang
    z0 = H - overhang * rh / (across / 2)

    def at(t, u, z):
        return (cx + t, cy + u, z) if axis == 'x' else (cx + u, cy + t, z)

    return [(at(-a, -c, z0), at(a, -c, z0), at(-a, 0, H + rh), at(a, 0, H + rh)),
            (at(a, c, z0), at(-a, c, z0), at(a, 0, H + rh), at(-a, 0, H + rh))]


def pale_blocks(prefix='pb'):
    """Light, warm sandstone of the Roman gables and the bakery's upper walls, a greenish one among them."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=7, stretch=(1, 1, 1), bump=1.0) for k, (a, b) in enumerate((
        ((0.58, 0.54, 0.42), (0.86, 0.82, 0.66)),
        ((0.5, 0.52, 0.42), (0.76, 0.79, 0.64)),
        ((0.62, 0.56, 0.44), (0.9, 0.84, 0.7)),
        ((0.46, 0.46, 0.4), (0.7, 0.7, 0.6)),
    ))]


def sky_slates(prefix='ss'):
    """The light, sky-blue slate tiles of the Settlers 4 Roman barracks."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.26, 0.42, 0.56), (0.46, 0.64, 0.78)),
        ((0.3, 0.48, 0.62), (0.52, 0.7, 0.84)),
        ((0.22, 0.36, 0.5), (0.38, 0.54, 0.68)),
        ((0.34, 0.5, 0.6), (0.56, 0.72, 0.8)),
    ))]


def dark_slates(prefix='ds'):
    """The dark blue-grey slate scales of the Roman residences."""
    return [lib.mat_grain(f'{prefix}{k}', a, b, scale=10, stretch=(1, 1, 1), bump=0.5) for k, (a, b) in enumerate((
        ((0.17, 0.2, 0.27), (0.32, 0.37, 0.46)),
        ((0.22, 0.26, 0.34), (0.4, 0.45, 0.55)),
        ((0.13, 0.15, 0.2), (0.25, 0.28, 0.35)),
        ((0.24, 0.3, 0.4), (0.44, 0.52, 0.64)),
    ))]


def stepped_wall(x, y0, y1, H, top, mats, rnd, steps=5, t=0.16):
    """A crow-stepped stone gable wall standing in the plane x (spanning y0..y1, from the ground up to
    `top`): each step a course a little narrower than the one under it, capped by coping stones."""
    yc, hw = (y0 + y1) / 2, (y1 - y0) / 2
    dz = (top - H) / steps
    lib.box((x, yc, H / 2 + 0.01), (t, y1 - y0, H), mats[0], bevel=0.015)
    for k in range(steps):
        w = hw * (1 - k / steps)
        z = H + (k + 0.5) * dz
        lib.box((x, yc, z), (t, 2 * w, dz * 0.96), mats[rnd.randrange(len(mats))], bevel=0.015)
        for side in (-1, 1):
            lib.box((x, yc + side * (w - 0.06), z + dz / 2 + 0.03), (t + 0.05, 0.16, 0.07), mats[rnd.randrange(len(mats))],
                    rot=(0, 0, rnd.uniform(-0.04, 0.04)), bevel=0.015)
    lib.box((x, yc, top + 0.05), (t + 0.06, 0.2, 0.1), mats[0], bevel=0.02)


def eagle(cx, cy, z, s, gold):
    """The Roman eagle in gilded relief lying on the yard's centre disc: wings spread and raised, head
    turned, tail fanned; upright on the screen (its head towards world −X+Y)."""
    from mathutils import Vector

    up = Vector((-math.sqrt(0.5), math.sqrt(0.5), 0))  # away from the camera: the top of the screen
    right = Vector((math.sqrt(0.5), math.sqrt(0.5), 0))
    yaw = math.atan2(up.y, up.x) - math.pi / 2

    def at(a, b, h=0.0):
        p = Vector((cx, cy, z)) + (right * a + up * b) * s
        return (p.x, p.y, p.z + h * s)

    def flat(a, b, size, ang, h=0.0):
        # A feather or plate lying on the disc, its long side at screen angle `ang` (0 = right, π/2 = up).
        o = lib.box(at(a, b, h), (size[0] * s, size[1] * s, size[2] * s), gold, bevel=0.01 * s)
        o.rotation_euler = (0, 0, yaw + ang)
        return o

    body = lib.sphere(at(0, -0.05, 0.05), 0.1 * s, gold, scale=(0.75, 1.25, 0.45))
    body.rotation_euler = (0, 0, yaw)
    lib.sphere(at(0.0, 0.14, 0.07), 0.075 * s, gold, scale=(0.9, 0.9, 0.6))
    lib.sphere(at(0.05, 0.25, 0.08), 0.058 * s, gold, scale=(1.1, 0.9, 0.7))
    beak = lib.cylinder(at(0.12, 0.24, 0.08), 0.022 * s, 0.07 * s, gold, verts=8, radius2=0.002 * s)
    beak.rotation_euler = (0, math.pi / 2, yaw)
    for side in (-1, 1):
        # Coverts along the arm, then the long flight feathers fanning out and up.
        flat(side * 0.15, 0.1, (0.24, 0.1, 0.07), math.pi / 2 - side * 1.15, 0.03)
        for k in range(6):
            ang = math.radians(78 - k * 17)
            length = 0.34 + 0.05 * math.sin(k / 5 * math.pi)
            a = side * (0.2 + math.cos(ang) * length / 2)
            b = 0.12 - k * 0.025 + math.sin(ang) * length / 2
            flat(a, b, (length, 0.075, 0.045), (math.pi - ang) if side < 0 else ang, 0.01 * (k % 2))
    for k in range(4):
        ang = -math.pi / 2 + (k - 1.5) * 0.28
        flat(math.cos(ang) * 0.27, -0.12 + math.sin(ang) * 0.17, (0.2, 0.07, 0.04), ang, 0.01 * (k % 2))
    for side in (-1, 1):
        flat(side * 0.06, -0.2, (0.05, 0.1, 0.05), math.pi / 2, 0.02)


def build_warehouse():
    """The Roman storage yard (Settlers 4's Lagerplatz): an open round platform of big, chunky setts in
    concentric rings — slate blue, grey and rose-brown, each its own height and tilt, dark joints between
    — round a green disc with the gilded Roman eagle, wings spread. The game stacks the stored goods on
    the ring (`syncYard`, at about two thirds of the radius)."""
    rnd = random.Random(81)
    setts = grain_set('sett', (
        ((0.24, 0.26, 0.32), (0.42, 0.44, 0.52)),
        ((0.34, 0.36, 0.42), (0.56, 0.58, 0.64)),
        ((0.4, 0.33, 0.32), (0.62, 0.52, 0.5)),
        ((0.28, 0.27, 0.29), (0.48, 0.46, 0.47)),
        ((0.46, 0.46, 0.48), (0.68, 0.68, 0.7)),
    ), scale=8, bump=0.9)
    joint = lib.mat_flat('joints', (0.16, 0.15, 0.15))
    green = lib.mat_grain('disc', (0.3, 0.5, 0.1), (0.56, 0.74, 0.22), scale=5, stretch=(1, 1, 1), bump=0.3)
    gold = lib.mat_grain('eagle', (0.78, 0.56, 0.1), (0.98, 0.82, 0.3), scale=14, stretch=(1, 1, 1), bump=0.3)
    earth_pad((0.0, -0.1, 0), 1.06, 1.08, seed=81)
    lib.tag(0)
    corner_stakes(-0.95, 0.95, -0.95, 0.95)
    lib.tag(0, until=0)

    def ring(r0, r1, n, stage):
        rr = (r0 + r1) / 2
        for k in range(n):
            a = (k + rnd.uniform(-0.1, 0.1)) / n * math.tau
            o = lib.box((math.cos(a) * rr, math.sin(a) * rr, 0.06 + rnd.uniform(-0.006, 0.01)),
                        (rr * math.tau / n * rnd.uniform(0.78, 0.9), (r1 - r0) * rnd.uniform(0.8, 0.9), 0.07),
                        setts[rnd.randrange(len(setts))], bevel=0.022)
            o.rotation_euler = (rnd.uniform(-0.05, 0.05), rnd.uniform(-0.05, 0.05), a + math.pi / 2 + rnd.uniform(-0.08, 0.08))
        lib.tag(stage)

    lib.cylinder((0, 0, 0.025), 1.02, 0.05, joint, verts=64)
    lib.tag(1)
    rings = ((0.89, 1.02, 44), (0.78, 0.89, 39), (0.67, 0.78, 34), (0.57, 0.67, 29), (0.48, 0.57, 25), (0.395, 0.48, 21))
    for k, (r0, r1, n) in enumerate(rings):
        ring(r0, r1, n, 1 + k // 2)
    lib.cylinder((0, 0, 0.055), 0.39, 0.05, joint, verts=48)
    lib.cylinder((0, 0, 0.065), 0.375, 0.06, green, verts=48, bevel=0.012)
    lib.tag(3)
    eagle(0.0, 0.0, 0.1, 0.7, gold)
    lib.tag(4)


def build_bakery():
    """The Roman bakery: two stone houses under bright terracotta — a tall one behind (ridge along X,
    its gable to the right) of pale, greenish stone above a blue-grey ground floor, and a lower one in
    front on the left (ridge along Y) with a big light window in its gable; between them on the right a
    dark plank lean-to with the door, and in front of it the bake oven: a drum of wooden staves on
    iron hoops lying on a stone plinth, its glowing mouth to the right, a square stone chimney on top."""
    rnd = random.Random(61)
    walls = stone_walls()
    blocks = grey_blocks('bkb')
    pale = pale_blocks('bkp')
    beam = beam_mat()
    planks = boards_mats()
    staves = grain_set('stave', (((0.42, 0.26, 0.1), (0.66, 0.44, 0.2)), ((0.5, 0.32, 0.12), (0.74, 0.52, 0.26)),
                                 ((0.36, 0.22, 0.09), (0.56, 0.38, 0.17))), scale=6, stretch=(1, 1, 8), bump=0.8)
    tiles = terracotta_mats('bktc')
    ridge = lib.mat_flat('bktc-r', (0.66, 0.24, 0.1))
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.35)
    door = door_mat()
    white = lib.mat_flat('bk-window', (0.86, 0.88, 0.86), rough=0.5)
    embers = lib.mat_flat('embers', (1.0, 0.72, 0.22), rough=0.6)
    earth_pad((0.05, -0.25, 0), 1.06, 1.15, seed=61)
    lib.tag(0)

    # Back house (ridge along X), front house (ridge along Y), lean-to, oven.
    bx0, bx1, by0, by1, bH, brh = -0.42, 0.5, -0.12, 0.92, 1.02, 0.48
    fx0, fx1, fy0, fy1, fH, frh = -0.95, -0.08, -0.95, 0.2, 0.62, 0.42
    lx0, lx1, ly0, ly1, lH0, lH1 = -0.08, 0.5, -0.62, -0.12, 0.46, 0.66
    oy, ox0, ox1, orr = -0.5, 0.5, 0.98, 0.27
    corner_stakes(fx0, ox1, fy0, by1)
    lib.tag(0, until=0)
    for (x0, x1, y0, y1), h in (((bx0, bx1, by0, by1), 0.1), ((fx0, fx1, fy0, fy1), 0.09)):  # no coplanar overlap
        lib.box(((x0 + x1) / 2, (y0 + y1) / 2, h / 2), (x1 - x0 + 0.06, y1 - y0 + 0.06, h), blocks[1], bevel=0.02)
    lib.box(((ox0 + ox1) / 2, oy, 0.06), (ox1 - ox0 + 0.04, 2 * orr + 0.1, 0.12), blocks[0], bevel=0.02)
    lib.tag(1)
    _b().timber_frame((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0, by1 - by0, bH, brh, beam, axis='x')
    _b().timber_frame((fx0 + fx1) / 2, (fy0 + fy1) / 2, fx1 - fx0, fy1 - fy0, fH, frh, beam, axis='y')
    lib.tag(1, until=2)

    stone_house(bx0, bx1, by0, by1, bH * 0.42, rnd, walls, blocks, block=0.17)
    quoins(bx0, bx1, by0, by1, 0.02, bH * 0.42, blocks, rnd, block=0.2, row=0.15)
    stone_house(fx0, fx1, fy0, fy1, fH * 0.55, rnd, walls, blocks, block=0.17)
    quoins(fx0, fx1, fy0, fy1, 0.02, fH * 0.55, blocks, rnd, block=0.2, row=0.15)
    # The oven's plinth.
    lib.box(((ox0 + ox1) / 2, oy, 0.17), (ox1 - ox0, 2 * orr + 0.04, 0.12), walls)
    stone_course(ox0, ox1, oy - orr - 0.02, oy + orr + 0.02, 0.12, 0.23, blocks, rnd, block=0.14, depth=0.04)
    lib.tag(2)

    # Upper walls: pale stone on the back house, grey on the front one; gables and windows.
    stone_house(bx0, bx1, by0, by1, bH, rnd, walls, pale, z0=bH * 0.42, block=0.16)
    quoins(bx0, bx1, by0, by1, bH * 0.42, bH, pale, rnd, block=0.2, row=0.15)
    lib.gable(((bx0 + bx1) / 2, (by0 + by1) / 2, bH), by1 - by0, brh - 0.02, bx1 - 0.01, walls, along='x')
    stone_course(bx1 - 0.02, bx1, by0 + 0.12, by1 - 0.12, bH, bH + brh * 0.45, pale, rnd, block=0.15, faces=('x',))
    stone_house(fx0, fx1, fy0, fy1, fH, rnd, walls, blocks, z0=fH * 0.55, block=0.17)
    quoins(fx0, fx1, fy0, fy1, fH * 0.55, fH, blocks, rnd, block=0.2, row=0.15)
    lib.gable(((fx0 + fx1) / 2, (fy0 + fy1) / 2, fH), fx1 - fx0, frh - 0.02, fy0 + 0.01, walls, along='y')
    stone_course(fx0 + 0.12, fx1 - 0.12, fy0, fy0 + 0.02, fH, fH + frh * 0.4, blocks, rnd, block=0.15, faces=('y',))
    window((fx0 + fx1) / 2, fy0 - 0.05, fH * 0.5, 0.3, 0.26, beam, white)
    window((fx0 + fx1) / 2, fy0 - 0.03, fH + frh * 0.35, 0.12, 0.12, beam, dark)
    window(fx1 + 0.05, -0.55, 0.3, 0.14, 0.16, beam, dark, face='x')
    window(0.22, by0 - 0.05, bH * 0.76, 0.16, 0.18, beam, dark)
    window(bx1 + 0.05, 0.4, bH * 0.74, 0.16, 0.18, beam, white, face='x')
    window(bx1 + 0.05, 0.4, bH + brh * 0.32, 0.11, 0.11, beam, dark, face='x')
    # The lean-to: dark planks, the door.
    plank_walls(lx0, lx1, ly0, ly1, 0.0, lH0, planks[1:2] + planks[3:], dark, beam, rnd, faces=('y',))
    plank_door(0.25, ly0 - 0.035, 0.0, 0.22, 0.4, door, dark, iron, beam)
    lib.tag(3)

    scale_roof((bx0 + bx1) / 2, (by0 + by1) / 2, bx1 - bx0, by1 - by0, bH, brh, tiles, ridge, axis='x',
               overhang=0.1, seed=62, size=0.15, shape='tile')
    lib.tag(None, split=lambda o: 3 if o.location.y < (by0 + by1) / 2 else 4)
    scale_roof((fx0 + fx1) / 2, (fy0 + fy1) / 2, fx1 - fx0, fy1 - fy0, fH, frh, tiles, ridge, axis='y',
               overhang=0.09, seed=63, size=0.15, shape='tile')
    # The lean-to's roof: tiles from the back house's wall down over the planks.
    run = math.hypot(ly1 - ly0 + 0.12, lH1 - lH0)
    tilt = math.atan2(lH1 - lH0, ly1 - ly0 + 0.12)
    lib.box(((lx0 + lx1) / 2, (ly0 + ly1) / 2 - 0.06, (lH0 + lH1) / 2), (lx1 - lx0 + 0.1, run, 0.04), tiles[0],
            rot=(tilt, 0, 0))
    tile_face((lx0 - 0.05, ly0 - 0.12, lH0), (lx1 + 0.05, ly0 - 0.12, lH0), (lx0 - 0.05, ly1, lH1 + 0.01),
              (lx1 + 0.05, ly1, lH1 + 0.01), tiles, rnd, size=0.14, shape='tile', lift=0.025)
    # The oven: a drum of staves on iron hoops, closed at the back, its mouth glowing at the +X end.
    n = 16
    for k in range(n + 1):
        th = math.radians(-12) + math.radians(192) * k / n
        y, z = oy - math.cos(th) * orr, 0.23 + math.sin(th) * orr
        st = lib.box(((ox0 + ox1) / 2, y, z), (ox1 - ox0 - 0.02, 0.07, 0.04), staves[k % len(staves)], bevel=0.008)
        st.rotation_euler = (math.pi / 2 - th, 0, 0)
    for x in (ox0 + 0.08, (ox0 + ox1) / 2, ox1 - 0.08):
        torus((x, oy, 0.23), orr + 0.015, 0.014, iron, rot=(0, math.pi / 2, 0))
    lib.cylinder((ox1 - 0.005, oy, 0.23), orr, 0.03, staves[2], rot=(0, math.pi / 2, 0), verts=24)
    lib.cylinder((ox1 + 0.012, oy, 0.2), 0.13, 0.012, embers, rot=(0, math.pi / 2, 0), verts=20)
    lib.box((ox1 + 0.012, oy, 0.14), (0.012, 0.26, 0.12), embers)
    for k in range(7):
        a = math.pi * k / 6
        lib.box((ox1 + 0.025, oy + math.cos(a) * 0.16, 0.2 + math.sin(a) * 0.16), (0.04, 0.07, 0.06), blocks[k % 4],
                rot=(-a + math.pi / 2, 0, 0), bevel=0.01)
    note_fx('bakery', 'glow', (ox1 + 0.08, oy, 0.17))
    chimney(ox0 + 0.14, oy + 0.08, 0.36, 1.0, blocks, rnd, name='bakery')
    lib.box((ox0 + 0.14, oy + 0.08, 1.04), (0.1, 0.1, 0.03), dark)
    # A sack of flour by the door.
    sack = lib.lumpy((-0.02, ly0 - 0.2, 0.09), 0.08, white, scale=(0.9, 0.8, 1.2), strength=0.2, seed=6)
    sack.rotation_euler = (0.1, 0, 0.3)
    lib.tag(4)


def build_house_large_blocks():
    """Three joined blocks (since scaled down into the medium residence, `build_house_large` below
    is the new large one): on the left a two-storey
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




def build_house_medium():
    """The medium residence: our three-block house (half-timbered wing under slate, a dark stone block
    under terracotta, a stone annex under slate), scaled to a 2×2 footprint."""
    build_house_large_blocks()
    scale_scene(0.66)


def build_house_large():
    """The large residence (3×3): a two-storey fieldstone house, ridge along X under blue-grey slate
    scales, a crow-stepped west gable; a half-timbered oriel on timber legs in front with teal
    windows under its own terracotta gable; a round corner turret under a slate cone; a ball finial."""
    rnd = random.Random(171)
    walls = stone_walls()
    blocks = block_mats()
    beam = lib.mat_grain('timber', (0.24, 0.15, 0.06), (0.42, 0.28, 0.12), scale=5, stretch=(1, 1, 8), bump=0.6)
    plaster = lib.mat_stones('plaster', (0.88, 0.8, 0.66), (0.72, 0.64, 0.5), (0.6, 0.52, 0.4), scale=6, bump=0.3)
    slates = slate_mats()
    tiles = terracotta_mats('ltc')
    sl_ridge = lib.mat_flat('sl-ridge', (0.22, 0.29, 0.42))
    tc_ridge = lib.mat_flat('tc-ridge', (0.62, 0.26, 0.1))
    teal = lib.mat_flat('teal', (0.2, 0.5, 0.52), rough=0.5)
    glass = lib.mat_flat('glass', (0.36, 0.56, 0.62), rough=0.2)
    door = door_mat()
    earth_pad((0.15, -0.3, 0), 1.45, 1.5, seed=171)
    lib.tag(0)
    x0, x1, y0, y1, H, rh = -1.15, 1.15, -0.5, 1.05, 1.0, 0.58
    ox0, ox1, oy0, oy1, oz0, oH, orh = -0.38, 0.38, -0.98, y0, 0.3, 0.98, 0.42
    tx, ty, tr, tH = x0 + 0.05, y0 - 0.02, 0.3, H + 0.18
    corner_stakes(x0 - 0.1, x1, y0 - 0.55, y1)
    lib.tag(0, until=0)
    lib.box(((x0 + x1) / 2, (y0 + y1) / 2, 0.05), (x1 - x0 + 0.06, y1 - y0 + 0.06, 0.1), blocks[1], bevel=0.02)
    _b().timber_frame((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, beam, axis='x')
    lib.tag(1, until=3)
    stone_house(x0, x1, y0, y1, H * 0.5, rnd, walls, blocks, block=0.22)
    quoins(x0, x1, y0, y1, 0.02, H * 0.5, blocks, rnd, block=0.26, row=0.2)
    round_tower(tx, ty, tr, 0.0, tH * 0.5, walls, blocks, rnd, rows=3)
    lib.tag(2)
    stone_house(x0, x1, y0, y1, H, rnd, walls, blocks, z0=H * 0.5, block=0.22)
    quoins(x0, x1, y0, y1, H * 0.5, H, blocks, rnd, block=0.26, row=0.2)
    round_tower(tx, ty, tr, tH * 0.5, tH, walls, blocks, rnd, rows=3)
    lib.gable(((x0 + x1) / 2, (y0 + y1) / 2, H), y1 - y0, rh - 0.02, x1 - 0.01, walls, along='x')
    lib.gable(((x0 + x1) / 2, (y0 + y1) / 2, H), y1 - y0, rh - 0.02, x0 + 0.01, walls, along='x')
    arch_door(0.92, y0 - 0.02, 0.0, 0.26, 0.48, door, blocks)
    for wx in (-0.75, 0.55):
        mullion_window(wx, y0 - 0.05, H * 0.72, 0.17, 0.2, teal, glass)
    for wz in (H * 0.28, H * 0.72):
        mullion_window(x1 + 0.05, 0.3, wz, 0.17, 0.2, teal, glass, face='x')
    mullion_window(tx + 0.05, ty - tr - 0.02, tH * 0.7, 0.12, 0.16, teal, glass)
    # The oriel on its legs.
    for x in (ox0 + 0.04, ox1 - 0.04):
        lib.box((x, oy0 + 0.04, oz0 / 2), (0.07, 0.07, oz0), beam, bevel=0.01)
    half_timber(ox0, ox1, oy0, oy1, oz0, oH, plaster, beam, rnd)
    for wx in (ox0 + 0.2, ox1 - 0.2):
        mullion_window(wx, oy0 - 0.04, (oz0 + oH) / 2 + 0.05, 0.15, 0.22, teal, glass)
    mullion_window(ox1 + 0.04, (oy0 + oy1) / 2, (oz0 + oH) / 2 + 0.05, 0.15, 0.22, teal, glass, face='x')
    lib.gable(((ox0 + ox1) / 2, (oy0 + oy1) / 2, oH), ox1 - ox0, orh - 0.02, oy0 + 0.005, plaster, along='y')
    lib.tag(3)
    scale_roof((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0, H, rh, slates, sl_ridge, axis='x', overhang=0.1,
               seed=172, size=0.15)
    lib.tag(None, split=lambda o: 3 if o.location.y < (y0 + y1) / 2 else 4)
    scale_roof((ox0 + ox1) / 2, (oy0 + oy1) / 2 - 0.05, ox1 - ox0, oy1 - oy0 + 0.25, oH, orh, tiles, tc_ridge, axis='y',
               overhang=0.08, seed=173, size=0.11, shape='tile')
    stepped_gable_x((y0 + y1) / 2, x0 - 0.02, y1 - y0, H, rh, blocks, rnd, steps=4)
    cone_tiles(tx, ty, tH, tr + 0.08, 0.55, slates, rnd, size=0.11, shape='scale')
    lib.sphere((tx, ty, tH + 0.6), 0.04, sl_ridge)
    lib.sphere(((x0 + x1) / 2 + 0.4, (y0 + y1) / 2, H + rh + 0.1), 0.05, sl_ridge)
    lib.tag(4)


def build_barracks():
    """The Roman barracks (3×3): a square hall of big pale-grey squared stones, rugged blocks along the
    wall top, under a low hipped roof of sky-blue slate tiles, and on it a square stone upper storey
    under a steep pyramid of the same tiles; a dark red double door studded with iron; in front a drill
    yard of mossy flagstones between low stone walls, with a gallows-pell and its straw-yellow dummy, a
    round target on a stand and swords lying on the stones."""
    rnd = random.Random(181)
    walls = stone_walls()
    blocks = grain_set('bkb', (((0.4, 0.42, 0.45), (0.7, 0.72, 0.74)), ((0.46, 0.47, 0.48), (0.78, 0.79, 0.8)),
                               ((0.34, 0.36, 0.4), (0.6, 0.62, 0.66)), ((0.5, 0.5, 0.48), (0.82, 0.81, 0.78))),
                       scale=7, bump=1.0)
    beam = beam_mat()
    slates = sky_slates('bsl')
    ridge = lib.mat_flat('bsl-r', (0.3, 0.46, 0.6))
    door = lib.mat_grain('bdoor', (0.34, 0.12, 0.07), (0.52, 0.22, 0.12), scale=4, stretch=(1, 1, 9), bump=0.6)
    iron = lib.mat_flat('iron', (0.2, 0.2, 0.22), rough=0.35)
    steel = lib.mat_flat('steel', (0.7, 0.72, 0.76), rough=0.3)
    dark = lib.mat_flat('dark', (0.05, 0.04, 0.03))
    straw = thatch_mat('dummy')
    rings = lib.mat_flat('target-ring', (0.45, 0.22, 0.08))
    flags = grain_set('bflag', (((0.3, 0.34, 0.28), (0.5, 0.56, 0.46)), ((0.34, 0.36, 0.34), (0.56, 0.58, 0.54)),
                                ((0.26, 0.32, 0.22), (0.42, 0.52, 0.34))), scale=8, bump=0.8)
    moss = lib.mat_grain('moss', (0.16, 0.3, 0.08), (0.34, 0.5, 0.14), scale=12, stretch=(1, 1, 1), bump=0.6)
    earth_pad((0.0, -0.2, 0), 1.52, 1.58, seed=181)
    lib.tag(0)
    corner_stakes(-1.45, 1.4, -1.45, 1.4)
    lib.tag(0, until=0)
    x0, x1, y0, y1, H = -0.42, 1.28, -0.48, 1.25, 1.3
    ux0, ux1, uy0, uy1, uH = 0.12, 0.88, 0.04, 0.8, 2.2
    hcx, hcy = (x0 + x1) / 2, (y0 + y1) / 2
    lib.box((hcx, hcy, 0.05), (x1 - x0 + 0.08, y1 - y0 + 0.08, 0.1), blocks[2], bevel=0.02)
    # Yard: a bed under the flagstones.
    lib.box((0.0, -0.98, 0.012), (2.9, 1.0, 0.024), walls)
    lib.box((-0.94, 0.4, 0.012), (1.02, 1.8, 0.024), walls)
    lib.tag(1)
    for x in (x0, (x0 + x1) / 2, x1):
        for y in (y0, y1):
            lib.box((x, y, H / 2), (0.07, 0.07, H), beam)
    lib.box((x0, hcy, H / 2), (0.07, 0.07, H), beam)
    lib.box((x1, hcy, H / 2), (0.07, 0.07, H), beam)
    for (a, b) in (((x0, y0), (x1, y0)), ((x1, y0), (x1, y1)), ((x1, y1), (x0, y1)), ((x0, y1), (x0, y0))):
        rod((a[0], a[1], H), (b[0], b[1], H), 0.035, beam, verts=6)
    lib.tag(1, until=2)

    stone_house(x0, x1, y0, y1, H * 0.45, rnd, walls, blocks, block=0.26)
    quoins(x0, x1, y0, y1, 0.02, H * 0.45, blocks, rnd, block=0.3, row=0.2)

    def flags_in(xa, xb, ya, yb):
        nx, ny = max(1, round((xb - xa) / 0.25)), max(1, round((yb - ya) / 0.22))
        for j in range(ny):
            for i in range(nx):
                x = xa + (i + 0.5 + (0.25 if j % 2 else -0.25)) * (xb - xa) / nx
                if x > xb - 0.05 or x < xa + 0.05:
                    continue
                y = ya + (j + 0.5) * (yb - ya) / ny
                lib.box((x + rnd.uniform(-0.02, 0.02), y + rnd.uniform(-0.02, 0.02), 0.03),
                        ((xb - xa) / nx * rnd.uniform(0.78, 0.92), (yb - ya) / ny * rnd.uniform(0.78, 0.9), 0.035),
                        flags[rnd.randrange(len(flags))], rot=(0, 0, rnd.uniform(-0.12, 0.12)), bevel=0.012)
    flags_in(-1.38, 1.38, -1.46, -0.5)
    flags_in(-1.38, x0 - 0.06, -0.5, 1.28)
    for k in range(14):
        lib.lumpy((rnd.uniform(-1.3, 1.2), rnd.uniform(-1.4, -0.6), 0.04), rnd.uniform(0.04, 0.08), moss,
                  scale=(1.3, 1.0, 0.25), strength=0.4, seed=k)
    # Low walls on both sides of the yard.
    for (xa, ya, xb, yb) in ((-1.44, 1.25, -1.44, -1.42), (1.42, y0 - 0.05, 1.42, -1.38)):
        n = max(2, round(math.hypot(xb - xa, yb - ya) / 0.24))
        for k in range(n):
            t = (k + 0.5) / n
            px, py = xa + (xb - xa) * t, ya + (yb - ya) * t
            for z, hz in ((0.08, 0.15), (0.22, 0.13)):
                lib.box((px, py, z), (0.2, 0.24 if k % 2 == 0 else 0.22, hz), blocks[rnd.randrange(len(blocks))],
                        rot=(0, 0, rnd.uniform(-0.08, 0.08)), bevel=0.02)
            if k % 2 == 0:
                lib.box((px, py, 0.33), (0.22, 0.24, 0.1), blocks[rnd.randrange(len(blocks))], bevel=0.02)
    lib.tag(2)

    stone_house(x0, x1, y0, y1, H, rnd, walls, blocks, z0=H * 0.45, block=0.26)
    quoins(x0, x1, y0, y1, H * 0.45, H, blocks, rnd, block=0.3, row=0.2)
    battlements(x0 + 0.06, x1 - 0.06, y0 + 0.06, y1 - 0.06, H, blocks, rnd, size=0.2, h=0.16)
    for (x, y) in ((x0 + 0.08, y0 + 0.08), (x1 - 0.08, y0 + 0.08), (x1 - 0.08, y1 - 0.08), (x0 + 0.08, y1 - 0.08)):
        lib.box((x, y, H + 0.1), (0.24, 0.24, 0.2), blocks[rnd.randrange(len(blocks))], bevel=0.025)
    # The double door under a stone arch, the windows.
    dxc, dw, dh = 0.9, 0.52, 0.74
    for s_ in (-1, 1):
        lib.box((dxc + s_ * dw / 4, y0 - 0.04, dh / 2), (dw / 2 - 0.015, 0.04, dh), door, bevel=0.008)
        for z in (0.14, 0.36, 0.56):
            lib.box((dxc + s_ * dw / 4, y0 - 0.065, z), (dw / 2 - 0.04, 0.012, 0.03), iron)
            for k in range(3):
                lib.sphere((dxc + s_ * dw / 4 + (k - 1) * 0.06, y0 - 0.075, z), 0.012, iron, subdiv=1)
    for k in range(9):
        a = math.pi * k / 8
        lib.box((dxc + math.cos(a) * (dw / 2 + 0.06), y0 - 0.07, dh + math.sin(a) * 0.14),
                (0.1, 0.08, 0.1), blocks[k % len(blocks)], rot=(0, -a + math.pi / 2, 0), bevel=0.015)
    lib.box((dxc, y0 - 0.06, dh + 0.04), (dw + 0.04, 0.06, 0.08), blocks[1], bevel=0.015)
    for wx in (0.0, 0.42):
        slit(wx, y0 - 0.02, H * 0.68, 'y', dark, blocks[3])
    for wy in (0.05, 0.75):
        slit(x1 + 0.02, wy, H * 0.68, 'x', dark, blocks[3])
    # The upper storey.
    stone_house(ux0, ux1, uy0, uy1, uH, rnd, walls, blocks, z0=H, block=0.22)
    quoins(ux0, ux1, uy0, uy1, H + 0.15, uH, blocks, rnd, block=0.24, row=0.18)
    slit((ux0 + ux1) / 2, uy0 - 0.02, uH - 0.32, 'y', dark, blocks[3])
    slit(ux1 + 0.02, (uy0 + uy1) / 2, uH - 0.32, 'x', dark, blocks[3])
    lib.tag(3)

    hip_roof(hcx, hcy, x1 - x0 - 0.26, y1 - y0 - 0.26, H + 0.06, 0.62, slates, ridge, rnd, overhang=0.04, size=0.16,
             shape='tile', ridge_frac=0.0)
    lib.tag(None, split=lambda o: 4 if o.name.startswith('hip') else (3 if (o.location.y - hcy) < (o.location.x - hcx) else 4))
    hip_roof((ux0 + ux1) / 2, (uy0 + uy1) / 2, ux1 - ux0, uy1 - uy0, uH, 0.7, slates, ridge, rnd, overhang=0.1,
             size=0.15, shape='tile', ridge_frac=0.0)
    # The pell: a gallows of squared timber with the straw dummy hanging from it.
    px, py = -1.12, -0.7
    lib.box((px, py, 0.5), (0.07, 0.07, 1.0), beam, bevel=0.008)
    lib.box((px + 0.22, py, 0.97), (0.5, 0.06, 0.06), beam, bevel=0.008)
    rod((px, py, 0.72), (px + 0.2, py, 0.95), 0.02, beam, verts=6)
    lib.box((px, py, 0.03), (0.22, 0.22, 0.06), beam, bevel=0.01)
    hx = px + 0.38
    rod((hx, py, 0.94), (hx, py, 0.78), 0.008, beam, verts=4)
    lib.cylinder((hx, py, 0.6), 0.075, 0.3, straw, verts=12, radius2=0.06)
    lib.sphere((hx, py, 0.81), 0.055, straw)
    lib.box((hx, py, 0.68), (0.06, 0.32, 0.05), straw, rot=(0.25, 0, 0))
    for s_ in (-1, 1):
        lib.cylinder((hx, py + s_ * 0.03, 0.38), 0.025, 0.16, straw, verts=8)
    # Swords on the ground by the pell.
    for (sx, sy, a) in ((-0.7, -1.1, 0.4), (-0.62, -1.18, -0.5)):
        lib.box((sx, sy, 0.065), (0.34, 0.035, 0.01), steel, rot=(0, 0, a))
        lib.box((sx - math.cos(a) * 0.17, sy - math.sin(a) * 0.17, 0.07), (0.03, 0.12, 0.02), iron, rot=(0, 0, a))
    # The target: rings of straw and red-brown on a slanted stand.
    tgx, tgy = 0.2, -1.2
    for dx in (-0.12, 0.12):
        rod((tgx + dx, tgy + 0.08, 0.0), (tgx + dx * 0.4, tgy + 0.02, 0.62), 0.022, beam, verts=6)
    rod((tgx, tgy + 0.22, 0.0), (tgx, tgy + 0.04, 0.6), 0.02, beam, verts=6)
    for k, (rr, m) in enumerate(((0.26, straw), (0.2, rings), (0.15, straw), (0.09, rings), (0.04, straw))):
        lib.cylinder((tgx, tgy - k * 0.006, 0.44), rr, 0.05, m, rot=(math.pi / 2 - 0.25, 0, 0.35), verts=28)
    lib.tag(4)
