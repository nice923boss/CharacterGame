"""Connection test for the settings page (B01, B02, B05): the smallest possible request on each NVIDIA path.

Spike 2026-10-03 (docs/dev-log.md section 17): NVIDIA checks the key before anything else. A wrong key gets 403
from both endpoints; with a good key the text endpoint answers 200, or 503 when overloaded, to max_tokens 1, and
the image endpoint answers 422 to an empty body without drawing anything. So 503 and 422 still prove the key works.
"""
import time

import httpx

from . import config, nvidia_image

TEXT_URL = f"{config.NV_BASE}/chat/completions"
TIMEOUT = httpx.Timeout(20, connect=10)
CACHE_S = 600                     # the title line shows the last result this long, then "not tested" (B05)
KEY_SEEN = {200, 422, 429, 503}   # answers NVIDIA only gives after it accepted the key
SAVED_AT = "NVIDIA_KEY_SAVED_AT"  # .env line with the date the key was saved in the settings page (B04)

_last: dict = {}


def classify(status: int | None, failure: str = "") -> str:
    """failure: "timeout" or "unreachable" when no HTTP answer came back."""
    if failure:
        return failure
    if status in (401, 403):
        return "key_rejected"
    if status in (200, 422):
        return "ok"
    if status in config.TRANSIENT_STATUS:
        return "busy"
    return "error"


def _request(kind: str) -> tuple[str, dict]:
    if kind == "image":
        return nvidia_image.URL, {}
    model = next(c.model for c in config.CANDIDATES if c.provider == "nvidia")
    return TEXT_URL, {"model": model, "messages": [{"role": "user", "content": "hi"}], "max_tokens": 1,
                      "stream": False}


async def probe(kind: str, key: str) -> dict:
    """kind: "text" or "image". Returns state (see classify), HTTP status (None without an answer) and latency."""
    url, body = _request(kind)
    status, failure = None, ""
    t0 = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            r = await client.post(url, headers={"Authorization": f"Bearer {key}", "Accept": "application/json"},
                                  json=body)
        status = r.status_code
    except httpx.ConnectTimeout:
        failure = "unreachable"
    except httpx.TimeoutException:
        failure = "timeout"
    except httpx.HTTPError:
        failure = "unreachable"
    return {"kind": kind, "state": classify(status, failure), "status": status,
            "ms": round((time.monotonic() - t0) * 1000)}


def remember(results: list[dict]) -> None:
    """Keep what the last test says about the saved key: rejected, valid, or unknown (no answer from NVIDIA)."""
    verdict = ("rejected" if any(r["state"] == "key_rejected" for r in results) else
               "valid" if any(r["status"] in KEY_SEEN for r in results) else None)
    _last.update(at=time.monotonic(), verdict=verdict)


def key_info() -> dict:
    """What the page may know about the saved key: a masked hint, the saved date and the last test result."""
    key = config.ENV.get("NVIDIA_API_KEY", "")
    fresh = _last and time.monotonic() - _last["at"] < CACHE_S
    return {"key_hint": hint(key), "key_saved_at": config.ENV.get(SAVED_AT) or None,
            "key_check": _last["verdict"] if key and fresh else None}


def hint(key: str) -> str:
    """"nvapi-****AB12": enough to tell two keys apart, never enough to use one. Short keys show no tail."""
    if not key:
        return ""
    return ("nvapi-" if key.startswith("nvapi-") else "") + "****" + (key[-4:] if len(key) >= 12 else "")
