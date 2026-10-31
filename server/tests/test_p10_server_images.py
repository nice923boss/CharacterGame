"""Phase 10 server fixes in the image engines, cutout and batch control (S34..S40). NVIDIA and ComfyUI are faked."""
import asyncio
import base64
import json

import httpx
import numpy as np
import pytest
from PIL import Image

from server import comfy_client, config, cutout, nvidia_image
from server.asset_service import AssetService
from server.batch_service import BatchService
from server.story_store import Store
from server.turn_service import TurnService

from .test_batch import BATCH_GAME, DoneAssets
from .test_nvidia_image import _fake_server, ok
from .test_store_and_turns import ScriptedLLM

SEED_GAME = {"id": "g_1", "seed": 7, "style_en": "", "scenes": {"pier": {"image_prompt": "a pier"}},
             "characters": [{"id": "c1", "seed": 3, "appearance_en": "a woman"}]}


# ---------- S34 nvidia_image ----------

def _art(b64):
    return httpx.Response(200, json={"artifacts": [{"finishReason": "SUCCESS", "base64": b64}]})


@pytest.mark.parametrize("answer, words", [
    (httpx.Response(200, text="<html>gateway</html>"), "不是 JSON"),
    (httpx.Response(200, json=[]), "沒有回傳圖片"),
    (httpx.Response(200, json={"artifacts": "x"}), "沒有回傳圖片"),
    (httpx.Response(200, json={"artifacts": [None]}), "沒有回傳圖片"),
    (_art(None), "沒有回傳圖片"),
    (_art("!!!not base64"), "解不開"),
    (_art(base64.b64encode(b"not an image").decode()), "解不開"),
])
def test_odd_answers_are_retryable_errors(monkeypatch, answer, words):
    _fake_server(monkeypatch, [answer])
    with pytest.raises(nvidia_image.NvidiaImageError, match=words) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert e.value.retryable


def test_non_ascii_key_fails_once_without_a_request(monkeypatch):
    _, posts = _fake_server(monkeypatch, [ok()])
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "nvapi-ab​cdefgh")
    with pytest.raises(nvidia_image.NvidiaImageError) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert not e.value.retryable and posts == []


def test_txt2img_leaves_no_temp_file(monkeypatch, tmp_path):
    _fake_server(monkeypatch, [ok()])
    dest = tmp_path / "scenes" / "pier.png"
    asyncio.run(nvidia_image.txt2img("x", 64, 40, 1, dest))
    assert Image.open(dest).size == (64, 40)
    assert [p.name for p in dest.parent.iterdir()] == ["pier.png"]


# ---------- S35 comfy_client ----------

def _comfy(monkeypatch, tmp_path, post_answer, history):
    """post_answer: the /prompt or /upload answer; history: the /history answers in order."""
    monkeypatch.setattr(config, "COMFY_OUTPUT", tmp_path / "out")

    async def post(self, url, **kwargs):
        return post_answer

    async def get(self, url, **kwargs):
        return history.pop(0)

    async def no_sleep(s):
        pass
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr(httpx.AsyncClient, "get", get)
    monkeypatch.setattr(comfy_client.asyncio, "sleep", no_sleep)


def test_comfy_answer_that_is_not_json(monkeypatch, tmp_path):
    _comfy(monkeypatch, tmp_path, httpx.Response(200, text="<html>proxy</html>"), [])
    with pytest.raises(comfy_client.ComfyError, match="看不懂"):
        asyncio.run(comfy_client.txt2img("x", 64, 64, 1, tmp_path / "a.png"))
    src = tmp_path / "src.png"
    Image.new("RGB", (8, 8)).save(src)
    with pytest.raises(comfy_client.ComfyError, match="上傳回應看不懂"):
        asyncio.run(comfy_client.img2img("x", src, 1, 0.5, tmp_path / "b.png"))


