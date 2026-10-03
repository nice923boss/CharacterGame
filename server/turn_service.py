"""One story turn and the world setup call, as async jobs that report through `emit(dict)`.

A node is written only after the whole turn succeeded, so a cancelled or failed turn leaves the tree
exactly as it was (PLAN section 6).
"""
import asyncio
import random
import time

from . import config, prompts
from .asset_service import P_EXPR, P_SCENE, P_SPEAKER, AssetService
from .llm_client import LLMClient, LLMError, Waits
from .story_store import Store, now_iso
from .turn_parser import (LANGS, MAX_GAME_TITLE, NARRATOR, Cast, LineStream, apply_state, clip, game_lang, last_json,
                          mostly_ascii, repair, slug)

log = config.setup_logging()

MAX_CHARACTERS = 4
MAX_FREE_INPUT = 120
NOVEL_MAX_CHAPTERS = 10           # a batch is at most 10 turns deep, so more chapters could never all be reached
# English needs about twice the characters of Chinese for the same content; the web client uses the same factor
LIMIT_SCALE = {"zh": 1, "en": 2}
PARTIAL_KEEP_S = 600              # how long the whole lines of a turn that broke off wait for the player to retry


def whole_lines(text: str) -> str:
    """`text` up to and including its last newline."""
    return text[:text.rfind("\n") + 1]


def tree_size(options: int, turns: int) -> int:
    """Nodes in a full batch tree: the opening is turn 1 and every non-ending node has `options` children."""
    return sum(options ** k for k in range(turns))


class TurnError(Exception):
    """A player-facing error: `code` plus `params`; the web client turns it into text in the UI language."""

    def __init__(self, code: str, **params):
        super().__init__(code)
        self.code = code
        self.params = params


def _check_text(value, field: str, limit: int, required: bool = True, **params) -> str:
    text = str(value or "").strip()
    if required and not text:
        raise TurnError("required", field=field, **params)
    if len(text) > limit:
        raise TurnError("too_long", field=field, limit=limit, **params)
    return text


