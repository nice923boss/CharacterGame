"""Connection test (B01, B02, B04, B05): classification, the probe with a mocked httpx, the remembered verdict
and the two settings endpoints. Nothing reaches NVIDIA and the real .env is never written."""
import asyncio

import httpx
import pytest
from fastapi import HTTPException

from server import config, conn_check, nvidia_image

FAKE_KEY = "nvapi-abcdefghWXYZ"   # made up, shown as nvapi-****WXYZ


@pytest.fixture
def fresh(monkeypatch, tmp_path):
    """Empty verdict, a copy of ENV and SECRETS, and set_env pointed at a temporary .env."""
    env = tmp_path / ".env"
    monkeypatch.setattr(conn_check, "_last", {})
    monkeypatch.setattr(config, "ENV", {})
    monkeypatch.setattr(config, "SECRETS", [])
    write = config.set_env
    monkeypatch.setattr(config, "set_env",
                        lambda name, value, secret=True: write(name, value, path=env, secret=secret))
    return env


def answer(status=None, error=None):
    async def post(self, url, **kwargs):
        if error:
            raise error
        return httpx.Response(status, json={})
    return post


@pytest.mark.parametrize("status, failure, state", [
    (200, "", "ok"), (422, "", "ok"), (401, "", "key_rejected"), (403, "", "key_rejected"),
    (503, "", "busy"), (429, "", "busy"), (500, "", "busy"), (400, "", "error"),
    (None, "timeout", "timeout"), (None, "unreachable", "unreachable"),
])
def test_classify(status, failure, state):
    assert conn_check.classify(status, failure) == state


@pytest.mark.parametrize("status, error, state", [
    (200, None, "ok"), (422, None, "ok"), (503, None, "busy"), (403, None, "key_rejected"),
    (None, httpx.ConnectTimeout("slow"), "unreachable"),
    (None, httpx.ReadTimeout("slow"), "timeout"),
    (None, httpx.ConnectError("refused"), "unreachable"),
])
def test_probe(monkeypatch, status, error, state):
    monkeypatch.setattr(httpx.AsyncClient, "post", answer(status, error))
    r = asyncio.run(conn_check.probe("text", "nvapi-test"))
    assert r["kind"] == "text" and r["state"] == state and r["status"] == status
    assert isinstance(r["ms"], int)


def test_probe_requests(monkeypatch):
    seen = []

    async def post(self, url, **kwargs):
        seen.append((url, kwargs))
        return httpx.Response(422)
    monkeypatch.setattr(httpx.AsyncClient, "post", post)
    asyncio.run(conn_check.probe("text", "nvapi-test"))
    asyncio.run(conn_check.probe("image", "nvapi-test"))
    (text_url, text), (image_url, image) = seen
    assert text_url == conn_check.TEXT_URL and text["json"]["max_tokens"] == 1 and text["json"]["stream"] is False
    assert image_url == nvidia_image.URL
    assert image["json"] == {}          # an empty body: NVIDIA answers 422 and draws nothing
    assert text["headers"]["Authorization"] == "Bearer nvapi-test"


@pytest.mark.parametrize("results, verdict", [
    ([{"state": "ok", "status": 200}], "valid"),
    ([{"state": "busy", "status": 503}], "valid"),
    ([{"state": "ok", "status": 422}, {"state": "key_rejected", "status": 403}], "rejected"),
    ([{"state": "unreachable", "status": None}], None),
    ([{"state": "busy", "status": 500}], None),
])
def test_remember(fresh, results, verdict):
    config.ENV["NVIDIA_API_KEY"] = FAKE_KEY
    conn_check.remember(results)
    assert conn_check.key_info()["key_check"] == verdict


def test_verdict_expires_and_needs_a_key(fresh, monkeypatch):
    conn_check.remember([{"state": "ok", "status": 200}])
    assert conn_check.key_info()["key_check"] is None      # no saved key: nothing to vouch for
    config.ENV["NVIDIA_API_KEY"] = FAKE_KEY
    assert conn_check.key_info()["key_check"] == "valid"
    later = conn_check._last["at"] + conn_check.CACHE_S + 1
    monkeypatch.setattr(conn_check.time, "monotonic", lambda: later)
    assert conn_check.key_info()["key_check"] is None


