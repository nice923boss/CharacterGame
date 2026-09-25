"""Spike step 3 (CPU only): fix ghosting left by step 2 (c2 glasses doubled, c1 sad bangs smeared).

Variants per expression, compared on one sheet (rows c1/c2 x variant, columns calm + 4 expressions):
  full   : use the whole donor sprite, no paste (hair outline may drift between expressions)
  align  : shift the donor so its face lines up with calm (phase correlation on the head box), then paste the
           inner face with a tighter blur
Writes sheet_variants.png.
"""
import pathlib
import sys

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from server import cutout  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent / "results/nvidia_flux"
EXPRS = ["smile", "angry", "sad", "surprised"]


def inner_box(head) -> tuple[int, int, int, int]:
    left, top, right, bottom = head
    w, h = right - left, bottom - top
    return left + int(0.24 * w), top + int(0.30 * h), right - int(0.24 * w), top + int(0.80 * h)


def shift(base: Image.Image, donor: Image.Image, box) -> tuple[int, int]:
    a = np.asarray(base.crop(box).convert("L"), np.float32)
    b = np.asarray(donor.crop(box).convert("L"), np.float32)
    a, b = a - a.mean(), b - b.mean()
    r = np.fft.ifft2(np.fft.fft2(a) * np.conj(np.fft.fft2(b)))
    dy, dx = np.unravel_index(np.argmax(np.abs(r)), r.shape)
    h, w = a.shape
    return int(dx - w if dx > w // 2 else dx), int(dy - h if dy > h // 2 else dy)


def paste_tight(base: Image.Image, donor: Image.Image, box) -> Image.Image:
    w, h = box[2] - box[0], box[3] - box[1]
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).ellipse((int(w * .08), int(h * .06), w - int(w * .08), h - int(h * .06)), fill=255)
    out = base.copy()
    out.paste(donor.crop(box), box[:2], mask.filter(ImageFilter.GaussianBlur(w * 0.03)))
    return out


rows = []
for cid in ("c1", "c2"):
    calm_raw = Image.open(OUT / f"{cid}_calm.raw.png").convert("RGB")
    full = cutout.cutout_full(calm_raw)
    crop, head = cutout.padded_bbox(full), cutout.face_box(full)
    box = inner_box(head)
    full_row, align_row = [full.crop(crop)], [full.crop(crop)]
    for e in EXPRS:
        donor = Image.open(OUT / f"{cid}_{e}.donor.png").convert("RGB")
        full_row.append(cutout.cutout_full(donor).crop(crop))
        dx, dy = shift(calm_raw, donor, head)
        moved = ImageChops.offset(donor, dx, dy)
        print(cid, e, "shift", dx, dy)
        align_row.append(cutout.cutout_full(paste_tight(calm_raw, moved, box)).crop(crop))
    rows += [full_row, align_row]

S = 220
sheet = Image.new("RGB", (5 * S, len(rows) * S), "white")
for r, row in enumerate(rows):
    for c, im in enumerate(row):
        w = im.width
        face = im.crop((w // 2 - 130, 0, w // 2 + 130, 260)).resize((S, S))
        bg = Image.new("RGBA", face.size, (200, 200, 200, 255))
        bg.alpha_composite(face)
        sheet.paste(bg.convert("RGB"), (c * S, r * S))
sheet.save(OUT / "sheet_variants.png")
