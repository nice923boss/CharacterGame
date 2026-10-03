import asyncio

import numpy as np
import pytest
from PIL import Image

from server import asset_service, cutout
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


# ---------- image engines (NVIDIA FLUX.2 / ComfyUI) ----------

def _scene_setup(tmp_path, monkeypatch, settings, nvidia_fails=False):
    store = Store(tmp_path)
    store.save_settings(settings)
    svc = AssetService(store)
    calls, gates = [], []
    svc.gates = gates

    def fake(engine, fail):
        async def draw(prompt, w, h, seed, dest, gate=None):
            calls.append(engine)
            gates.append(gate)
            if fail:
                raise RuntimeError(f"{engine} down")
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"png")
        return draw

    monkeypatch.setattr(asset_service.nvidia_image, "txt2img", fake("nvidia", nvidia_fails))
    monkeypatch.setattr(asset_service.comfy_client, "txt2img", fake("comfy", False))
    game = {"id": "g_1", "seed": 7, "style_en": "", "scenes": {"pier": {"image_prompt": "a pier"}}}
    return svc, game, calls


def test_only_the_ticked_engine_draws(tmp_path, monkeypatch):
    svc, game, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": False},
                                    nvidia_fails=True)
    with pytest.raises(RuntimeError, match="輝達"):
        asyncio.run(svc._scene(game, "pier"))
    assert calls == ["nvidia"]     # ComfyUI unticked: never a fallback


def test_comfy_is_the_fallback_only_when_both_are_ticked(tmp_path, monkeypatch):
    svc, _, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": True},
                                 nvidia_fails=True)
    monkeypatch.setattr(svc, "_cut_calm", lambda *a: None)
    game = {"id": "g_1", "characters": [{"id": "c1", "seed": 3, "appearance_en": "a woman"}]}
    asyncio.run(svc._calm(game, "c1"))
    assert calls == ["nvidia", "comfy"]


def test_ticked_comfy_draws_every_scene(tmp_path, monkeypatch):
    # FLUX puts fake lettering on signs and scrolls, so NVIDIA never draws a scene while ComfyUI is ticked
    svc, game, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": True})
    asyncio.run(svc._scene(game, "pier"))
    assert calls == ["comfy"] and svc.scene_path("g_1", "pier").exists()


def test_comfy_only_never_calls_nvidia(tmp_path, monkeypatch):
    svc, game, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": False, "image_comfy": True})
    asyncio.run(svc._scene(game, "pier"))
    assert calls == ["comfy"]


def test_comfy_character_is_never_given_a_flux_face(tmp_path, monkeypatch):
    # Old sprites have no engine in meta.json (ComfyUI); a FLUX redraw would look like another person
    svc, _, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": False})
    calm = svc.sprite_path("g_1", "c1", "calm")
    calm.parent.mkdir(parents=True)
    calm.write_bytes(b"png")
    (calm.parent / "meta.json").write_text('{"crop": [0, 0, 1, 1], "face": [0, 0, 1, 1]}', encoding="utf-8")
    game = {"id": "g_1", "characters": [{"id": "c1", "seed": 3, "appearance_en": "a woman"}]}
    with pytest.raises(RuntimeError, match=asset_service.COMFY_ONLY):
        asyncio.run(svc._expression(game, "c1", "smile"))
    assert calls == []


