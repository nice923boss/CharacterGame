"""Spike: sprite consistency across 5 expressions (methods A/B/C), cutout of white parts, timings.

A  fixed seed + verbatim appearance text, only the expression phrase changes (txt2img x5)
B  A's calm image as base, img2img per expression (whole image, denoise B_DENOISE)
C  A's calm image as base, face crop -> upscale -> img2img -> feathered paste back
   (body and outfit are pixel-identical by construction; risk is seams / mismatched lighting)
Also renders 3 backgrounds for timing. Writes results/sprites/* and results/sprites/timings.json.
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

import comfy

sys.path.insert(0, r"C:\Users\Clare\.claude\skills\p5-comfyui-animation-v2\scripts")
from process_assets import cutout  # noqa: E402  (SKILL pipeline: rembg + alpha harden + iso residue)

OUT = pathlib.Path(__file__).parent / "results" / "sprites"
W, H = 512, 768
SEED = 20260925
B_DENOISE = 0.6
C_DENOISE = 0.6
FACE_SIZE = 768

STYLE = ("anime cel shading illustration, clean black lineart, flat colors with two-tone shading, "
         "visual novel character sprite")
FRAMING = ("single character, standing, upper body from the thighs up, facing the viewer, centered, "
           "whole head visible with margin above")
ISO = "isolated on a plain flat light blue background, nothing behind the subject"
NO_TEXT = "no text, no letters, no watermark, no signature"

CHARS = {
    "yingyue": ("a 22-year-old young woman, long straight black hair, a silver crescent-moon hair clip "
                "above her left ear, grey-blue eyes, white stand-collar blouse, dark navy vest, "
                "long dark navy skirt, holding a brass pocket watch"),
    "shenyan": ("a 28-year-old man, short silver-white hair, amber eyes, a thin scar through his left "
                "eyebrow, dark grey long trench coat, black leather gloves, leather goggles hanging "
                "around his neck"),
}
EXPR = {
    "calm": "calm neutral expression, closed mouth",
    "smile": "gentle warm smile",
    "angry": "angry expression, furrowed brows, gritted teeth",
    "sad": "sad expression, downcast eyes, slight frown",
    "surprised": "surprised expression, wide eyes, open mouth",
}
BGS = {
    "archive": "a cramped old archive room at night, tall wooden shelves of damp paper files, a single brass gas lamp",
    "harbor": "a foggy harbor dock at night, brass gas street lamps, moored steamships, calm dark sea",
    "clockshop": "the interior of an old clock shop, dozens of wall clocks and pendulums, warm afternoon light",
}
BG_STYLE = ("anime background art, cel shaded, visual novel background, 1930s steampunk port city, "
            "no people, no text, no signage, no written words")

timings = []


def sprite_prompt(appearance, expr):
    return f"{STYLE}, {appearance}, {expr}, {FRAMING}, {ISO}, {NO_TEXT}"


def timed(kind, name, secs):
    timings.append({"kind": kind, "name": name, "seconds": round(secs, 1)})
    print(f"{kind:10s} {name:28s} {secs:6.1f}s", flush=True)


def face_box(rgba):
    """Square box around the head, from the cutout silhouette: top of hair + width of the head row."""
    a = np.asarray(rgba.getchannel("A")) > 128
    rows = np.flatnonzero(a.sum(1) > 3)
    y0, y1 = rows[0], rows[-1]
    probe = y0 + int(0.10 * (y1 - y0))
    cols = np.flatnonzero(a[probe])
    cx = (cols[0] + cols[-1]) // 2
    size = int(1.35 * (cols[-1] - cols[0]))
    top = max(0, y0 - size // 10)
    left = int(np.clip(cx - size // 2, 0, rgba.width - size))
    return left, top, left + size, top + size


def paste_face(base, face, box):
    size = box[2] - box[0]
    face = face.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    m = int(size * 0.12)
    ImageDraw.Draw(mask).ellipse((m, m, size - m, size - m), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(size * 0.06))
    out = base.copy()
    out.paste(face, box[:2], mask)
    return out


def sheet(paths, rows_labels, dest, bg=None):
    """Grid: rows = methods, cols = expressions. bg set -> composite RGBA cutouts on that colour."""
    cols = list(EXPR)
    tw, th = W // 2, H // 2
    img = Image.new("RGB", (tw * len(cols), th * len(rows_labels)), (40, 40, 40) if bg is None else bg)
    for r, row in enumerate(rows_labels):
        for c, e in enumerate(cols):
            p = paths.get((row, e))
            if not p:
                continue
            im = Image.open(p)
            im.thumbnail((tw, th))
            if im.mode == "RGBA":
                img.paste(im, (c * tw + (tw - im.width) // 2, r * th + (th - im.height)), im)
            else:
                img.paste(im, (c * tw, r * th))
    img.save(dest)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    from rembg import new_session
    session = new_session("u2net", providers=["CPUExecutionProvider"])

    for cid, look in CHARS.items():
        paths = {}
        for e, ep in EXPR.items():
            p = OUT / f"{cid}_A_{e}.png"
            timed("sprite_A", p.stem, comfy.txt2img(sprite_prompt(look, ep), W, H, SEED, p))
            paths[("A", e)] = p
        base = OUT / f"{cid}_A_calm.png"
        paths[("B", "calm")] = paths[("C", "calm")] = base

        for e, ep in EXPR.items():
            if e == "calm":
                continue
            p = OUT / f"{cid}_B_{e}.png"
            timed("sprite_B", p.stem, comfy.img2img(sprite_prompt(look, ep), base, SEED + 1, B_DENOISE, p))
            paths[("B", e)] = p

        base_rgb = Image.open(base).convert("RGB")
        box = face_box(_alpha_full(base_rgb, session))
        dbg = base_rgb.copy()
        ImageDraw.Draw(dbg).rectangle(box, outline=(255, 0, 0), width=3)
        dbg.save(OUT / f"{cid}_C_facebox.png")
        crop = base_rgb.crop(box).resize((FACE_SIZE, FACE_SIZE), Image.LANCZOS)
        crop_path = OUT / f"{cid}_C_crop.png"
        crop.save(crop_path)
        for e, ep in EXPR.items():
            if e == "calm":
                continue
            fp = OUT / f"{cid}_C_face_{e}.png"
            prompt = f"{STYLE}, close-up of the face of {look}, {ep}, {NO_TEXT}"
            timed("sprite_C", fp.stem, comfy.img2img(prompt, crop_path, SEED + 2, C_DENOISE, fp))
            p = OUT / f"{cid}_C_{e}.png"
            paste_face(base_rgb, Image.open(fp).convert("RGB"), box).save(p)
            paths[("C", e)] = p

        sheet(paths, ["A", "B", "C"], OUT / f"sheet_{cid}_raw.png")
        cut_paths = {}
        for key, p in paths.items():
            cp = OUT / f"{p.stem}_cut.png"
            if not cp.exists():
                cutout(Image.open(p).convert("RGB"), session).save(cp)
            cut_paths[key] = cp
        sheet(cut_paths, ["A", "B", "C"], OUT / f"sheet_{cid}_cut_dark.png", bg=(24, 24, 32))
        sheet(cut_paths, ["A", "B", "C"], OUT / f"sheet_{cid}_cut_light.png", bg=(236, 232, 222))

    for name, desc in BGS.items():
        p = OUT / f"bg_{name}.png"
        timed("background", p.stem, comfy.txt2img(f"{BG_STYLE}, {desc}", 1280, 800, SEED, p))

    (OUT / "timings.json").write_text(json.dumps(timings, indent=1), encoding="utf-8")


def _alpha_full(rgb, session):
    """Uncropped rembg alpha (the SKILL cutout crops to content, which would shift the face box)."""
    from rembg import remove
    return remove(rgb, session=session)


if __name__ == "__main__":
    main()
