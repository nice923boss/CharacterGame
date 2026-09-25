from server.turn_parser import (Cast, LineStream, apply_state, clip, last_json, parse_line, repair, to_trad)

CHARS = [{"id": "c1", "name": "林映月"}, {"id": "c2", "name": "沈硯"}]
CAST = Cast(CHARS, "阿澈")
SCENES = {"archive": {"name": "檔案室", "image_prompt": "old archive room"}}
CURRENT = {"scene_id": "archive", "bgm_mood": "mysterious", "weather": "fog"}


def test_line_formats():
    assert parse_line("@林映月|smile: 你好", CAST) == {
        "kind": "character", "speaker": "林映月", "char_id": "c1", "expr": "smile", "text": "你好"}
    assert parse_line("@沈硯: angry: 走開", CAST)["expr"] == "angry"          # qwen variant
    assert parse_line("@沈硯：別動", CAST)["expr"] == "calm"                   # full-width, no expr
    assert parse_line("@映月|happy: 嗯", CAST)["speaker"] == "林映月"           # partial name, bad expr
    assert parse_line("@映月|happy: 嗯", CAST)["expr"] == "calm"


def test_protagonist_narrator_and_unknown():
    assert parse_line("@主角|calm: 我來了", CAST)["speaker"] == "阿澈"
    assert parse_line("@主角|calm: 我來了", CAST)["kind"] == "protagonist"
    assert parse_line("@路人甲|smile: 喂", CAST)["kind"] == "narration"
    assert parse_line("霧笛響起。", CAST)["speaker"] == "旁白"
    assert parse_line("```json", CAST) is None


def test_simplified_converted_names_kept():
    assert to_trad("这个软件", ()) == "這個軟體"
    assert parse_line("@沈硯|calm: 这里没有别人", CAST)["text"] == "這裡沒有別人"
    assert to_trad("沈硯说", ("沈硯",)) == "沈硯說"


def test_line_stream_stops_at_json():
    ls = LineStream(CAST)
    out = ls.feed("@林映月|smile: 早")
    assert out == []
    out = ls.feed("安\n@沈硯|calm: 嗯\n```json\n{\"a\": 1}\n")
    assert [l["text"] for l in out] == ["早安", "嗯"]
    assert ls.finish() == []
    assert len(ls.lines) == 2


def test_last_json_variants():
    assert last_json('x\n```json\n{"a": 1,}\n```') == {"a": 1}
    assert last_json('```json\n{"a": 1}\n```\n```json\n{"a": 2}\n```') == {"a": 2}
    assert last_json('bare {"b": [1, 2,], "c": "x"} tail') == {"b": [1, 2], "c": "x"}
    assert last_json("no json here") is None


def test_repair_scene_reuse_and_drop():
    r, _ = repair({"scene_change": True, "scene": {"id": "x", "name": "檔案室", "image_prompt": "a"}},
                  CAST, SCENES, {**CURRENT, "scene_id": "harbor"})
    assert r["scene"]["id"] == "archive"                                       # reused by name
    r, notes = repair({"scene_change": True, "scene": {"id": "pier", "name": "碼頭", "image_prompt": "碼頭夜景"}},
                      CAST, SCENES, CURRENT)
    assert r["scene_change"] is False and notes                                # non-English prompt dropped
    r, _ = repair({"scene_change": True, "scene": {"id": "Pier Night", "name": "碼頭",
                                                   "image_prompt": "foggy pier at night"}}, CAST, SCENES, CURRENT)
    assert r["scene"]["id"] == "pier_night" and r["weather"] == "none"
    r, _ = repair({"scene_change": True, "scene": {"id": "archive", "name": "檔案室", "image_prompt": "a"}},
                  CAST, SCENES, CURRENT)
    assert r["scene_change"] is False                                         # already here


def test_repair_options_mood_state():
    r, notes = repair({"options": ["1. 追上去", "- 追上去", "x" * 40], "bgm_mood": "epic",
                       "state_changes": {"affection": {"映月": 9, "阿澈": 1, "沈硯": "a"}},
                       "summary_update": "发现怀表"}, CAST, SCENES, CURRENT)
    assert r["options"][0] == "追上去" and len(r["options"][1]) == 24 and len(r["options"]) == 3
    assert r["bgm_mood"] == "mysterious" and r["weather"] == "fog"
    assert r["state_changes"]["affection"] == {"林映月": 3}
    assert r["summary_update"] == "發現懷錶"
    r, notes = repair(None, CAST, SCENES, CURRENT)
    assert "no json" in notes and len(r["options"]) == 3


