"""Batch mode: write the whole option tree of a new game ahead, so every option replays with no wait.

Progress lives in batch.json next to game.json (never inside it, so parallel turns cannot race on one file).
Text runs up to BATCH_CONCURRENCY turns at a time, fewer while the model is busy; images go through the normal
GPU queue at the same time. A failed branch waits outside its slot before each retry; whatever still fails gets
one more try after the whole pass, and is then recorded and skipped; the player's own choice there is written
live, like a normal game.
"""
import asyncio
import collections
import functools
import time
import traceback

from . import config
from .asset_service import P_EXPR, AssetService
from .llm_client import LLMError
from .story_store import Store, _read, _write, now_iso
from .turn_service import TurnError, TurnService, tree_size

log = config.setup_logging()

IMAGE_POLL_S = 5
ACTIVE = ("running", "images")
BUSY = ("transient", "timeout")      # LLMError reasons that mean the model is overloaded, not that the turn is bad
ETA_WINDOW = 10                      # finished turns the time estimate averages over


async def _noop(_ev):
    return None


def retry_wait(n: int) -> float:
    """Seconds to wait before try number n + 1 of a branch (n >= 1)."""
    waits = config.BATCH_RETRY_WAITS_S
    return waits[min(n, len(waits)) - 1]


class Limiter:
    """How many batch turns may talk to the model at once, shared by every batch (after a restart every game's
    batch resumes together). A busy answer halves the limit, never below 1; BATCH_GROW_AFTER successes in a row
    give one slot back."""

    def __init__(self, most: int):
        self.most = self.limit = most
        self.active = 0
        self.streak = 0
        self._changed = asyncio.Event()

    async def __aenter__(self):
        while self.active >= self.limit:
            self._changed.clear()
            await self._changed.wait()
        self.active += 1

    async def __aexit__(self, *_exc):
        self.active -= 1
        self._changed.set()

    def busy(self) -> None:
        self.limit = max(1, self.limit // 2)
        self.streak = 0

    def ok(self) -> None:
        self.streak += 1
        if self.streak >= config.BATCH_GROW_AFTER and self.limit < self.most:
            self.limit += 1
            self.streak = 0
            self._changed.set()


def branch_key(parent_id: str | None, option: str) -> tuple:
    return parent_id, "".join(option.split())


def open_failed(tree: dict, failed: list[dict]) -> list[dict]:
    """Recorded failures whose branch is still unwritten; the player or a later pass may have written it since."""
    def still_open(f):
        if f["parent"] is None:
            return tree["root"] is None
        parent = tree["nodes"].get(f["parent"])
        return parent is not None and TurnService._existing_child(tree, parent, f["option"]) is None
    return [f for f in failed if still_open(f)]


def option_children(tree: dict, node: dict):
    """(option text, existing child or None) for each distinct option of a node."""
    seen = set()
    for opt in node["result"].get("options") or []:
        key = "".join(opt.split())
        if key and key not in seen:
            seen.add(key)
            yield opt, TurnService._existing_child(tree, node, opt)


def main_line(tree: dict) -> list[str]:
    """Node ids from the root to the deepest ending (the deepest node when nothing ended yet)."""
    def depth(nid):
        return len(Store.path_to(tree, nid))
    ends = [n["id"] for n in tree["nodes"].values() if n["result"].get("ending")]
    leaf = max(ends or list(tree["nodes"]), key=lambda nid: (depth(nid), nid))
    return [n["id"] for n in Store.path_to(tree, leaf)]


def text_progress(game: dict, tree: dict) -> tuple[int, int]:
    """(nodes written, nodes planned). Planned is an upper bound that shrinks as early endings appear."""
    n, last = game["batch"]["options"], game["batch"]["turns"]
    if game["batch"].get("merge"):
        # Merge-back trees are graphs: count each node once; every open option is one more node to write
        open_opts = sum(1 for node in tree["nodes"].values() if not node["result"].get("ending")
                        for _opt, child in option_children(tree, node) if child is None)
        return len(tree["nodes"]), len(tree["nodes"]) + open_opts
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
        self.limiter = Limiter(config.BATCH_CONCURRENCY)
        self.done_at: dict[str, collections.deque] = {}      # monotonic times of the last finished turns, per game
        self._stop_as: dict[str, str] = {}                     # the state a stopped batch is saved with
        self._sleep = asyncio.sleep                            # the fixed waits; tests record them instead

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
        # The failed list stays: a branch leaves it only once it is written
        self._save(gid, state="running", started_at=old.get("started_at") or now_iso(), finished_at=None,
                   error=None)
        task = asyncio.create_task(self._run(gid))
        self.tasks[gid] = task
        task.add_done_callback(lambda _t: self.tasks.pop(gid, None))

    async def stop(self, gid: str, state: str = "cancelled") -> bool:
        """Cancel a running batch and wait until it has let go of the game's files. state="paused" when the
        player means to go on later; either way the tree is the progress, so resuming continues from it."""
        task = self.tasks.get(gid)
        if not task:
            return False
        self._stop_as[gid] = state
        task.cancel()
        await asyncio.wait([task], timeout=10)
        return True

    async def rewrite(self, gid: str, parent_id: str, option: str) -> dict:
        """Write one branch now, outside the walker (the tree view's retry button). Errors go to the caller."""
        parent = self.store.load_tree(gid)["nodes"].get(parent_id)
        options = (parent or {}).get("result", {}).get("options") or []
        if branch_key(parent_id, option) not in {branch_key(parent_id, o) for o in options}:
            raise TurnError("no_branch")
        async with self.limiter:
            return await self.turns.run_turn(gid, parent_id, {"kind": "option", "text": option}, _noop, batch=True)

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
        tree = self.store.load_tree(gid)
        made, planned = text_progress(game, tree)
        failed = open_failed(tree, b.get("failed") or [])
        a = self.assets.status(game)
        states = [s["state"] for s in a["scenes"].values()] + \
                 [s["state"] for sp in a["sprites"].values() for s in sp.values()]
        states = [s for s in states if s != "off"]
        live = b["state"] == "running" and gid in self.tasks
        # Time left: the average gap between the last finished turns times the turns still planned
        times = list(self.done_at.get(gid, ()))
        eta = round((times[-1] - times[0]) / (len(times) - 1) * max(0, planned - made)) \
            if live and len(times) >= 2 else None
        return {"id": gid, "title": game["title"], "lang": game.get("lang", "zh"), "state": b["state"],
                "nodes": made, "planned": planned, "failed": len(failed), "failed_list": failed,
                "eta_s": eta, "slow": live and self.limiter.limit < self.limiter.most,
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
        self.done_at[gid] = collections.deque(maxlen=ETA_WINDOW + 1)
        try:
            ok = await self._text(gid, 1 + config.BATCH_TURN_RETRIES)
            if self._open_failed(gid):
                # The busy spell may be over by now: every branch that failed gets one more try
                log.info("batch tail pass %s in %d s", gid, config.BATCH_TAIL_WAIT_S)
                await self._sleep(config.BATCH_TAIL_WAIT_S)
                ok = await self._text(gid, 1)
            failed = self._open_failed(gid)
            self._save(gid, failed=failed)
            if not ok:
                error = next((f["error"] for f in failed if f["parent"] is None), None) or "internal"
                self._save(gid, state="error", error=error, finished_at=now_iso())
                return
            made, _planned = text_progress(self.store.load_game(gid), self.store.load_tree(gid))
            log.info("batch text done %s: %d nodes, %d branches skipped", gid, made, len(failed))
            await self._images(gid)
        except asyncio.CancelledError:
            state = self._stop_as.pop(gid, "cancelled")
            self._save(gid, state=state, finished_at=now_iso())
            log.info("batch %s %s", state, gid)
            raise
        except Exception:
            log.error("batch crashed %s\n%s", gid, config.mask(traceback.format_exc()))
            self._save(gid, state="error", error="internal", finished_at=now_iso())

    def _open_failed(self, gid: str) -> "list[dict]":     # quoted: the method list() hides the builtin here
        return open_failed(self.store.load_tree(gid), (self.load(gid) or {}).get("failed") or [])

    async def _text(self, gid: str, tries: int) -> bool:
        """One pass over every open branch, each with `tries` tries. False when the opening could not be written."""
        game = self.store.load_game(gid)
        turn = functools.partial(self._turn, gid, tries)
        if game["batch"].get("merge"):
            return await self._merge_text(gid, game, turn)
        if self.store.load_tree(gid)["root"] is None and await turn(None, {"kind": "opening"}) is None \
                and self.store.load_tree(gid)["root"] is None:      # unless the player opened it live meanwhile
            return False
        await self._walk(gid, game["batch"]["turns"], tries)
        return True

    async def _attempt(self, gid: str, parent_id: str | None, player_input: dict) -> tuple[dict | None, str | None]:
        """One try at one branch inside a limiter slot: (node, None), or (None, error code)."""
        try:
            async with self.limiter:
                node = await self.turns.run_turn(gid, parent_id, player_input, _noop, batch=True)
        except (TurnError, LLMError) as e:
            if isinstance(e, LLMError) and any(x.get("reason") in BUSY for x in e.params["errors"]):
                self.limiter.busy()
            return None, e.code
        except Exception:
            log.error("batch turn crashed %s\n%s", gid, config.mask(traceback.format_exc()))
            return None, "internal"
        self.limiter.ok()
        self.done_at.setdefault(gid, collections.deque(maxlen=ETA_WINDOW + 1)).append(time.monotonic())
        return node, None

    async def _turn(self, gid: str, tries: int, parent_id: str | None, player_input: dict) -> dict | None:
        """One branch with all its tries, each wait spent outside any slot. The opening and the merge walker use
        this; the tree walker schedules its own retries so other branches can use the slot meanwhile."""
        error = None
        for n in range(tries):
            if n:
                await self._sleep(retry_wait(n))
            node, error = await self._attempt(gid, parent_id, player_input)
            if node:
                return node
        self._fail(gid, parent_id, player_input.get("text", ""), error)
        return None

    def _fail(self, gid: str, parent_id: str | None, option: str, error: str | None) -> None:
        """Record a branch that used up its tries; the same branch failing again replaces its old entry."""
        key = branch_key(parent_id, option)
        old = [f for f in (self.load(gid) or {}).get("failed") or [] if branch_key(f["parent"], f["option"]) != key]
        entry = {"parent": parent_id, "option": option, "error": error}
        self._save(gid, failed=open_failed(self.store.load_tree(gid), old) + [entry])
        log.warning("batch branch skipped %s parent=%s: %s", gid, parent_id, error)

    def _focus(self, gid: str, tree: dict) -> set[str]:
        """The node the player is on (autosave) and every node written under it."""
        auto = self.store.load_autosave() or {}
        nid = auto.get("node_id") if auto.get("game_id") == gid else None
        if nid not in tree["nodes"]:
            return set()
        out, stack = set(), [nid]
        while stack:
            n = stack.pop()
            out.add(n)
            stack.extend(c for c in tree["nodes"][n].get("children", []) if c in tree["nodes"])
        return out

    async def _walk(self, gid: str, last: int, tries: int) -> None:
        """Write every open option: the player's own branch first, then shallow turns before deep ones, so the
        player can start at the opening and rarely catches up with the writer. The order is worked out again
        after every finished turn, because the player moves while the batch runs. A failed branch gives its slot
        to the others while it waits for its next try; after `tries` failures it is recorded and skipped."""
        loop = asyncio.get_running_loop()
        tried: set[tuple] = set()
        later: dict[tuple, tuple[float, int]] = {}      # branch -> (when it may try again, tries so far)
        running: dict[asyncio.Task, tuple] = {}          # task -> (parent id, option, tries before this one)
        try:
            while True:
                tree = self.store.load_tree(gid)
                focus = self._focus(gid, tree)
                now = loop.time()
                todo, still_open, stack = [], set(), [(tree["root"], 1)]
                while stack:
                    nid, depth = stack.pop()
                    node = tree["nodes"][nid]
                    if node["result"].get("ending") or depth >= last:
                        continue
                    for opt, child in option_children(tree, node):
                        key = branch_key(nid, opt)
                        if child:
                            stack.append((child["id"], depth + 1))
                            continue
                        still_open.add(key)
                        if key not in tried:
                            todo.append((nid not in focus, depth, nid, opt, 0))
                        elif key in later and later[key][0] <= now:
                            todo.append((nid not in focus, depth, nid, opt, later[key][1]))
                for key in set(later) - still_open:              # the player wrote it meanwhile
                    del later[key]
                for _away, _depth, nid, opt, n in sorted(todo)[:max(0, self.limiter.limit - len(running))]:
                    key = branch_key(nid, opt)
                    tried.add(key)
                    later.pop(key, None)
                    running[asyncio.create_task(self._attempt(gid, nid, {"kind": "option", "text": opt}))] = \
                        (nid, opt, n)
                if not running and not later:
                    return
                # Wake for a finished turn or for the next retry that comes due (one already due waits for room)
                wake = min((due for due, _n in later.values() if due > now), default=None)
                timeout = None if wake is None else max(0.0, wake - loop.time())
                if running:
                    done, _pending = await asyncio.wait(running, timeout=timeout, return_when=asyncio.FIRST_COMPLETED)
                else:
                    await asyncio.sleep(timeout)
                    done = set()
                for task in done:
                    nid, opt, n = running.pop(task)
                    node, error = task.result()
                    if node is None and n + 1 < tries:
                        later[branch_key(nid, opt)] = (loop.time() + retry_wait(n + 1), n + 1)
                    elif node is None:
                        self._fail(gid, nid, opt, error)
        finally:
            for t in running:
                t.cancel()
            await asyncio.gather(*running, return_exceptions=True)

    async def _merge_text(self, gid: str, game: dict, turn) -> bool:
        """Merge-back walker. The main line (saved in batch.json) is written to an ending; every other option of
        a main node opens a side branch of at most `merge` turns whose last option rejoins the main line one turn
        further on, so a side branch never grows a tree of its own. False when the opening itself failed."""
        plan = game["batch"]
        last, detour = plan["turns"], plan["merge"]
        tree = self.store.load_tree(gid)
        if tree["root"] is None:
            if await turn(None, {"kind": "opening"}) is None:
                return False
            tree = self.store.load_tree(gid)
        main = (self.load(gid) or {}).get("main") or main_line(tree)
        while not tree["nodes"][main[-1]]["result"].get("ending") and len(main) < last + 1:
            opts = tree["nodes"][main[-1]]["result"].get("options") or []
            child = opts and TurnService._existing_child(tree, tree["nodes"][main[-1]], opts[0])
            child = child or (opts and await turn(main[-1], {"kind": "option", "text": opts[0]}))
            if not child:
                break
            main.append(child["id"])
            self._save(gid, main=main)
            tree = self.store.load_tree(gid)
        self._save(gid, main=main)
        if tree["nodes"][main[-1]]["result"].get("ending") and len(main) != last:
            # The main line ended on its own: side branches past it have nothing to rejoin, so they end there too
            last = len(main)
            game = self.store.load_game(gid)
            self.store.save_game({**game, "batch": {**game["batch"], "turns": last}})
        on_main = set(main)

        async def side(parent_id: str, opt: str, child: dict | None, depth: int, k: int) -> None:
            if child is None:
                child = await turn(parent_id, {"kind": "option", "text": opt})
            if not child or child["result"].get("ending") or depth > last + 1:
                return
            tree = self.store.load_tree(gid)
            node = tree["nodes"][child["id"]]
            target = main[depth] if depth < len(main) else None      # main[i] is turn i + 1
            if target and "merged_to" not in node:
                back = tree["nodes"][target]["player_input"]["text"]
                pairs = list(option_children(tree, node))
                keep = [o for o, c in pairs if c]                      # options the player already took
                fresh = [o for o, c in pairs if not c and "".join(o.split()) != "".join(back.split())]
                if k < detour and fresh:
                    keep.append(fresh[0])
                if "".join(back.split()) not in {"".join(o.split()) for o in keep}:
                    keep.append(back)
                self.store.link(gid, node["id"], target, keep)
                tree = self.store.load_tree(gid)
                node = tree["nodes"][node["id"]]
            elif not target and depth < last:
                return                          # the main line broke off before an ending: left for live play
            await asyncio.gather(*(side(node["id"], o, c, depth + 1, k + 1)
                                   for o, c in option_children(tree, node)
                                   if not (c and c.get("parent") != node["id"])))

        await asyncio.gather(*(side(mid, o, c, d + 1, 1)
                               for d, mid in enumerate(main, 1)
                               for o, c in option_children(tree, tree["nodes"][mid])
                               if not (c and c["id"] in on_main)))
        return True

    async def _images(self, gid: str) -> None:
        """Queue every scene and sprite of the game and wait until each one is drawn or failed."""
        self._save(gid, state="images")
        while True:
            game = self.store.load_game(gid)
            for sid in game["scenes"]:
                self.assets.request(("scene", gid, sid), P_EXPR, retry=False)
            self.assets.ensure_game(game, retry=False)
            a = self.assets.status(game)
            states = [s["state"] for s in a["scenes"].values()] + \
                     [s["state"] for sp in a["sprites"].values() for s in sp.values()]
            if all(s in ("done", "error", "off") for s in states):   # "off": the image mode skips it
                break
            await asyncio.sleep(IMAGE_POLL_S)
        self._save(gid, state="done", finished_at=now_iso())
        log.info("batch done %s", gid)
