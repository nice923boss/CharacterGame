"""Story store branching, and TurnService node writing with a scripted LLM (unit level only).

The acceptance run uses the real endpoints (docs/dev-log.md); this file only checks the plumbing.
"""
import asyncio

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

    async def stream(self, messages, emit, temperature=0.8):
        text = self.replies.pop(0)
        await emit({"type": "delta", "text": text})
        return LLMResult(text, "stop", CAND, False)

    async def complete(self, messages, temperature=0.7):
        return await self.stream(messages, lambda e: asyncio.sleep(0))


class NullAssets:
    def __init__(self):
        self.requests = []

    def request(self, key, priority):
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
