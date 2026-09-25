"""Batch mode: write the whole option tree of a new game ahead, so every option replays with no wait.

Progress lives in batch.json next to game.json (never inside it, so parallel turns cannot race on one file).
Text runs BATCH_CONCURRENCY turns at a time; images go through the normal GPU queue at the same time. A branch
that keeps failing is recorded and skipped; the player's own choice there is written live, like a normal game.
"""
import asyncio
import traceback

from . import config
from .asset_service import P_EXPR, AssetService
from .llm_client import LLMError
from .story_store import Store, _read, _write, now_iso
from .turn_service import TurnError, TurnService, tree_size

log = config.setup_logging()

IMAGE_POLL_S = 5
ACTIVE = ("running", "images")


async def _noop(_ev):
    return None


def option_children(tree: dict, node: dict):
    """(option text, existing child or None) for each distinct option of a node."""
    seen = set()
    for opt in node["result"].get("options") or []:
        key = "".join(opt.split())
        if key and key not in seen:
            seen.add(key)
            yield opt, TurnService._existing_child(tree, node, opt)


def text_progress(game: dict, tree: dict) -> tuple[int, int]:
    """(nodes written, nodes planned). Planned is an upper bound that shrinks as early endings appear."""
    n, last = game["batch"]["options"], game["batch"]["turns"]
    if tree["root"] is None:
        return 0, tree_size(n, last)
    made = planned = 0
    stack = [(tree["root"], 1)]
    while stack:
        nid, depth = stack.pop()
        node = tree["nodes"][nid]
        made += 1
        planned += 1
        if node["result"].get("ending") or depth >= last:
            continue
        for _opt, child in option_children(tree, node):
            if child:
                stack.append((child["id"], depth + 1))
            else:
                planned += tree_size(n, last - depth)
    return made, planned


class BatchService:
    def __init__(self, store: Store, turns: TurnService, assets: AssetService):
        self.store = store
        self.turns = turns
        self.assets = assets
        self.tasks: dict[str, asyncio.Task] = {}

    # ---------- batch.json ----------

    def load(self, gid: str) -> dict | None:
        return _read(self.store.game_dir(gid) / "batch.json")

    def _save(self, gid: str, **fields) -> None:
        folder = self.store.game_dir(gid)
        if (folder / "game.json").exists():      # never bring back the folder of a deleted game
            _write(folder / "batch.json", {**(self.load(gid) or {}), **fields})

    # ---------- control ----------

    def start(self, gid: str) -> None:
        if gid in self.tasks:
            return
        old = self.load(gid) or {}
        self._save(gid, state="running", started_at=old.get("started_at") or now_iso(), finished_at=None,
                   failed=[], error=None)
        task = asyncio.create_task(self._run(gid))
        self.tasks[gid] = task
        task.add_done_callback(lambda _t: self.tasks.pop(gid, None))

    async def stop(self, gid: str) -> bool:
        """Cancel a running batch and wait until it has let go of the game's files."""
        task = self.tasks.get(gid)
        if not task:
            return False
        task.cancel()
        await asyncio.wait([task], timeout=10)
        return True

    def resume_all(self) -> None:
        """After a server restart, pick up every batch that was still working."""
        for p in (self.store.root / "games").glob("*/batch.json"):
            if (_read(p) or {}).get("state") in ACTIVE:
                log.info("batch resumed %s", p.parent.name)
                self.start(p.parent.name)

    def status(self, gid: str) -> dict | None:
        b = self.load(gid)
        if not b:
            return None
        game = self.store.load_game(gid)
        made, planned = text_progress(game, self.store.load_tree(gid))
        a = self.assets.status(game)
        states = [s["state"] for s in a["scenes"].values()] + \
                 [s["state"] for sp in a["sprites"].values() for s in sp.values()]
        return {"id": gid, "title": game["title"], "lang": game.get("lang", "zh"), "state": b["state"],
                "nodes": made, "planned": planned, "failed": len(b.get("failed") or []),
                "images": states.count("done"), "images_total": len(states), "image_errors": states.count("error"),
                "started_at": b.get("started_at"), "finished_at": b.get("finished_at"), "error": b.get("error")}

    def list(self) -> list[dict]:
        out = []
        for p in sorted((self.store.root / "games").glob("*/batch.json"), reverse=True):
            if (p.parent / "game.json").exists():
                out.append(self.status(p.parent.name))
        return out

    # ---------- walker ----------

    async def _run(self, gid: str) -> None:
        failed: list[dict] = []
        try:
            game = self.store.load_game(gid)
            last = game["batch"]["turns"]
            sem = asyncio.Semaphore(config.BATCH_CONCURRENCY)

            async def turn(parent_id: str | None, player_input: dict) -> dict | None:
                error = None
                for _ in range(1 + config.BATCH_TURN_RETRIES):
                    try:
                        async with sem:
                            return await self.turns.run_turn(gid, parent_id, player_input, _noop, batch=True)
                    except (TurnError, LLMError) as e:
                        error = e.code
                    except Exception:
                        log.error("batch turn crashed %s\n%s", gid, config.mask(traceback.format_exc()))
                        error = "internal"
                failed.append({"parent": parent_id, "option": player_input.get("text", ""), "error": error})
                log.warning("batch branch skipped %s parent=%s: %s", gid, parent_id, error)
                self._save(gid, failed=failed)
                return None

            async def expand(node: dict, depth: int) -> None:
                if node["result"].get("ending") or depth >= last:
                    return
                tree = self.store.load_tree(gid)
                await asyncio.gather(*(child_branch(node["id"], opt, child, depth + 1)
                                       for opt, child in option_children(tree, tree["nodes"][node["id"]])))

            async def child_branch(parent_id: str, opt: str, child: dict | None, depth: int) -> None:
                if child is None:
                    child = await turn(parent_id, {"kind": "option", "text": opt})
                if child:
                    await expand(child, depth)

            tree = self.store.load_tree(gid)
            root = tree["nodes"][tree["root"]] if tree["root"] else await turn(None, {"kind": "opening"})
            if root is None and self.store.load_tree(gid)["root"]:     # the player opened it live meanwhile
                tree = self.store.load_tree(gid)
                root = tree["nodes"][tree["root"]]
            if root is None:
                self._save(gid, state="error", error=failed[-1]["error"], finished_at=now_iso())
                return
            await expand(root, 1)
            made, _planned = text_progress(game, self.store.load_tree(gid))
            log.info("batch text done %s: %d nodes, %d branches skipped", gid, made, len(failed))

            self._save(gid, state="images")
            while True:
                game = self.store.load_game(gid)
                for sid in game["scenes"]:
                    if ("scene", gid, sid) not in self.assets.errors:
                        self.assets.request(("scene", gid, sid), P_EXPR)
                self.assets.ensure_game(game, retry=False)
                a = self.assets.status(game)
                states = [s["state"] for s in a["scenes"].values()] + \
                         [s["state"] for sp in a["sprites"].values() for s in sp.values()]
                if all(s in ("done", "error") for s in states):
                    break
                await asyncio.sleep(IMAGE_POLL_S)
            self._save(gid, state="done", finished_at=now_iso())
            log.info("batch done %s", gid)
        except asyncio.CancelledError:
            self._save(gid, state="cancelled", finished_at=now_iso())
            log.info("batch cancelled %s", gid)
            raise
        except Exception:
            log.error("batch crashed %s\n%s", gid, config.mask(traceback.format_exc()))
            self._save(gid, state="error", error="internal", finished_at=now_iso())
