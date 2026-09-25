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
