"""Streaming chat client for NVIDIA NIM and the local OpenAI-compatible endpoint.

Implements GBrain nvidia-api-default-settings with the game-specific changes from PLAN section 6:
- per-read watchdog with asyncio.wait_for (httpx's sync iter_lines blocked for 208 s in the spike)
- two retry groups: transient status / connection / timeout, and empty reply
- a transient failure on the first candidate retries briefly ("quality" preference) or switches at once ("speed");
  only the last candidate walks the whole backoff table, then keeps queueing while the player's patience lasts
- Retry-After replaces the backoff table, every other wait gets random jitter so parallel calls spread out
- cooldown per provider+model that grows with failures in a row, RPM sliding window per provider
- content only (reasoning_content dropped, <think> blocks stripped), first 8 chars buffered to drop U+FFFD
- finish_reason / [DONE] double check, errors wrapped inside HTTP 200 (three shapes), secrets masked
Every event for the player goes through `emit(dict)`.
"""
import asyncio
import email.utils
import json
import math
import random
import re
import time
from collections import Counter, deque
from dataclasses import dataclass
from typing import Awaitable, Callable

import httpx

from . import config
from .config import Candidate, mask

Emit = Callable[[dict], Awaitable[None]]
log = config.setup_logging()

# Failure kinds sent to the player as codes (the web client has the text): transient, connect, empty,
# timeout, truncated, gone (model name not found), fatal
RETRYABLE = ("transient", "connect", "truncated", "timeout")
# NVIDIA also answers 404 "Function ...: Not found for account" while a model is briefly unavailable, so only a
# body that names the model as missing skips the retries. An unknown model name gets the gateway's bare
# "404 page not found" (probe 2026-10-03)
MODEL_GONE = re.compile(r"model_not_found|model\b.{0,120}\b(not found|does not exist)|^\s*404 page not found\s*$",
                        re.I | re.S)


@dataclass(frozen=True)
class Waits:
    """The player's choices for one request (settings page): how long to keep queueing when every model is
    busy, whether the first model gets short retries before switching, and the "retry now" button."""
    patience: float = 0             # seconds counted from the start of the request; 0 gives up after the backoff
    prefer: str = "quality"         # "quality": the first model retries before switching; "speed": switch at once
    skip: asyncio.Event | None = None

    @classmethod
    def from_payload(cls, raw, skip: asyncio.Event | None = None) -> "Waits":
        raw = raw if isinstance(raw, dict) else {}
        try:
            patience = min(max(float(raw.get("patience", 0)), 0.0), config.PATIENCE_MAX_S)
        except (TypeError, ValueError):
            patience = 0.0
        return cls(patience, raw.get("prefer") if raw.get("prefer") in ("quality", "speed") else "quality", skip)


def retry_after(value: str | None) -> float | None:
    """Seconds from a Retry-After header (a number or an HTTP date); None when missing or unreadable."""
    if not value:
        return None
    try:
        return max(float(value), 0.0)
    except ValueError:
        pass
    try:
        return max(email.utils.parsedate_to_datetime(value).timestamp() - time.time(), 0.0)
    except (TypeError, ValueError):
        return None


def summarize(rows: list[dict]) -> dict:
    tries = [r for r in rows if r["outcome"] not in ("wait", "switch")]
    first = [r["s"] for r in tries if r["outcome"] == "ok"]
    return {"requests": len(tries), "ok": len(first),
            "failed": dict(Counter(r["outcome"] for r in tries if r["outcome"] != "ok")),
            "status": dict(Counter(str(r["status"]) for r in tries if r["status"])),
            "switches": sum(r["outcome"] == "switch" for r in rows),
            "wait_s": sum(r["s"] for r in rows if r["outcome"] == "wait"),
            "avg_first_s": round(sum(first) / len(first), 1) if first else None}


def busy_level(rows: list[dict]) -> dict:
    """Green / yellow / red from busy failures and the average wait for the first reply text."""
    s = summarize(rows)
    busy = sum(n for kind, n in s["failed"].items() if kind in RETRYABLE)
    avg = s["avg_first_s"] or 0
    level = ("unknown" if not s["requests"] else "red" if busy >= 3 or avg > 25
             else "yellow" if busy or avg > 10 else "green")
    return {"level": level, "busy": busy, "requests": s["requests"], "avg_first_s": s["avg_first_s"]}


