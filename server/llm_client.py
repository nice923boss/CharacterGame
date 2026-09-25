"""Streaming chat client for NVIDIA NIM and the local OpenAI-compatible endpoint.

Implements GBrain nvidia-api-default-settings with the game-specific changes from PLAN section 6:
- per-read watchdog with asyncio.wait_for (httpx's sync iter_lines blocked for 208 s in the spike)
- three retry groups: transient status / connection, empty reply, timeout (no retry, next candidate)
- a transient failure on a candidate that has a fallback switches immediately instead of backing off,
  so the player waits ~2 s instead of up to 62 s
- cooldown per provider+model, RPM sliding window per provider
- content only (reasoning_content dropped, <think> blocks stripped), first 8 chars buffered to drop U+FFFD
- finish_reason / [DONE] double check, errors wrapped inside HTTP 200 (three shapes), secrets masked
Every event for the player goes through `emit(dict)`.
"""
import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx

from . import config
from .config import Candidate, mask

Emit = Callable[[dict], Awaitable[None]]
log = config.setup_logging()

# Failure kinds sent to the player as codes (the web client has the text): transient, connect, empty,
# timeout, truncated, fatal


class LLMError(Exception):
    """Every candidate failed. `params["errors"]` lists {model, reason} and is safe to show to the player."""

    def __init__(self, errors: list[dict]):
        super().__init__("all_failed: " + "; ".join(f"{e['model']} {e['reason']}" for e in errors))
        self.code = "all_failed"
        self.params = {"errors": errors}


class AttemptFailure(Exception):
    def __init__(self, kind: str, detail: str, partial: bool = False):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = mask(detail)
        self.partial = partial   # some text already reached the player


@dataclass(frozen=True)
class LLMResult:
    content: str
    finish_reason: str | None
    candidate: Candidate
    truncated: bool


async def _noop(_event: dict) -> None:
    return None


class ContentFilter:
    """Turns raw content deltas into player-visible text: strips <think> blocks and leading U+FFFD."""

    HEAD = 8

    def __init__(self):
        self.raw = ""
        self.sent = 0          # chars of visible() already handed out

    def visible(self) -> str | None:
        """None while inside (or possibly starting) a <think> block."""
        text = self.raw
        if "</think>" in text:
            text = text.rsplit("</think>", 1)[1]
        else:
            head = text.lstrip()
            if not head or head.startswith("<think>") or "<think>".startswith(head):
                return None
        return text.lstrip("� \r\n\t")

    def feed(self, delta: str) -> str:
        self.raw += delta
        vis = self.visible()
        if vis is None or (not self.sent and len(vis) < self.HEAD and "\n" not in vis):
            return ""
        out = vis[self.sent:]
        self.sent = len(vis)
        return out

    def flush(self) -> str:
        vis = self.visible() or ""
        out = vis[self.sent:]
        self.sent = len(vis)
        return out


def wrapped_error(obj) -> tuple[str, int | None] | None:
    """Recognise an error object sent with HTTP 200: {"error": {...}}, {"error": "str"}, {"object": "error"}."""
    if not isinstance(obj, dict):
        return None
    err = obj.get("error")
    if isinstance(err, dict):
        code = err.get("code") or err.get("status")
        return str(err.get("message") or err), int(code) if str(code).isdigit() else None
    if isinstance(err, str) and err:
        return err, None
    if obj.get("object") == "error":
        code = obj.get("code")
        return str(obj.get("message") or obj), int(code) if str(code).isdigit() else None
    return None


def classify_error(message: str, code: int | None) -> str:
    if code in config.TRANSIENT_STATUS or "overload" in message.lower() or "temporarily" in message.lower():
        return "transient"
    return "fatal"


