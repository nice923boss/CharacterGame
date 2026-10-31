"""Phase 10 server fixes in turn_service and turn_parser (S12..S18)."""
import pytest

from server.turn_parser import Cast, last_json, repair
from server.turn_service import TurnError, TurnService

from .test_store_and_turns import NullAssets, ScriptedLLM, _events
from .test_store_and_turns import store  # noqa: F401  (fixture)

CAST = Cast([{"id": "c1", "name": "林映月"}], "阿澈")
CURRENT = {"scene_id": "archive", "bgm_mood": "calm", "weather": "none"}
BASE = {"world": {"era": "1930", "place": "港"}, "protagonist": {"name": "阿澈"},
        "characters": [{"name": "林映月", "appearance": "a", "personality": "b", "speech": "c",
                        "relationship": "d"}]}


# ---------- S13, S14 create_game ----------

async def test_wrong_field_types_give_codes_not_crashes(store):
    svc = TurnService(store, ScriptedLLM([]), NullAssets())
    _, emit = await _events()
    for payload, code in [({**BASE, "world": "港口"}, "required"),
                          ({**BASE, "protagonist": ["阿澈"]}, "required"),
                          ({**BASE, "characters": {"name": "林映月"}}, "char_count"),
                          ({**BASE, "characters": ["林映月"]}, "required")]:
        with pytest.raises(TurnError) as e:
            await svc.create_game(payload, emit)
        assert e.value.code == code, payload


async def test_null_appearance_en_is_not_taken_for_english(store):
    setup = '```json\n{"characters": [{"name": "林映月", "appearance_en": null}], ' \
            '"first_scene": {"id": "pier", "name": "碼頭", "image_prompt": "foggy pier"}}\n```'
    svc = TurnService(store, ScriptedLLM([setup]), NullAssets())
    _, emit = await _events()
    with pytest.raises(TurnError) as e:
        await svc.create_game(BASE, emit)
    assert e.value.code == "setup_unusable"


# ---------- S12 run_turn ----------

async def test_run_turn_rejects_odd_ids_and_inputs(store):
    svc = TurnService(store, ScriptedLLM([]), NullAssets())
    _, emit = await _events()
    with pytest.raises(TurnError) as e:
        await svc.run_turn("g_test", ["n1"], {"kind": "option", "text": "走"}, emit)
    assert e.value.code == "node_not_found"
    with pytest.raises(TurnError) as e:
        await svc.run_turn("g_test", None, "opening", emit)
    assert e.value.code == "bad_input_kind"
    assert not svc.busy("g_test")


# ---------- S18 last_json ----------

def test_last_json_upper_case_fence_and_braces_in_dialogue():
    assert last_json('x\n```JSON\n{"a": 1}\n```') == {"a": 1}
    text = '@林映月|calm: 他寫了 {秘密} 兩個字。\n{"options": ["走", "留", "問"]}'
    assert last_json(text) == {"options": ["走", "留", "問"]}


# ---------- S15..S17 repair ----------

def test_null_and_object_options():
    r, _ = repair({"options": [None, {"text": "走"}, {"label": "留"}, "問", None]}, CAST, {}, CURRENT)
    assert r["options"] == ["走", "留", "問"]
    assert "None" not in r["options"]


def test_null_scene_fields_drop_the_scene_change():
    r, notes = repair({"scene_change": True, "scene": {"id": None, "name": None, "image_prompt": None}},
                      CAST, {}, CURRENT)
    assert r["scene_change"] is False and r["scene"] is None and notes


def test_ending_type_must_be_text():
    r, _ = repair({"ending": {"type": ["good"], "title": "x"}, "options": ["走", "留", "問"]},
                  CAST, {}, CURRENT, allow_ending=True)
    assert r["ending"] is None and r["options"] == ["走", "留", "問"]


def test_infinite_affection_is_skipped():
    r, _ = repair({"state_changes": {"affection": {"林映月": float("inf")}}}, CAST, {}, CURRENT)
    assert r["state_changes"]["affection"] == {}
