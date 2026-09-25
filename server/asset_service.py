"""Single GPU queue for scene backgrounds and D6t sprites, with priority bumping (PLAN sections 1 and 2).

Priority (lower runs first): 0 current background, 1 current speaker's expression, 2 calm sprites,
3 other expressions. A job already queued is never queued twice; asking again only raises its priority.
"""
import asyncio
import json
import pathlib
import re
import shutil
import time
from dataclasses import dataclass, field

from PIL import Image

from . import comfy_client, config, cutout
from .story_store import Store
from .turn_parser import EXPRESSIONS

log = config.setup_logging()

BG_W, BG_H = 1280, 800
SP_W, SP_H = 512, 768
EXPR_DENOISE = 0.6

STYLE = ("anime cel shading illustration, clean black lineart, flat colors with two-tone shading, "
         "visual novel character sprite")
FRAMING = ("single character, standing, upper body from the thighs up, facing the viewer, centered, "
           "whole head visible with margin above")
NO_TEXT = "no text, no letters, no watermark, no signature"
EXPR_PROMPT = {
    "calm": "calm neutral expression, closed mouth",
    "smile": "gentle warm smile",
    "angry": "angry expression, furrowed brows, gritted teeth",
    "sad": "sad expression, downcast eyes, slight frown",
    "surprised": "surprised expression, wide eyes, open mouth",
}
BG_STYLE = "anime background art, cel shaded, visual novel background"
BG_TAIL = "no people, no characters, no text, no signage, no written words, no letters"

P_SCENE, P_SPEAKER, P_CALM, P_EXPR = 0, 1, 2, 3


def sprite_prompt(appearance_en: str, expr: str) -> str:
    return (f"{STYLE}, {appearance_en}, {EXPR_PROMPT[expr]}, {FRAMING}, "
            f"{cutout.iso_phrase(appearance_en)}, {NO_TEXT}")


def scene_prompt(style_en: str, image_prompt: str) -> str:
    # Drop words that invite people or lettering into the picture
    clean = re.sub(r"\b(sign|signs|signage|poster|posters|text|letters?|words?)\b", "", image_prompt, flags=re.I)
    return f"{BG_STYLE}, {style_en}, {clean}, {BG_TAIL}"


@dataclass(order=True)
class Job:
    priority: int
    seq: int
    key: tuple = field(compare=False)       # ("scene", gid, sid) | ("sprite", gid, cid, expr)


