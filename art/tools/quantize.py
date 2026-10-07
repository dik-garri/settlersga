"""Shrinks rendered sprite pages to 256-colour palette PNGs (with alpha), in place.

    python3 art/tools/quantize.py public/art/3d/settlers-*.png

Needs Pillow. The settler pages are ~6× smaller this way and look the same at game scale.
"""

import os
import sys

from PIL import Image

for path in sys.argv[1:]:
    before = os.path.getsize(path)
    img = Image.open(path).convert('RGBA')
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE).save(path, optimize=True)
    print(f'{path}: {before // 1024} → {os.path.getsize(path) // 1024} KB')
