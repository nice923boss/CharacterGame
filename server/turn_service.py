"""One story turn and the world setup call, as async jobs that report through `emit(dict)`.

A node is written only after the whole turn succeeded, so a cancelled or failed turn leaves the tree
exactly as it was (PLAN section 6).
"""
import asyncio
import random

from . import config, prompts
from .asset_service import P_EXPR, P_SCENE, P_SPEAKER, AssetService
from .llm_client import LLMClient
from .story_store import Store, now_iso
from .turn_parser import (LANGS, MAX_GAME_TITLE, NARRATOR, Cast, LineStream, apply_state, clip, game_lang, last_json,
                          mostly_ascii, repair, slug)

log = config.setup_logging()

MAX_CHARACTERS = 4
MAX_FREE_INPUT = 120
# English needs about twice the characters of Chinese for the same content; the web client uses the same factor
LIMIT_SCALE = {"zh": 1, "en": 2}


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

    # ---------- new game ----------

    async def create_game(self, payload: dict, emit) -> dict:
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

        async def status_only(ev):
            if ev["type"] == "status":
                await emit(ev)

        await emit({"type": "phase", "code": "setup_art"})
        res = await self.llm.stream(prompts.setup_messages(world, chars, lang), status_only, temperature=0.5)
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

    async def run_turn(self, gid: str, parent_id: str | None, player_input: dict, emit, batch: bool = False) -> dict:
        """batch=True: written ahead by the batch walker, so no autosave, no sprite requests, and the
        scene waits behind the images of the game on screen."""
        game = self.store.load_game(gid)
        tree = self.store.load_tree(gid)
        kind = player_input.get("kind")
        if parent_id is None:
            if tree["root"] is not None or kind != "opening":
                raise TurnError("already_started")
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
                # Same answer at the same node: replay the stored turn, no LLM call, tree unchanged
                for ln in known["lines"]:
                    await emit({"type": "line", "line": ln})
                self.store.set_autosave(gid, known["id"], known["scene_id"])
                self.assets.request(("scene", gid, known["scene_id"]), P_SCENE)
                log.info("turn replayed %s %s", gid, known["id"])
                await emit({"type": "final", "node": known, "scenes": game["scenes"], "replayed": True})
                return known
        scene_id = parent["scene_id"] if parent else game["first_scene"]
        scene = {"id": scene_id, **game["scenes"][scene_id]}
        cast = Cast(game["characters"], game["protagonist"]["name"], game_lang(game))
        msgs = prompts.turn_messages(game, path, player_input, scene)
        holder = [LineStream(cast)]

        async def emit_lines(lines):
            for ln in lines:
                if ln["char_id"] and not batch:
                    self.assets.request(("sprite", gid, ln["char_id"], ln["expr"]), P_SPEAKER)
                await emit({"type": "line", "line": ln})

        async def on_event(ev):
            if ev["type"] == "delta":
                await emit_lines(holder[0].feed(ev["text"]))
            elif ev["type"] == "reset":
                holder[0] = LineStream(cast)
                await emit(ev)
            else:
                await emit(ev)

        res = await self.llm.stream(msgs, on_event)
        await emit_lines(holder[0].finish())
        lines = holder[0].lines
        if not lines:
            log.warning("turn without lines: %s", config.mask(res.content[:600]))
            raise TurnError("no_lines")

        d = last_json(res.content)
        if d is None:
            await emit({"type": "phase", "code": "repair_json"})
            fix = await self.llm.complete(prompts.repair_messages(msgs, res.content, game_lang(game)),
                                          temperature=0.3)
            d = last_json(fix.content)
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
            fix = await self.llm.complete(prompts.repair_messages(msgs, res.content, game_lang(game),
                                                                  "force_ending"), temperature=0.3)
            result, notes = repair({**(d or {}), **(last_json(fix.content) or {})}, cast, game["scenes"],
                                   current, **opts)
            notes = [*notes, "ending forced" if result["ending"] else "forced ending missing"]
        if notes:
            log.info("turn repaired %s: %s", gid, notes)

        async with self._locks.setdefault(gid, asyncio.Lock()):
            if batch and parent:
                # The player may have reached this branch live while it was being written
                twin = self._existing_child(self.store.load_tree(gid), parent, player_input["text"])
                if twin:
                    return twin
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