@pytest.mark.parametrize("both, expected", [(True, ["comfy"]), (False, ["nvidia"])])
def test_nvidia_calm_gets_comfy_expressions_when_ticked(tmp_path, monkeypatch, both, expected):
    # FLUX whole redraws swap non-human faces (robot, fox ears), so img2img wins when ComfyUI is ticked;
    # NVIDIA alone (players without ComfyUI) still redraws the whole sprite
    svc, _, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": both})
    calm = svc.sprite_path("g_1", "c1", "calm")
    calm.parent.mkdir(parents=True)
    calm.write_bytes(b"png")
    (calm.parent / "meta.json").write_text('{"crop": [0, 0, 1, 1], "face": [0, 0, 1, 1], "engine": "nvidia"}',
                                           encoding="utf-8")

    async def img2img(*args):
        calls.append("comfy")

    monkeypatch.setattr(asset_service.comfy_client, "img2img", img2img)
    monkeypatch.setattr(svc, "_cut_expression", lambda *a: None)
    monkeypatch.setattr(svc, "_cut_whole", lambda *a: None)
    game = {"id": "g_1", "characters": [{"id": "c1", "seed": 3, "appearance_en": "a woman"}]}
    asyncio.run(svc._expression(game, "c1", "smile"))
    assert calls == expected


def test_default_settings_are_nvidia_only(tmp_path):
    assert AssetService(Store(tmp_path)).engines() == ["nvidia"]


def test_flux_scene_prompt_blanks_props_that_carry_writing():
    p = asset_service.flux_scene_prompt("", "meeting room, large screen displaying the proposal, whiteboard with "
                                            "notes, table with documents, city skyline")
    assert "proposal" not in p and "notes" not in p and "documents" not in p
    assert "blank whiteboard" in p and "abstract color gradient" in p and "city skyline" in p


def test_flux_sprite_prompt_leads_with_the_isolation_colour():
    # FLUX ignored a trailing background phrase and drew white, so white fox ears were cut away with it
    assert asset_service.flux_sprite_prompt("a fox girl, white ears", "calm").startswith("solid light blue background")
    assert asset_service.flux_sprite_prompt("a man in a blue coat", "smile").startswith("solid light green background")


def test_key_cutout_keeps_a_white_ear_on_a_flat_background():
    # u2net dropped the white fox ear and faded the body of FLUX sprites; the chroma key keeps both
    import numpy as np
    from PIL import Image
    from server import cutout
    img = np.full((120, 80, 3), (150, 210, 250), np.uint8)
    img[10:30, 10:25] = 255                  # white ear touching nothing but background
    img[30:120, 10:70] = (180, 225, 200)     # light green body running off the bottom edge
    img[60:70, 30:40] = (150, 210, 250)      # background-coloured pocket enclosed by the body
    a = np.asarray(cutout.cutout_full(Image.fromarray(img), key=True).getchannel("A"))
    assert a[20, 17] > 200 and a[100, 40] > 200 and a[5, 60] == 0 and a[65, 35] < 50


@pytest.mark.parametrize("appearance, expected", [("half black mask, purple robe", "eyes"),
                                                  ("android bartender, copper plating", "eyes"),
                                                  ("gray hoodie, worn gas mask on face", "eyes"),
                                                  ("trench coat, aviator goggles around neck", "face")])
def test_covered_faces_only_redraw_the_eyes(tmp_path, monkeypatch, appearance, expected):
    # A face-box img2img redrew the mask and robot plating (spike_eyes_only.py); those faces only change eyes
    svc, _, calls = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": False, "image_comfy": True})
    calm = svc.sprite_path("g_1", "c1", "calm")
    calm.parent.mkdir(parents=True)
    calm.write_bytes(b"png")
    (calm.parent / "meta.json").write_text('{"crop": [0, 0, 1, 1], "face": [100, 0, 300, 280]}', encoding="utf-8")
    Image.new("RGB", (512, 768), (200, 180, 160)).save(svc.sprite_path("g_1", "c1", "calm", raw=True))

    async def img2img(*args):
        calls.append("face")

    async def inpaint(prompt, src, mask, seed, denoise, dest):
        calls.append("eyes")
        assert not asset_service.cutout.COVERED_FACE.search(prompt) and denoise == asset_service.EYE_DENOISE
        assert Image.open(mask).getbbox() == (219, 231, 362, 339)       # eye band of the 3x face crop

    monkeypatch.setattr(asset_service.comfy_client, "img2img", img2img)
    monkeypatch.setattr(asset_service.comfy_client, "inpaint", inpaint)
    monkeypatch.setattr(svc, "_cut_expression", lambda *a: None)
    monkeypatch.setattr(svc, "_cut_eyes", lambda *a: None)
    game = {"id": "g_1", "characters": [{"id": "c1", "seed": 3, "appearance_en": appearance}]}
    asyncio.run(svc._expression(game, "c1", "angry"))
    assert calls == [expected]