class LLMError(Exception):
    """Every candidate failed. `params["errors"]` lists {model, reason} and is safe to show to the player."""

    def __init__(self, errors: list[dict]):
        super().__init__("all_failed: " + "; ".join(f"{e['model']} {e['reason']}" for e in errors))
        self.code = "all_failed"
        self.params = {"errors": errors}


class AttemptFailure(Exception):
    def __init__(self, kind: str, detail: str, partial: bool = False, retry_after: float | None = None,
                 status: int | None = None):
        super().__init__(f"{kind}: {detail}")
        self.kind = kind
        self.detail = mask(detail)
        self.partial = partial   # some text already reached the player
        self.retry_after = retry_after
        self.status = status


@dataclass(frozen=True)
class LLMResult:
    content: str
    finish_reason: str | None
    candidate: Candidate
    truncated: bool
    first_s: float = 0.0     # seconds until the first data line


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
                 sleep=asyncio.sleep, clock=time.monotonic, rand=random.random, wall=time.time):
        self.candidates = candidates or config.CANDIDATES
        self._transport = transport
        self._sleep = sleep
        self._clock = clock
        self._rand = rand
        self._wall = wall
        self.cooldown: dict[str, float] = {}
        self.streak: dict[str, int] = {}        # failures in a row per provider+model
        self._rpm: dict[str, deque] = {}
        self.history: deque = deque(maxlen=config.STATS_KEEP)
        self._client: httpx.AsyncClient | None = None
        self._client_loop = None

    # ---------- public ----------

    async def stream(self, messages: list[dict], emit: Emit = _noop, temperature: float = 0.8,
                     waits: Waits | None = None) -> LLMResult:
        waits = waits or Waits()
        started = self._clock()
        ready = [c for c in self.candidates if self.cooldown.get(c.cooldown_key, 0) <= started]
        if ready:
            for c in self.candidates:
                if c not in ready:
                    await emit({"type": "status", "state": "cooling", "model": c.label,
                                "remaining": math.ceil(self.cooldown[c.cooldown_key] - started)})
        order = ready or list(self.candidates)
        errors = []
        for idx, cand in enumerate(order):
            is_last = idx == len(order) - 1
            retry_n = empty_n = 0
            while True:
                await self._rpm_wait(cand, emit)
                await emit({"type": "status", "state": "waiting", "model": cand.label})
                t0 = self._clock()
                try:
                    res = await self._attempt(cand, messages, emit, temperature)
                except AttemptFailure as f:
                    self._note(cand.label, f.kind, self._clock() - t0, f.status)
                    log.warning("llm %s attempt failed: %s %s", cand.cooldown_key, f.kind, f.detail[:300])
                    errors.append({"model": cand.label, "reason": f.kind})
                    if f.partial:
                        await emit({"type": "reset"})
                    plan = self._retry_plan(f, idx, is_last, retry_n, empty_n, waits, started)
                    if plan:
                        wait, attempt, most = plan
                        if f.kind == "empty":
                            empty_n += 1
                        else:
                            retry_n += 1
                        await self._countdown(wait, emit, {"model": cand.label, "reason": f.kind, "attempt": attempt,
                                                           "max": most, "waited": round(self._clock() - started)},
                                              waits.skip)
                        continue
                    n = self.streak[cand.cooldown_key] = self.streak.get(cand.cooldown_key, 0) + 1
                    steps = config.COOLDOWN_STEPS_S
                    self.cooldown[cand.cooldown_key] = self._clock() + steps[min(n, len(steps)) - 1]
                    if not is_last:
                        self._note(cand.label, "switch", 0)
                        await emit({"type": "status", "state": "switch", "from": cand.label,
                                    "to": order[idx + 1].label, "reason": f.kind})
                    break
                self.streak.pop(cand.cooldown_key, None)
                self.cooldown.pop(cand.cooldown_key, None)
                self._note(cand.label, "ok", res.first_s)
                return res
        raise LLMError(errors[-3:])

    async def complete(self, messages: list[dict], temperature: float = 0.7) -> LLMResult:
        return await self.stream(messages, _noop, temperature)

    def stats(self) -> dict:
        """Today's attempts, waits and switches, and the busy light for the last few minutes."""
        now = self._wall()
        day = time.localtime(now)[:3]
        rows = list(self.history)
        return {"today": summarize([r for r in rows if time.localtime(r["t"])[:3] == day]),
                "recent": busy_level([r for r in rows if now - r["t"] < config.BUSY_WINDOW_S])}

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ---------- internals ----------

    def _note(self, model: str, outcome: str, seconds: float, status: int | None = None) -> None:
        self.history.append({"t": self._wall(), "model": model, "outcome": outcome, "status": status,
                             "s": round(seconds, 1)})

    def _retry_plan(self, f: AttemptFailure, idx: int, is_last: bool, retry_n: int, empty_n: int, waits: Waits,
                    started: float) -> tuple[int, int, int | None] | None:
        """(seconds, attempt number, attempts planned or None while queueing) for another try on the same
        model, or None to move on."""
        if f.kind == "empty":
            table = config.EMPTY_BACKOFF_S
            return (self._wait(table[empty_n], f), empty_n + 1, len(table)) if empty_n < len(table) else None
        if f.kind not in RETRYABLE:
            return None
        if is_last:
            table = config.TRANSIENT_BACKOFF_S
        else:
            table = config.PRIMARY_RETRY_S if idx == 0 and waits.prefer == "quality" else []
        if retry_n < len(table):
            return self._wait(table[retry_n], f), retry_n + 1, len(table)
        left = waits.patience - (self._clock() - started)
        if is_last and left > 0:
            return min(self._wait(config.PATIENCE_STEP_S, f), math.ceil(left)), retry_n + 1, None
        return None

    def _wait(self, base: float, f: AttemptFailure) -> int:
        if f.retry_after is not None:
            return max(1, math.ceil(min(f.retry_after, config.RETRY_AFTER_MAX_S)))
        lo, hi = config.JITTER
        return max(1, round(base * (lo + (hi - lo) * self._rand())))

    async def _countdown(self, seconds: int, emit: Emit, info: dict, skip: asyncio.Event | None = None) -> None:
        waited = 0
        for remaining in range(seconds, 0, -1):
            if skip is not None and skip.is_set():   # the player pressed "retry now"
                skip.clear()
                break
            await emit({"type": "status", "state": "retry", "remaining": remaining, "total": seconds, **info})
            await self._sleep(1)
            waited += 1
        self._note(info["model"], "wait", waited)

    def _http(self) -> httpx.AsyncClient:
        """One connection pool per event loop, so a busy server does not cost a TLS handshake per attempt."""
        loop = asyncio.get_running_loop()
        if self._client is None or self._client_loop is not loop:
            self._client = httpx.AsyncClient(transport=self._transport)
            self._client_loop = loop
        return self._client

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
        first_s = 0.0
        client = self._http()
        req = client.build_request("POST", f"{cand.base_url}/chat/completions", json=body, headers=headers,
                                   timeout=timeout)
        try:
            resp = await asyncio.wait_for(client.send(req, stream=True), config.FIRST_DATA_TIMEOUT_S)
        except asyncio.TimeoutError:
            raise AttemptFailure("timeout", f"no headers in {config.FIRST_DATA_TIMEOUT_S}s")
        except (httpx.ConnectError, httpx.ConnectTimeout, httpx.RemoteProtocolError, httpx.ReadError) as e:
            raise AttemptFailure("connect", f"{type(e).__name__}: {e}")
        try:
            if resp.status_code != 200:
                status = resp.status_code
                text = (await asyncio.wait_for(resp.aread(), 15)).decode("utf-8", "replace")[:300]
                if status == 410 or (status == 404 and MODEL_GONE.search(text)):
                    log.warning("llm %s: model not found or retired, check config.CANDIDATES", cand.model)
                    raise AttemptFailure("gone", f"HTTP {status}: {text}", status=status)
                kind = "transient" if status in config.TRANSIENT_STATUS else "fatal"
                raise AttemptFailure(kind, f"HTTP {status}: {text}", retry_after=retry_after(
                    resp.headers.get("retry-after")), status=status)
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
                if not diag["data_lines"]:
                    first_s = self._clock() - t0
                diag["data_lines"] += 1
                err = wrapped_error(chunk)
                if err:
                    raise AttemptFailure(classify_error(*err), f"wrapped error: {err[0]} ({err[1]})",
                                         bool(filt.sent), status=err[1])
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
        return LLMResult(content, diag["finish"], cand, truncated, first_s)
