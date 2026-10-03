"""llm_client against httpx.MockTransport: retry groups, candidate switch, watchdog, filters, masking."""
import asyncio
import json

import httpx
import pytest

from server import config
from server.config import Candidate
from server.llm_client import ContentFilter, LLMClient, LLMError, Waits, busy_level, retry_after, wrapped_error

A = Candidate("A", "p1", "http://a", "NVIDIA_API_KEY", "m-a")
B = Candidate("B", "p2", "http://b", "NVIDIA_API_KEY", "m-b")


def sse(*contents, finish="stop", done=True):
    rows = [f"data: {json.dumps({'choices': [{'delta': {'content': c}}]})}" for c in contents]
    if finish:
        rows.append(f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': finish}]})}")
    if done:
        rows.append("data: [DONE]")
    return ("\n\n".join(rows) + "\n\n").encode()


class Recorder:
    """Collects events; sleeping only moves a fake clock forward."""

    def __init__(self):
        self.events = []
        self.sleeps = []
        self.now = 1000.0

    async def emit(self, ev):
        self.events.append(ev)

    async def sleep(self, s):
        self.sleeps.append(s)
        self.now += s

    def clock(self):
        return self.now

    def states(self):
        return [e.get("state") for e in self.events if e["type"] == "status"]


def client(handler, rec, cands=(A, B), rand=0.5):
    # rand 0.5 makes the jitter factor exactly 1.0
    return LLMClient(list(cands), httpx.MockTransport(handler), sleep=rec.sleep, clock=rec.clock,
                     rand=lambda: rand, wall=rec.clock)


async def test_success_streams_deltas():
    rec = Recorder()
    res = await client(lambda r: httpx.Response(200, content=sse("@A|calm: 你好\n", "世界")), rec).stream([
        {"role": "user", "content": "x"}], rec.emit)
    assert res.content == "@A|calm: 你好\n世界"
    assert "".join(e["text"] for e in rec.events if e["type"] == "delta") == res.content
    assert res.candidate is A and not res.truncated


def busy_a(req):
    if req.url.host == "a":
        return httpx.Response(503, text="overloaded")
    return httpx.Response(200, content=sse("ok 回應內容很長"))


async def test_speed_preference_switches_immediately():
    rec = Recorder()
    res = await client(busy_a, rec).stream([{"role": "user", "content": "x"}], rec.emit, waits=Waits(prefer="speed"))
    assert res.candidate is B
    assert "switch" in rec.states() and rec.sleeps == []
    assert [e["status"] for e in rec.events if e.get("state") == "switch"] == [503]   # shown under "details"


async def test_quality_preference_retries_first_model_before_switching():
    rec = Recorder()
    res = await client(busy_a, rec).stream([{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B
    assert sum(rec.sleeps) == sum(config.PRIMARY_RETRY_S)
    retries = [e for e in rec.events if e.get("state") == "retry"]
    assert retries[0]["remaining"] == 3 and retries[0]["max"] == 2 and retries[-1]["attempt"] == 2


async def test_transient_on_last_candidate_counts_down():
    rec = Recorder()
    calls = []

    def handler(req):
        calls.append(1)
        return httpx.Response(429) if len(calls) < 3 else httpx.Response(200, content=sse("第三次成功了"))

    res = await client(handler, rec, (A,)).stream([{"role": "user", "content": "x"}], rec.emit)
    assert res.content == "第三次成功了"
    retries = [e for e in rec.events if e.get("state") == "retry"]
    assert [e["remaining"] for e in retries] == [2, 1, 4, 3, 2, 1]
    assert retries[0]["attempt"] == 1 and retries[-1]["attempt"] == 2
    assert {e["status"] for e in retries} == {429}


async def test_wrapped_error_in_200_and_empty_reply_then_switch():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(200, content=sse(finish=None, done=False) +
                                  b'data: {"error": {"message": "fatal thing", "code": 400}}\n\n')
        return httpx.Response(200, content=sse())            # empty reply

    with pytest.raises(LLMError):
        await client(handler, rec).stream([{"role": "user", "content": "x"}], rec.emit)
    assert rec.sleeps.count(1) == 2 + 5                      # empty backoff 2 s then 5 s on B


async def test_truncated_stream_without_finish_is_failure():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(200, content=sse("斷在一半的內容", finish=None, done=False))
        return httpx.Response(200, content=sse("完整的回應內容"))

    res = await client(handler, rec).stream([{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B
    assert {"type": "reset"} in rec.events                   # partial text on screen gets cleared


async def test_idle_watchdog_switches(monkeypatch):
    monkeypatch.setattr(config, "IDLE_TIMEOUT_S", 0.3)
    rec = Recorder()

    async def stalled():
        yield sse("開頭已經送出", finish=None, done=False)
        await asyncio.sleep(5)

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(200, content=stalled())
        return httpx.Response(200, content=sse("備援回應內容"))

    res = await asyncio.wait_for(client(handler, rec).stream([{"role": "user", "content": "x"}], rec.emit), 3)
    assert res.candidate is B


async def test_first_data_watchdog(monkeypatch):
    monkeypatch.setattr(config, "FIRST_DATA_TIMEOUT_S", 0.3)
    rec = Recorder()

    async def silent():
        await asyncio.sleep(5)
        yield b""

    with pytest.raises(LLMError) as e:
        await asyncio.wait_for(client(lambda r: httpx.Response(200, content=silent()), rec, (A,)).stream(
            [{"role": "user", "content": "x"}], rec.emit), 5)
    assert e.value.params["errors"][-1]["reason"] == "timeout"
    assert sum(rec.sleeps) == sum(config.TRANSIENT_BACKOFF_S)           # a slow server gets the backoff too


async def test_connect_error_and_cooldown():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            raise httpx.ConnectError("refused")
        return httpx.Response(200, content=sse("備援回應內容"))

    c = client(handler, rec)
    await c.stream([{"role": "user", "content": "x"}], rec.emit)
    rec2 = Recorder()
    res = await c.stream([{"role": "user", "content": "x"}], rec2.emit)
    assert res.candidate is B and "switch" not in rec2.states()    # A is cooling down, not retried
    assert "cooling" in rec2.states()


async def test_secret_never_in_errors(monkeypatch):
    monkeypatch.setattr(config, "SECRETS", ["sk-SECRET123"])
    rec = Recorder()
    with pytest.raises(LLMError) as e:
        await client(lambda r: httpx.Response(401, text="bad key sk-SECRET123"), rec, (A,)).stream(
            [{"role": "user", "content": "x"}], rec.emit)
    assert "sk-SECRET123" not in str(e.value)
    assert "sk-SECRET123" not in json.dumps(rec.events, ensure_ascii=False)


def flaky(fails, response):
    """Handler that answers `response()` for the first `fails` calls, then a good reply."""
    calls = []

    def handler(req):
        calls.append(1)
        return response() if len(calls) <= fails else httpx.Response(200, content=sse("終於成功的回應"))
    return handler


async def test_retry_after_header_replaces_backoff_and_is_capped():
    rec = Recorder()
    await client(flaky(1, lambda: httpx.Response(429, headers={"Retry-After": "7"})), rec, (A,)).stream(
        [{"role": "user", "content": "x"}], rec.emit)
    assert sum(rec.sleeps) == 7
    rec = Recorder()
    await client(flaky(1, lambda: httpx.Response(503, headers={"Retry-After": "999"})), rec, (A,)).stream(
        [{"role": "user", "content": "x"}], rec.emit)
    assert sum(rec.sleeps) == config.RETRY_AFTER_MAX_S


def test_retry_after_parsing():
    assert retry_after("12") == 12 and retry_after("-3") == 0
    assert retry_after(None) is None and retry_after("soon") is None
    assert retry_after("Wed, 21 Oct 2015 07:28:00 GMT") == 0             # a date in the past means now


async def test_jitter_spreads_the_backoff():
    low, high = Recorder(), Recorder()
    await client(flaky(2, lambda: httpx.Response(429)), low, (A,), rand=0.0).stream(
        [{"role": "user", "content": "x"}], low.emit)
    await client(flaky(2, lambda: httpx.Response(429)), high, (A,), rand=1.0).stream(
        [{"role": "user", "content": "x"}], high.emit)
    assert sum(low.sleeps) == round(2 * 0.7) + round(4 * 0.7)
    assert sum(high.sleeps) == round(2 * 1.3) + round(4 * 1.3)


async def test_patience_keeps_queueing_until_the_limit():
    rec = Recorder()
    with pytest.raises(LLMError):
        await client(lambda r: httpx.Response(503), rec, (A,)).stream(
            [{"role": "user", "content": "x"}], rec.emit, waits=Waits(patience=100))
    assert sum(rec.sleeps) == 100                                        # 62 s of backoff, then 20 + 18 s queueing
    queued = [e for e in rec.events if e.get("state") == "retry" and e["max"] is None]
    assert queued[0]["remaining"] == 20 and queued[0]["waited"] == 62
    rec = Recorder()
    with pytest.raises(LLMError):
        await client(lambda r: httpx.Response(503), rec, (A,)).stream([{"role": "user", "content": "x"}], rec.emit)
    assert sum(rec.sleeps) == sum(config.TRANSIENT_BACKOFF_S)


async def test_patience_does_not_hide_a_rejected_key():
    rec = Recorder()
    with pytest.raises(LLMError):
        await client(lambda r: httpx.Response(401, text="bad key"), rec, (A,)).stream(
            [{"role": "user", "content": "x"}], rec.emit, waits=Waits(patience=300))
    assert rec.sleeps == []


async def test_retry_now_skips_the_rest_of_the_countdown():
    rec = Recorder()
    skip = asyncio.Event()

    async def sleep(s):
        rec.sleeps.append(s)
        skip.set()                                                       # pressed during the first second

    c = client(flaky(1, lambda: httpx.Response(429)), rec, (A,))
    c._sleep = sleep
    res = await c.stream([{"role": "user", "content": "x"}], rec.emit, waits=Waits(skip=skip))
    assert res.content == "終於成功的回應" and rec.sleeps == [1] and not skip.is_set()


async def test_cancel_during_countdown():
    rec = Recorder()
    forever = asyncio.Event()

    async def sleep(s):
        await forever.wait()

    c = client(lambda r: httpx.Response(503), rec, (A,))
    c._sleep = sleep
    task = asyncio.create_task(c.stream([{"role": "user", "content": "x"}], rec.emit))
    await asyncio.sleep(0.05)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task


async def test_cooldown_grows_with_failures_and_clears_on_success():
    rec = Recorder()
    a_ok = []

    def handler(req):
        if req.url.host == "a" and not a_ok:
            return httpx.Response(503)
        return httpx.Response(200, content=sse("回應內容夠長了"))

    c = client(handler, rec)
    speed = Waits(prefer="speed")
    for expected in (90, 180, 300, 300):
        await c.stream([{"role": "user", "content": "x"}], rec.emit, waits=speed)
        assert c.cooldown[A.cooldown_key] - rec.now == expected
        rec.now += expected + 1
    a_ok.append(1)
    res = await c.stream([{"role": "user", "content": "x"}], rec.emit, waits=speed)
    assert res.candidate is A and A.cooldown_key not in c.streak and A.cooldown_key not in c.cooldown


async def test_model_not_found_switches_without_retrying():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(404, json={"error": {"message": "The model `m-a` does not exist",
                                                       "code": "model_not_found"}})
        return httpx.Response(200, content=sse("備援回應內容"))

    res = await client(handler, rec).stream([{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B and rec.sleeps == []
    # What NVIDIA really answers for an unknown model name (probe 2026-10-03)
    rec = Recorder()
    res = await client(lambda req: httpx.Response(404, text="404 page not found") if req.url.host == "a"
                       else httpx.Response(200, content=sse("備援回應內容")), rec).stream(
        [{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B and rec.sleeps == []
    # A retired model answers 410 (nemotron-3-super, 2026-10-03)
    rec = Recorder()
    res = await client(lambda req: httpx.Response(410, json={"title": "Gone", "detail": "reached its end of life"})
                       if req.url.host == "a" else httpx.Response(200, content=sse("備援回應內容")), rec).stream(
        [{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B and rec.sleeps == []
    assert [e["reason"] for e in rec.events if e.get("state") == "switch"] == ["gone"]
    # NVIDIA's "function not found for account" 404 is a short outage: it is retried
    rec = Recorder()
    await client(flaky(1, lambda: httpx.Response(404, text="Function 'f1': Not found for account 'acc'")),
                 rec, (A,)).stream([{"role": "user", "content": "x"}], rec.emit)
    assert sum(rec.sleeps) == 2


async def test_stats_and_busy_light():
    rec = Recorder()
    c = client(flaky(2, lambda: httpx.Response(429)), rec, (A,))
    await c.stream([{"role": "user", "content": "x"}], rec.emit)
    s = c.stats()
    assert s["today"]["requests"] == 3 and s["today"]["ok"] == 1
    assert s["today"]["status"] == {"429": 2} and s["today"]["wait_s"] == 6
    assert s["recent"]["busy"] == 2 and s["recent"]["level"] == "yellow"
    assert busy_level([])["level"] == "unknown"
    rec.now += config.BUSY_WINDOW_S + 1
    assert c.stats()["recent"]["level"] == "unknown"


def test_waits_from_payload():
    assert Waits.from_payload({"patience": 300, "prefer": "speed"}) == Waits(300, "speed")
    assert Waits.from_payload({"patience": 10 ** 9}).patience == config.PATIENCE_MAX_S
    assert Waits.from_payload({"patience": "x", "prefer": "fast"}) == Waits(0, "quality")
    assert Waits.from_payload(None) == Waits()


def test_content_filter_think_and_fffd():
    f = ContentFilter()
    out = f.feed("<thi") + f.feed("nk>想一想</think>\n�@A") + f.feed("|calm: 嗨嗨嗨嗨\n") + f.flush()
    assert out == "@A|calm: 嗨嗨嗨嗨\n"


def test_wrapped_error_shapes():
    assert wrapped_error({"error": {"message": "x", "code": 503}}) == ("x", 503)
    assert wrapped_error({"error": "busy"}) == ("busy", None)
    assert wrapped_error({"object": "error", "message": "m", "code": "429"}) == ("m", 429)
    assert wrapped_error({"choices": []}) is None


async def test_image_slot_leaves_room_for_the_story_text():
    # Hosted FLUX shares the NVIDIA per-minute window; images stop IMAGE_RPM_RESERVE calls short of the limit
    rec = Recorder()
    c = client(lambda req: None, rec)
    for _ in range(config.RPM_LIMIT - config.IMAGE_RPM_RESERVE):
        await c.image_slot()
    assert rec.sleeps == []
    await c.image_slot()
    assert 59 <= sum(rec.sleeps) <= 61                     # waited for the oldest call to leave the window
    assert list(c._rpm["nvidia"]) == [rec.now]             # the earlier calls (all at one instant) left together
