"""D6 retry with a taller face region.

spike_sprites2 found the square face box ends at the mouth: B's mouth sits at 89% of the box height,
outside the feathered ellipse, so the calm base's closed mouth bled back in. Here the region extends
down to the chin (height = TALL x width) and the feathered ellipse covers that rectangle.
Writes <cid>_D6t_<expr>.png and faces3_<cid>.png (rows B, D6, D6t) - CPU only.
"""
import sys

from PIL import Image, ImageDraw, ImageFilter
from rembg import new_session

from spike_sprites import CHARS, EXPR, OUT, _alpha_full, face_box

TALL = 1.35


def tall_box(box, height):
    left, top, right, _ = box
    return left, top, right, min(height, top + int((right - left) * TALL))


def region_paste(base, donor, box):
    w, h = box[2] - box[0], box[3] - box[1]
    mask = Image.new("L", (w, h), 0)
    mx, my = int(w * 0.10), int(h * 0.06)
    ImageDraw.Draw(mask).ellipse((mx, my, w - mx, h - my), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * 0.05))
    out = base.copy()
    out.paste(donor.crop(box), box[:2], mask)
    return out


def main(cids):
    session = new_session("u2net", providers=["CPUExecutionProvider"])
    for cid in cids:
        base = Image.open(OUT / f"{cid}_A_calm.png").convert("RGB")
        box = tall_box(face_box(_alpha_full(base, session)), base.height)
        print(cid, "box", box, flush=True)
        for e in EXPR:
            if e != "calm":
                donor = Image.open(OUT / f"{cid}_B_{e}.png").convert("RGB")
                region_paste(base, donor, box).save(OUT / f"{cid}_D6t_{e}.png")
        t = 220
        tw = int(t * (box[2] - box[0]) / (box[3] - box[1]))
        rows = ["B", "D6", "D6t"]
        sheet = Image.new("RGB", (tw * len(EXPR), t * len(rows)))
        for r, m in enumerate(rows):
            for c, e in enumerate(EXPR):
                p = OUT / (f"{cid}_A_calm.png" if e == "calm" else f"{cid}_{m}_{e}.png")
                sheet.paste(Image.open(p).convert("RGB").crop(box).resize((tw, t)), (c * tw, r * t))
        sheet.save(OUT / f"faces3_{cid}.png")


if __name__ == "__main__":
    main(sys.argv[1:] or list(CHARS))
