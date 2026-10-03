"""FastAPI entry: static web client, save media, JSON API and SSE jobs (turns, new game).

Run: python -m server.main   (from the project root) -> http://127.0.0.1:8765
"""
import asyncio
import json
import traceback
from contextlib import asynccontextmanager
from datetime import datetime

import uvicorn
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import comfy_client, config, conn_check, nvidia_image
from .asset_service import IMAGE_MODES, AssetService
from .batch_service import BatchService
from .jobs import Job, Jobs
from .llm_client import LLMClient, LLMError, Waits
from .novel_service import NovelService
from .story_store import Store
from .turn_service import TurnError, TurnService

log = config.setup_logging()
store = Store()
llm = LLMClient()
assets = AssetService(store, rpm_gate=llm.image_slot)
turns = TurnService(store, llm, assets)
batches = BatchService(store, turns, assets)
novels = NovelService(turns.llm)
JOBS = Jobs()


@asynccontextmanager
async def lifespan(_app):
    (config.SAVES / "games").mkdir(parents=True, exist_ok=True)
    assets.start()
    batches.resume_all()
    log.info("server up on http://%s:%s", config.HOST, config.PORT)
    yield
    await turns.llm.aclose()
    await nvidia_image.aclose()


app = FastAPI(lifespan=lifespan)


def _event(ev: dict) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


def sse_job(work, payload: dict | None = None) -> StreamingResponse:
    """Run `work(emit, waits)` as a job and stream its events. Closing the stream does not cancel the job:
    the client may follow it again with /api/tasks/{tid}/events (see jobs.py).
    waits: how long the player agreed to queue for a busy model (payload["waits"]) and the retry-now switch."""
    job = Job()
    waits = Waits.from_payload((payload or {}).get("waits"), job.skip)

    async def emit(ev: dict) -> None:
        job.push(ev)

    async def runner():
        try:
            await work(emit, waits)
        except (TurnError, LLMError) as e:
            job.push({"type": "error", "code": e.code, "params": e.params})
        except asyncio.CancelledError:
            job.push({"type": "cancelled"})
            raise
        except Exception:
            log.error("job %s crashed\n%s", job.id, config.mask(traceback.format_exc()))
            job.push({"type": "error", "code": "internal", "params": {}})
        finally:
            JOBS.ended(job)

    JOBS.add(job)
    job.task = asyncio.create_task(runner())
    return follow_job(job, 0)


def follow_job(job: Job, after: int) -> StreamingResponse:
    JOBS.attach(job)

    async def stream():
        try:
            yield _event({"type": "task", "id": job.id})
            async for ev in job.follow(after):
                yield ": ping\n\n" if ev is None else _event(ev)
        finally:
            JOBS.detach(job)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


def _game_or_404(gid: str) -> dict:
    try:
        return store.load_game(gid)
    except (FileNotFoundError, ValueError):
        raise HTTPException(404, "game_not_found")


# ---------- API ----------

@app.get("/api/health")
async def health():
    demo = (config.SAVES / "games" / config.DEMO_GAME / "game.json").exists()
    return {"comfy": await comfy_client.online(), "nvidia_image": nvidia_image.available(),
            "engines": assets.engines(), "models": [c.label for c in turns.llm.candidates],
            "demo": config.DEMO_GAME if demo else None, **conn_check.key_info()}


@app.get("/api/stats")
async def stats():
    return turns.llm.stats()


@app.get("/api/settings")
async def get_settings():
    return store.load_settings()