def test_eye_paste_keeps_every_pixel_outside_the_eye_band():
    calm = Image.new("RGB", (512, 768), (200, 180, 160))
    face, eyes = (100, 0, 300, 280), cutout.eye_band((100, 0, 300, 280))
    merged = cutout.eye_paste(calm, Image.new("RGB", (600, 832), (0, 0, 0)), face, eyes)
    diff = np.abs(np.asarray(merged, np.int16) - np.asarray(calm, np.int16)).sum(2) > 0
    ys, xs = np.nonzero(diff)
    assert diff.any() and xs.min() >= eyes[0] - 8 and xs.max() <= eyes[2] + 8
    assert ys.min() >= eyes[1] - 8 and ys.max() <= eyes[3] + 8


# ---------- pause during turns, automatic retry, redraw, image mode ----------

GAME = {"id": "g_1", "seed": 7, "style_en": "", "scenes": {"pier": {"image_prompt": "a pier"}},
        "characters": [{"id": "c1", "seed": 3, "appearance_en": "a woman"}]}


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


def test_nvidia_draws_go_through_the_rpm_gate(tmp_path, monkeypatch):
    svc, game, _ = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": False})

    async def gate():
        pass

    svc.rpm_gate = gate
    asyncio.run(svc._scene(game, "pier"))
    assert svc.gates == [gate]


def test_only_the_background_on_screen_is_drawn_while_a_turn_is_written(tmp_path):
    svc = AssetService(Store(tmp_path))
    svc.active = "g_1"
    svc.ensure_game(GAME, "pier")
    svc.request(("scene", "g_2", "pier"), asset_service.P_SCENE)
    with svc.text_turn():
        assert [j.key for j in svc.jobs.values() if svc._runnable(j)] == [("scene", "g_1", "pier")]
        assert svc.status(GAME)["paused"]
    assert all(svc._runnable(j) for j in svc.jobs.values()) and not svc.status(GAME)["paused"]


def test_failed_image_is_queued_again_later_then_marked_as_error(tmp_path):
    clock = Clock()
    svc = AssetService(Store(tmp_path), clock=clock)
    key = ("sprite", "g_1", "c1", "calm")
    job = asset_service.Job(2, 1, key)
    for n in range(1, asset_service.AUTO_RETRY_ROUNDS + 1):
        svc._failed(job, RuntimeError("busy"))
        assert key in svc.later and svc.rounds[key] == n and key not in svc.errors
        st = svc.status(GAME)["sprites"]["c1"]["calm"]
        assert st["state"] == "queued" and st["retry_in"] == asset_service.AUTO_RETRY_S and st["error"] == "busy"
        svc.request(key, 2, retry=False)                    # polling does not cut the wait short
        assert key not in svc.jobs
        clock.now += asset_service.AUTO_RETRY_S
        svc._promote()
        assert key in svc.jobs and key not in svc.later
        del svc.jobs[key]
    svc._failed(job, RuntimeError("busy"))
    assert svc.errors[key] == "busy" and key not in svc.later and key not in svc.rounds


def test_hopeless_failure_is_an_error_at_once(tmp_path):
    svc = AssetService(Store(tmp_path))
    key = ("scene", "g_1", "pier")
    svc._failed(asset_service.Job(0, 1, key), asset_service.ImageFailed("filtered", retryable=False))
    assert svc.errors[key] == "filtered" and key not in svc.later


