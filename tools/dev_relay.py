"""Local CORS relay for testing the GitHub Pages build (same behaviour as relay/worker.js).

Binds to 127.0.0.1 only and forwards two NVIDIA paths for the allowed origins. Request headers are never logged.

--inject-env-key (development only): replaces the page's Authorization header with NVIDIA_API_KEY from .env,
so the owner can test real generation while the browser only holds a placeholder key.

Run from the project root: python tools/dev_relay.py [--port 8787] [--allow-origin URL ...] [--inject-env-key]
"""
import argparse
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

ROUTES = [("/v1/chat/completions", "https://integrate.api.nvidia.com"),
          ("/v1/genai/", "https://ai.api.nvidia.com")]
DEFAULT_ORIGINS = ["http://127.0.0.1:8766", "http://localhost:8766", "https://nice923boss.github.io"]


def make_handler(origins: set[str], env_key: str | None):
    class Relay(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):   # path and status only, never headers
            sys.stderr.write(f"relay {self.command} {self.path.split('?')[0]} {args[1] if len(args) > 1 else ''}\n")

        def cors(self, origin: str) -> None:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, Accept")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")

        def reply(self, status: int, body: dict, origin: str) -> None:
            data = json.dumps(body).encode()
            self.send_response(status)
            self.cors(origin)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def allowed(self) -> str | None:
            origin = self.headers.get("Origin", "")
            if origin in origins:
                return origin
            self.reply(403, {"error": "origin_not_allowed"}, origin)
            return None

        def do_OPTIONS(self):
            origin = self.allowed()
            if origin is None:
                return
            self.send_response(204)
            self.cors(origin)
            self.end_headers()

        def do_POST(self):
            origin = self.allowed()
            if origin is None:
                return
            path = self.path.split("?")[0]
            upstream = next((base for prefix, base in ROUTES
                             if path == prefix or (prefix.endswith("/") and path.startswith(prefix))), None)
            if upstream is None:
                self.reply(404, {"error": "path_not_allowed"}, origin)
                return
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            headers = {"Content-Type": self.headers.get("Content-Type", "application/json"),
                       "Accept": self.headers.get("Accept", "*/*")}
            auth = f"Bearer {env_key}" if env_key else self.headers.get("Authorization")
            if auth:
                headers["Authorization"] = auth
            try:
                with httpx.stream("POST", upstream + path, content=body, headers=headers,
                                  timeout=httpx.Timeout(300, connect=15)) as res:
                    self.send_response(res.status_code)
                    self.cors(origin)
                    self.send_header("Content-Type", res.headers.get("Content-Type", "application/json"))
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in res.iter_raw():
                        self.wfile.write(chunk)
                        self.wfile.flush()
            except httpx.HTTPError as e:
                sys.stderr.write(f"relay upstream error: {type(e).__name__}\n")
                self.close_connection = True

    return Relay


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    ap.add_argument("--allow-origin", action="append", default=[])
    ap.add_argument("--inject-env-key", action="store_true")
    args = ap.parse_args()
    env_key = None
    if args.inject_env_key:
        from server import config
        env_key = config.ENV.get("NVIDIA_API_KEY") or None
        if not env_key:
            raise SystemExit("NVIDIA_API_KEY missing in .env")
    origins = set(DEFAULT_ORIGINS + args.allow_origin)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(origins, env_key))
    print(f"dev relay on http://127.0.0.1:{args.port} (origins: {', '.join(sorted(origins))}; "
          f"env key {'injected' if env_key else 'not used'})", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
