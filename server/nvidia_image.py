"""Hosted NVIDIA FLUX.2 klein 4B txt2img (spike section 7).

The endpoint only draws 1024x1024 and takes no input image, so sprites and scenes are center-cropped to the game
sizes, and expressions are redrawn whole with the same seed. The key is read from config at request time and
never appears in errors or logs.
"""
import asyncio
import base64
import io
import pathlib
import re

import httpx
from PIL import Image

from . import config

URL = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"
SIZE = 1024
STEPS = 4
TIMEOUT_S = 120
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRY_BACKOFF_S = [3, 8]
# Words the hosted prompt filter rejects outright (CONTENT_FILTERED for any seed, probed 2026-09-25), with
# tested stand-ins. The list is not exhaustive: an unknown word still fails and falls back or reports it.
SOFTEN = [
    (r"\bgritty\b", "weathered"),
    (r"\bhorror(s)?\b|\bhorrific\b", "eerie"),
    (r"\bwars?\b", "old conflict"),
    (r"\bzombies?\b", "undead"),
]


def soften(prompt: str) -> str:
    for pattern, stand_in in SOFTEN:
        prompt = re.sub(pattern, stand_in, prompt, flags=re.I)
    return prompt


class NvidiaImageError(Exception):
    pass


def available() -> bool:
    return bool(config.ENV.get("NVIDIA_API_KEY"))


def _safe(text: str) -> str:
    """Error text for logs and the player: known secrets and NVIDIA account ids removed."""
    return re.sub(r"ONT_[A-Za-z0-9_-]+", "***", config.mask(text))[:200]


def fit(square: Image.Image, width: int, height: int) -> Image.Image:
    """Center-crop the square to the target aspect ratio, then resize."""
    if width / height < 1:
        w = round(square.height * width / height)
        x = (square.width - w) // 2
        box = (x, 0, x + w, square.height)
    else:
        h = round(square.width * height / width)
        y = (square.height - h) // 2
        box = (0, y, square.width, y + h)
    return square.crop(box).resize((width, height), Image.LANCZOS)


async def _draw(prompt: str, seed: int) -> Image.Image:
    key = config.ENV.get("NVIDIA_API_KEY", "")
    if not key:
        raise NvidiaImageError("未設定 NVIDIA_API_KEY")
    body = {"prompt": soften(prompt), "width": SIZE, "height": SIZE, "seed": seed % 2**31, "steps": STEPS}
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    async with httpx.AsyncClient(timeout=TIMEOUT_S) as c:
        for wait in [*RETRY_BACKOFF_S, None]:
            try:
                r = await c.post(URL, headers=headers, json=body)
            except httpx.HTTPError as e:
                raise NvidiaImageError(f"連不上輝達生圖（{type(e).__name__}）") from e
            if r.status_code == 200:
                break
            if r.status_code not in RETRY_STATUS or wait is None:
                # a 404 body carries the account id, so only the status is reported for it
                detail = "" if r.status_code == 404 else f" {_safe(r.text)}"
                raise NvidiaImageError(f"輝達生圖失敗：HTTP {r.status_code}{detail}")
            await asyncio.sleep(wait)
    art = (r.json().get("artifacts") or [{}])[0]
    if art.get("finishReason") != "SUCCESS" or not art.get("base64"):
        reason = _safe(str(art.get("finishReason")))
        if reason == "CONTENT_FILTERED":
            raise NvidiaImageError("輝達內容過濾擋下這段提示詞（CONTENT_FILTERED）")
        raise NvidiaImageError(f"輝達生圖沒有回傳圖片（{reason}）")
    return Image.open(io.BytesIO(base64.b64decode(art["base64"]))).convert("RGB")


async def txt2img(prompt: str, width: int, height: int, seed: int, dest: pathlib.Path) -> None:
    img = fit(await _draw(prompt, seed), width, height)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest)
