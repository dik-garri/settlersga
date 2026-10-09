"""Seamless ground textures in the Settlers 4 manner, sliced into the game's diamond tiles.

    blender -b --factory-startup -P art/textures/ground.py

Runs inside Blender (for numpy and PNG output, so the art pipeline needs nothing else). For each kind a texture periodic over PERIOD×PERIOD tiles is generated in
tile space (FFT-filtered noise is periodic by construction, strokes and flowers wrap), then cut into
PERIOD² diamond sprites: tile (x, y) of the map uses variant (x mod PERIOD) + PERIOD·(y mod PERIOD),
so neighbouring tiles continue each other and the pattern repeats only every PERIOD tiles. The
diamond is mapped exactly the way the renderer's ground mesh samples it (`quadOf` in renderer.ts:
tile corners at frame points (33, 2), (63.5, 17), (33, 32), (2.5, 17)).
"""

import json
import os

import bpy
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT = os.path.join(ROOT, 'public', 'art', '3d')
PERIOD = 8
TEX = 128  # texture pixels per tile
SCALE = 2  # atlas resolution
FRAME_W, FRAME_H = 66, 34


def periodic_noise(rng, n, beta, band=None):
    """Noise with a 1/f^beta spectrum on an n×n torus, normalised to 0..1. `band` (lo, hi) keeps only
    those frequencies, in cycles per texture: broad swells without one blob per period."""
    white = rng.standard_normal((n, n))
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1
    spectrum = np.fft.fft2(white) / f ** beta
    if band:
        cycles = f * n
        spectrum[(cycles < band[0]) | (cycles > band[1])] = 0
    field = np.real(np.fft.ifft2(spectrum))
    field -= field.min()
    return field / field.max()


def ramp(v, stops):
    """Piecewise-linear colour ramp; `stops` are (position, (r, g, b)) in 0..1."""
    pos = np.array([p for p, _ in stops])
    out = np.zeros(v.shape + (3,))
    for c in range(3):
        out[..., c] = np.interp(v, pos, [col[c] for _, col in stops])
    return out


def stamp(img, x, y, col, r=0.6):
    """Paints a small dot (radius `r` px) at a wrapped position."""
    n = img.shape[0]
    for oy in range(-1, 2):
        for ox in range(-1, 2):
            if ox * ox + oy * oy <= (r + 0.5) ** 2:
                img[int(y + oy) % n, int(x + ox) % n] = col


def line(img, x, y, dx, dy, length, col):
    for t in np.linspace(0, length, int(length * 2) + 1):
        stamp(img, x + dx * t, y + dy * t, col, r=0.3)


def strokes(img, rng, count, length, width_px, angle_field, color_fn, jitter=0.35):
    """Draws `count` tapered strokes at once (numpy): each starts at a random point, runs along the
    local `angle_field` direction (±jitter), and is painted with `color_fn(k)` (k strokes × 3).
    Wraps around the torus, so the texture stays periodic."""
    n = img.shape[0]
    x0 = rng.uniform(0, n, count)
    y0 = rng.uniform(0, n, count)
    ang = angle_field[y0.astype(int) % n, x0.astype(int) % n] + rng.uniform(-jitter, jitter, count)
    ln = rng.uniform(*length, count)
    cols = color_fn(count)
    steps = int(np.ceil(length[1] * 1.5))
    dx, dy = np.cos(ang), np.sin(ang)
    for t in np.linspace(0, 1, steps):
        xs = x0 + dx * ln * t
        ys = y0 + dy * ln * t
        w = width_px * (1 - 0.7 * t)  # tapers towards the tip
        for ox, oy in ((0, 0), (1, 0), (0, 1)) if width_px > 1 else ((0, 0),):
            keep = (ox == 0 and oy == 0) | (w > 1.2)
            xi = (xs[keep] + ox).astype(int) % n
            yi = (ys[keep] + oy).astype(int) % n
            img[yi, xi] = cols[keep]


