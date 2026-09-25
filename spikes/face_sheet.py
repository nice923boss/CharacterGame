"""Enlarged head crops for every sprite (rows A/B/C x 5 expressions) to judge expression and identity."""
import pathlib
import sys

from PIL import Image

OUT = pathlib.Path(__file__).parent / "results" / "sprites"
EXPR = ["calm", "smile", "angry", "sad", "surprised"]
cid = sys.argv[1]
box = tuple(int(v) for v in sys.argv[2:6])  # left top right bottom in 512x768 space
T = 220
sheet = Image.new("RGB", (T * 5, T * 3), (40, 40, 40))
for r, m in enumerate("ABC"):
    for c, e in enumerate(EXPR):
        p = OUT / f"{cid}_{'A' if e == 'calm' else m}_{e}.png"
        sheet.paste(Image.open(p).convert("RGB").crop(box).resize((T, T)), (c * T, r * T))
sheet.save(OUT / f"faces_{cid}.png")
