"""Smoke test against the running server with the real LLM: create a game from presets, play the opening + 2 turns.

Usage: python tools/api_smoke.py   (server on 127.0.0.1:8765)
"""
import json
import pathlib
import sys
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8")
BASE = "http://127.0.0.1:8765"
ROOT = pathlib.Path(__file__).resolve().parent.parent


def sse(path, body):
    t0 = time.time()
    final = None
    first_line = None
    with httpx.stream("POST", BASE + path, json=body, timeout=400) as r:
        for row in r.iter_lines():
            if not row.startswith("data:"):
                continue
            ev = json.loads(row[5:])
            if ev["type"] == "line":
                first_line = first_line or time.time() - t0
                ln = ev["line"]
                print(f"  [{ln['speaker']}|{ln['expr']}] {ln['text']}")
            elif ev["type"] == "status":
                print("  status", ev)
            elif ev["type"] in ("final", "error", "cancelled", "phase"):
                print("  ", ev["type"], ev.get("message", ev.get("text", "")))
                if ev["type"] == "final":
                    final = ev
    print(f"  took {time.time() - t0:.1f}s, first line {first_line and round(first_line, 1)}s")
    return final


def main():
    p = json.loads((ROOT / "web" / "presets.json").read_text(encoding="utf-8"))
    w = p["worlds"][0]
    body = {"world": {k: w[k] for k in ("era", "place", "genre", "tone", "extra")},
            "protagonist": p["protagonist"], "characters": p["characters"]}
    g = sse("/api/games", body)["game"]
    print(json.dumps({k: g[k] for k in ("id", "title", "style_en", "scenes")}, ensure_ascii=False, indent=1))
    for c in g["characters"]:
        print(c["name"], "->", c["appearance_en"])
    node = sse(f"/api/games/{g['id']}/turn", {"parent_id": None, "input": {"kind": "opening"}})["node"]
    for _ in range(2):
        opts = node["result"]["options"]
        print("options:", opts, "scene:", node["scene_id"], node["bgm_mood"], node["weather"])
        node = sse(f"/api/games/{g['id']}/turn",
                   {"parent_id": node["id"], "input": {"kind": "option", "text": opts[0]}})["node"]
    print("options:", node["result"]["options"], "scene:", node["scene_id"])
    print(json.dumps(httpx.get(f"{BASE}/api/games/{g['id']}/assets").json(), ensure_ascii=False))


if __name__ == "__main__":
    main()
