"""Clears whatever on the settler pages no frame of settlers.json refers to, in place.

    python3 art/tools/blank_unused.py public/art/3d/settlers.json

After `settlers:civil` (art/blender/figures.py) the fighters' pages still hold the old frames of
others; this makes those pixels transparent and cuts each page down to the rows it uses. A
palette page keeps its palette, so the frames that stay keep every pixel. Needs Pillow.
"""

import json
import os
import sys

from PIL import Image

meta_path = sys.argv[1]
root = os.path.dirname(meta_path)
with open(meta_path) as f:
    meta = json.load(f)
used = set()
for rows in meta['groups'].values():
    for row in rows:
        for fr in row:
            used.update(i for i in fr if i >= 0)
for row in meta['hats'].values():
    used.update(i for i in row if i >= 0)
for k, name in enumerate(meta['pages']):
    path = os.path.join(root, name)
    img = Image.open(path)
    before = os.path.getsize(path)
    rects = [meta['frames'][i][1:5] for i in sorted(used) if meta['frames'][i][0] == k]
    keep = Image.new('1', img.size, 0)
    for x, y, w, h in rects:
        keep.paste(1, (x, y, x + w, y + h))
    bottom = max(y + h for x, y, w, h in rects) + 1
    if img.mode == 'P':
        trns = img.info.get('transparency')
        alpha = list(trns) if isinstance(trns, (bytes, bytearray)) else []
        clear = next((i for i, a in enumerate(alpha) if a == 0), None)
        if clear is None:
            raise SystemExit(f'{name}: no transparent palette entry')
        blank = Image.new('P', img.size, clear)
        blank.putpalette(img.getpalette())
        out = Image.composite(img, blank, keep)
        out.info['transparency'] = trns
        out = out.crop((0, 0, img.width, min(bottom, img.height)))
        out.save(path, optimize=True, transparency=trns)
    else:
        img = img.convert('RGBA')
        out = Image.composite(img, Image.new('RGBA', img.size, (0, 0, 0, 0)), keep)
        out.crop((0, 0, img.width, min(bottom, img.height))).save(path, optimize=True)
    print(f'{name}: {before // 1024} → {os.path.getsize(path) // 1024} KB')