def grass(rng, n):
    """Settlers 4 grass: combed, flowing blades (each a dark stroke with a light one beside it) over
    deep green, under broad soft swells of light and shade."""
    big = periodic_noise(rng, n, 2.0, band=(2, 5))
    mid = periodic_noise(rng, n, 2.0)
    fine = periodic_noise(rng, n, 0.6)
    base = ramp(0.65 * mid + 0.35 * fine, [
        (0.0, (26, 74, 10)),
        (0.5, (48, 112, 18)),
        (1.0, (78, 146, 26)),
    ])
    # Blades lean "up" on screen (−u −v in tile space, angle −3π/4) and sway with a slow field.
    sway = periodic_noise(rng, n, 2.6)
    angle = -3 * np.pi / 4 + (sway - 0.5) * 1.6

    def shade(lo, hi):
        def f(k):
            t = rng.uniform(0, 1, (k, 1))
            return np.array(lo) * (1 - t) + np.array(hi) * t
        return f

    img = base.copy()
    area = n * n
    strokes(img, rng, area // 9, (5, 11), 1, angle, shade((12, 44, 6), (30, 80, 12)))      # dark under-blades
    strokes(img, rng, area // 10, (5, 12), 1, angle, shade((70, 140, 24), (120, 180, 40)))  # mid blades
    strokes(img, rng, area // 26, (4, 10), 1, angle, shade((150, 196, 52), (200, 214, 90)))  # sunlit tips
    # Broad swells of light and shade (like cloud shadows and hollows), strong as in the original.
    light = 0.62 + 0.62 * big
    img = img * light[..., None]
    # Sparse flowers.
    for _ in range(int(area / 5200)):
        x, y = rng.uniform(0, n, 2)
        col = [(250, 250, 240), (250, 220, 60), (200, 120, 220), (240, 90, 90)][rng.integers(0, 4)]
        for _ in range(rng.integers(2, 5)):
            ox, oy = rng.normal(0, 2.5, 2)
            stamp(img, x + ox, y + oy, col, r=1.0)
    return np.clip(img, 0, 255)


def shade_fn(rng, lo, hi):
    """Colours between `lo` and `hi`, one per stroke."""
    def f(k):
        t = rng.uniform(0, 1, (k, 1))
        return np.array(lo) * (1 - t) + np.array(hi) * t
    return f


def specks(img, rng, count, colours, r=(0.6, 1.2)):
    """Scattered small dots (pebbles, shells, flecks) in a few colours."""
    n = img.shape[0]
    for _ in range(count):
        x, y = rng.uniform(0, n, 2)
        stamp(img, x, y, colours[rng.integers(0, len(colours))], r=rng.uniform(*r))


def sand(rng, n):
    """Beach sand, as on Settlers 4 shores: bright yellow-orange, fine grain, soft wind ripples,
    scattered pebbles and shells."""
    big = periodic_noise(rng, n, 2.2, band=(2, 6))
    fine = periodic_noise(rng, n, 0.3)
    img = ramp(0.55 * big + 0.45 * fine, [
        (0.0, (196, 138, 52)), (0.45, (224, 172, 78)), (0.8, (240, 198, 108)), (1.0, (248, 214, 132)),
    ])
    yy, xx = np.mgrid[0:n, 0:n]
    warp = periodic_noise(rng, n, 2.4) * 40
    rip = np.sin((xx + yy + warp) * (2 * np.pi * 9 / n)) * 0.5 + 0.5
    img *= (0.92 + 0.12 * rip)[..., None]
    specks(img, rng, n * n // 900, [(170, 120, 60), (250, 236, 200), (150, 140, 120)], r=(0.5, 1.0))
    return np.clip(img, 0, 255)


def desert(rng, n):
    """Desert: paler, dustier ochre than the beach, long dune swells and a few dry tufts."""
    big = periodic_noise(rng, n, 2.6, band=(1, 4))
    fine = periodic_noise(rng, n, 0.4)
    img = ramp(0.6 * big + 0.4 * fine, [
        (0.0, (186, 140, 78)), (0.5, (214, 172, 104)), (1.0, (236, 204, 142)),
    ])
    yy, xx = np.mgrid[0:n, 0:n]
    warp = periodic_noise(rng, n, 2.6) * 70
    dune = np.sin((xx - yy * 0.5 + warp) * (2 * np.pi * 3 / n)) * 0.5 + 0.5
    img *= (0.94 + 0.08 * dune)[..., None]
    for _ in range(n * n // 9000):
        x, y = rng.uniform(0, n, 2)
        for _ in range(rng.integers(4, 9)):
            a = -3 * np.pi / 4 + rng.uniform(-0.8, 0.8)
            line(img, x, y, np.cos(a), np.sin(a), rng.uniform(3, 7), (140, 120, 60))
    specks(img, rng, n * n // 1400, [(160, 120, 70), (240, 222, 180)])
    return np.clip(img, 0, 255)


def water(rng, n):
    """Open water: deep turquoise with lighter swells, short wave crests and bright flecks (the game
    adds moving sun glints on top)."""
    big = periodic_noise(rng, n, 2.4, band=(2, 6))
    mid = periodic_noise(rng, n, 1.4)
    img = ramp(0.6 * big + 0.4 * mid, [
        (0.0, (16, 84, 130)), (0.45, (28, 120, 168)), (0.8, (52, 156, 196)), (1.0, (84, 186, 214)),
    ])
    angle = (periodic_noise(rng, n, 2.6) - 0.5) * 0.6
    strokes(img, rng, n * n // 160, (4, 10), 1, angle, shade_fn(rng, (70, 170, 205), (150, 220, 236)), jitter=0.15)
    strokes(img, rng, n * n // 260, (3, 8), 1, angle, shade_fn(rng, (10, 64, 104), (20, 90, 130)), jitter=0.15)
    specks(img, rng, n * n // 700, [(230, 250, 255), (200, 240, 250)], r=(0.4, 0.9))
    return np.clip(img, 0, 255)


def ford(rng, n):
    """Shallow ford: light turquoise over a visible sandy, pebbly bottom."""
    bottom = sand(rng, n) * 0.85
    surface = water(rng, n)
    depth = periodic_noise(rng, n, 2.2)
    k = (0.45 + 0.25 * depth)[..., None]
    img = bottom * (1 - k) + surface * k
    specks(img, rng, n * n // 500, [(150, 150, 140), (110, 110, 100), (200, 196, 180)], r=(0.8, 1.6))
    return np.clip(img, 0, 255)


def mountain(rng, n):
    """Walkable mountain slope: grey-brown rock in bent strata, dark cracks, lit edges, lichen."""
    big = periodic_noise(rng, n, 2.2, band=(1, 5))
    fine = periodic_noise(rng, n, 0.9)
    yy, xx = np.mgrid[0:n, 0:n]
    warp = periodic_noise(rng, n, 2.4) * 90
    strata = np.sin((yy * 1.0 - xx * 0.35 + warp) * (2 * np.pi * 14 / n))
    v = 0.5 * big + 0.38 * fine + 0.12 * (strata * 0.5 + 0.5)
    img = ramp(v, [
        (0.0, (112, 100, 82)), (0.35, (146, 132, 108)), (0.7, (176, 162, 136)), (1.0, (204, 194, 170)),
    ])
    crack = np.clip((strata - 0.92) * 10, 0, 1)
    img = img * (1 - 0.22 * crack[..., None])
    lit = np.clip((-strata - 0.94) * 12, 0, 1)
    img = img + 22 * lit[..., None]
    specks(img, rng, n * n // 1600, [(118, 128, 70), (140, 136, 80)], r=(1.0, 2.0))
    specks(img, rng, n * n // 900, [(60, 54, 46), (196, 188, 170)], r=(0.5, 1.0))
    return np.clip(img, 0, 255)


def rock(rng, n):
    """Impassable peaks: pale, sharply cracked stone."""
    big = periodic_noise(rng, n, 2.0, band=(1, 6))
    fine = periodic_noise(rng, n, 0.8)
    img = ramp(0.55 * big + 0.45 * fine, [
        (0.0, (104, 100, 96)), (0.4, (150, 146, 140)), (0.75, (192, 188, 182)), (1.0, (222, 218, 212)),
    ])
    # Facets and cracks: a cellular pattern of plates with dark seams and lit upper rims.
    yy, xx = np.mgrid[0:n, 0:n]
    pts = rng.uniform(0, n, (n * n // 1800, 2))
    d1 = np.full((n, n), 1e9)
    d2 = np.full((n, n), 1e9)
    for px_, py_ in pts:
        dx = np.abs(xx - px_)
        dy = np.abs(yy - py_)
        d = np.hypot(np.minimum(dx, n - dx), np.minimum(dy, n - dy))
        d2 = np.where(d < d1, d1, np.minimum(d2, d))
        d1 = np.minimum(d1, d)
    seam = np.clip(1 - (d2 - d1) / 2.5, 0, 1)
    img = img * (1 - 0.55 * seam[..., None])
    rim = np.clip(1 - (d2 - d1 - 2.5) / 2.0, 0, 1) * (1 - seam)
    img = img + 26 * rim[..., None]
    return np.clip(img, 0, 255)


def swamp(rng, n):
    """Swamp: dark green-brown mud with murky pools and reeds."""
    big = periodic_noise(rng, n, 2.4, band=(2, 7))
    fine = periodic_noise(rng, n, 0.7)
    img = ramp(0.6 * big + 0.4 * fine, [
        (0.0, (44, 50, 26)), (0.5, (66, 74, 36)), (1.0, (92, 96, 48)),
    ])
    pools = periodic_noise(rng, n, 2.6, band=(3, 9))
    pool = np.clip((pools - 0.62) * 8, 0, 1)[..., None]
    img = img * (1 - pool) + np.array((30, 62, 60)) * pool
    angle = -np.pi / 2 + (periodic_noise(rng, n, 2.0) - 0.5) * 0.5
    strokes(img, rng, n * n // 120, (4, 9), 1, angle, shade_fn(rng, (70, 96, 34), (150, 156, 70)), jitter=0.3)
    specks(img, rng, n * n // 2000, [(120, 80, 50), (210, 200, 120)], r=(0.8, 1.4))
    return np.clip(img, 0, 255)


def slice_diamonds(tex, period=PERIOD):
    """period² diamond frames in a row, at SCALE×, sampled bilinearly from the periodic texture."""
    n = tex.shape[0]
    w, h = FRAME_W * SCALE, FRAME_H * SCALE
    py, px = np.mgrid[0:h, 0:w].astype(np.float64)
    lx = (px + 0.5) / SCALE
    ly = (py + 0.5) / SCALE
    a = (lx - 33) / 30.5  # u − v
    b = (ly - 2) / 15  # u + v
    u = (a + b) / 2
    v = (b - a) / 2
    sheet = np.zeros((h, w * period * period, 4), dtype=np.uint8)
    for j in range(period):
        for i in range(period):
            tu = ((i + u) * TEX) % n
            tv = ((j + v) * TEX) % n
            x0 = np.floor(tu).astype(int)
            y0 = np.floor(tv).astype(int)
            fx = (tu - x0)[..., None]
            fy = (tv - y0)[..., None]
            x1 = (x0 + 1) % n
            y1 = (y0 + 1) % n
            c = (tex[y0, x0] * (1 - fx) * (1 - fy) + tex[y0, x1] * fx * (1 - fy)
                 + tex[y1, x0] * (1 - fx) * fy + tex[y1, x1] * fx * fy)
            k = i + period * j
            sheet[:, k * w:(k + 1) * w, :3] = np.clip(c, 0, 255).astype(np.uint8)
            sheet[:, k * w:(k + 1) * w, 3] = 255
    return sheet


def save_png(rgba, path):
    """Writes an RGBA uint8 array (top row first) as a PNG through Blender."""
    h, w = rgba.shape[:2]
    img = bpy.data.images.new('out', width=w, height=h, alpha=True)
    img.pixels.foreach_set((rgba[::-1].astype(np.float32) / 255).ravel())
    img.filepath_raw = path
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)


def tile_to_px(u, v, cy, cx=33, hw=30.5, hh=15):
    """Tile-local (u, v) in 0..1 → pixel position (at SCALE×) in a frame whose diamond centre is (cx, cy)."""
    return (cx + (u - v) * hw) * SCALE, (cy - hh + (u + v) * hh) * SCALE


def diamond_mask(w, h, cx, cy, hw, hh, soft=0.0):
    """1 inside a diamond centred at logical (cx, cy) with half sizes hw, hh; `soft` fades the rim."""
    py, px = np.mgrid[0:h, 0:w].astype(np.float64)
    d = np.abs((px + 0.5) / SCALE - cx) / hw + np.abs((py + 0.5) / SCALE - cy) / hh
    if soft <= 0:
        return (d <= 1).astype(np.float64)
    return np.clip((1 - d) / soft, 0, 1)


def plot(img, x, y, col):
    h, w = img.shape[:2]
    xi, yi = int(x), int(y)
    if 0 <= yi < h and 0 <= xi < w:
        img[yi, xi, :3] = col
        img[yi, xi, 3] = 255


def fields(rng):
    """Grain field decals for stages 1 (sown) … 4 (ripe) and 5 (stubble after the harvest,
    `CROP_STUBBLE`), as a strip of 66×40 frames with the tile centre at (33, 24) (the
    `field:grain:<stage>` convention): tilled earth in furrows along the tile's x, plants standing in
    the rows, green while growing and golden when ripe, then cut stalks and loose straw."""
    W, H, CY = 66, 40, 24
    w, h = W * SCALE, H * SCALE
    mask = diamond_mask(w, h, 33, CY, 31, 15.5)
    py, px = np.mgrid[0:h, 0:w].astype(np.float64)
    a = ((px + 0.5) / SCALE - 33) / 30.5
    b = ((py + 0.5) / SCALE - (CY - 15)) / 15
    v = (b - a) / 2
    furrow = np.sin(v * np.pi * 2 * 6) * 0.5 + 0.5
    nz = periodic_noise(rng, 256, 1.2)[py.astype(int) % 256, px.astype(int) % 256]
    earth = ramp(0.6 * furrow + 0.4 * nz, [(0.0, (88, 56, 30)), (0.6, (130, 88, 50)), (1.0, (156, 112, 68))])
    frames = []
    for stage in range(1, 5):
        img = np.zeros((h, w, 4))
        img[..., :3] = earth
        img[..., 3] = mask * 255
        height = [0, 2.0, 5.5, 8.5, 10.0][stage] * SCALE
        stem = (60, 128, 30) if stage < 4 else (178, 140, 44)
        tip = (118, 176, 52) if stage < 4 else (238, 206, 96)
        rows, per_row = 6, 9
        for r in range(rows):
            vv = (r + 0.5) / rows
            for k in range(per_row):
                uu = (k + 0.5 + rng.uniform(-0.25, 0.25)) / per_row
                x, y = tile_to_px(uu, vv, CY)
                if stage == 1:
                    for _ in range(2):
                        plot(img, x + rng.uniform(-2, 2), y + rng.uniform(-1, 1), (98, 150, 40))
                    continue
                for _ in range(3):
                    sx = x + rng.uniform(-3, 3)
                    hgt = height * rng.uniform(0.8, 1.15)
                    lean = rng.uniform(-0.25, 0.25)
                    for t in np.linspace(0, 1, int(hgt) + 2):
                        col = np.array(stem) * (1 - t) + np.array(tip) * t
                        plot(img, sx + lean * hgt * t, y - hgt * t, col)
                        if stage == 4 and t > 0.65:
                            plot(img, sx + lean * hgt * t + 1, y - hgt * t, (224, 188, 76))
        frames.append(np.clip(img, 0, 255).astype(np.uint8))
    frames.append(stubble(earth, mask, CY, w, h))
    return np.concatenate(frames, axis=1)


def stubble(earth, mask, cy, w, h):
    """The reaped field: the furrowed earth dried paler, short stalks cut off in the rows (pale gold,
    a darker cut end), straw left lying along the furrows and a few green weeds coming up. Its own
    random stream, so the frames and decals generated after it stay as they were."""
    rng = np.random.default_rng(78)
    img = np.zeros((h, w, 4))
    img[..., :3] = earth * 0.72 + np.array((168, 134, 84)) * 0.28
    img[..., 3] = mask * 255
    # Loose straw first, so the standing stalks are drawn over it: short strokes along the furrows
    # (the tile's x axis runs down-right on screen, 2:1), a little scattered in direction.
    for _ in range(46):
        x, y = tile_to_px(rng.uniform(0.04, 0.96), rng.uniform(0.04, 0.96), cy)
        ang = np.arctan2(1, 2) + rng.uniform(-0.6, 0.6)
        length = rng.uniform(3.0, 6.0) * SCALE
        col = np.array((226, 204, 132)) * rng.uniform(0.85, 1.05)
        for t in np.linspace(-0.5, 0.5, int(length) + 2):
            plot(img, x + np.cos(ang) * length * t, y + np.sin(ang) * length * t, col)
    # Straw lies on the ground: none outside the tile (stalks may stand above its top edge).
    img[..., 3] = np.where(mask > 0, img[..., 3], 0)
    rows, per_row = 6, 9
    for r in range(rows):
        vv = (r + 0.5) / rows
        for k in range(per_row):
            uu = (k + 0.5 + rng.uniform(-0.25, 0.25)) / per_row
            x, y = tile_to_px(uu, vv, cy)
            for _ in range(4):
                sx = x + rng.uniform(-3, 3)
                hgt = rng.uniform(1.2, 2.6) * SCALE
                lean = rng.uniform(-0.3, 0.3)
                for t in np.linspace(0, 1, int(hgt) + 2):
                    col = np.array((176, 146, 80)) * (1 - t) + np.array((222, 198, 120)) * t
                    plot(img, sx + lean * hgt * t, y - hgt * t, col)
                plot(img, sx + lean * hgt, y - hgt - 1, (150, 118, 60))
    # A few weeds sprouting between the rows.
    for _ in range(9):
        x, y = tile_to_px(rng.uniform(0.1, 0.9), rng.uniform(0.1, 0.9), cy)
        for _ in range(3):
            plot(img, x + rng.uniform(-1.5, 1.5), y + rng.uniform(-1.5, 0.5), (92, 142, 44))
    return np.clip(img, 0, 255).astype(np.uint8)


def paths(rng, variants=4):
    """Worn path decals, 80×44 with the tile centre at (40, 22) (the `path:<level>:<v>` convention):
    level 1 a dusty path fraying into the grass, level 2 a road of rounded cobbles over gravel.
    One strip of `variants` frames per level."""
    W, H, CX, CY = 80, 44, 40, 22
    w, h = W * SCALE, H * SCALE
    yy, xx = np.mgrid[0:h, 0:w]
    out = {}
    for level in (1, 2):
        frames = []
        for _ in range(variants):
            img = np.zeros((h, w, 4))
            nz = periodic_noise(rng, 256, 1.6)[yy % 256, xx % 256]
            grain = periodic_noise(rng, 256, 0.3)[yy % 256, xx % 256]
            reach = diamond_mask(w, h, CX, CY, 37, 18.5, soft=0.5)
            alpha = np.clip((reach * 1.3 - (1 - nz) * 0.6) * 1.7, 0, 1)
            if level == 1:
                img[..., :3] = ramp(0.6 * nz + 0.4 * grain, [(0.0, (120, 82, 46)), (0.5, (164, 120, 72)), (1.0, (192, 154, 102))])
                img[..., 3] = alpha * 210
            else:
                img[..., :3] = ramp(0.5 * nz + 0.5 * grain, [(0.0, (104, 90, 74)), (0.5, (136, 122, 102)), (1.0, (166, 152, 130))])
                img[..., 3] = alpha * 235
                core = diamond_mask(w, h, CX, CY, 30, 15)
                for _ in range(52):
                    uu, vv = rng.uniform(0.0, 1.0, 2)
                    x, y = tile_to_px(uu, vv, CY, cx=CX, hw=32, hh=16)
                    if core[int(min(h - 1, max(0, y))), int(min(w - 1, max(0, x)))] == 0:
                        continue
                    rx, ry = rng.uniform(4.0, 6.0), rng.uniform(2.2, 3.2)
                    e = ((xx - x) / rx) ** 2 + ((yy - y) / ry) ** 2
                    stone = e <= 1
                    joint = (e > 1) & (e <= 1.6)
                    tone = rng.uniform(150, 205)
                    lit = np.clip(1 - ((xx - x + rx * 0.35) / rx) ** 2 - ((yy - y + ry * 0.45) / ry) ** 2, 0, 1)
                    for c, k in enumerate((1.0, 0.97, 0.9)):
                        img[..., c] = np.where(stone, tone * k * (0.75 + 0.4 * lit), img[..., c])
                    img[..., :3] = np.where((joint & ~stone)[..., None], img[..., :3] * 0.55, img[..., :3])
                    img[..., 3] = np.where(stone | joint, 255, img[..., 3])
            frames.append(np.clip(img, 0, 255).astype(np.uint8))
        out[level] = np.concatenate(frames, axis=1)
    return out


#: Ground kinds and their texture period in tiles. Grass repeats every 8 tiles, the rest every 4 —
#: every ground diamond and transition overlay must fit on one atlas page.
KINDS = {
    'grass': (grass, PERIOD),
    'sand': (sand, 4),
    'desert': (desert, 4),
    'water': (water, 4),
    'ford': (ford, 4),
    'mountain': (mountain, 4),
    'rock': (rock, 4),
    'swamp': (swamp, 4),
}


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(os.path.join(ROOT, 'art', '.tmp'), exist_ok=True)
    periods = {}
    for kind, (make, period) in KINDS.items():
        # Grass keeps its old seed, so its texture stays the same.
        rng = np.random.default_rng(4 if kind == 'grass' else 4 + sum(map(ord, kind)))
        tex = make(rng, TEX * period)
        save_png(slice_diamonds(tex, period), os.path.join(OUT, f'ground-{kind}.png'))
        full = np.concatenate([np.clip(tex, 0, 255), np.full(tex.shape[:2] + (1,), 255.0)], axis=2)
        save_png(full.astype(np.uint8), os.path.join(ROOT, 'art', '.tmp', f'tex-{kind}.png'))
        periods[kind] = period
    rng = np.random.default_rng(77)
    save_png(fields(rng), os.path.join(OUT, 'fields-grain.png'))
    for level, strip in paths(rng).items():
        save_png(strip, os.path.join(OUT, f'path-{level}.png'))
    with open(os.path.join(OUT, 'ground.json'), 'w') as f:
        json.dump({'frame': [FRAME_W, FRAME_H], 'kinds': periods, 'fields': {'grain': 5},
                   'paths': {'levels': 2, 'variants': 4}}, f)
    print('ground textures:', ', '.join(periods))


main()