class AssetService:
    def __init__(self, store: Store):
        self.store = store
        self.jobs: dict[tuple, Job] = {}
        self.errors: dict[tuple, str] = {}
        self.running: tuple | None = None
        self.active: str | None = None     # id of the game on screen; its images jump the queue
        self._seq = 0
        self._wake = asyncio.Event()
        self._worker: asyncio.Task | None = None

    # ---------- paths ----------

    def scene_path(self, gid: str, sid: str) -> pathlib.Path:
        return self.store.game_dir(gid) / "assets" / "scenes" / f"{sid}.png"

    def sprite_path(self, gid: str, cid: str, expr: str, raw: bool = False) -> pathlib.Path:
        return self.store.game_dir(gid) / "assets" / "sprites" / cid / f"{expr}{'.raw' if raw else ''}.png"

    def _done(self, key: tuple) -> bool:
        if key[0] == "scene":
            return self.scene_path(key[1], key[2]).exists()
        return self.sprite_path(key[1], key[2], key[3]).exists()

    # ---------- queue ----------

    def start(self) -> None:
        if self._worker is None:
            self._worker = asyncio.create_task(self._loop())

    def request(self, key: tuple, priority: int) -> None:
        if self._done(key) or key == self.running:
            return
        self.errors.pop(key, None)
        job = self.jobs.get(key)
        if job:
            job.priority = min(job.priority, priority)
        else:
            self._seq += 1
            self.jobs[key] = Job(priority, self._seq, key)
        self._wake.set()

    def forget(self, gid: str) -> None:
        """Drop the queued jobs and errors of a deleted game."""
        self.jobs = {k: j for k, j in self.jobs.items() if k[1] != gid}
        self.errors = {k: e for k, e in self.errors.items() if k[1] != gid}

    def _order(self, job: Job) -> tuple:
        return (job.key[1] != self.active, job.priority, job.seq)

    def ensure_game(self, game: dict, scene_id: str | None = None, retry: bool = True) -> None:
        """Queue every missing asset of a game (after creation, or after a server restart).

        retry=False leaves failed images alone, so polling never re-runs a failing job every few seconds.
        """
        gid = game["id"]
        wanted = [(("scene", gid, scene_id), P_SCENE)] if scene_id else []
        wanted += [(("sprite", gid, c["id"], "calm"), P_CALM) for c in game["characters"]]
        wanted += [(("sprite", gid, c["id"], e), P_EXPR) for c in game["characters"] for e in EXPRESSIONS[1:]]
        for key, priority in wanted:
            if retry or key not in self.errors:
                self.request(key, priority)

    def status(self, game: dict) -> dict:
        gid = game["id"]

        def one(key):
            if self._done(key):
                path = self.scene_path(gid, key[2]) if key[0] == "scene" else self.sprite_path(gid, key[2], key[3])
                return {"state": "done", "v": int(path.stat().st_mtime)}
            if key == self.running:
                return {"state": "running"}
            if key in self.errors:
                return {"state": "error", "error": self.errors[key]}
            if key in self.jobs:
                mine = self._order(self.jobs[key])
                ahead = sum(1 for j in self.jobs.values() if self._order(j) < mine)
                return {"state": "queued", "ahead": ahead + (1 if self.running else 0)}
            return {"state": "missing"}

        return {
            "scenes": {sid: one(("scene", gid, sid)) for sid in game["scenes"]},
            "sprites": {c["id"]: {e: one(("sprite", gid, c["id"], e)) for e in EXPRESSIONS}
                        for c in game["characters"]},
            "queue": len(self.jobs) + (1 if self.running else 0),
        }

    async def _loop(self) -> None:
        while True:
            if not self.jobs:
                self._wake.clear()
                await self._wake.wait()
                continue
            job = min(self.jobs.values(), key=self._order)
            del self.jobs[job.key]
            self.running = job.key
            t0 = time.monotonic()
            try:
                await self._run(job.key)
                log.info("asset done %s %.1fs", job.key, time.monotonic() - t0)
            except Exception as e:     # a failed image must not stop the queue; the player sees the error state
                msg = config.mask(str(e))[:300]
                self.errors[job.key] = msg
                log.error("asset failed %s: %s", job.key, msg)
            finally:
                self.running = None
                folder = self.store.game_dir(job.key[1])
                if folder.exists() and not (folder / "game.json").exists():   # game deleted while rendering
                    shutil.rmtree(folder, ignore_errors=True)
                    self.forget(job.key[1])

    # ---------- jobs ----------

    async def _run(self, key: tuple) -> None:
        if self._done(key):     # a queued calm may already have been made inline by an expression job
            return
        game = self.store.load_game(key[1])
        if key[0] == "scene":
            await self._scene(game, key[2])
        elif key[3] == "calm":
            await self._calm(game, key[2])
        else:
            await self._expression(game, key[2], key[3])

    async def _scene(self, game: dict, sid: str) -> None:
        sc = game["scenes"][sid]
        seed = game["seed"] + sum(map(ord, sid))
        await comfy_client.txt2img(scene_prompt(game.get("style_en", ""), sc["image_prompt"]), BG_W, BG_H, seed,
                                   self.scene_path(game["id"], sid))

    def _char(self, game: dict, cid: str) -> dict:
        return next(c for c in game["characters"] if c["id"] == cid)

    async def _calm(self, game: dict, cid: str) -> None:
        c = self._char(game, cid)
        raw = self.sprite_path(game["id"], cid, "calm", raw=True)
        await comfy_client.txt2img(sprite_prompt(c["appearance_en"], "calm"), SP_W, SP_H, c["seed"], raw)
        await asyncio.to_thread(self._cut_calm, game["id"], cid)

    def _cut_calm(self, gid: str, cid: str) -> None:
        base = Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB")
        full = cutout.cutout_full(base)
        box = cutout.padded_bbox(full)
        meta = {"crop": list(box), "face": list(cutout.face_box(full))}
        (self.sprite_path(gid, cid, "calm").parent / "meta.json").write_text(
            json.dumps(meta), encoding="utf-8")
        full.crop(box).save(self.sprite_path(gid, cid, "calm"))

    async def _expression(self, game: dict, cid: str, expr: str) -> None:
        if not self.sprite_path(game["id"], cid, "calm").exists():
            await self._calm(game, cid)
        c = self._char(game, cid)
        donor = self.sprite_path(game["id"], cid, expr, raw=True).with_suffix(".donor.png")
        await comfy_client.img2img(sprite_prompt(c["appearance_en"], expr),
                                   self.sprite_path(game["id"], cid, "calm", raw=True), c["seed"] + 1,
                                   EXPR_DENOISE, donor)
        await asyncio.to_thread(self._cut_expression, game["id"], cid, expr, donor)

    def _cut_expression(self, gid: str, cid: str, expr: str, donor_path: pathlib.Path) -> None:
        meta = json.loads((self.sprite_path(gid, cid, "calm").parent / "meta.json").read_text(encoding="utf-8"))
        base = Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB")
        donor = Image.open(donor_path).convert("RGB")
        merged = cutout.region_paste(base, donor, tuple(meta["face"]))
        merged.save(self.sprite_path(gid, cid, expr, raw=True))
        cutout.cutout_full(merged).crop(tuple(meta["crop"])).save(self.sprite_path(gid, cid, expr))
