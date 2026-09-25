"""Spike step 2 (CPU only, reuses spike_nvidia_flux.py output).

Step 1 showed same-seed txt2img donors keep body and clothes but the hair outline drifts, so pasting the whole
head box (cutout.face_box, made for img2img donors) leaves a light halo. Here only the inner face (brows, eyes,
mouth) is pasted and the calm hair stays. Writes <cid>_<expr>_inner.png and sheet_inner.png.
"""
import pathlib
import sys

from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from server import cutout  # noqa: E402

OUT = pathlib.Path(__file__).resolve().parent / "results/nvidia_flux"
EXPRS = ["smile", "angry", "sad", "surprised"]


def inner_box(head) -> tuple[int, int, int, int]:
    left, top, right, bottom = head
    w, h = right - left, bottom - top
    return left + int(0.24 * w), top + int(0.30 * h), right - int(0.24 * w), top + int(0.80 * h)


cells = []
for cid in ("c1", "c2"):
    calm_raw = Image.open(OUT / f"{cid}_calm.raw.png").convert("RGB")
    full = cutout.cutout_full(calm_raw)
    crop, head = cutout.padded_bbox(full), cutout.face_box(full)
    box = inner_box(head)
    print(cid, "head", head, "inner", box)
    row = [full.crop(crop)]
    for e in EXPRS:
        donor = Image.open(OUT / f"{cid}_{e}.donor.png").convert("RGB")
        merged = cutout.region_paste(calm_raw, donor, box)
        out = cutout.cutout_full(merged).crop(crop)
        out.save(OUT / f"{cid}_{e}_inner.png")
        row.append(out)
    cells.append(row)

S = 220
sheet = Image.new("RGB", (5 * S, 2 * S), "white")
for r, row in enumerate(cells):
    for c, im in enumerate(row):
        w = im.width
        face = im.crop((w // 2 - 120, 0, w // 2 + 120, 240)).resize((S, S))
        bg = Image.new("RGBA", face.size, (200, 200, 200, 255))
        bg.alpha_composite(face)
        sheet.paste(bg.convert("RGB"), (c * S, r * S))
sheet.save(OUT / "sheet_inner.png")