def test_retry_starts_a_waiting_image_now(tmp_path):
    svc = AssetService(Store(tmp_path))
    key = ("scene", "g_1", "pier")
    svc._failed(asset_service.Job(0, 1, key), RuntimeError("busy"))
    svc.ensure_game(GAME, "pier")                           # the chip's retry button
    assert key in svc.jobs and key not in svc.later and key not in svc.rounds


def test_engine_errors_are_retryable_unless_every_engine_says_no(tmp_path, monkeypatch):
    svc, game, _ = _scene_setup(tmp_path, monkeypatch, {"image_nvidia": True, "image_comfy": False})

    async def filtered(*a):
        raise asset_service.nvidia_image.NvidiaImageError("filtered", retryable=False)

    monkeypatch.setattr(asset_service.nvidia_image, "txt2img", filtered)
    with pytest.raises(asset_service.ImageFailed) as e:
        asyncio.run(svc._scene(game, "pier"))
    assert not e.value.retryable
    svc.store.save_settings({"image_nvidia": False, "image_comfy": False})
    with pytest.raises(asset_service.ImageFailed) as e:
        asyncio.run(svc._scene(game, "pier"))
    assert not e.value.retryable and str(e.value) == asset_service.NO_ENGINE


def test_redraw_deletes_the_files_and_draws_with_a_new_seed(tmp_path):
    store = Store(tmp_path)
    store.save_game(GAME)
    svc = AssetService(store)
    folder = svc.sprite_path("g_1", "c1", "calm").parent
    folder.mkdir(parents=True)
    for name in ("calm.png", "calm.raw.png", "smile.png", "meta.json"):
        (folder / name).write_bytes(b"x")
    assert svc._seed(GAME, "sprite", "c1") == 3
    assert svc.redraw(GAME, "sprite", "c1")
    assert list(folder.iterdir()) == []
    assert svc.jobs[("sprite", "g_1", "c1", "calm")].priority == asset_service.P_SPEAKER
    assert ("sprite", "g_1", "c1", "smile") in svc.jobs
    seed = svc._seed(GAME, "sprite", "c1")
    assert seed != 3 and svc._seed(GAME, "scene", "pier") == 7 + sum(map(ord, "pier"))
    svc.scene_path("g_1", "pier").parent.mkdir(parents=True)
    svc.scene_path("g_1", "pier").write_bytes(b"x")
    assert svc.redraw(GAME, "scene", "pier", new_seed=False)
    assert not svc.scene_path("g_1", "pier").exists() and ("scene", "g_1", "pier") in svc.jobs
    assert svc._seed(GAME, "scene", "pier") == 7 + sum(map(ord, "pier")) and svc._seed(GAME, "sprite", "c1") == seed


def test_redraw_waits_for_the_image_being_drawn(tmp_path):
    svc = AssetService(Store(tmp_path))
    svc.running = ("scene", "g_1", "pier")
    assert not svc.redraw(GAME, "scene", "pier")


@pytest.mark.parametrize("mode, queued", [
    ("all", {"scene", "calm", "smile"}), ("basic", {"scene", "calm"}), ("off", set())])
def test_image_mode_limits_what_is_drawn(tmp_path, mode, queued):
    store = Store(tmp_path)
    store.save_settings({"image_nvidia": True, "image_comfy": False, "image_mode": mode})
    svc = AssetService(store)
    svc.ensure_game(GAME, "pier")
    assert {k[0] if k[0] == "scene" else k[3] for k in svc.jobs} & {"scene", "calm", "smile"} == queued
    st = svc.status(GAME)
    assert (st["sprites"]["c1"]["smile"]["state"] == "off") is (mode != "all")
    assert (st["scenes"]["pier"]["state"] == "off") is (mode == "off")


def test_switching_mode_drops_queued_images_it_no_longer_draws(tmp_path):
    svc = AssetService(Store(tmp_path))
    svc.ensure_game(GAME, "pier")
    svc.set_mode("basic")
    assert {k[3] for k in svc.jobs if k[0] == "sprite"} == {"calm"} and ("scene", "g_1", "pier") in svc.jobs
