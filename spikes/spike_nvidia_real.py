"""Spike step 5 (R5 real assets): run the production AssetService with NVIDIA only on copies of real games.

Step 1-4 used one modern-office game; the first real backfill (fantasy game 145203) drifted outfits between
expressions, dropped prompt details (fox ears) and drew fake lettering in scenes. This runs more real games
through the exact production code to see whether that was one bad case. Saves stay untouched: game.json files
are copied into spikes/results/nvidia_real/<gid>/ and rendered there.
"""
import asyncio
import json
import pathlib
import shutil
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
    store.save_settings({"image_nvidia": True, "image_comfy": False})
    svc = AssetService(store)
    report = []
    for gid in GAMES:
        dst = store.game_dir(gid)
        dst.mkdir(parents=True, exist_ok=True)
        shutil.copy(ROOT / "saves/games" / gid / "game.json", dst / "game.json")
        game = store.load_game(gid)
        keys = [("scene", gid, s) for s in game["scenes"]]
        keys += [("sprite", gid, c["id"], e) for c in game["characters"] for e in EXPRESSIONS]
        for key in keys:
            t = time.monotonic()
            try:
                await svc._run(key)
                report.append({"key": key, "ok": True, "s": round(time.monotonic() - t, 1)})
            except Exception as e:     # report every failure, keep going
                report.append({"key": key, "ok": False, "error": str(e)[:200]})
            print(report[-1])
    (OUT / "run.json").write_text(json.dumps(report, ensure_ascii=False, indent=1), encoding="utf-8")


asyncio.run(main())
