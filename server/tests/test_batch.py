"""Batch mode plumbing with a scripted LLM: tree size, option count, scene budget, forced endings, retries.

The acceptance run with the real model and ComfyUI is in docs/dev-log.md; this file only checks the walker.
"""
import asyncio

import pytest

from server import config
from server.batch_service import BatchService, text_progress
from server.llm_client import LLMError, LLMResult
from server.story_store import Store
from server.turn_parser import Cast, repair
from server.turn_service import TurnError, TurnService, tree_size

from .test_store_and_turns import CAND, GAME, NullAssets, ScriptedLLM

BATCH_GAME = {**GAME, "world": {**GAME["world"], "goal": "找回懷錶"}, "batch": {"options": 2, "turns": 3}}


def _reply(scene_id: str, ending: bool = False) -> str:
    return f"""@旁白|calm: 風停了。
@林映月|smile: 走吧。
```json
{{"scene_change": true, "scene": {{"id": "{scene_id}", "name": "地{scene_id}", "image_prompt": "street {scene_id}"}},
 "bgm_mood": "calm", "weather": "none", "options": ["往東", "往西", "往北"],
 "state_changes": {{}}, "summary_update": "走了一段", "ending": {'{"type": "bad", "title": "迷路"}' if ending else "null"}}}
```"""


async def _quiet(_ev):
    pass


class TreeLLM:
    """Answers by prompt content: every turn invents a new scene, the last turn forgets its ending,
    and the action in `fail` always fails."""

    def __init__(self, fail: str | None = None):
        self.candidates = [CAND]
        self.fail = fail
        self.calls = 0

    async def stream(self, messages, emit, temperature=0.8):
        self.calls += 1
        last = messages[-1]["content"]
        if "ending 不可為 null。台詞不要重寫" in last:
            text = '```json\n{"ending": {"type": "good", "title": "歸來"}, "options": []}\n```'
        elif self.fail and last.split("## 玩家本輪行動")[-1].strip().startswith(self.fail):
            raise LLMError([{"model": "t", "reason": "transient"}])
        else:
            text = _reply(f"s{self.calls}")
        await emit({"type": "delta", "text": text})
        return LLMResult(text, "stop", CAND, False)

    async def complete(self, messages, temperature=0.7):
        return await self.stream(messages, _quiet, temperature)


class DoneAssets(NullAssets):
    """Every image counts as drawn, so the batch finishes right after its text."""

    errors: dict = {}

    def ensure_game(self, game, scene_id=None, retry=True):
        pass

    def status(self, game):
        return {"scenes": {s: {"state": "done"} for s in game["scenes"]},
                "sprites": {c["id"]: {"calm": {"state": "done"}} for c in game["characters"]}, "queue": 0}


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.save_game(BATCH_GAME)
    return s


async def _run(store, llm):
    assets = DoneAssets()
    batches = BatchService(store, TurnService(store, llm, assets), assets)
    batches.start("g_test")
    await batches.tasks["g_test"]
    return batches, assets


def test_tree_size():
    assert [tree_size(3, 6), tree_size(2, 8), tree_size(4, 5), tree_size(2, 3)] == [364, 255, 341, 7]


def test_repair_exact_option_count_and_scene_budget():
    cast = Cast(GAME["characters"], "阿澈", "zh")
    cur = {"scene_id": "archive", "bgm_mood": "calm", "weather": "none"}
    d = {"options": ["甲", "乙", "丙"], "scene_change": True,
         "scene": {"id": "pier", "name": "碼頭", "image_prompt": "pier"}}
    result, notes = repair(d, cast, GAME["scenes"], cur, n_options=2, allow_new_scene=False)
    assert result["options"] == ["甲", "乙"] and result["scene_change"] is False
    assert any("scene budget" in n for n in notes)
    result, _ = repair({**d, "options": ["甲"]}, cast, GAME["scenes"], cur, n_options=4)
    assert len(result["options"]) == 4 and result["scene"]["id"] == "pier"


