"""Story store branching, and TurnService node writing with a scripted LLM (unit level only).

The acceptance run uses the real endpoints (docs/dev-log.md); this file only checks the plumbing.
"""
import asyncio
import json
from datetime import datetime, timedelta

import pytest

from server.config import Candidate
from server.llm_client import LLMResult
from server.story_store import Store
from server.turn_service import TurnError, TurnService

CAND = Candidate("test", "t", "http://t", "X", "scripted")
GAME = {
    "id": "g_test", "seed": 1, "title": "t", "style_en": "", "first_scene": "archive",
    "world": {"era": "1930", "place": "港"}, "protagonist": {"name": "阿澈", "profile": ""},
    "characters": [{"id": "c1", "name": "林映月", "appearance": "", "personality": "", "speech": "",
                    "relationship": "", "appearance_en": "girl", "seed": 1}],
    "scenes": {"archive": {"name": "檔案室", "image_prompt": "archive"}},
}
REPLY = """@旁白|calm: 燈晃了一下。
@林映月|smile: 你來了。
```json
{"scene_change": %s, "scene": {"id": "pier", "name": "碼頭", "image_prompt": "foggy pier"},
 "bgm_mood": "warm", "weather": "rain", "options": ["走", "留", "問"],
 "state_changes": {"affection": {"林映月": 1}}, "summary_update": "見面"}
```"""


class ScriptedLLM:
    def __init__(self, replies):
        self.replies = list(replies)
        self.candidates = [CAND]

    async def stream(self, messages, emit, temperature=0.8, waits=None):
        text = self.replies.pop(0)
        await emit({"type": "delta", "text": text})
        return LLMResult(text, "stop", CAND, False)

    async def complete(self, messages, temperature=0.7):
        return await self.stream(messages, lambda e: asyncio.sleep(0))


class NullAssets:
    def __init__(self):
        self.requests = []

    def request(self, key, priority, retry=True):
        self.requests.append((key, priority))


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.save_game(GAME)
    return s


async def _events():
    out = []

    async def emit(ev):
        out.append(ev)
    return out, emit


async def test_turns_branching_and_snapshots(store):
    svc = TurnService(store, ScriptedLLM([REPLY % "false", REPLY % "true", REPLY % "false"]), NullAssets())
    ev, emit = await _events()
    root = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert [e["line"]["speaker"] for e in ev if e["type"] == "line"] == ["旁白", "林映月"]
    a = await svc.run_turn("g_test", root["id"], {"kind": "option", "text": "走"}, emit)
    b = await svc.run_turn("g_test", root["id"], {"kind": "free", "text": "我想留下"}, emit)
    tree = store.load_tree("g_test")
    assert tree["nodes"][root["id"]]["children"] == [a["id"], b["id"]]
    assert a["scene_id"] == "pier" and b["scene_id"] == "archive"
    assert "pier" in store.load_game("g_test")["scenes"]
    assert a["state"]["affection"]["林映月"] == 2 and root["state"]["affection"]["林映月"] == 1
    assert a["summary"] == ["見面", "見面"]
    assert [n["id"] for n in store.path_to(tree, b["id"])] == [root["id"], b["id"]]
    assert store.load_autosave()["node_id"] == b["id"]


async def test_same_answer_replays_existing_child(store):
    llm = ScriptedLLM([REPLY % "false", REPLY % "true"])
    svc = TurnService(store, llm, NullAssets())
    ev, emit = await _events()
    root = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    a = await svc.run_turn("g_test", root["id"], {"kind": "option", "text": "走"}, emit)
    ev.clear()
    again = await svc.run_turn("g_test", root["id"], {"kind": "free", "text": " 走 "}, emit)
    assert again["id"] == a["id"] and llm.replies == []
    assert [e["line"]["text"] for e in ev if e["type"] == "line"] == [ln["text"] for ln in a["lines"]]
    assert ev[-1]["replayed"] is True
    assert store.load_tree("g_test")["nodes"][root["id"]]["children"] == [a["id"]]


async def test_failed_turn_writes_nothing(store):
    svc = TurnService(store, ScriptedLLM(["```json\n{}\n```"]), NullAssets())
    _, emit = await _events()
    with pytest.raises(TurnError):
        await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert store.load_tree("g_test")["nodes"] == {}


async def test_ending_needs_goal_and_closes_the_branch(store):
    ending = REPLY.replace('"summary_update": "見面"', '"summary_update": "見面", "ending": {"type": "good", "title": "重逢"}')
    svc = TurnService(store, ScriptedLLM([ending % "false", ending % "false"]), NullAssets())
    _, emit = await _events()
    root = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert root["result"]["ending"] is None                                  # the game has no goal
    store.save_game({**GAME, "world": {**GAME["world"], "goal": "找回懷錶"}})
    end = await svc.run_turn("g_test", root["id"], {"kind": "option", "text": "走"}, emit)
    assert end["result"]["ending"] == {"type": "good", "title": "重逢"} and end["result"]["options"] == []
    with pytest.raises(TurnError):
        await svc.run_turn("g_test", end["id"], {"kind": "free", "text": "再走"}, emit)


