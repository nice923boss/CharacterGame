"""Novel import with a scripted LLM: splitting, the cleaned draft, chapter prompts, novel games and batch order.

The run with a real novel and the real model is in docs/dev-log.md; this file only checks the plumbing.
"""
import json

import pytest

from server import config, prompts
from server.batch_service import BatchService
from server.llm_client import LLMResult
from server.novel_service import NovelService, split_parts
from server.story_store import Store
from server.turn_service import TurnError, TurnService

from .test_batch import BATCH_GAME, DoneAssets, TreeLLM, _quiet
from .test_store_and_turns import CAND, NullAssets, ScriptedLLM

CHAPTERS = [{"title": f"第{i}關", "summary": f"事件{i}"} for i in range(1, 6)]
DRAFT = {"world": {"era": "现代", "place": "台北", "genre": "成长", "tone": "热血", "extra": "", "goal": "成名"},
         "protagonist": {"name": "阿明", "profile": "新人歌手"},
         "characters": [{"name": "小美", "appearance": "长发", "personality": "开朗", "speech": "直率",
                         "relationship": "朋友"},
                        {"name": "小美", "appearance": "重复", "personality": "", "speech": "", "relationship": ""},
                        {"name": "旁白", "appearance": "", "personality": "", "speech": "", "relationship": ""},
                        {"name": "阿明", "appearance": "", "personality": "", "speech": "", "relationship": ""}],
         "chapters": [{"title": f"第{i}关", "summary": f"事件{i}"} for i in range(1, 13)]}


class NovelLLM:
    """Notes for every part, then the draft; remembers every prompt."""

    def __init__(self, draft=DRAFT):
        self.candidates = [CAND]
        self.draft = draft
        self.prompts = []

    async def stream(self, messages, emit, temperature=0.8):
        self.prompts.append(messages[-1]["content"])
        text = f"```json\n{json.dumps(self.draft, ensure_ascii=False)}\n```" if "改編成遊戲設定" in messages[-1][
            "content"] else "人物：阿明"
        return LLMResult(text, "stop", CAND, False)


async def _analyze(llm, text, title="《成名之路》"):
    events = []

    async def emit(ev):
        events.append(ev)
    draft = await NovelService(llm).analyze({"lang": "zh", "title": title, "text": text}, emit)
    return draft, events


def test_split_parts_cuts_at_line_breaks():
    text = "\n".join("甲" * 99 for _ in range(300))           # 30,000 characters in lines of 100
    parts = split_parts(text, 12000)
    assert len(parts) == 3 and all(len(p) <= 12000 for p in parts)
    assert all(len(line) == 99 for p in parts for line in p.split("\n"))        # no line cut in half
    assert sum(len(p.replace("\n", "")) for p in parts) == 99 * 300


async def test_analyze_cleans_the_draft():
    llm = NovelLLM()
    draft, events = await _analyze(llm, ("第一章\n" + "字" * 500 + "\n") * 50)   # about 25,000 characters
    assert [e for e in events if e["type"] == "progress"][-1] == {"type": "progress", "done": 3, "total": 3}
    assert {"type": "phase", "code": "novel_outline"} in events and events[-1]["type"] == "final"
    assert len(llm.prompts) == 4 and "《成名之路》" in llm.prompts[0] and "### 3" in llm.prompts[-1]
    assert draft["world"]["era"] == "現代" and draft["world"]["tone"] == "熱血"       # simplified to traditional
    assert [c["name"] for c in draft["characters"]] == ["小美"]                  # no duplicate, narrator or hero
    assert len(draft["novel"]["chapters"]) == 10 and draft["novel"]["chapters"][0]["title"] == "第1關"
    assert draft["novel"]["title"] == "成名之路"


async def test_analyze_refuses_empty_long_and_unusable():
    with pytest.raises(TurnError) as e:
        await _analyze(NovelLLM(), " \n ")
    assert e.value.code == "novel_empty"
    with pytest.raises(TurnError) as e:
        await _analyze(NovelLLM(), ("字" * 999 + "\n") * 300)                   # 300,000 characters
    assert e.value.code == "novel_too_long"
    with pytest.raises(TurnError) as e:
        await _analyze(NovelLLM({**DRAFT, "chapters": []}), "短篇")
    assert e.value.code == "novel_unusable"


