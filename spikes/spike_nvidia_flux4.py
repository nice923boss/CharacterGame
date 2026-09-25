"""Spike step 4: FLUX.2 klein draws fake lettering on screens/whiteboards (cfg 0, so "no text" negatives do not work
and may even invite text). Try positive phrasing: rewrite text-carrying props into blank ones and say what the
surfaces show instead. 2 scenes x 2 seeds, writes scene_v2_*.png and sheet_scenes_v2.png. Never prints the key.
"""
import base64
import io
import json
import pathlib
import re
import sys
import time

import httpx
from PIL import Image

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from _env import api_key  # noqa: E402
from server.asset_service import BG_H, BG_STYLE, BG_W  # noqa: E402

URL = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"
ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "spikes/results/nvidia_flux"
H = {"Authorization": f"Bearer {api_key()}", "Accept": "application/json"}

PROPS = [  # (pattern, replacement): text-carrying props -> blank versions
    (r"\b(screen|monitor|display|tv|television)s?\b[^,]*", "screen showing soft abstract color gradient"),
    (r"\bwhiteboards?\b[^,]*", "clean blank whiteboard"),
    (r"\b(sign|signs|signage|poster|posters|text|letters?|words?|notes|documents|papers?)\b", ""),
]
TAIL = "empty room, fully painted detailed background, all surfaces plain and unmarked"


def flux_scene_prompt(style_en: str, image_prompt: str) -> str:
    p = image_prompt
    for pat, rep in PROPS:
        p = re.sub(pat, rep, p, flags=re.I)
    return f"{BG_STYLE}, {style_en}, {p}, {TAIL}"


def to_scene(sq: Image.Image) -> Image.Image:
    h = round(sq.width * BG_H / BG_W)
    y = (sq.height - h) // 2
    return sq.crop((0, y, sq.width, y + h)).resize((BG_W, BG_H), Image.LANCZOS)


game = json.loads((ROOT / "saves/games/g_20260925_150905/game.json").read_text(encoding="utf-8"))
tiles = []
for sid, sc in game["scenes"].items():
    prompt = flux_scene_prompt(game.get("style_en", ""), sc["image_prompt"])
    print(sid, "|", prompt)
    for k in range(2):
        t = time.time()
        r = httpx.post(URL, headers=H, timeout=120, json={"prompt": prompt, "width": 1024, "height": 1024,
                                                           "seed": (game["seed"] + sum(map(ord, sid)) + k) % 2**31,
                                                           "steps": 4})
        print(" seed+", k, r.status_code, f"{time.time() - t:.1f}s")
        if r.status_code == 200:
            im = to_scene(Image.open(io.BytesIO(base64.b64decode(r.json()["artifacts"][0]["base64"]))).convert("RGB"))
            im.save(OUT / f"scene_v2_{sid}_{k}.png")
            tiles.append(im.resize((640, 400)))
sheet = Image.new("RGB", (1280, 400 * ((len(tiles) + 1) // 2)), "white")
for i, im in enumerate(tiles):
    sheet.paste(im, ((i % 2) * 640, (i // 2) * 400))
sheet.save(OUT / "sheet_scenes_v2.png")
