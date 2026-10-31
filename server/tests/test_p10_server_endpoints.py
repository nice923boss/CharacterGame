"""Phase 10 server fixes in the endpoints and the key probe (S24, S25, S30..S33): odd payloads get a 4xx code
the page can explain, not a 500. Nothing reaches NVIDIA and the real .env is never written."""
import httpx
import pytest
from fastapi import HTTPException

from server import conn_check, main
from server.story_store import SLOT_COUNT, Store

from .test_conn_check import fresh  # noqa: F401  (fixture)
from .test_store_and_turns import GAME


@pytest.fixture
def store(tmp_path, monkeypatch):
    s = Store(tmp_path)
    s.save_game(GAME)
    s.add_node("g_test", {"parent": None, "lines": [], "scene_id": "archive"})
    monkeypatch.setattr(main, "store", s)
    return s


class ModeOnly:
    def __init__(self):
        self.modes = []

    def set_mode(self, mode):
        self.modes.append(mode)


async def _code(call) -> tuple[int, str]:
    with pytest.raises(HTTPException) as e:
        await call
    return e.value.status_code, e.value.detail


async def test_slot_numbers_out_of_range(store):
    assert await _code(main.save_slot(-1, {"game_id": "g_test", "node_id": "n_0000"})) == (400, "bad_slot")
    assert await _code(main.save_slot(SLOT_COUNT, {"game_id": "g_test", "node_id": "n_0000"})) == (400, "bad_slot")
    assert await _code(main.delete_slot(SLOT_COUNT)) == (400, "bad_slot")
    assert await _code(main.delete_slot(-1)) == (400, "bad_slot")


async def test_slot_with_odd_ids_is_a_save_failure(store):
    for payload in ({"game_id": "g_test", "node_id": ["n_0000"]}, {"game_id": 5, "node_id": "n_0000"},
                    {"game_id": "ｇ１", "node_id": "n_0000"}, {}):
        assert await _code(main.save_slot(0, payload)) == (400, "save_failed"), payload
    saved = await main.save_slot(0, {"game_id": "g_test", "node_id": "n_0000", "label": "x"})
    assert saved[0]["node_id"] == "n_0000"


async def test_redraw_with_a_list_target(store):
    for target in (["archive"], {"id": "c1"}, None):
        assert await _code(main.asset_redraw("g_test", {"kind": "scene", "target": target})) == (400, "bad_target")


@pytest.mark.parametrize("key", ["nvapi-ab​cdefgh", "nvapi-ａｂｃｄｅｆｇｈ", "nvapi-ab cdefgh", "x" * 201, 12345])
async def test_unusable_key_is_refused_before_any_request(fresh, monkeypatch, key):
    async def post(self, url, **kwargs):
        raise AssertionError("no request may be sent")
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    assert await _code(main.save_nvidia_key({"key": key})) == (422, "bad_key")
    assert not fresh.exists()


async def test_text_false_does_not_switch_an_engine_on(store, monkeypatch):
    monkeypatch.setattr(main, "assets", ModeOnly())
    settings = await main.save_settings({"image_nvidia": "false", "image_comfy": "true"})
    assert settings["image_nvidia"] is True and settings["image_comfy"] is False
    settings = await main.save_settings({"image_comfy": True})
    assert settings["image_comfy"] is True


async def test_probe_with_non_ascii_key_sends_nothing(monkeypatch):
    async def post(self, url, **kwargs):
        raise AssertionError("no request may be sent")
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    r = await conn_check.probe("text", "nvapi-abcédefgh")
    assert r["state"] == "key_rejected" and r["status"] is None