class LLMClient:
    def __init__(self, candidates=None, transport: httpx.AsyncBaseTransport | None = None,
                 sleep=asyncio.sleep, clock=time.monotonic):
        self.candidates = candidates or config.CANDIDATES
        self._transport = transport
        self._sleep = sleep
        self._clock = clock
        self.cooldown: dict[str, float] = {}
        self._rpm: dict[str, deque] = {}

    # ---------- public ----------

    async def stream(self, messages: list[dict], emit: Emit = _noop, temperature: float = 0.8) -> LLMResult:
        now = self._clock()
        ready = [c for c in self.candidates if self.cooldown.get(c.cooldown_key, 0) <= now]
        order = ready or list(self.candidates)
        errors = []
        for idx, cand in enumerate(order):
            is_last = idx == len(order) - 1
            transient_n = empty_n = 0
            while True:
                await self._rpm_wait(cand, emit)
                await emit({"type": "status", "state": "waiting", "model": cand.label})
                try:
                    return await self._attempt(cand, messages, emit, temperature)
                except AttemptFailure as f:
                    log.warning("llm %s attempt failed: %s %s", cand.cooldown_key, f.kind, f.detail[:300])
                    errors.append({"model": cand.label, "reason": f.kind})
                    if f.partial:
                        await emit({"type": "reset"})
                    info = {"model": cand.label, "reason": f.kind}
                    if f.kind in ("transient", "connect", "truncated") and is_last and \
                            transient_n < len(config.TRANSIENT_BACKOFF_S):
                        wait = config.TRANSIENT_BACKOFF_S[transient_n]
                        transient_n += 1
                        await self._countdown(wait, emit, {**info, "attempt": transient_n,
                                                           "max": len(config.TRANSIENT_BACKOFF_S)})
                        continue
                    if f.kind == "empty" and empty_n < len(config.EMPTY_BACKOFF_S):
                        wait = config.EMPTY_BACKOFF_S[empty_n]
                        empty_n += 1
                        await self._countdown(wait, emit, {**info, "attempt": empty_n,
                                                           "max": len(config.EMPTY_BACKOFF_S)})
                        continue
                    self.cooldown[cand.cooldown_key] = self._clock() + config.COOLDOWN_S
                    if not is_last:
                        await emit({"type": "status", "state": "switch", "from": cand.label,
                                    "to": order[idx + 1].label, "reason": f.kind})
                    break
        raise LLMError(errors[-3:])

    async def complete(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        return await self.stream(messages, _noop, temperature)

    # ---------- internals ----------

    async def _countdown(self, seconds: int, emit: Emit, info: dict) -> None:
        for remaining in range(seconds, 0, -1):
            await emit({"type": "status", "state": "retry", "remaining": remaining, **info})
            await self._sleep(1)

    async def _rpm_wait(self, cand: Candidate, emit: Emit) -> None:
        q = self._rpm.setdefault(cand.provider, deque())
        while True:
            now = self._clock()
            while q and now - q[0] >= 60:
                q.popleft()
            if len(q) < config.RPM_LIMIT:
                q.append(now)
                return
            wait = int(60 - (now - q[0])) + 1
            await emit({"type": "status", "state": "rpm", "remaining": wait, "model": cand.label})
            await self._sleep(1)

    async def _attempt(self, cand: Candidate, messages: list[dict], emit: Emit, temperature: float) -> LLMResult:
        body = {"model": cand.model, "messages": messages, "stream": True, "max_tokens": config.MAX_TOKENS,
                "temperature": temperature, **cand.extra}
        headers = {"Authorization": f"Bearer {cand.api_key}"}
        timeout = httpx.Timeout(connect=config.CONNECT_TIMEOUT_S, read=None, write=30, pool=config.CONNECT_TIMEOUT_S)
        t0 = self._clock()
        deadline = t0 + config.TOTAL_TIMEOUT_S
        filt = ContentFilter()
        diag = {"data_lines": 0, "delta_keys": set(), "finish": None, "done": False, "usage": None,
                "input_chars": sum(len(m["content"]) for m in messages)}
        raw_non_sse: list[str] = []
        async with httpx.AsyncClient(transport=self._transport, timeout=timeout) as client:
            req = client.build_request("POST", f"{cand.base_url}/chat/completions", json=body, headers=headers)
            try:
                resp = await asyncio.wait_for(client.send(req, stream=True), config.FIRST_DATA_TIMEOUT_S)
            except asyncio.TimeoutError:
                raise AttemptFailure("timeout", f"no headers in {config.FIRST_DATA_TIMEOUT_S}s")
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.ReadError) as e:
                raise AttemptFailure("connect", f"{type(e).__name__}: {e}")
            try:
                if resp.status_code != 200:
                    text = (await asyncio.wait_for(resp.aread(), 15)).decode("utf-8", "replace")[:300]
                    kind = "transient" if resp.status_code in config.TRANSIENT_STATUS else "fatal"
                    raise AttemptFailure(kind, f"HTTP {resp.status_code}: {text}")
                lines = resp.aiter_lines()
                while True:
                    now = self._clock()
                    gate = config.IDLE_TIMEOUT_S if diag["data_lines"] else config.FIRST_DATA_TIMEOUT_S - (now - t0)
                    wait = min(gate, deadline - now)
                    if wait <= 0:
                        raise AttemptFailure("timeout", "total time cap", bool(filt.sent))
                    try:
                        line = await asyncio.wait_for(lines.__anext__(), wait)
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError:
                        what = "idle" if diag["data_lines"] else "first data"
                        raise AttemptFailure("timeout", f"{what} watchdog after {wait:.0f}s", bool(filt.sent))
                    except (httpx.ReadError, httpx.RemoteProtocolError) as e:
                        raise AttemptFailure("truncated", f"{type(e).__name__}: {e}", bool(filt.sent))
                    if not line.startswith("data:"):
                        if line.strip() and len(raw_non_sse) < 50:
                            raw_non_sse.append(line)
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        diag["done"] = True
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue
                    diag["data_lines"] += 1
                    err = wrapped_error(chunk)
                    if err:
                        raise AttemptFailure(classify_error(*err), f"wrapped error: {err[0]} ({err[1]})",
                                             bool(filt.sent))
                    if chunk.get("usage"):
                        diag["usage"] = chunk["usage"]
                    for ch in chunk.get("choices") or []:
                        delta = ch.get("delta") or {}
                        diag["delta_keys"].update(k for k, v in delta.items() if v)
                        if delta.get("content"):
                            out = filt.feed(delta["content"])
                            if out:
                                await emit({"type": "delta", "text": out})
                        if ch.get("finish_reason"):
                            diag["finish"] = ch["finish_reason"]
                    if len(filt.raw) > config.CHAR_CAP:
                        diag["finish"] = "char_cap"
                        break
            finally:
                await resp.aclose()

        tail = filt.flush()
        if tail:
            await emit({"type": "delta", "text": tail})
        content = filt.visible() or ""
        if not content.strip():
            body_err = None
            if raw_non_sse:
                try:
                    body_err = wrapped_error(json.loads("\n".join(raw_non_sse)))
                except json.JSONDecodeError:
                    pass
            if body_err:
                raise AttemptFailure(classify_error(*body_err), f"error body with HTTP 200: {body_err[0]}")
            log.warning("llm empty reply diag model=%s data_lines=%s delta_keys=%s finish=%s done=%s usage=%s "
                        "input_chars=%s", cand.model, diag["data_lines"], sorted(diag["delta_keys"]), diag["finish"],
                        diag["done"], diag["usage"], diag["input_chars"])
            raise AttemptFailure("empty", f"no content (data_lines={diag['data_lines']})")
        if diag["finish"] is None and not diag["done"]:
            raise AttemptFailure("truncated", "stream ended without finish_reason and [DONE]", True)
        truncated = diag["finish"] in ("length", "char_cap")
        log.info("llm ok %s %.1fs chars=%d finish=%s", cand.cooldown_key, self._clock() - t0, len(content),
                 diag["finish"])
        return LLMResult(content, diag["finish"], cand, truncated)