async def test_missing_json_uses_repair_call(store):
    svc = TurnService(store, ScriptedLLM(["@林映月|sad: 唉。", REPLY % "false"]), NullAssets())
    _, emit = await _events()
    node = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert node["result"]["options"] == ["走", "留", "問"] and len(node["lines"]) == 1


def test_slots_and_atomic_files(store, tmp_path):
    store.add_node("g_test", {"parent": None, "scene_id": "archive"})
    store.save_slot(3, "g_test", "n_0000", "序章")
    assert store.load_slots()[3]["label"] == "序章"
    with pytest.raises(ValueError):
        store.save_slot(3, "g_test", "n_9999", "x")
    assert not list(tmp_path.rglob("*.tmp"))
    with pytest.raises(ValueError):
        store.game_dir("../etc")


def test_delete_game_clears_its_slots_and_autosave(store):
    store.save_game({**GAME, "id": "g_other"})
    for gid in ("g_test", "g_other"):
        store.add_node(gid, {"parent": None, "scene_id": "archive"})
    store.save_slot(0, "g_test", "n_0000", "a")
    store.save_slot(1, "g_other", "n_0000", "b")
    store.set_autosave("g_test", "n_0000", "archive")
    store.delete_game("g_test")
    assert not store.game_dir("g_test").exists()
    slots = store.load_slots()
    assert slots[0] is None and slots[1]["game_id"] == "g_other"
    assert store.load_autosave() is None
    assert [g["id"] for g in store.list_games()] == ["g_other"]
    with pytest.raises(FileNotFoundError):
        store.delete_game("g_test")


def test_delete_game_keeps_autosave_of_another_game(store):
    store.save_game({**GAME, "id": "g_other"})
    store.set_autosave("g_other", "n_0000", "archive")
    store.delete_game("g_test")
    assert store.load_autosave()["game_id"] == "g_other"


def test_thumb_only_once_scene_is_drawn(store):
    assert store.list_games()[0]["thumb"] is None
    assert store.thumb("g_test", None) is None
    png = store.game_dir("g_test") / "assets" / "scenes" / "archive.png"
    png.parent.mkdir(parents=True)
    png.write_bytes(b"png")
    assert store.list_games()[0]["thumb"] == "/media/g_test/assets/scenes/archive.png"


async def test_english_game_prompt_and_turn(store):
    from server import prompts
    game = {**GAME, "lang": "en", "protagonist": {"name": "Kai", "profile": "a courier"},
            "characters": [{**GAME["characters"][0], "name": "Mira"}]}
    store.save_game(game)
    msgs = prompts.turn_messages(game, [], {"kind": "opening", "text": ""}, {"id": "archive", "name": "Archive"})
    assert "Narrator, Mira, Kai" in msgs[0]["content"] and "繁體中文" not in msgs[0]["content"]
    assert "## World\n- Era: 1930" in msgs[1]["content"]
    reply = REPLY.replace("旁白", "Narrator").replace("林映月", "Mira")
    svc = TurnService(store, ScriptedLLM([reply % "false"]), NullAssets())
    _, emit = await _events()
    node = await svc.run_turn("g_test", None, {"kind": "opening"}, emit)
    assert [ln["speaker"] for ln in node["lines"]] == ["Narrator", "Mira"]


def test_summary_folds_into_long_term_memory():
    from server import prompts
    items = [f"事件{i}。" for i in range(1, 25)]
    for n, folded in ((7, 0), (8, 0), (15, 0), (16, 8), (23, 8), (24, 16)):
        memory, recent = prompts.split_summary(items[:n], "zh")
        assert recent == items[folded:n] and bool(memory) == bool(folded)
    memory, _ = prompts.split_summary(items[:16], "zh")
    assert memory == "事件1；事件2；事件3；事件4；事件5；事件6；事件7；事件8。"
    long = [f"{i:02d}" + "長" * 98 for i in range(16)]           # 100 chars each: 5 fit in 600 with separators
    memory, _ = prompts.split_summary(long + ["x"] * 8, "zh")
    assert memory.startswith("…11") and memory.count("；") == 4 and "10" not in memory
    game = {**GAME, "scenes": GAME["scenes"]}
    parent = {"state": {"affection": {}, "flags": [], "items": []}, "summary": items[:16], "lines": [],
              "player_input": {"kind": "opening"}}
    text = prompts.turn_messages(game, [parent], {"kind": "option", "text": "走"}, {"id": "archive", "name": "檔案室"})[1]["content"]
    assert "## 長期記憶（較早的劇情）\n事件1；" in text and "## 前情摘要\n1. 事件9。" in text
    short = prompts.turn_messages(game, [{**parent, "summary": items[:15]}], {"kind": "option", "text": "走"},
                                  {"id": "archive", "name": "檔案室"})[1]["content"]
    assert "長期記憶" not in short and "15. 事件15。" in short


