"""Phase 10 server fixes in config, llm_client and jobs (S01..S11)."""
import asyncio
import json

import httpx
import pytest

from server import config, main
from server.jobs import Job, Jobs
from server.llm_client import LLMError, retry_after

from .test_llm_client import A, B, Recorder, client, flaky, sse

MSG = [{"role": "user", "content": "x"}]


# ---------- S01..S03 config ----------

def test_read_env_skips_bom_and_quotes(tmp_path):
    env = tmp_path / ".env"
    env.write_bytes("﻿NVIDIA_API_KEY=\"nvapi-abc\"\nOTHER='x y'\nPLAIN=v\n".encode("utf-8"))
    assert config._read_env(env) == {"NVIDIA_API_KEY": "nvapi-abc", "OTHER": "x y", "PLAIN": "v"}


def test_set_env_replaces_the_line_of_a_bom_file(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ENV", {})
    monkeypatch.setattr(config, "SECRETS", [])
    env = tmp_path / ".env"
    env.write_bytes("﻿NVIDIA_API_KEY=old\nKEEP=1\n".encode("utf-8"))
    config.set_env("NVIDIA_API_KEY", "new", env)
    lines = env.read_text(encoding="utf-8").splitlines()
    assert lines == ["KEEP=1", "NVIDIA_API_KEY=new"]             # no second line under the BOM-prefixed name
    assert not list(tmp_path.glob("*.tmp"))
    assert config.ENV["NVIDIA_API_KEY"] == "new" and "new" in config.SECRETS


def test_mask_hides_an_unsaved_nvidia_key(monkeypatch):
    monkeypatch.setattr(config, "SECRETS", [])
    assert config.mask("refused nvapi-abcdefgh_12-XY here") == "refused *** here"
    assert config.mask("nvapi-short") == "nvapi-short"           # too short to be a key


# ---------- S04..S09 llm_client ----------

def test_retry_after_nan_is_ignored():
    assert retry_after("nan") is None and retry_after("NaN") is None


async def test_nan_retry_after_falls_back_to_the_backoff_table():
    rec = Recorder()
    res = await client(flaky(1, lambda: httpx.Response(429, headers={"Retry-After": "nan"})), rec, (A,)).stream(
        MSG, rec.emit)
    assert res.content == "終於成功的回應"
    assert sum(rec.sleeps) == 2                                   # first step of the table, jitter factor 1.0


async def test_write_error_switches_to_the_next_model():
    rec = Recorder()

    def handler(req):
        if req.url.host == "a":
            raise httpx.WriteError("pipe closed")
        return httpx.Response(200, content=sse("備援回應內容"))
    res = await client(handler, rec).stream(MSG, rec.emit)
    assert res.candidate is B


async def test_decoding_error_mid_stream_counts_as_truncated():
    rec = Recorder()

    async def broken():
        yield sse("前半段", finish=None, done=False)
        raise httpx.DecodingError("bad gzip")

    def handler(req):
        if req.url.host == "a":
            return httpx.Response(200, content=broken())
        return httpx.Response(200, content=sse("備援回應內容"))
    res = await client(handler, rec).stream(MSG, rec.emit)
    assert res.candidate is B and res.content == "備援回應內容"
    assert "retry" in rec.states()                                # retried as a cut stream, not a crash


async def test_unreadable_error_body_still_retries():
    rec = Recorder()

    async def body():
        raise httpx.ReadError("reset")
        yield b""   # noqa: unreachable, makes this an async generator

    res = await client(flaky(1, lambda: httpx.Response(429, content=body())), rec, (A,)).stream(MSG, rec.emit)
    assert res.content == "終於成功的回應" and sum(rec.sleeps) == 2


async def test_odd_chunks_are_skipped():
    rows = ["data: [1]", "data: \"text\"", 'data: {"choices": "x"}',
            'data: {"choices": [null, {"delta": "s"}, {"delta": {"content": 5}}, {"delta": {"content": null}}]}',
            f"data: {json.dumps({'choices': [{'delta': {'content': '好的內容'}}]})}",
            f"data: {json.dumps({'choices': [{'delta': {}, 'finish_reason': 'stop'}]})}", "data: [DONE]"]
    rec = Recorder()
    res = await client(lambda r: httpx.Response(200, content=("\n\n".join(rows) + "\n\n").encode()), rec,
                       (A,)).stream(MSG, rec.emit)
    assert res.content == "好的內容"


async def test_non_ascii_key_fails_without_sending(monkeypatch):
    monkeypatch.setattr(config, "ENV", {"NVIDIA_API_KEY": "nvapi-ab​cdefgh"})
    calls = []

    def handler(req):
        calls.append(req)
        return httpx.Response(200, content=sse("x"))
    rec = Recorder()
    with pytest.raises(LLMError) as e:
        await client(handler, rec, (A,)).stream(MSG, rec.emit)
    assert calls == [] and rec.sleeps == []
    assert e.value.params["errors"][-1]["reason"] == "fatal"


# ---------- S10, S11 jobs ----------

async def test_job_whose_stream_never_started_is_reaped():
    jobs = Jobs(keep_s=0.02)
    job = Job()
    jobs.add(job)

    async def work():
        try:
            await asyncio.sleep(10)
        finally:
            jobs.ended(job)
    job.task = asyncio.create_task(work())
    await asyncio.sleep(0.05)
    assert job.task.cancelled()
    await asyncio.sleep(0.05)
    assert jobs.get(job.id) is None


async def test_follow_job_attaches_only_while_the_body_runs(monkeypatch):
    jobs = Jobs(keep_s=60)
    monkeypatch.setattr(main, "JOBS", jobs)
    job = Job()
    jobs.add(job)
    job.push({"type": "line", "n": 1})
    resp = main.follow_job(job, 0)
    assert job.followers == 0                                     # a response never sent keeps no follower
    body = resp.body_iterator
    first = await body.__anext__()
    assert job.id in first and job.followers == 1
    jobs.ended(job)
    rest = [chunk async for chunk in body]
    assert '"n": 1' in rest[0] and job.followers == 0
