"""tools/dev_relay.py (phase 10, P16-P22): method, length and size checks, preflight cache, origin matching,
a page that hangs up mid-stream, a port in use. NVIDIA is replaced by a fake httpx.stream."""
import http.client
import importlib.util
import json
import threading
import time
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
ORIGIN = "http://localhost:8766"


def load():
    spec = importlib.util.spec_from_file_location("dev_relay", ROOT / "tools" / "dev_relay.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeUpstream:
    """Stands in for httpx.stream; records the forwarded requests."""

    def __init__(self, chunks=(b'{"ok":true}',), headers=None):
        self.chunks = chunks
        self.headers = httpx.Headers(headers or {"Content-Type": "application/json"})
        self.status_code = 200
        self.calls = []
        self.closed = threading.Event()

    def __call__(self, method, url, content=None, headers=None, timeout=None):
        self.calls.append({"url": url, "content": content})
        return self

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed.set()
        return False

    def iter_raw(self):
        yield from self.chunks


@pytest.fixture()
def relay(monkeypatch):
    dr = load()
    up = FakeUpstream()
    monkeypatch.setattr(httpx, "stream", up)
    server = dr.bind(0, dr.make_handler({"HTTP://LOCALHOST:8766/"}, None))
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    port = server.server_address[1]

    def send(method, path="/v1/chat/completions", body=None, headers=None):
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        conn.putrequest(method, path, skip_accept_encoding=True)
        for k, v in {"Origin": ORIGIN, **(headers or {})}.items():
            conn.putheader(k, v)
        if body is not None and "Content-Length" not in (headers or {}):
            conn.putheader("Content-Length", str(len(body)))
        conn.endheaders(body)
        res = conn.getresponse()
        data = res.read()
        conn.close()
        return res, data

    yield dr, up, send, port
    server.shutdown()
    server.server_close()


def test_preflight_is_cached_and_origin_ignores_slash_and_case(relay):
    _, _, send, _ = relay
    res, _ = send("OPTIONS")
    assert res.status == 204
    assert res.getheader("Access-Control-Max-Age") == "86400"
    assert res.getheader("Access-Control-Allow-Origin") == ORIGIN


@pytest.mark.parametrize("method", ["GET", "PUT", "DELETE", "PATCH"])
def test_other_methods_get_json_405_with_cors(relay, method):
    _, up, send, _ = relay
    res, data = send(method)
    assert res.status == 405
    assert json.loads(data) == {"error": "method_not_allowed"}
    assert res.getheader("Allow") == "POST, OPTIONS"
    assert res.getheader("Access-Control-Allow-Origin") == ORIGIN
    assert up.calls == []


def test_head_gets_405_without_body(relay):
    _, _, send, _ = relay
    res, data = send("HEAD")
    assert res.status == 405 and data == b""


def test_unknown_origin_is_refused_for_every_method(relay):
    _, _, send, _ = relay
    res, _ = send("GET", headers={"Origin": "https://evil.example"})
    assert res.status == 403


def test_missing_or_bad_length_is_refused(relay):
    _, up, send, _ = relay
    res, data = send("POST")
    assert res.status == 411 and json.loads(data) == {"error": "length_required"}
    res, data = send("POST", body=b"{}", headers={"Content-Length": "2x"})
    assert res.status == 400 and json.loads(data) == {"error": "bad_length"}
    assert up.calls == []


def test_body_over_4_mb_is_refused_unsent(relay):
    dr, up, send, _ = relay
    res, data = send("POST", body=b"x" * (dr.MAX_BODY + 1))
    assert res.status == 413 and json.loads(data) == {"error": "body_too_large"}
    assert res.getheader("Access-Control-Allow-Origin") == ORIGIN
    assert up.calls == []


def test_post_is_forwarded(relay):
    _, up, send, _ = relay
    res, data = send("POST", body=b'{"a":1}', headers={"Content-Type": "application/json"})
    assert res.status == 200 and data == b'{"ok":true}'
    assert up.calls == [{"url": "https://integrate.api.nvidia.com/v1/chat/completions", "content": b'{"a":1}'}]


def test_page_hanging_up_mid_stream_logs_one_line(relay, capsys):
    _, up, _, port = relay
    up.chunks = [b"x" * 65536] * 400
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    conn.request("POST", "/v1/chat/completions", body=b"{}", headers={"Origin": ORIGIN})
    res = conn.getresponse()
    assert res.status == 200
    res.close()   # the page gives up while the answer is still streaming
    conn.close()
    assert up.closed.wait(10)   # the NVIDIA stream is closed too
    err = ""
    for _ in range(100):   # the log line follows the close
        err += capsys.readouterr().err
        if "closed the connection" in err:
            break
        time.sleep(0.05)
    assert "relay page closed the connection" in err
    assert "Traceback" not in err


def test_port_in_use_stops_with_a_message():
    dr = load()
    first = dr.bind(0, dr.make_handler(set(), None))
    try:
        with pytest.raises(SystemExit, match="--port"):
            dr.bind(first.server_address[1], dr.make_handler(set(), None))
    finally:
        first.server_close()
