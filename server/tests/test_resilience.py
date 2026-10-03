"""Turns that survive dropped streams and failed calls, and jobs that outlive their connection."""
import asyncio

import pytest

from server.jobs import Job, Jobs
from server.llm_client import LLMError, LLMResult
from server.turn_service import TurnService

from .test_store_and_turns import CAND, GAME, REPLY, NullAssets, ScriptedLLM, _events  # noqa: F401
from .test_store_and_turns import store  # noqa: F401  (fixture)

HEAD = "@旁白|calm: 燈晃了一下。\n"
BUSY = [{"model": "t", "reason": "busy"}]


class FailingRepairLLM(ScriptedLLM):
    async def complete(self, messages, temperature=0.7):
        raise LLMError(BUSY)


async def test_failed_repair_call_keeps_the_turn(store):
    svc = TurnService(store, FailingRepairLLM(["@林映月|sad: 唉。\n"]), NullAssets())
    _, emit = await _events()
    node = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert len(node["lines"]) == 1 and len(node["result"]["options"]) >= 2
    assert any("repair call failed" in n for n in node["repair_notes"])
    assert store.load_tree("g_test")["root"] == node["id"]


async def test_resent_opening_replays_the_root(store):
    llm = ScriptedLLM([REPLY % "false"])
    svc = TurnService(store, llm, NullAssets())
    ev, emit = await _events()
    root = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    ev.clear()
    again = await svc.run_turn("g_test", None, {"kind": "opening", "text": ""}, emit)
    assert again["id"] == root["id"] and ev[-1]["replayed"] is True
    assert [e["line"]["text"] for e in ev if e["type"] == "line"] == [ln["text"] for ln in root["lines"]]


class GatedLLM(ScriptedLLM):
    """The first stream waits for `gate`, so a second request can arrive while it runs."""
    def __init__(self, replies):
        super().__init__(replies)
        self.gate = asyncio.Event()
        self.calls = 0

    async def stream(self, messages, emit, temperature=0.8, waits=None):
        self.calls += 1
        await self.gate.wait()
        return await super().stream(messages, emit, temperature, waits)


async def test_resent_turn_waits_for_the_running_one(store):
    llm = GatedLLM([REPLY % "false"])
    svc = TurnService(store, llm, NullAssets())
    first_ev, first = await _events()
    second_ev, second = await _events()
    a = asyncio.create_task(svc.run_turn("g_test", None, {"kind": "opening"}, first))
    await asyncio.sleep(0)
    b = asyncio.create_task(svc.run_turn("g_test", None, {"kind": "opening"}, second))
    await asyncio.sleep(0.01)
    assert {"type": "phase", "code": "same_wait"} in second_ev
    llm.gate.set()
    na, nb = await asyncio.gather(a, b)
    assert na["id"] == nb["id"] and llm.calls == 1 and second_ev[-1]["replayed"] is True
    assert len(store.load_tree("g_test")["nodes"]) == 1


class BreakingLLM(ScriptedLLM):
    """Attempt 1 sends whole and half lines, then every candidate fails; attempt 2 sends the rest."""
    def __init__(self):
        super().__init__([])
        self.seen = []

    async def stream(self, messages, emit, temperature=0.8, waits=None):
        self.seen.append(messages)
        if len(self.seen) == 1:
            await emit({"type": "delta", "text": HEAD + "@林映月|smile: 你來"})
            await emit({"type": "reset"})
            raise LLMError(BUSY)
        rest = (REPLY % "false")[len(HEAD):]
        await emit({"type": "delta", "text": rest})
        return LLMResult(rest, "stop", CAND, False)


async def test_broken_turn_resumes_after_its_whole_lines(store):
    llm = BreakingLLM()
    svc = TurnService(store, llm, NullAssets())
    ev, emit = await _events()
    with pytest.raises(LLMError):
        await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    ev.clear()
    node = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    sent = llm.seen[1]
    assert sent[-2] == {"role": "assistant", "content": HEAD} and sent[-1]["role"] == "user"
    assert ev[0] == {"type": "phase", "code": "resume_partial"}
    assert [e["line"]["speaker"] for e in ev if e["type"] == "line"] == ["旁白", "林映月"]
    assert [ln["speaker"] for ln in node["lines"]] == ["旁白", "林映月"]
    assert node["result"]["options"] == ["走", "留", "問"] and "resumed after a break" in node["repair_notes"]


async def test_resumed_lines_survive_a_reset(store):
    class ResetOnce(BreakingLLM):
        async def stream(self, messages, emit, temperature=0.8, waits=None):
            if len(self.seen) == 1:
                await emit({"type": "delta", "text": "@林映月|smile: 錯"})
                await emit({"type": "reset"})
            return await super().stream(messages, emit, temperature, waits)

    llm = ResetOnce()
    svc = TurnService(store, llm, NullAssets())
    ev, emit = await _events()
    with pytest.raises(LLMError):
        await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    ev.clear()
    node = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert {"type": "reset", "keep": 1} in ev
    assert [ln["text"] for ln in node["lines"]] == ["燈晃了一下。", "你來了。"]


async def test_job_events_can_be_followed_again():
    job = Job()
    job.push({"type": "line", "n": 1})
    job.push({"type": "line", "n": 2})

    async def finish():
        await asyncio.sleep(0.01)
        job.push({"type": "final"})
        job.end()
    asyncio.create_task(finish())
    got = [ev async for ev in job.follow(after=1)]
    assert got == [{"type": "line", "n": 2}, {"type": "final"}]


async def test_quiet_job_stream_pings(monkeypatch):
    monkeypatch.setattr("server.jobs.PING_S", 0.01)
    job = Job()

    async def finish():
        await asyncio.sleep(0.05)
        job.push({"type": "final"})
        job.end()
    asyncio.create_task(finish())
    got = [ev async for ev in job.follow()]
    assert got[0] is None and got[-1] == {"type": "final"}


async def test_unfollowed_job_is_cancelled_then_dropped():
    jobs = Jobs(keep_s=0.02)
    job = Job()
    jobs.add(job)

    async def work():
        try:
            await asyncio.sleep(10)
        finally:
            jobs.ended(job)
    job.task = asyncio.create_task(work())
    jobs.attach(job)
    jobs.detach(job)                    # the stream dropped and nobody came back
    await asyncio.sleep(0.05)
    assert job.task.cancelled()
    await asyncio.sleep(0.05)
    assert jobs.get(job.id) is None


async def test_followed_job_is_kept():
    jobs = Jobs(keep_s=0.02)
    job = Job()
    jobs.add(job)
    jobs.attach(job)
    jobs.attach(job)
    jobs.detach(job)                    # one follower left, one still reading
    await asyncio.sleep(0.05)
    assert jobs.get(job.id) is job
