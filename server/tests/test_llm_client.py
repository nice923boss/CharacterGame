"""llm_client against httpx.MockTransport: retry groups, candidate switch, watchdog, filters, masking."""
import asyncio
import json

import httpx
import pytest

from server import config
from server.config import Candidate
from server.llm_client import ContentFilter, LLMClient, LLMError, wrapped_error

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
    def __init__(self):
        self.events = []
        self.sleeps = []

    async def emit(self, ev):
        self.events.append(ev)

    async def sleep(self, s):
        self.sleeps.append(s)

    def states(self):
        return [e.get("state") for e in self.events if e["type"] == "status"]


def client(handler, rec, cands=(A, B)):
    return LLMClient(list(cands), httpx.MockTransport(handler), sleep=rec.sleep)


async def test_success_streams_deltas():
    rec = Recorder()
    res = await client(lambda r: httpx.Response(200, content=sse("@A|calm: 你好\n", "世界")), rec).stream([
        {"role": "user", "content": "x"}], rec.emit)
    assert res.content == "@A|calm: 你好\n世界"
    assert "".join(e["text"] for e in rec.events if e["type"] == "delta") == res.content
    assert res.candidate is A and not res.truncated


async def test_transient_on_first_candidate_switches_immediately():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(503, text="overloaded")
        return httpx.Response(200, content=sse("ok 回應內容很長"))

    res = await client(handler, rec).stream([{"role": "user", "content": "x"}], rec.emit)
    assert res.candidate is B
    assert "switch" in rec.states() and rec.sleeps == []


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
            [{"role": "user", "content": "x"}], rec.emit), 3)
    assert e.value.params["errors"][-1]["reason"] == "timeout"


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


async def test_secret_never_in_errors(monkeypatch):
    monkeypatch.setattr(config, "SECRETS", ["sk-SECRET123"])
    rec = Recorder()
    with pytest.raises(LLMError) as e:
        await client(lambda r: httpx.Response(401, text="bad key sk-SECRET123"), rec, (A,)).stream(
            [{"role": "user", "content": "x"}], rec.emit)
    assert "sk-SECRET123" not in str(e.value)
    assert "sk-SECRET123" not in json.dumps(rec.events, ensure_ascii=False)


def test_content_filter_think_and_fffd():
    f = ContentFilter()
    out = f.feed("<thi") + f.feed("nk>想一想</think>\n�@A") + f.feed("|calm: 嗨嗨嗨嗨\n") + f.flush()
    assert out == "@A|calm: 嗨嗨嗨嗨\n"


def test_wrapped_error_shapes():
    assert wrapped_error({"error": {"message": "x", "code": 503}}) == ("x", 503)
    assert wrapped_error({"error": "busy"}) == ("busy", None)
    assert wrapped_error({"object": "error", "message": "m", "code": "429"}) == ("m", 429)
    assert wrapped_error({"choices": []}) is None
