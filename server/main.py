"""FastAPI entry: static web client, save media, JSON API and SSE jobs (turns, new game).

Run: python -m server.main   (from the project root) -> http://127.0.0.1:8765
"""
import asyncio
import json
import traceback
import uuid
from contextlib import asynccontextmanager

import uvicorn
from fastapi import Body, FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import comfy_client, config
from .asset_service import AssetService
from .batch_service import BatchService
from .llm_client import LLMClient, LLMError
from .story_store import Store
from .turn_service import TurnError, TurnService

log = config.setup_logging()
store = Store()
assets = AssetService(store)
turns = TurnService(store, LLMClient(), assets)
batches = BatchService(store, turns, assets)
TASKS: dict[str, asyncio.Task] = {}


@asynccontextmanager
async def lifespan(_app):
    (config.SAVES / "games").mkdir(parents=True, exist_ok=True)
    assets.start()
    batches.resume_all()
    log.info("server up on http://%s:%s", config.HOST, config.PORT)
    yield


app = FastAPI(lifespan=lifespan)


def _event(ev: dict) -> str:
    return f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"


def sse_job(work) -> StreamingResponse:
    """Run `work(emit)` as a task and stream its events. Closing the stream cancels the task."""
    q: asyncio.Queue = asyncio.Queue()
    tid = uuid.uuid4().hex[:12]

    async def emit(ev: dict) -> None:
        await q.put(ev)

    async def runner():
        try:
            await work(emit)
        except (TurnError, LLMError) as e:
            await q.put({"type": "error", "code": e.code, "params": e.params})
        except asyncio.CancelledError:
            await q.put({"type": "cancelled"})
            raise
        except Exception:
            log.error("job %s crashed\n%s", tid, config.mask(traceback.format_exc()))
            await q.put({"type": "error", "code": "internal", "params": {}})
        finally:
            await q.put(None)

    task = asyncio.create_task(runner())
    TASKS[tid] = task

    async def stream():
        yield _event({"type": "task", "id": tid})
        try:
            while True:
                ev = await q.get()
                if ev is None:
                    break
                yield _event(ev)
        finally:
            if not task.done():
                task.cancel()
            TASKS.pop(tid, None)

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
    return {"comfy": await comfy_client.online(), "models": [c.label for c in turns.llm.candidates]}


@app.get("/api/games")
async def list_games():
    return store.list_games()


@app.post("/api/games")
async def create_game(payload: dict = Body(...)):
    async def work(emit):
        game = await turns.create_game(payload, emit)
        if game.get("batch"):
            batches.start(game["id"])
    return sse_job(work)


@app.get("/api/batches")
async def list_batches():
    return batches.list()


@app.post("/api/games/{gid}/batch/cancel")
async def cancel_batch(gid: str):
    _game_or_404(gid)
    return {"ok": await batches.stop(gid)}


@app.post("/api/games/{gid}/batch/resume")
async def resume_batch(gid: str):
    game = _game_or_404(gid)
    if not game.get("batch"):
        raise HTTPException(400, "not_batch")
    batches.start(gid)
    return batches.status(gid)


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
async def asset_status(gid: str, scene: str | None = None):
    # The game on screen polls this: keep its images first in line and re-queue what a server restart dropped
    game = _game_or_404(gid)
    assets.active = gid
    assets.ensure_game(game, scene if scene in game["scenes"] else None, retry=False)
    return assets.status(game)


@app.post("/api/games/{gid}/turn")
async def turn(gid: str, payload: dict = Body(...)):
    _game_or_404(gid)
    return sse_job(lambda emit: turns.run_turn(gid, payload.get("parent_id"), payload.get("input") or {}, emit))


@app.post("/api/tasks/{tid}/cancel")
async def cancel(tid: str):
    task = TASKS.get(tid)
    if task and not task.done():
        task.cancel()
        return {"ok": True}
    return {"ok": False}


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