async def test_setup_errors_are_codes(store):
    svc = TurnService(store, ScriptedLLM([]), NullAssets())
    _, emit = await _events()
    base = {"world": {"era": "x", "place": "y"}, "protagonist": {"name": "Kai"},
            "characters": [{"name": "Narrator", "appearance": "a", "personality": "b", "speech": "c",
                            "relationship": "d"}]}
    with pytest.raises(TurnError) as e:
        await svc.create_game({**base, "lang": "en"}, emit)
    assert e.value.code == "dup_names" and e.value.params == {"narrator": "Narrator"}
    long_name = {**base["characters"][0], "name": "x" * 20}
    with pytest.raises(TurnError) as e:
        await svc.create_game({**base, "characters": [long_name]}, emit)            # Chinese limit 12
    assert e.value.code == "too_long" and e.value.params == {"field": "char_name", "limit": 12, "i": 1}


def test_new_game_ids_are_unique_within_one_second(store):
    ids = {store.new_game_id() for _ in range(3)}
    assert len(ids) == 3
    assert all(store.game_dir(g).is_dir() for g in ids)
    assert [g["id"] for g in store.list_games()] == ["g_test"]   # claimed but unsaved folders are not stories


def test_deleted_game_waits_in_trash_and_restores_its_slots(store):
    store.save_game({**GAME, "id": "g_other"})
    for gid in ("g_test", "g_other"):
        store.add_node(gid, {"parent": None, "scene_id": "archive"})
    store.save_slot(0, "g_test", "n_0000", "a")
    store.save_slot(2, "g_test", "n_0000", "c")
    store.delete_game("g_test")
    [item] = store.list_trash()
    assert item["id"] == "g_test" and item["title"] == "t" and item["nodes"] == 1
    assert datetime.fromisoformat(item["expires_at"]) - datetime.fromisoformat(item["deleted_at"]) == timedelta(days=7)
    assert not (store.root / "games" / "g_test" / "game.json").exists()
    store.save_slot(2, "g_other", "n_0000", "taken")                # slot 2 is used again before the restore
    store.restore_game("g_test")
    slots = store.load_slots()
    assert slots[0]["game_id"] == "g_test" and slots[2]["game_id"] == "g_other"
    assert sorted(g["id"] for g in store.list_games()) == ["g_other", "g_test"]
    assert store.list_trash() == [] and not (store.game_dir("g_test") / "deleted.json").exists()
    with pytest.raises(FileNotFoundError):
        store.restore_game("g_test")


def test_trash_purge_and_expiry(store):
    store.delete_game("g_test")
    store.purge_game("g_test")
    assert store.list_trash() == [] and not store.trash_dir("g_test").exists()
    with pytest.raises(FileNotFoundError):
        store.purge_game("g_test")
    store.save_game(GAME)
    store.delete_game("g_test")
    info = store.trash_dir("g_test") / "deleted.json"
    old = datetime.now().astimezone() - timedelta(days=7, minutes=1)
    info.write_text(json.dumps({"deleted_at": old.isoformat(timespec="seconds"), "slots": []}), encoding="utf-8")
    assert store.list_trash() == [] and not store.trash_dir("g_test").exists()


def test_autosave_keeps_the_five_newest_points(store):
    (store.root / "autosave.json").write_text(json.dumps(
        {"game_id": "g_test", "node_id": "n_old", "scene_id": "archive", "saved_at": "2026-10-01T10:00:00+08:00"}),
        encoding="utf-8")
    assert [a["node_id"] for a in store.load_autosaves()] == ["n_old"]     # autosave.json of older versions
    for i in range(6):
        store.set_autosave("g_test", f"n_{i:04d}", "archive")
    store.set_autosave("g_test", "n_0003", "archive")                       # the same point moves to the top
    assert [a["node_id"] for a in store.load_autosaves()] == ["n_0003", "n_0005", "n_0004", "n_0002", "n_0001"]
    assert store.load_autosave()["node_id"] == "n_0003"


def test_story_with_work_under_way_cannot_be_deleted(store, monkeypatch):
    from fastapi import HTTPException
    from server import main
    monkeypatch.setattr(main, "store", store)
    monkeypatch.setattr(main.turns, "_writing", {("g_test", None, "走"): (None, False)})
    assert main.turns.busy("g_test") and not main.turns.busy("g_other")
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.delete_game("g_test"))
    assert e.value.status_code == 409 and e.value.detail == "game_busy"
    monkeypatch.setattr(main.turns, "_writing", {})
    monkeypatch.setattr(main.batches, "status", lambda gid: {"state": "running"})
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.delete_game("g_test"))
    assert e.value.detail == "game_busy"
    assert (store.game_dir("g_test") / "game.json").exists()
