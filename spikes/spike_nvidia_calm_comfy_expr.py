"""Spike step 6 (R5): NVIDIA calm + ComfyUI img2img expressions, on the copies made by spike_nvidia_real.py.

Whole FLUX redraws swapped the robot bartender's face for a human one. This keeps each NVIDIA calm, deletes the
FLUX expressions, and redraws them through the production path with both engines ticked (ComfyUI goes first for
expressions). Old FLUX expressions are kept as *.flux.png for side-by-side sheets.
"""
import asyncio
import json
import pathlib
import sys
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from server.asset_service import AssetService  # noqa: E402
from server.story_store import Store  # noqa: E402
from server.turn_parser import EXPRESSIONS  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "spikes/results/nvidia_real"
GAMES = sys.argv[1:] or ["g_20260925_150254", "g_20260925_143214"]


async def main() -> None:
    store = Store(OUT)
    store.save_settings({"image_nvidia": True, "image_comfy": True})
    svc = AssetService(store)
    report = []
    for gid in GAMES:
        for c in store.load_game(gid)["characters"]:
            for expr in EXPRESSIONS:
                if expr == "calm":
                    continue
                png = svc.sprite_path(gid, c["id"], expr)
                if png.exists():
                    png.replace(png.with_suffix(".flux.png"))
                t = time.monotonic()
                key = ("sprite", gid, c["id"], expr)
                try:
                    await svc._run(key)
                    report.append({"key": key, "ok": True, "s": round(time.monotonic() - t, 1)})
                except Exception as e:     # report every failure, keep going
                    report.append({"key": key, "ok": False, "error": str(e)[:200]})
                print(report[-1])
    (OUT / "run_comfy_expr.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


asyncio.run(main())