def test_chapter_text_batch_spreads_chapters_over_turns():
    game = {**BATCH_GAME, "novel": {"title": "", "chapters": CHAPTERS}}           # 5 chapters over 3 turns
    t1, t2, t3 = (prompts.chapter_text(game, t, "zh") for t in (1, 2, 3))
    assert "第 1 關「第1關」" in t1 and "下一關「第2關」" in t1
    assert "第 2 到 3 關" in t2 and "下一關「第4關」" in t2
    assert "第 4 到 5 關" in t3 and "最後一關" in t3


def test_chapter_text_live_moves_every_few_turns():
    game = {**BATCH_GAME, "novel": {"title": "", "chapters": CHAPTERS[:3]}}
    del game["batch"]
    step = prompts.LIVE_TURNS_PER_CHAPTER
    assert "第 1 關" in prompts.chapter_text(game, 1, "zh") and "下一關" not in prompts.chapter_text(game, 1, "zh")
    assert "下一關「第2關」" in prompts.chapter_text(game, step, "zh")
    assert "最後一關" in prompts.chapter_text(game, 2 * step + 5, "zh")


def test_turn_messages_include_the_outline():
    game = {**BATCH_GAME, "novel": {"title": "成名之路", "chapters": CHAPTERS}}
    msgs = prompts.turn_messages(game, [], {"kind": "opening", "text": ""}, {"id": "archive", "name": "檔案室"})
    text = msgs[-1]["content"]
    assert "改編自小說《成名之路》" in text and "5. 第5關：事件5" in text and "## 本輪關卡" in text


class SetupAssets(NullAssets):
    def ensure_game(self, game, scene_id=None, retry=True):
        pass


SETUP_REPLY = """```json
{"title": "成名", "style_en": "anime", "characters": [{"name": "Mira", "appearance_en": "girl"}],
 "first_scene": {"id": "stage", "name": "舞台", "image_prompt": "stage"}}
```"""


async def test_create_game_checks_and_keeps_the_novel(tmp_path):
    store = Store(tmp_path)
    base = {"world": {"era": "x", "place": "y"}, "protagonist": {"name": "Kai"},
            "characters": [{"name": "Mira", "appearance": "a", "personality": "b", "speech": "c",
                            "relationship": "d"}]}

    async def emit(_ev):
        pass
    svc = TurnService(store, ScriptedLLM([]), NullAssets())
    for novel, code in (({"chapters": []}, "chapter_count"), ({"chapters": CHAPTERS * 3}, "chapter_count"),
                        ({"chapters": [{"title": "t", "summary": ""}]}, "required"),
                        ({"chapters": [{"title": "長" * 21, "summary": "s"}]}, "too_long")):
        with pytest.raises(TurnError) as e:
            await svc.create_game({**base, "novel": novel}, emit)
        assert e.value.code == code
    svc = TurnService(store, ScriptedLLM([SETUP_REPLY]), SetupAssets())
    game = await svc.create_game({**base, "novel": {"title": "成名之路", "chapters": CHAPTERS}}, emit)
    assert store.load_game(game["id"])["novel"] == {"title": "成名之路", "chapters": CHAPTERS}


async def test_batch_writes_the_players_branch_then_shallow_turns(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "BATCH_CONCURRENCY", 1)
    store = Store(tmp_path)
    store.save_game({**BATCH_GAME, "batch": {"options": 2, "turns": 4}})
    assets = DoneAssets()
    batches = BatchService(store, TurnService(store, TreeLLM(), assets), assets)
    root = await batches.turns.run_turn("g_test", None, {"kind": "opening"}, _quiet)
    west = await batches.turns.run_turn("g_test", root["id"], {"kind": "option", "text": "往西"}, _quiet)
    assert store.load_autosave()["node_id"] == west["id"]                       # the player played up to here

    parents = []
    run_turn = batches.turns.run_turn

    async def spy(gid, parent_id, player_input, emit, batch=False):
        parents.append(parent_id)
        return await run_turn(gid, parent_id, player_input, emit, batch)
    batches.turns.run_turn = spy
    batches.start("g_test")
    await batches.tasks["g_test"]
    tree = store.load_tree("g_test")
    depth = {nid: len(Store.path_to(tree, nid)) for nid in tree["nodes"]}
    under_west = {nid for nid in tree["nodes"] if west["id"] in [n["id"] for n in Store.path_to(tree, nid)]}
    assert len(parents) == 13 and all(p in under_west for p in parents[:6])     # 2 + 4 turns under 往西 first
    assert [depth[p] for p in parents[:6]] == [2, 2, 3, 3, 3, 3]
    assert [depth[p] for p in parents[6:]] == [1, 2, 2, 3, 3, 3, 3]             # then 往東, shallow first
