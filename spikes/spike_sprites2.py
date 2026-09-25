"""Follow-up to spike_sprites.py: stronger denoise variants and a hybrid.

B7  whole-image img2img at denoise 0.7 (B at 0.6 kept identity but smile/sad were weak)
C8  face-crop img2img at denoise 0.8 (C at 0.6 barely changed the expression)
D6/D7  hybrid: take B6/B7's head region and feather-paste it onto the calm base,
       so the body is pixel-identical and the face keeps whole-image lighting context
Writes results/sprites/<cid>_{B7,C8,D6,D7}_<expr>.png, faces2_<cid>.png, timings2.json.
"""
import json

from PIL import Image
from rembg import new_session

import comfy
from spike_sprites import (CHARS, EXPR, FACE_SIZE, NO_TEXT, OUT, SEED, STYLE, _alpha_full, face_box,
                           paste_face, sprite_prompt)

timings = []


def region_paste(base, donor, box):
    """paste_face with a same-size donor: crop the donor's box, feather-paste onto base."""
    return paste_face(base, donor.crop(box), box)


def faces_sheet(cid, box, rows):
    t = 200
    sheet = Image.new("RGB", (t * len(EXPR), t * len(rows)), (40, 40, 40))
    for r, m in enumerate(rows):
        for c, e in enumerate(EXPR):
            p = OUT / (f"{cid}_A_calm.png" if e == "calm" else f"{cid}_{m}_{e}.png")
            sheet.paste(Image.open(p).convert("RGB").crop(box).resize((t, t)), (c * t, r * t))
    sheet.save(OUT / f"faces2_{cid}.png")


def main():
    session = new_session("u2net", providers=["CPUExecutionProvider"])
    for cid, look in CHARS.items():
        base_path = OUT / f"{cid}_A_calm.png"
        base = Image.open(base_path).convert("RGB")
        box = face_box(_alpha_full(base, session))
        crop_path = OUT / f"{cid}_C_crop.png"
        for e, ep in EXPR.items():
            if e == "calm":
                continue
            p = OUT / f"{cid}_B7_{e}.png"
            secs = comfy.img2img(sprite_prompt(look, ep), base_path, SEED + 1, 0.7, p)
            timings.append({"kind": "sprite_B7", "name": p.stem, "seconds": round(secs, 1)})
            print(f"B7 {p.stem} {secs:.1f}s", flush=True)

            fp = OUT / f"{cid}_C8_face_{e}.png"
            secs = comfy.img2img(f"{STYLE}, close-up of the face of {look}, {ep}, {NO_TEXT}", crop_path,
                                 SEED + 2, 0.8, fp)
            timings.append({"kind": "sprite_C8", "name": fp.stem, "seconds": round(secs, 1)})
            print(f"C8 {fp.stem} {secs:.1f}s", flush=True)
            paste_face(base, Image.open(fp).convert("RGB").resize((FACE_SIZE, FACE_SIZE)), box).save(
                OUT / f"{cid}_C8_{e}.png")

            for tag, src in (("D6", f"{cid}_B_{e}.png"), ("D7", f"{cid}_B7_{e}.png")):
                region_paste(base, Image.open(OUT / src).convert("RGB"), box).save(OUT / f"{cid}_{tag}_{e}.png")
        faces_sheet(cid, box, ["B", "B7", "C8", "D6", "D7"])
    (OUT / "timings2.json").write_text(json.dumps(timings, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
