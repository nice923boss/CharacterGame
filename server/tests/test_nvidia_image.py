import asyncio

import httpx
import pytest
from PIL import Image

from server import config, nvidia_image


def test_fit_center_crops_to_sprite_and_scene_sizes():
    sq = Image.new("RGB", (1024, 1024))
    assert nvidia_image.fit(sq, 512, 768).size == (512, 768)
    assert nvidia_image.fit(sq, 1280, 800).size == (1280, 800)


def test_404_error_does_not_leak_the_body(monkeypatch):
    # A real 404 body from this endpoint printed the NVIDIA account id
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "nvapi-test")

    async def post(self, url, **kwargs):
        return httpx.Response(404, text='{"detail": "account ONT_abc123 has no access"}')

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(nvidia_image.NvidiaImageError) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert str(e.value) == "輝達生圖失敗：HTTP 404"


def test_other_errors_hide_account_ids_and_keys(monkeypatch):
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "nvapi-test")
    monkeypatch.setattr(config, "SECRETS", ["nvapi-test"])

    async def post(self, url, **kwargs):
        return httpx.Response(422, text="bad input for ONT_abc123 with nvapi-test")

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(nvidia_image.NvidiaImageError) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert "ONT_abc123" not in str(e.value) and "nvapi-test" not in str(e.value) and "422" in str(e.value)


def test_soften_replaces_words_the_prompt_filter_rejects():
    # Each of these alone made the hosted endpoint return CONTENT_FILTERED for any seed
    p = nvidia_image.soften("Gritty town, horror atmosphere, war ruins, zombies, warrior, grit")
    assert p == "weathered town, eerie atmosphere, old conflict ruins, undead, warrior, grit"


def test_filtered_prompt_gets_a_readable_error(monkeypatch):
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "nvapi-test")

    async def post(self, url, **kwargs):
        return httpx.Response(200, json={"artifacts": [{"finishReason": "CONTENT_FILTERED", "base64": ""}]})

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    with pytest.raises(nvidia_image.NvidiaImageError, match="內容過濾"):
        asyncio.run(nvidia_image._draw("x", 1))


def test_key_typed_in_settings_replaces_its_env_line_and_is_masked(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ENV", {"NVIDIA_API_KEY": "old"})
    monkeypatch.setattr(config, "SECRETS", ["old"])
    env = tmp_path / ".env"
    env.write_bytes(b"A=1\nNVIDIA_API_KEY=old\n# note\n")
    config.set_env("NVIDIA_API_KEY", "nvapi-new", env)
    assert env.read_bytes() == b"A=1\n# note\nNVIDIA_API_KEY=nvapi-new\n"
    assert nvidia_image.available() and config.mask("got nvapi-new") == "got ***"


def _png_b64() -> str:
    import base64
    import io
    buf = io.BytesIO()
    Image.new("RGB", (8, 8)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _fake_server(monkeypatch, answers):
    """Each post takes the next answer: an exception to raise or an httpx.Response. Sleeps are recorded."""
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "nvapi-test")
    sleeps, posts = [], []

    async def post(self, url, **kwargs):
        posts.append(self)
        a = answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return a

    async def sleep(s):
        sleeps.append(s)

    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    monkeypatch.setattr(nvidia_image.asyncio, "sleep", sleep)
    return sleeps, posts


def ok():
    return httpx.Response(200, json={"artifacts": [{"finishReason": "SUCCESS", "base64": _png_b64()}]})


def test_network_errors_retry_with_the_backoff_table(monkeypatch):
    sleeps, posts = _fake_server(monkeypatch, [httpx.ConnectError("down"), httpx.ReadTimeout("slow"), ok()])
    assert asyncio.run(nvidia_image._draw("x", 1)).size == (8, 8)
    assert sleeps == [3, 8]
    assert posts[0] is posts[1] is posts[2]                 # one shared connection pool


def test_network_error_after_the_last_step_is_reported(monkeypatch):
    sleeps, _ = _fake_server(monkeypatch, [httpx.ConnectError("down")] * 5)
    with pytest.raises(nvidia_image.NvidiaImageError, match="連不上輝達生圖") as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert sleeps == nvidia_image.RETRY_BACKOFF_S and e.value.retryable


def test_retry_after_replaces_the_table_step_and_is_capped(monkeypatch):
    busy = lambda ra: httpx.Response(503, headers={"Retry-After": ra}, text="busy")
    sleeps, _ = _fake_server(monkeypatch, [busy("2"), busy("900"), ok()])
    asyncio.run(nvidia_image._draw("x", 1))
    assert sleeps == [2, config.RETRY_AFTER_MAX_S]


def test_gate_runs_before_every_attempt(monkeypatch):
    _fake_server(monkeypatch, [httpx.Response(429, text="slow down"), ok()])
    gates = []

    async def gate():
        gates.append(1)

    asyncio.run(nvidia_image._draw("x", 1, gate))
    assert gates == [1, 1]


@pytest.mark.parametrize("answer, retryable", [
    (httpx.Response(200, json={"artifacts": [{"finishReason": "CONTENT_FILTERED"}]}), False),
    (httpx.Response(401, text="bad key"), False),
    (httpx.Response(422, text="bad input"), False),
    (httpx.Response(404, text="not found"), True),
])
def test_errors_say_whether_a_later_retry_can_help(monkeypatch, answer, retryable):
    _fake_server(monkeypatch, [answer])
    with pytest.raises(nvidia_image.NvidiaImageError) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert e.value.retryable is retryable


def test_missing_key_is_not_retryable(monkeypatch):
    monkeypatch.setitem(config.ENV, "NVIDIA_API_KEY", "")
    with pytest.raises(nvidia_image.NvidiaImageError) as e:
        asyncio.run(nvidia_image._draw("x", 1))
    assert not e.value.retryable