async def test_create_game_checks_batch_size_and_goal(store):
    svc = TurnService(store, ScriptedLLM([]), NullAssets())
    base = {"world": {"era": "x", "place": "y", "goal": "g"}, "protagonist": {"name": "Kai"},
            "characters": [{"name": "Mira", "appearance": "a", "personality": "b", "speech": "c",
                            "relationship": "d"}]}

    async def emit(_ev):
        pass
    for batch in ({"options": 3, "turns": 7}, {"options": 5, "turns": 3}, {"options": "x", "turns": 3}):
        with pytest.raises(TurnError) as e:
            await svc.create_game({**base, "batch": batch}, emit)
        assert e.value.code == "batch_size"
    with pytest.raises(TurnError) as e:
        await svc.create_game({**base, "world": {"era": "x", "place": "y"}, "batch": {"options": 2, "turns": 3}}, emit)
    assert e.value.code == "batch_goal"


async def test_batch_writes_whole_tree_then_replays_it(store, monkeypatch):
    monkeypatch.setattr(config, "BATCH_MAX_SCENES", 3)
    llm = TreeLLM()
    batches, assets = await _run(store, llm)
    tree = store.load_tree("g_test")
    assert len(tree["nodes"]) == 7 and text_progress(BATCH_GAME, tree) == (7, 7)
    leaves = [n for n in tree["nodes"].values() if not n["children"]]
    assert len(leaves) == 4 and all(n["result"]["ending"] == {"type": "good", "title": "歸來"} for n in leaves)
    assert all(len(n["result"]["options"]) == 2 for n in tree["nodes"].values() if n["children"])
    assert len(store.load_game("g_test")["scenes"]) == 3                     # budget holds under parallel turns
    assert store.load_autosave() is None                                     # the walker never moves the autosave
    assert not [k for k, _p in assets.requests if k[0] == "sprite"]
    b = batches.status("g_test")
    assert b["state"] == "done" and b["nodes"] == 7 and b["failed"] == 0

    calls = llm.calls
    root = tree["nodes"][tree["root"]]
    events = []

    async def emit(ev):
        events.append(ev)
    node = await batches.turns.run_turn("g_test", root["id"], {"kind": "option", "text": "往西"}, emit)
    assert llm.calls == calls and events[-1]["replayed"] is True and node["parent"] == root["id"]


async def test_merge_batch_rejoins_the_main_line_and_leaves_no_option_open(store, monkeypatch):
    # Side branches are at most 2 turns long and their last option leads back to the main line one turn on
    monkeypatch.setattr(config, "BATCH_MAX_SCENES", 3)
    store.save_game({**BATCH_GAME, "batch": {"options": 3, "turns": 4, "merge": 2}})
    llm = TreeLLM()
    batches, _ = await _run(store, llm)
    tree = store.load_tree("g_test")
    main = batches.load("g_test")["main"]
    assert len(main) == 4 and tree["nodes"][main[-1]]["result"]["ending"]
    # main 4 + (2 sides x 2 turns) at turns 2 and 3 + 2 forced endings at turn 4
    assert len(tree["nodes"]) == 14 and text_progress(store.load_game("g_test"), tree) == (14, 14)
    for node in tree["nodes"].values():
        if not node["result"]["ending"]:
            assert all(TurnService._existing_child(tree, node, o) for o in node["result"]["options"])
    links = [(n, n["merged_to"]) for n in tree["nodes"].values() if "merged_to" in n]
    assert len(links) == 6 and all(t in main and t in n["children"] for n, t in links)
    assert all(n["result"]["options"][-1] == "往東" for n, _t in links)

    side, target = links[0]
    calls = llm.calls
    node = await batches.turns.run_turn("g_test", side["id"], {"kind": "option", "text": "往東"}, _quiet)
    assert node["id"] == target and llm.calls == calls                      # the rejoin replays, no LLM call


async def test_failed_branch_is_recorded_and_resume_fills_it(store):
    batches, _ = await _run(store, TreeLLM(fail="往西"))
    b = batches.load("g_test")
    assert b["state"] == "done" and len(b["failed"]) == 2                     # root->往西 and 往東->往西
    assert text_progress(BATCH_GAME, store.load_tree("g_test")) == (3, 7)

    batches.turns.llm = TreeLLM()
    batches.start("g_test")
    await batches.tasks["g_test"]
    assert batches.status("g_test")["nodes"] == 7 and batches.load("g_test")["failed"] == []


async def test_cancel_marks_batch_cancelled(store):
    assets = DoneAssets()
    batches = BatchService(store, TurnService(store, TreeLLM(), assets), assets)
    batches.start("g_test")
    await asyncio.sleep(0)
    assert await batches.stop("g_test")
    assert batches.load("g_test")["state"] == "cancelled" and "g_test" not in batches.tasks