def test_comfy_poll_survives_a_bad_history_answer(monkeypatch, tmp_path):
    out = tmp_path / "out"
    out.mkdir()
    Image.new("RGB", (8, 8), "red").save(out / "cg_1.png")
    done = {"p1": {"status": {"status_str": "success"}, "outputs": {"9": {"images": [{"filename": "cg_1.png"}]}}}}
    _comfy(monkeypatch, tmp_path, httpx.Response(200, json={"prompt_id": "p1"}),
           [httpx.Response(200, text="restarting"), httpx.Response(200, json=[]), httpx.Response(200, json={}),
            httpx.Response(200, json=done)])
    dest = tmp_path / "scene" / "pier.png"
    asyncio.run(comfy_client.txt2img("x", 8, 8, 1, dest))
    assert Image.open(dest).getpixel((0, 0)) == (255, 0, 0)
    assert [p.name for p in dest.parent.iterdir()] == ["pier.png"]


# ---------- S36 asset_service ----------

@pytest.mark.parametrize("content", ["{broken", "[1, 2]", '{"sprite:c1": "12"}'])
def test_damaged_seeds_file_falls_back_to_the_game_seed(tmp_path, content):
    store = Store(tmp_path)
    store.save_game(SEED_GAME)
    svc = AssetService(store)
    path = svc._seeds_path("g_1")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    assert svc._seed(SEED_GAME, "sprite", "c1") == 3
    assert svc.redraw(SEED_GAME, "scene", "pier")                  # writes a fresh seeds.json over the bad one
    assert type(json.loads(path.read_text(encoding="utf-8"))["scene:pier"]) is int
    assert not list(path.parent.glob("*.tmp"))


# ---------- S38 cutout ----------

def test_empty_cutout_gives_a_readable_error():
    empty = Image.new("RGBA", (40, 60), (0, 0, 0, 0))
    with pytest.raises(ValueError, match="去背結果是空的"):
        cutout.padded_bbox(empty)
    with pytest.raises(ValueError, match="去背結果是空的"):
        cutout.face_box(empty)


def test_face_box_skips_a_gap_at_the_ten_percent_row():
    a = np.zeros((120, 80), np.uint8)
    a[10:13, 30:50] = 255          # a floating hat brim
    a[30:110, 20:60] = 255         # the head and body, below a gap that holds the 10% row (y = 19)
    img = Image.new("RGBA", (80, 120))
    img.putalpha(Image.fromarray(a))
    left, top, right, bottom = cutout.face_box(img)
    assert right - left == int(1.35 * 39)                         # width of the first solid row below the mark


# ---------- S39, S40 batch_service ----------

@pytest.fixture
def batch_store(tmp_path):
    s = Store(tmp_path)
    s.save_game(BATCH_GAME)
    return s


def _service(store):
    assets = DoneAssets()
    return BatchService(store, TurnService(store, ScriptedLLM([]), assets), assets)


async def test_stop_pauses_a_batch_cancelled_before_its_first_step(batch_store):
    batches = _service(batch_store)
    batches.start("g_test")
    assert await batches.stop("g_test", "paused")
    assert batches.load("g_test")["state"] == "paused" and batches._stop_as == {}


async def test_stop_pauses_a_running_batch_without_a_task(batch_store):
    batches = _service(batch_store)
    batches._save("g_test", state="running")
    assert await batches.stop("g_test", "paused")
    assert batches.load("g_test")["state"] == "paused"
    assert not await batches.stop("g_test", "paused")               # nothing left to stop


async def test_damaged_batch_files_do_not_stop_resume_or_list(batch_store, tmp_path):
    for gid, text in (("g_bad", "{oops"), ("g_list", "[1]"), ("g-bad", '{"state": "running"}')):
        folder = tmp_path / "games" / gid
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "batch.json").write_text(text, encoding="utf-8")
        (folder / "game.json").write_text("{}", encoding="utf-8")
    batches = _service(batch_store)
    batches._save("g_test", state="running")
    batches.resume_all()
    assert list(batches.tasks) == ["g_test"]
    await batches.stop("g_test", "paused")
    assert [b["id"] for b in batches.list()] == ["g_test"]
