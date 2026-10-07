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


def slice_diamonds(tex):
    """PERIOD² diamond frames in a row, at SCALE×, sampled bilinearly from the periodic texture."""
    n = tex.shape[0]
    w, h = FRAME_W * SCALE, FRAME_H * SCALE
    py, px = np.mgrid[0:h, 0:w].astype(np.float64)
    lx = (px + 0.5) / SCALE
    ly = (py + 0.5) / SCALE
    a = (lx - 33) / 30.5  # u − v
    b = (ly - 2) / 15  # u + v
    u = (a + b) / 2
    v = (b - a) / 2
    sheet = np.zeros((h, w * PERIOD * PERIOD, 4), dtype=np.uint8)
    for j in range(PERIOD):
        for i in range(PERIOD):
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
            k = i + PERIOD * j
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


def main():
    os.makedirs(OUT, exist_ok=True)
    rng = np.random.default_rng(4)
    n = TEX * PERIOD
    kinds = {'grass': grass(rng, n)}
    for kind, tex in kinds.items():
        save_png(slice_diamonds(tex), os.path.join(OUT, f'ground-{kind}.png'))
        full = np.concatenate([np.clip(tex, 0, 255), np.full(tex.shape[:2] + (1,), 255.0)], axis=2)
        save_png(full.astype(np.uint8), os.path.join(ROOT, 'art', '.tmp', f'tex-{kind}.png'))
    with open(os.path.join(OUT, 'ground.json'), 'w') as f:
        json.dump({'period': PERIOD, 'frame': [FRAME_W, FRAME_H], 'kinds': list(kinds)}, f)
    print('ground textures:', ', '.join(kinds))


main()
