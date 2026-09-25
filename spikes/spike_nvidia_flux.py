"""Spike: can hosted NVIDIA FLUX.2 klein 4B replace ComfyUI for sprites, expressions and scenes?

Questions:
  Q1 Does Image Editing accept our own image (docs say the preview only takes example ids 0-3)?
  Q2 Same seed + only the expression words changed: does the face stay the same person and in the same place,
     so the existing face-region paste (cutout.region_paste) still works?
  Q3 1024x1024 only: how do the crops look (sprite 512x768, scene 1280x800)?
Uses a real character and scene from saved game g_20260925_150905 so the result sits next to its ComfyUI images.
Writes spikes/results/nvidia_flux/*.png and run.json. Never prints the key.
"""
import base64
import io
import json
import pathlib
import sys
import time

import httpx
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _env import api_key  # noqa: E402
from server import cutout  # noqa: E402
from server.asset_service import BG_H, BG_W, EXPR_PROMPT, SP_H, SP_W, scene_prompt, sprite_prompt  # noqa: E402

URL = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"
ROOT = pathlib.Path(__file__).resolve().parent.parent
GAME = ROOT / "saves/games/g_20260925_150905"
OUT = ROOT / "spikes/results/nvidia_flux"
OUT.mkdir(parents=True, exist_ok=True)
H = {"Authorization": f"Bearer {api_key()}", "Accept": "application/json"}
runs = []


def flux(prompt: str, seed: int, **extra) -> tuple[int, Image.Image | None, float, str]:
    t = time.time()
    r = httpx.post(URL, headers=H, timeout=120,
                   json={"prompt": prompt, "width": 1024, "height": 1024, "seed": seed, "steps": 4, **extra})
    dt = time.time() - t
    if r.status_code != 200:
        return r.status_code, None, dt, r.text[:300]
    art = r.json()["artifacts"][0]
    return 200, Image.open(io.BytesIO(base64.b64decode(art["base64"]))).convert("RGB"), dt, art.get("finishReason", "")


def to_sprite(sq: Image.Image) -> Image.Image:
    w = round(sq.height * SP_W / SP_H)
    x = (sq.width - w) // 2
    return sq.crop((x, 0, x + w, sq.height)).resize((SP_W, SP_H), Image.LANCZOS)


def to_scene(sq: Image.Image) -> Image.Image:
    h = round(sq.width * BG_H / BG_W)
    y = (sq.height - h) // 2
    return sq.crop((0, y, sq.width, y + h)).resize((BG_W, BG_H), Image.LANCZOS)


def log(step: str, status: int, dt: float, note: str) -> None:
    runs.append({"step": step, "status": status, "seconds": round(dt, 2), "note": note})
    print(f"{step:22s} {status} {dt:5.1f}s {note[:120]}")


game = json.loads((GAME / "game.json").read_text(encoding="utf-8"))
chars = game["characters"]
for c in chars:
    cid = c["id"]
    st, sq, dt, note = flux(sprite_prompt(c["appearance_en"], "calm"), c["seed"] % 2**31)
    log(f"{cid} calm", st, dt, note)
    if sq is None:
        continue
    sq.save(OUT / f"{cid}_calm_square.png")
    calm_raw = to_sprite(sq)
    calm_raw.save(OUT / f"{cid}_calm.raw.png")
    full = cutout.cutout_full(calm_raw)
    box, face = cutout.padded_bbox(full), cutout.face_box(full)
    full.crop(box).save(OUT / f"{cid}_calm.png")

    if cid == "c1":   # Q1 once
        buf = io.BytesIO()
        sq.save(buf, "PNG")
        uri = "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()
        st, ed, dt, note = flux("make her smile gently, keep everything else identical", 1,
                                mode="Image Editing", image=uri)
        log("c1 edit (own image)", st, dt, note)
        if ed is not None:
            ed.save(OUT / "c1_edit_smile.png")

    for expr in EXPR_PROMPT:   # Q2: same seed, only the expression words differ
        if expr == "calm":
            continue
        st, dsq, dt, note = flux(sprite_prompt(c["appearance_en"], expr), c["seed"] % 2**31)
        log(f"{cid} {expr}", st, dt, note)
        if dsq is None:
            continue
        donor = to_sprite(dsq)
        donor.save(OUT / f"{cid}_{expr}.donor.png")
        merged = cutout.region_paste(calm_raw, donor, face)
        cutout.cutout_full(merged).crop(box).save(OUT / f"{cid}_{expr}.png")

for sid, sc in game["scenes"].items():   # Q3 scenes
    st, sq, dt, note = flux(scene_prompt(game.get("style_en", ""), sc["image_prompt"]),
                            (game["seed"] + sum(map(ord, sid))) % 2**31)
    log(f"scene {sid[:14]}", st, dt, note)
    if sq is not None:
        to_scene(sq).save(OUT / f"scene_{sid}.png")

(OUT / "run.json").write_text(json.dumps(runs, ensure_ascii=False, indent=1), encoding="utf-8")
