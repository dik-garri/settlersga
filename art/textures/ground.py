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
PERIOD = 4
TEX = 160  # texture pixels per tile
SCALE = 2  # atlas resolution
FRAME_W, FRAME_H = 66, 34


def periodic_noise(rng, n, beta):
    """Noise with a 1/f^beta spectrum on an n×n torus, normalised to 0..1."""
    white = rng.standard_normal((n, n))
    fy = np.fft.fftfreq(n)[:, None]
    fx = np.fft.fftfreq(n)[None, :]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1
    field = np.real(np.fft.ifft2(np.fft.fft2(white) / f ** beta))
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


def grass(rng, n):
    big = periodic_noise(rng, n, 2.6)
    mid = periodic_noise(rng, n, 1.6)
    fine = periodic_noise(rng, n, 0.4)
    v = 0.5 * big + 0.3 * mid + 0.2 * fine
    v = (v - v.min()) / (v.max() - v.min())
    rgb = ramp(v, [
        (0.0, (24, 70, 12)),
        (0.35, (52, 112, 20)),
        (0.6, (84, 146, 30)),
        (0.85, (128, 172, 44)),
        (1.0, (170, 190, 70)),
    ])

    # Short grass blades, leaning "up" on screen (−u −v in tile space), light and dark.
    for _ in range(int(n * n / 18)):
        x, y = rng.uniform(0, n, 2)
        length = rng.uniform(3, 8)
        lean = rng.uniform(-0.5, 0.5)
        col = (150, 196, 64) if rng.random() < 0.55 else (22, 64, 12)
        if rng.random() < 0.15:
            col = (190, 200, 96)
        line(rgb, x, y, -0.7 + lean, -0.7 - lean, length, col)
    # Sparse little flowers.
    for _ in range(int(n * n / 2600)):
        x, y = rng.uniform(0, n, 2)
        col = [(250, 250, 240), (250, 220, 60), (200, 120, 220), (240, 90, 90)][rng.integers(0, 4)]
        for _ in range(rng.integers(2, 6)):
            ox, oy = rng.normal(0, 3, 2)
            stamp(rgb, x + ox, y + oy, col, r=1.2)
    return rgb


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