def test_repair_ending():
    d = {"options": ["走", "留", "問"], "ending": {"type": "good", "title": "雾散之时"}}
    r, notes = repair(d, CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"] == {"type": "good", "title": "霧散之時"} and r["options"] == [] and notes == ["no summary_update"]
    r, _ = repair(d, CAST, SCENES, CURRENT)                                  # no goal or opening turn
    assert r["ending"] is None and r["options"] == ["走", "留", "問"]
    r, _ = repair({**d, "ending": {"type": "bad"}}, CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"] == {"type": "bad", "title": "壞結局"}
    r, _ = repair({**d, "ending": {"type": "maybe"}}, CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"] is None and len(r["options"]) == 3


def test_apply_state_is_new_object():
    s = {"affection": {"林映月": 2}, "flags": ["a"], "items": ["懷錶"]}
    n = apply_state(s, {"affection": {"林映月": 1, "沈硯": -1}, "flags_add": ["a", "b"],
                        "items_add": ["鑰匙"], "items_remove": ["懷錶"]})
    assert n == {"affection": {"林映月": 3, "沈硯": -1}, "flags": ["a", "b"], "items": ["鑰匙"]}
    assert s == {"affection": {"林映月": 2}, "flags": ["a"], "items": ["懷錶"]}


EN_CAST = Cast([{"id": "c1", "name": "Mira Vance"}, {"id": "c2", "name": "Ren"}], "Kai", "en")


def test_english_lines():
    assert parse_line("@Mira Vance|smile: Listen: the clock stopped.", EN_CAST) == {
        "kind": "character", "speaker": "Mira Vance", "char_id": "c1", "expr": "smile",
        "text": "Listen: the clock stopped."}                                  # text colon kept
    assert parse_line("@Mira: Wait: listen.", EN_CAST)["text"] == "Wait: listen."   # not an expression, kept
    assert parse_line("@Ren: angry: Back off.", EN_CAST)["expr"] == "angry"          # qwen variant
    assert parse_line("@Mira|calm: 这个", EN_CAST)["text"] == "这个"                 # no s2t conversion in English
    assert parse_line("@Me|calm: I'm here.", EN_CAST)["speaker"] == "Kai"
    assert parse_line("@Narrator|calm: Fog rolls in.", EN_CAST)["speaker"] == "Narrator"
    assert parse_line("@Ma|calm: hi", EN_CAST)["kind"] == "narration"               # no loose substring match
    assert parse_line("The bell rings.", EN_CAST)["speaker"] == "Narrator"


def test_english_repair_limits_and_labels():
    long = "Walk to the old lighthouse and ask the keeper about the stopped clocks"
    r, _ = repair({"options": [long, "Wait", "Run"], "summary_update": "Met Mira."}, EN_CAST, SCENES, CURRENT)
    assert r["options"][0] == long[:63] + "…" and r["summary_update"] == "Met Mira."
    r, _ = repair({"options": ["Go"]}, EN_CAST, SCENES, CURRENT)
    assert r["options"][1:] == ["Keep listening", "Look around carefully"]
    r, _ = repair({"ending": {"type": "bad"}}, EN_CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"] == {"type": "bad", "title": "Bad Ending"}


def test_markdown_asterisks_never_reach_the_dialog_box():
    # a leading *stage direction* on a spoken line reads like the Chinese （動作） convention
    assert parse_line("@Ren|angry: *cold, final* The east wing is forbidden.", EN_CAST)["text"] == \
        "(cold, final) The east wing is forbidden."
    assert parse_line("@Mira|calm: Your *duty* is the **vigil**.", EN_CAST)["text"] == "Your duty is the vigil."
    assert parse_line("@Narrator|calm: *The music stops.*", EN_CAST)["text"] == "The music stops."
    assert parse_line("@沈硯|calm: （轉身）走吧。", CAST)["text"] == "（轉身）走吧。"
    assert parse_line("@沈硯|calm: *轉身* 走吧。", CAST)["text"] == "（轉身）走吧。"
    r, _ = repair({"options": ["Row to the *Sea Sprite*", "Wait", "Hide"]}, EN_CAST, SCENES, CURRENT)
    assert r["options"][0] == "Row to the Sea Sprite"
    r, _ = repair({"ending": {"type": "good", "title": "The *Last* Note"}}, EN_CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"]["title"] == "The Last Note"


def test_clip_keeps_whole_english_words():
    # a real English setup title was stored as "Singapore Office Proposa"
    assert clip("Singapore Office Proposal Under Pressure Today", 40) == "Singapore Office Proposal Under Pressure"
    assert clip("Winning Over Procurement: A Friday Pitch Story", 30) == "Winning Over Procurement: A"
    assert clip("Short Title", 40) == "Short Title"
    assert clip("霧散之時的最後一盞燈與遠方的歌", 12) == "霧散之時的最後一盞燈與遠"
    r, _ = repair({"ending": {"type": "bad", "title": "Walked Out Before the Client Could Approve Anything"}},
                  EN_CAST, SCENES, CURRENT, allow_ending=True)
    assert r["ending"]["title"] == "Walked Out Before the Client Could"