@app.post("/api/settings/nvidia_key")
async def save_nvidia_key(payload: dict = Body(...)):
    """Write-only: the key goes into .env and never comes back; the page only gets a masked hint.
    One tiny request tests it first (B01): a key NVIDIA rejects is not saved; busy or unreachable still saves."""
    key = payload.get("key")
    if not isinstance(key, str) or not key.strip() or len(key.strip()) > 200 or any(c.isspace() for c in key.strip()):
        raise HTTPException(422, "bad_key")
    check = await conn_check.probe("text", key.strip())
    if check["state"] == "key_rejected":
        log.info("key from the settings page rejected by NVIDIA, not saved")
        raise HTTPException(422, "key_rejected")
    config.set_env("NVIDIA_API_KEY", key.strip())
    config.set_env(conn_check.SAVED_AT, datetime.now().isoformat(timespec="seconds"), secret=False)
    conn_check.remember([check])
    log.info("NVIDIA_API_KEY updated from the settings page (test: %s)", check["state"])
    return {"nvidia_key": True, "check": check, **conn_check.key_info()}


@app.post("/api/settings/check")
async def check_connection():
    """The settings page's test button (B02): the saved key on the text and the image path, side by side."""
    key = config.ENV.get("NVIDIA_API_KEY", "")
    if not key:
        raise HTTPException(400, "no_key")
    results = await asyncio.gather(conn_check.probe("text", key), conn_check.probe("image", key))
    conn_check.remember(list(results))
    return {"text": results[0], "image": results[1], **conn_check.key_info()}


@app.post("/api/settings")
async def save_settings(payload: dict = Body(...)):
    settings = {**store.load_settings(),
                **{k: bool(v) for k, v in payload.items() if k in ("image_nvidia", "image_comfy")}}
    if payload.get("image_mode") in IMAGE_MODES:
        settings["image_mode"] = payload["image_mode"]
    if not (settings["image_nvidia"] or settings["image_comfy"]):
        raise HTTPException(400, "no_engine")
    store.save_settings(settings)
    assets.set_mode(settings["image_mode"])
    return settings


@app.get("/api/games")
async def list_games():
    return store.list_games()


@app.post("/api/games")
async def create_game(payload: dict = Body(...)):
    async def work(emit, waits):
        with assets.text_turn():
            game = await turns.create_game(payload, emit, waits)
        if game.get("batch"):
            batches.start(game["id"])
    return sse_job(work, payload)


@app.post("/api/novel/analyze")
async def analyze_novel(payload: dict = Body(...)):
    return sse_job(lambda emit, waits: novels.analyze(payload, emit, waits), payload)


@app.get("/api/batches")
async def list_batches():
    return batches.list()


@app.post("/api/games/{gid}/batch/cancel")
async def cancel_batch(gid: str):
    _game_or_404(gid)
    return {"ok": await batches.stop(gid)}


@app.post("/api/games/{gid}/batch/pause")
async def pause_batch(gid: str):
    _game_or_404(gid)
    return {"ok": await batches.stop(gid, "paused")}


@app.post("/api/games/{gid}/batch/resume")
async def resume_batch(gid: str):
    game = _game_or_404(gid)
    if not game.get("batch"):
        raise HTTPException(400, "not_batch")
    batches.start(gid)
    return batches.status(gid)


@app.post("/api/games/{gid}/batch/branch")
async def rewrite_branch(gid: str, payload: dict = Body(...)):
    """The tree view's retry button on a branch the batch could not write."""
    game = _game_or_404(gid)
    if not game.get("batch"):
        raise HTTPException(400, "not_batch")
    try:
        node = await batches.rewrite(gid, str(payload.get("parent") or ""), str(payload.get("option") or ""))
    except (TurnError, LLMError) as e:
        raise HTTPException(400 if isinstance(e, TurnError) else 503, {"code": e.code, "params": e.params})
    return {"node_id": node["id"]}


@app.get("/api/games/{gid}")
async def get_game(gid: str, scene: str | None = None):
    game = _game_or_404(gid)
    assets.active = gid
    assets.ensure_game(game, scene if scene in game["scenes"] else None)
    return {"game": game, "tree": store.load_tree(gid), "assets": assets.status(game)}


@app.delete("/api/games/{gid}")
async def delete_game(gid: str):
    _game_or_404(gid)
    await batches.stop(gid)
    assets.forget(gid)
    try:
        store.delete_game(gid)
    except OSError as e:
        log.error("delete game %s failed: %s", gid, e)
        raise HTTPException(500, "delete_failed")
    return {"ok": True}