class TurnService:
    def __init__(self, store: Store, llm: LLMClient, assets: AssetService):
        self.store = store
        self.llm = llm
        self.assets = assets
        self._locks: dict[str, asyncio.Lock] = {}
        self._writing: dict[tuple, tuple] = {}    # turns in progress by (gid, parent, input): (future, batch)
        self._partial: dict[tuple, tuple] = {}    # whole lines of a turn that broke off, same key: (text, until)

    # ---------- new game ----------

    async def create_game(self, payload: dict, emit, waits: Waits | None = None) -> dict:
        lang = payload.get("lang") if payload.get("lang") in LANGS else "zh"
        x = LIMIT_SCALE[lang]
        world = {k: _check_text((payload.get("world") or {}).get(k), k, 200 * x, k in ("era", "place"))
                 for k in ("era", "place", "genre", "tone", "extra", "goal")}
        p = payload.get("protagonist") or {}
        protagonist = {"name": _check_text(p.get("name"), "hero_name", 12 * x),
                       "profile": _check_text(p.get("profile"), "hero_profile", 200 * x, False)}
        raw_chars = payload.get("characters") or []
        if not 1 <= len(raw_chars) <= MAX_CHARACTERS:
            raise TurnError("char_count", max=MAX_CHARACTERS)
        chars = []
        for i, c in enumerate(raw_chars, 1):
            chars.append({"id": f"c{i}", **{k: _check_text(c.get(k), f"char_{k}", limit * x, i=i) for k, limit in (
                ("name", 12), ("appearance", 300), ("personality", 200), ("speech", 200), ("relationship", 200))}})
        names = [c["name"] for c in chars] + [protagonist["name"]]
        if len(set(names)) != len(names) or set(names) & set(NARRATOR.values()):
            raise TurnError("dup_names", narrator=NARRATOR[lang])
        batch = None
        if payload.get("batch"):
            b = payload["batch"]
            try:
                batch = {"options": int(b.get("options")), "turns": int(b.get("turns"))}
            except (TypeError, ValueError, AttributeError):
                raise TurnError("batch_size", max=config.BATCH_MAX_NODES)
            if not (2 <= batch["options"] <= 4 and 3 <= batch["turns"] <= 10) or                     tree_size(batch["options"], batch["turns"]) > config.BATCH_MAX_NODES:
                raise TurnError("batch_size", max=config.BATCH_MAX_NODES)
            if not world["goal"]:
                raise TurnError("batch_goal")
        novel = None
        if payload.get("novel"):
            n = payload["novel"]
            rows = n.get("chapters") if isinstance(n, dict) else None
            if not isinstance(rows, list) or not 1 <= len(rows) <= NOVEL_MAX_CHAPTERS or \
                    not all(isinstance(r, dict) for r in rows):
                raise TurnError("chapter_count", max=NOVEL_MAX_CHAPTERS)
            novel = {"title": _check_text(n.get("title"), "novel_title", 60 * x, False),
                     "chapters": [{"title": _check_text(r.get("title"), "chapter_title", 20 * x, i=i),
                                   "summary": _check_text(r.get("summary"), "chapter_summary", 200 * x, i=i)}
                                  for i, r in enumerate(rows, 1)]}

        async def status_only(ev):
            if ev["type"] == "status":
                await emit(ev)

        await emit({"type": "phase", "code": "setup_art"})
        res = await self.llm.stream(prompts.setup_messages(world, chars, lang), status_only, temperature=0.5,
                                   waits=waits)
        d = last_json(res.content) or {}
        looks = {str(x.get("name", "")).strip(): str(x.get("appearance_en", "")).strip()
                 for x in d.get("characters") or [] if isinstance(x, dict)}
        fs = d.get("first_scene") if isinstance(d.get("first_scene"), dict) else {}
        sid = slug(fs.get("id", "")) or "opening"
        if not mostly_ascii(str(fs.get("image_prompt", ""))) or not all(mostly_ascii(looks.get(c["name"], ""))
                                                                          for c in chars):
            log.warning("setup json unusable: %s", config.mask(res.content[:800]))
            raise TurnError("setup_unusable")

        seed = random.randint(1, 2**31 - 1000)
        cast = Cast(chars, protagonist["name"], lang)
        game = {
            "id": self.store.new_game_id(), "created_at": now_iso(), "seed": seed, "lang": lang,
            "title": cast.conv(clip(str(d.get("title") or world["place"]).strip(), MAX_GAME_TITLE[lang])),
            "style_en": str(d.get("style_en", "")).strip()[:200],
            "world": world, "protagonist": protagonist,
            "characters": [{**c, "appearance_en": looks[c["name"]], "seed": seed + 17 * i}
                           for i, c in enumerate(chars, 1)],
            "scenes": {sid: {"name": cast.conv(str(fs.get("name") or ("序章" if lang == "zh" else "Prologue"))),
                             "image_prompt": str(fs["image_prompt"]).strip()}},
            "first_scene": sid,
            "setup_model": res.candidate.model,
            **({"batch": batch} if batch else {}),
            **({"novel": novel} if novel else {}),
        }
        self.store.save_game(game)
        self.assets.ensure_game(game, sid)
        log.info("game created %s title=%s", game["id"], game["title"])
        await emit({"type": "final", "game": game})
        return game

    # ---------- one turn ----------

    @staticmethod
    def _existing_child(tree: dict, parent: dict, text: str) -> dict | None:
        """A child of `parent` whose player input has the same text (option or free, spaces ignored)."""
        key = "".join(text.split())
        for cid in parent.get("children", []):
            child = tree["nodes"].get(cid)
            if child and "".join(str(child["player_input"].get("text", "")).split()) == key:
                return child
        return None

    async def run_turn(self, gid: str, parent_id: str | None, player_input: dict, emit, batch: bool = False,
                       waits: Waits | None = None) -> dict:
        """batch=True: written ahead by the batch walker, so no autosave, no sprite requests, and the
        scene waits behind the images of the game on screen."""
        key = (gid, parent_id, "".join(str(player_input.get("text") or "").split()))
        writing = self._writing.get(key)
        if writing and not batch:
            # This branch is being written already (by the batch, or by this player's earlier request whose
            # stream dropped): wait for it and replay it instead of writing a second copy
            await emit({"type": "phase", "code": "batch_wait" if writing[1] else "same_wait"})
            await asyncio.wait([writing[0]])
        if key in self._writing:
            return await self._turn(gid, parent_id, player_input, emit, batch, waits, key)
        done = asyncio.get_running_loop().create_future()
        self._writing[key] = (done, batch)
        try:
            return await self._turn(gid, parent_id, player_input, emit, batch, waits, key)
        finally:
            self._writing.pop(key, None)
            done.set_result(None)

    def _take_partial(self, key: tuple) -> str:
        text, until = self._partial.pop(key, ("", 0))
        return text if time.monotonic() < until else ""

    def _keep_partial(self, key: tuple, text: str, cast: Cast) -> None:
        now = time.monotonic()
        self._partial = {k: v for k, v in self._partial.items() if v[1] > now}
        if text and LineStream(cast).feed(text):
            self._partial[key] = (text, now + PARTIAL_KEEP_S)

    async def _replay(self, gid: str, game: dict, node: dict, emit) -> dict:
        """Same answer at the same node: replay the stored turn, no LLM call, tree unchanged."""
        for ln in node["lines"]:
            await emit({"type": "line", "line": ln})
        self.store.set_autosave(gid, node["id"], node["scene_id"])
        self.assets.request(("scene", gid, node["scene_id"]), P_SCENE)
        log.info("turn replayed %s %s", gid, node["id"])
        await emit({"type": "final", "node": node, "scenes": game["scenes"], "replayed": True})
        return node

    async def _turn(self, gid: str, parent_id: str | None, player_input: dict, emit, batch: bool,
                    waits: Waits | None = None, key: tuple = ()) -> dict:
        game = self.store.load_game(gid)
        tree = self.store.load_tree(gid)
        kind = player_input.get("kind")
        if parent_id is None:
            if kind != "opening":
                raise TurnError("already_started")
            if tree["root"] is not None:
                # Sent again after the opening was saved (its stream dropped, or the batch wrote it): replay it
                root = tree["nodes"][tree["root"]]
                return root if batch else await self._replay(gid, game, root, emit)
            player_input = {"kind": "opening", "text": ""}
        else:
            if parent_id not in tree["nodes"]:
                raise TurnError("node_not_found")
            if kind not in ("option", "free"):
                raise TurnError("bad_input_kind")
            player_input = {"kind": kind, "text": _check_text(player_input.get("text"), "action",
                                                              MAX_FREE_INPUT * LIMIT_SCALE[game_lang(game)])}

        path = self.store.path_to(tree, parent_id)
        parent = path[-1] if path else None
        if parent and parent["result"].get("ending"):
            raise TurnError("branch_ended")
        if parent:
            known = self._existing_child(tree, parent, player_input["text"])
            if known and batch:
                return known
            if known:
                return await self._replay(gid, game, known, emit)
        scene_id = parent["scene_id"] if parent else game["first_scene"]
        scene = {"id": scene_id, **game["scenes"][scene_id]}
        cast = Cast(game["characters"], game["protagonist"]["name"], game_lang(game))
        lang = game_lang(game)
        msgs = prompts.turn_messages(game, path, player_input, scene)
        # The same turn broke off before: keep its whole lines and ask only for the rest
        partial = "" if batch else self._take_partial(key)
        holder = [LineStream(cast)]
        raw = [partial]         # text of the current attempt, the resumed part included
        broken = [""]           # whole lines of the last attempt that was reset

        async def emit_lines(lines):
            for ln in lines:
                if ln["char_id"] and not batch:
                    self.assets.request(("sprite", gid, ln["char_id"], ln["expr"]), P_SPEAKER)
                await emit({"type": "line", "line": ln})

        async def on_event(ev):
            if ev["type"] == "delta":
                raw[0] += ev["text"]
                await emit_lines(holder[0].feed(ev["text"]))
            elif ev["type"] == "reset":
                broken[0] = whole_lines(raw[0])
                raw[0] = partial
                holder[0] = LineStream(cast)
                await emit({**ev, "keep": len(holder[0].feed(partial))})   # the resumed lines stay
            else:
                await emit(ev)

        if partial:
            await emit({"type": "phase", "code": "resume_partial"})
            await emit_lines(holder[0].feed(partial))
        try:
            res = await self.llm.stream(prompts.repair_messages(msgs, partial, lang, "continue") if partial else msgs,
                                        on_event, waits=waits)
        except BaseException:
            if not batch:
                self._keep_partial(key, max(whole_lines(raw[0]), broken[0], key=len), cast)
            raise
        content = partial + res.content
        await emit_lines(holder[0].finish())
        lines = holder[0].lines
        if not lines:
            log.warning("turn without lines: %s", config.mask(content[:600]))
            raise TurnError("no_lines")

        d = last_json(content)
        failed = []         # repair calls that failed: the dialogue is on screen, so the turn keeps the defaults
        if d is None:
            await emit({"type": "phase", "code": "repair_json"})
            try:
                fix = await self.llm.complete(prompts.repair_messages(msgs, content, lang), temperature=0.3)
                d = last_json(fix.content)
            except LLMError as e:
                failed.append(f"repair call failed ({e.code})")
        current = {"scene_id": scene_id, "bgm_mood": parent["bgm_mood"] if parent else "calm",
                   "weather": parent.get("weather", "none") if parent else "none"}
        plan = game.get("batch")
        allow_ending = bool(parent) and bool(game["world"].get("goal"))
        opts = {"allow_ending": allow_ending, "n_options": plan and plan["options"],
                "allow_new_scene": not plan or len(game["scenes"]) < config.BATCH_MAX_SCENES}
        result, notes = repair(d, cast, game["scenes"], current, **opts)
        if plan and allow_ending and not result["ending"] and len(path) + 1 >= plan["turns"]:
            # The tree is only finite if the last turn ends; ask for the ending JSON on its own
            await emit({"type": "phase", "code": "repair_json"})
            try:
                fix = await self.llm.complete(prompts.repair_messages(msgs, content, lang, "force_ending"),
                                              temperature=0.3)
                extra = last_json(fix.content) or {}
            except LLMError as e:
                failed.append(f"ending call failed ({e.code})")
                extra = {}
            result, notes = repair({**(d or {}), **extra}, cast, game["scenes"], current, **opts)
            notes = [*notes, "ending forced" if result["ending"] else "forced ending missing"]
        notes = [*notes, *failed, *(["resumed after a break"] if partial else [])]
        if notes:
            log.info("turn repaired %s: %s", gid, notes)

        async with self._locks.setdefault(gid, asyncio.Lock()):
            fresh = self.store.load_tree(gid)
            if batch and parent:
                # The player may have reached this branch live while it was being written
                twin = self._existing_child(fresh, fresh["nodes"][parent_id], player_input["text"])
                if twin:
                    return twin
            if not parent and fresh["root"] is not None:
                # Someone else saved the opening meanwhile; a tree has one root, so show theirs
                root = fresh["nodes"][fresh["root"]]
                if batch:
                    return root
                await emit({"type": "reset", "keep": 0})
                return await self._replay(gid, game, root, emit)
            if result["scene_change"]:
                sc = result["scene"]
                game = self.store.load_game(gid)
                if sc["id"] not in game["scenes"]:
                    if plan and len(game["scenes"]) >= config.BATCH_MAX_SCENES:
                        # Parallel batch turns can pass the budget check together; the last ones stay put
                        sc = None
                        result = {**result, "scene_change": False, "scene": None}
                        notes.append("new scene dropped (scene budget used up)")
                    else:
                        game["scenes"][sc["id"]] = {"name": sc["name"], "image_prompt": sc["image_prompt"]}
                        self.store.save_game(game)
                if sc:
                    scene_id = sc["id"]
            base_state = parent["state"] if parent else {"affection": {c["name"]: 0 for c in game["characters"]},
                                                        "flags": [], "items": []}
            summary = (parent["summary"] if parent else []) + ([result["summary_update"]]
                                                                if result["summary_update"] else [])
            node = self.store.add_node(gid, {
                "parent": parent_id, "scene_id": scene_id, "player_input": player_input, "lines": lines,
                "result": result, "state": apply_state(base_state, result["state_changes"]), "summary": summary,
                "bgm_mood": result["bgm_mood"], "weather": result["weather"], "model": res.candidate.model,
                "repair_notes": notes,
            })
            if not batch:
                self.store.set_autosave(gid, node["id"], node["scene_id"])
        self.assets.request(("scene", gid, scene_id), P_EXPR if batch else P_SCENE)
        await emit({"type": "final", "node": node, "scenes": game["scenes"]})
        return node
