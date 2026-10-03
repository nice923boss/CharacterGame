"""Hosted NVIDIA FLUX.2 klein 4B txt2img (spike section 7).

The endpoint only draws 1024x1024 and takes no input image, so sprites and scenes are center-cropped to the game
sizes, and expressions are redrawn whole with the same seed. The key is read from config at request time and
never appears in errors or logs. Busy answers and network errors retry with the backoff table (a Retry-After
header replaces the table step); one connection pool is shared by every call.
"""
import asyncio
import base64
import io
import pathlib
import re
from collections.abc import Awaitable, Callable

import httpx
from PIL import Image

from . import config
from .llm_client import retry_after

URL = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b"
SIZE = 1024
STEPS = 4
TIMEOUT_S = 120
RETRY_STATUS = {429, 500, 502, 503, 504}
RETRY_BACKOFF_S = [3, 8, 20, 45]
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
    """retryable: False when trying the same prompt again later cannot help (filtered prompt, refused key)."""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


_client: httpx.AsyncClient | None = None
_client_loop = None


def _http() -> httpx.AsyncClient:
    """One connection pool per event loop, so a busy server does not cost a TLS handshake per image."""
    global _client, _client_loop
    loop = asyncio.get_running_loop()
    if _client is None or _client_loop is not loop:
        _client = httpx.AsyncClient(timeout=TIMEOUT_S)
        _client_loop = loop
    return _client


async def aclose() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


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


Gate = Callable[[], Awaitable[None]]


async def _draw(prompt: str, seed: int, gate: Gate | None = None) -> Image.Image:
    """gate: awaited before every attempt (the RPM window shared with the chat models)."""
    key = config.ENV.get("NVIDIA_API_KEY", "")
    if not key:
        raise NvidiaImageError("未設定 NVIDIA_API_KEY", retryable=False)
    body = {"prompt": soften(prompt), "width": SIZE, "height": SIZE, "seed": seed % 2**31, "steps": STEPS}
    headers = {"Authorization": f"Bearer {key}", "Accept": "application/json"}
    for backoff in [*RETRY_BACKOFF_S, None]:
        if gate:
            await gate()
        try:
            r = await _http().post(URL, headers=headers, json=body)
        except httpx.HTTPError as e:
            if backoff is None:
                raise NvidiaImageError(f"連不上輝達生圖（{type(e).__name__}）") from e
            await asyncio.sleep(backoff)
            continue
        if r.status_code == 200:
            break
        if r.status_code not in RETRY_STATUS or backoff is None:
            # a 404 body carries the account id, so only the status is reported for it. NVIDIA also answers 404
            # while a function is briefly unavailable, so a later round may still work
            detail = "" if r.status_code == 404 else f" {_safe(r.text)}"
            raise NvidiaImageError(f"輝達生圖失敗：HTTP {r.status_code}{detail}",
                                   retryable=r.status_code in RETRY_STATUS or r.status_code == 404)
        hint = retry_after(r.headers.get("retry-after"))
        await asyncio.sleep(backoff if hint is None else min(hint, config.RETRY_AFTER_MAX_S))
    art = (r.json().get("artifacts") or [{}])[0]
    if art.get("finishReason") != "SUCCESS" or not art.get("base64"):
        reason = _safe(str(art.get("finishReason")))
        if reason == "CONTENT_FILTERED":
            raise NvidiaImageError("輝達內容過濾擋下這段提示詞（CONTENT_FILTERED）", retryable=False)
        raise NvidiaImageError(f"輝達生圖沒有回傳圖片（{reason}）")
    return Image.open(io.BytesIO(base64.b64decode(art["base64"]))).convert("RGB")


async def txt2img(prompt: str, width: int, height: int, seed: int, dest: pathlib.Path,
                  gate: Gate | None = None) -> None:
    img = fit(await _draw(prompt, seed, gate), width, height)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img.save(dest)