@app.get("/api/games/{gid}/assets")
async def asset_status(gid: str, scene: str | None = None, focus: int = 0):
    # The game on screen polls this: re-queue what a server restart dropped. Only a window the player is
    # looking at (focus=1) moves its images first in line, so two open windows do not take turns
    game = _game_or_404(gid)
    if focus:
        assets.active = gid
    assets.ensure_game(game, scene if scene in game["scenes"] else None, retry=False)
    return assets.status(game)


@app.post("/api/games/{gid}/assets/retry")
async def asset_retry(gid: str, scene: str | None = None):
    """The asset chip's retry button: failed images and the ones waiting for their automatic retry start again."""
    game = _game_or_404(gid)
    assets.active = gid
    assets.ensure_game(game, scene if scene in game["scenes"] else None)
    return assets.status(game)


@app.post("/api/games/{gid}/assets/redraw")
async def asset_redraw(gid: str, payload: dict = Body(...)):
    game = _game_or_404(gid)
    kind, target = payload.get("kind"), payload.get("target")
    if not ((kind == "scene" and target in game["scenes"]) or
            (kind == "sprite" and any(c["id"] == target for c in game["characters"]))):
        raise HTTPException(400, "bad_target")
    if assets.mode == "off":
        raise HTTPException(400, "images_off")
    assets.active = gid
    if not assets.redraw(game, kind, target, bool(payload.get("new_seed", True))):
        raise HTTPException(409, "drawing")
    return assets.status(game)


@app.post("/api/games/{gid}/turn")
async def turn(gid: str, payload: dict = Body(...)):
    _game_or_404(gid)

    async def work(emit, waits):
        with assets.text_turn():
            await turns.run_turn(gid, payload.get("parent_id"), payload.get("input") or {}, emit, waits=waits)
    return sse_job(work, payload)


@app.get("/api/tasks/{tid}/events")
async def task_events(tid: str, after: int = 0):
    """Follow a job again after the stream dropped; `after` is how many events the client already has."""
    job = JOBS.get(tid)
    if not job:
        raise HTTPException(404, "task_gone")
    return follow_job(job, after)


@app.post("/api/tasks/{tid}/cancel")
async def cancel(tid: str):
    job = JOBS.get(tid)
    if job and job.task and not job.task.done():
        job.task.cancel()
        return {"ok": True}
    return {"ok": False}


@app.post("/api/tasks/{tid}/retry_now")
async def retry_now(tid: str):
    """Cut the current countdown short: the next attempt starts at once."""
    job = JOBS.get(tid)
    if job and not job.ended:
        job.skip.set()
    return {"ok": bool(job and not job.ended)}


def _with_thumb(save: dict | None) -> dict | None:
    """Add the scene thumbnail URL (None until drawn) to a slot or the autosave."""
    return save and {**save, "thumb": store.thumb(save["game_id"], save.get("scene_id"))}


@app.get("/api/slots")
async def slots():
    return [_with_thumb(s) for s in store.load_slots()]


@app.post("/api/slots/{slot}")
async def save_slot(slot: int, payload: dict = Body(...)):
    try:
        saved = store.save_slot(slot, payload["game_id"], payload["node_id"], str(payload.get("label", ""))[:80])   # English labels run about twice as long as Chinese ones
    except (KeyError, ValueError) as e:
        log.warning("save slot %s failed: %s", slot, e)
        raise HTTPException(400, "save_failed")
    return [_with_thumb(s) for s in saved]


@app.delete("/api/slots/{slot}")
async def delete_slot(slot: int):
    return [_with_thumb(s) for s in store.delete_slot(slot)]


@app.get("/api/autosave")
async def autosave():
    return _with_thumb(store.load_autosave())


config.SAVES.joinpath("games").mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=config.SAVES / "games"), name="media")
app.mount("/", StaticFiles(directory=config.WEB, html=True), name="web")


if __name__ == "__main__":
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")