def test_key_info(fresh):
    assert conn_check.key_info() == {"key_hint": "", "key_saved_at": None, "key_check": None}
    config.ENV.update(NVIDIA_API_KEY=FAKE_KEY, NVIDIA_KEY_SAVED_AT="2026-10-03T12:00:00")
    info = conn_check.key_info()
    assert info["key_hint"] == "nvapi-****WXYZ" and info["key_saved_at"] == "2026-10-03T12:00:00"


@pytest.mark.parametrize("key, shown", [
    (FAKE_KEY, "nvapi-****WXYZ"), ("sk-1234567890abcd", "****abcd"), ("nvapi-ab", "nvapi-****"),
    ("short", "****"), ("", ""),
])
def test_hint(key, shown):
    assert conn_check.hint(key) == shown


def test_set_env_plain_value_is_not_a_secret(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "ENV", {})
    monkeypatch.setattr(config, "SECRETS", [])
    env = tmp_path / ".env"
    config.set_env("NVIDIA_KEY_SAVED_AT", "2026-10-03T12:00:00", path=env, secret=False)
    config.set_env("NVIDIA_API_KEY", "nvapi-secret", path=env)
    assert config.SECRETS == ["nvapi-secret"]
    assert env.read_text(encoding="utf-8").splitlines() == ["NVIDIA_KEY_SAVED_AT=2026-10-03T12:00:00",
                                                            "NVIDIA_API_KEY=nvapi-secret"]


def probe_as(state, status):
    async def probe(kind, key):
        return {"kind": kind, "state": state, "status": status, "ms": 5}
    return probe


def test_save_rejected_key_writes_nothing(fresh, monkeypatch):
    from server import main
    monkeypatch.setattr(conn_check, "probe", probe_as("key_rejected", 403))
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.save_nvidia_key({"key": "nvapi-wrong"}))
    assert e.value.status_code == 422 and e.value.detail == "key_rejected"
    assert not fresh.exists() and "NVIDIA_API_KEY" not in config.ENV


@pytest.mark.parametrize("state, status, verdict", [("ok", 200, "valid"), ("busy", 503, "valid"),
                                                    ("unreachable", None, None)])
def test_save_keeps_key_unless_rejected(fresh, monkeypatch, state, status, verdict):
    from server import main
    monkeypatch.setattr(conn_check, "probe", probe_as(state, status))
    r = asyncio.run(main.save_nvidia_key({"key": f"  {FAKE_KEY} "}))
    assert r["nvidia_key"] is True and r["check"]["state"] == state and r["key_check"] == verdict
    assert r["key_hint"] == "nvapi-****WXYZ" and r["key_saved_at"]
    lines = fresh.read_text(encoding="utf-8").splitlines()
    assert lines[0] == f"NVIDIA_API_KEY={FAKE_KEY}" and lines[1].startswith("NVIDIA_KEY_SAVED_AT=")
    assert config.SECRETS == [FAKE_KEY]
    assert FAKE_KEY not in str(r)


def test_check_needs_a_saved_key(fresh):
    from server import main
    with pytest.raises(HTTPException) as e:
        asyncio.run(main.check_connection())
    assert e.value.status_code == 400 and e.value.detail == "no_key"


def test_check_tests_both_paths(fresh, monkeypatch):
    from server import main
    config.ENV["NVIDIA_API_KEY"] = FAKE_KEY
    states = {"text": ("busy", 503), "image": ("ok", 422)}

    async def probe(kind, key):
        state, status = states[kind]
        return {"kind": kind, "state": state, "status": status, "ms": 5}
    monkeypatch.setattr(conn_check, "probe", probe)
    r = asyncio.run(main.check_connection())
    assert r["text"]["state"] == "busy" and r["image"]["status"] == 422 and r["key_check"] == "valid"
