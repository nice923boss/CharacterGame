import asyncio

from server import asset_service
from server.asset_service import AssetService
from server.story_store import Store


def test_queued_job_is_skipped_when_file_already_exists(tmp_path, monkeypatch):
    # An expression job makes calm inline; the calm job still in the queue must not render again
    svc = AssetService(Store(tmp_path))
    calm = svc.sprite_path("g_1", "c1", "calm")
    calm.parent.mkdir(parents=True)
    calm.write_bytes(b"png")

    async def no_render(*args, **kwargs):
        raise AssertionError("rendered an image that already exists")

    monkeypatch.setattr(asset_service.comfy_client, "txt2img", no_render)
    asyncio.run(svc._run(("sprite", "g_1", "c1", "calm")))


def test_forget_drops_only_that_games_jobs(tmp_path):
    svc = AssetService(Store(tmp_path))
    svc.request(("scene", "g_1", "pier"), 0)
    svc.request(("sprite", "g_1", "c1", "calm"), 2)
    svc.request(("scene", "g_2", "pier"), 0)
    svc.errors[("sprite", "g_1", "c1", "sad")] = "x"
    svc.forget("g_1")
    assert list(svc.jobs) == [("scene", "g_2", "pier")] and svc.errors == {}


def test_leftovers_of_a_deleted_game_are_removed_after_its_running_job(tmp_path, monkeypatch):
    # The game is deleted while its image is rendering; the render then writes into a fresh folder
    store = Store(tmp_path)
    svc = AssetService(store)
    key = ("scene", "g_1", "pier")

    async def run(k):
        out = svc.scene_path("g_1", "pier")
        out.parent.mkdir(parents=True)
        out.write_bytes(b"png")
        raise asyncio.CancelledError     # stop the endless loop after one job

    monkeypatch.setattr(svc, "_run", run)
    svc.request(key, 0)
    try:
        asyncio.run(svc._loop())
    except asyncio.CancelledError:
        pass
    assert not store.game_dir("g_1").exists()


def test_game_on_screen_jumps_the_queue(tmp_path):
    # Another story's scene was queued first; the story being played still gets its calm portrait first
    svc = AssetService(Store(tmp_path))
    svc.request(("scene", "g_old", "pier"), 0)
    svc.request(("sprite", "g_now", "c1", "calm"), 2)
    assert min(svc.jobs.values(), key=svc._order).key[1] == "g_old"
    svc.active = "g_now"
    assert min(svc.jobs.values(), key=svc._order).key == ("sprite", "g_now", "c1", "calm")


def test_polling_requeues_missing_images_but_not_failed_ones(tmp_path):
    # After a server restart the queue is empty; polling brings the missing images back, failures stay failed
    svc = AssetService(Store(tmp_path))
    game = {"id": "g_1", "characters": [{"id": "c1"}], "scenes": {"pier": {}}}
    svc.errors[("sprite", "g_1", "c1", "sad")] = "comfy down"
    svc.ensure_game(game, "pier", retry=False)
    assert ("scene", "g_1", "pier") in svc.jobs and ("sprite", "g_1", "c1", "calm") in svc.jobs
    assert ("sprite", "g_1", "c1", "sad") not in svc.jobs and ("sprite", "g_1", "c1", "sad") in svc.errors
    svc.ensure_game(game)     # opening the story again retries the failed one
    assert ("sprite", "g_1", "c1", "sad") in svc.jobs
