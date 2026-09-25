"""Spike: eyes-only expressions for masked characters (145203 c2, half black mask).

Face-box img2img redrew the whole face and changed the mask. Here only an eye band is re-noised
(SetLatentNoiseMask) on a 3x crop of the face, then pasted back, so mask, hair and face stay the calm pixels.
Eye band is framed by hand for this spike; automatic placement is a later decision.
Output goes to spikes/results/eyes_only/ (nothing in saves/ is touched).
"""
import asyncio
import copy
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from server import comfy_client, cutout  # noqa: E402
from server.asset_service import STYLE  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SPRITES = ROOT / "saves/games/g_20260925_145203/assets/sprites/c2"
OUT = ROOT / "spikes/results/eyes_only"
APPEARANCE = "ageless tall thin man, gray-white long hair tied with wooden hairpin, half black mask"
FACE = (148, 1, 355, 280)       # meta.json face box
EYES = (224, 78, 274, 116)      # framed by hand on calm.raw.png: skin gap between the hair strands
# round 1 used (200, 80, 290, 116) and "black mask covering nose and mouth" in the prompt: the band cut into
# hair strands (stray lines, black blots) and at 0.9 the mask grew over the eyes
SCALE = 3
EYE_PROMPT = {
    "smile": "smiling eyes, gently curved happy eyes, relaxed eyebrows",
    "angry": "angry glaring eyes, sharply furrowed eyebrows",
    "sad": "sad teary eyes, eyebrows slanted upward, downcast gaze",
    "surprised": "wide open surprised eyes, small pupils, raised eyebrows",
}
DENOISE = (0.75, 0.9)
SEED = 11


def ellipse_mask(size, box, blur):
    m = Image.new("L", size, 0)
    ImageDraw.Draw(m).ellipse(box, fill=255)
    return m.filter(ImageFilter.GaussianBlur(blur))


async def inpaint(prompt, src, mask, denoise, dest):
    g = copy.deepcopy(comfy_client._BASE)
    g["4"]["inputs"]["text"] = prompt
    g["11"] = {"class_type": "LoadImage", "inputs": {"image": await comfy_client._upload(src)}}
    g["12"] = {"class_type": "LoadImageMask", "inputs": {"image": await comfy_client._upload(mask), "channel": "red"}}
    g["13"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
    g["6"] = {"class_type": "SetLatentNoiseMask", "inputs": {"samples": ["13", 0], "mask": ["12", 0]}}
    g["8"]["inputs"].update(seed=SEED, denoise=denoise)
    return await comfy_client._run(g, dest)


async def main():
    OUT.mkdir(parents=True, exist_ok=True)
    calm = Image.open(SPRITES / "calm.raw.png").convert("RGB")
    fw, fh = FACE[2] - FACE[0], FACE[3] - FACE[1]
    big = ((fw * SCALE) // 16 * 16, (fh * SCALE) // 16 * 16)
    crop = calm.crop(FACE).resize(big, Image.LANCZOS)
    crop.save(OUT / "face_big.png")
    sx, sy = big[0] / fw, big[1] / fh
    eye_big = (int((EYES[0] - FACE[0]) * sx), int((EYES[1] - FACE[1]) * sy),
               int((EYES[2] - FACE[0]) * sx), int((EYES[3] - FACE[1]) * sy))
    ellipse_mask(big, eye_big, 0).convert("RGB").save(OUT / "mask_big.png")
    paste_mask = ellipse_mask(calm.size, EYES, 3)
    crop_box = tuple(json.loads((SPRITES / "meta.json").read_text(encoding="utf-8"))["crop"])
    for d in DENOISE:
        for expr, eyes in EYE_PROMPT.items():
            prompt = f"{STYLE}, close-up of the eyes, {APPEARANCE}, {eyes}"
            raw = OUT / f"{expr}_{d}.big.png"
            s = await inpaint(prompt, OUT / "face_big.png", OUT / "mask_big.png", d, raw)
            face = Image.open(raw).convert("RGB").resize((fw, fh), Image.LANCZOS)
            donor = calm.copy()
            donor.paste(face, FACE[:2])
            merged = Image.composite(donor, calm, paste_mask)
            merged.save(OUT / f"{expr}_{d}.raw.png")
            cutout.cutout_full(merged, key=True).crop(crop_box).save(OUT / f"{expr}_{d}.png")
            diff = np.abs(np.asarray(merged, np.int16) - np.asarray(calm, np.int16)).sum(2) > 24
            print(f"{expr} d={d} {s:.0f}s changed px outside eye box:",
                  int(diff.sum() - diff[EYES[1]:EYES[3], EYES[0]:EYES[2]].sum()))


asyncio.run(main())
