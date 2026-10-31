"""Phase 10 server fixes in story_store (S19..S29): damaged index files and ids never break a whole page."""
import json
import os
import time

import pytest

from server import story_store
from server.story_store import DEFAULT_SETTINGS, SLOT_COUNT, Store

from .test_store_and_turns import GAME


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path)
    s.save_game(GAME)
    s.add_node("g_test", {"parent": None, "lines": [], "scene_id": "archive"})
    return s


def test_one_damaged_story_does_not_hide_the_others(store, tmp_path):
    bad = tmp_path / "games" / "g_bad"
    bad.mkdir(parents=True)
    (bad / "game.json").write_text("{not json", encoding="utf-8")
    other = tmp_path / "games" / "g_list"
    other.mkdir(parents=True)
    (other / "game.json").write_text("[1, 2]", encoding="utf-8")
    assert [g["id"] for g in store.list_games()] == ["g_test"]


def test_damaged_settings_fall_back_to_defaults(store, tmp_path):
    (tmp_path / "settings.json").write_text("{", encoding="utf-8")
    assert store.load_settings() == DEFAULT_SETTINGS
    (tmp_path / "settings.json").write_text("[]", encoding="utf-8")
    assert store.load_settings() == DEFAULT_SETTINGS


def test_damaged_slots_file_shows_empty_slots(store, tmp_path):
    (tmp_path / "slots.json").write_text('{"0": 1}', encoding="utf-8")
    assert store.load_slots() == [None] * SLOT_COUNT
    (tmp_path / "slots.json").write_text('[1, "x", {"game_id": 5}, {"game_id": "g_test", "node_id": "n_0000"}]',
                                         encoding="utf-8")
    slots = store.load_slots()
    assert slots[:3] == [None, None, None] and slots[3]["game_id"] == "g_test"
    assert store.save_slot(0, "g_test", "n_0000", "x")[0]["node_id"] == "n_0000"


def test_damaged_autosaves_load_as_empty(store, tmp_path):
    (tmp_path / "autosaves.json").write_text("{oops", encoding="utf-8")
    assert store.load_autosaves() == [] and store.load_autosave() is None
    (tmp_path / "autosaves.json").write_text('[null, {"game_id": "g_test"}, {"game_id": "g_test", "node_id": "n"}]',
                                             encoding="utf-8")
    assert store.load_autosaves() == [{"game_id": "g_test", "node_id": "n"}]
    store.set_autosave("g_test", "n_0000", "archive")
    assert store.load_autosave()["node_id"] == "n_0000"


def test_damaged_trash_record_is_listed_and_purged_by_file_time(store, tmp_path):
    store.delete_game("g_test")
    record = tmp_path / "trash" / "g_test" / "deleted.json"
    record.write_text("{broken", encoding="utf-8")
    listed = store.list_trash()
    assert [t["id"] for t in listed] == ["g_test"] and listed[0]["title"] == "t"
    old = time.time() - 10 * 86400
    os.utime(record, (old, old))
    assert store.list_trash() == []                               # past TRASH_DAYS by the file's own time
    assert not (tmp_path / "trash" / "g_test").exists()


def test_naive_deleted_at_still_compares(store, tmp_path):
    store.delete_game("g_test")
    record = tmp_path / "trash" / "g_test" / "deleted.json"
    record.write_text(json.dumps({"deleted_at": "2020-01-01T00:00:00", "slots": []}), encoding="utf-8")
    assert store.list_trash() == []                               # naive and aware dates no longer raise TypeError


def test_restore_skips_damaged_slot_records(store, tmp_path):
    store.save_slot(2, "g_test", "n_0000", "x")
    store.delete_game("g_test")
    record = tmp_path / "trash" / "g_test" / "deleted.json"
    info = json.loads(record.read_text(encoding="utf-8"))
    info["slots"] += [None, {"slot": 99}, {"slot": "3"}, {"slot": True}]
    record.write_text(json.dumps(info), encoding="utf-8")
    store.restore_game("g_test")
    slots = store.load_slots()
    assert slots[2]["game_id"] == "g_test" and sum(s is not None for s in slots) == 1
    assert (tmp_path / "games" / "g_test" / "game.json").exists()


def test_restore_without_record_is_not_found(store, tmp_path):
    (tmp_path / "trash" / "g_gone").mkdir(parents=True)
    with pytest.raises(FileNotFoundError):
        store.restore_game("g_gone")


def test_delete_slot_out_of_range(store):
    store.save_slot(SLOT_COUNT - 1, "g_test", "n_0000", "x")
    for n in (-1, SLOT_COUNT):
        with pytest.raises(ValueError):
            store.delete_slot(n)
    assert store.load_slots()[SLOT_COUNT - 1] is not None         # -1 used to clear the last slot


@pytest.mark.parametrize("gid", ["ｇ１", "中文", "CON", "nul", "Lpt1", "a/b", "..", "", "x" * 65])
def test_game_dir_rejects_odd_ids(store, gid):
    with pytest.raises(ValueError):
        store.game_dir(gid)
    assert store.thumb(gid, "archive") is None


def test_write_retries_a_locked_target(tmp_path, monkeypatch):
    real, calls = os.replace, []

    def locked_twice(src, dst):
        calls.append(dst)
        if len(calls) <= 2:
            raise PermissionError("held by another process")
        real(src, dst)
    monkeypatch.setattr(story_store.os, "replace", locked_twice)
    monkeypatch.setattr(story_store.time, "sleep", lambda s: None)
    story_store._write(tmp_path / "x.json", {"a": 1})
    assert json.loads((tmp_path / "x.json").read_text(encoding="utf-8")) == {"a": 1}
    assert len(calls) == 3 and not list(tmp_path.glob("*.tmp"))


def test_write_failure_leaves_no_temp_file(tmp_path, monkeypatch):
    def always_locked(src, dst):
        raise PermissionError("held")
    monkeypatch.setattr(story_store.os, "replace", always_locked)
    monkeypatch.setattr(story_store.time, "sleep", lambda s: None)
    with pytest.raises(PermissionError):
        story_store._write(tmp_path / "x.json", {"a": 1})
    assert not list(tmp_path.iterdir())
