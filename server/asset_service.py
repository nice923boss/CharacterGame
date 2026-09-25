"""Single GPU queue for scene backgrounds and D6t sprites, with priority bumping (PLAN sections 1 and 2).

Priority (lower runs first): 0 current background, 1 current speaker's expression, 2 calm sprites,
3 other expressions. A job already queued is never queued twice; asking again only raises its priority.
Engines (settings): hosted NVIDIA FLUX.2 and/or local ComfyUI; with both on, ComfyUI runs only when NVIDIA fails.
"""
import asyncio
import json
import pathlib
import re
import shutil
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from PIL import Image

from . import comfy_client, config, cutout, nvidia_image
from .story_store import Store
from .turn_parser import EXPRESSIONS

log = config.setup_logging()

BG_W, BG_H = 1280, 800
SP_W, SP_H = 512, 768
EXPR_DENOISE = 0.6
EYE_DENOISE = 0.9       # 0.75 barely moved the eyes (spike_eyes_only.py)

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
# No word "mask" here: at 0.9 it grew the mask over the eyes (spike_eyes_only.py)
EYE_PROMPT = {
    "smile": "smiling eyes, gently curved happy eyes, relaxed eyebrows",
    "angry": "angry glaring eyes, sharply furrowed eyebrows",
    "sad": "sad teary eyes, eyebrows slanted upward, downcast gaze",
    "surprised": "wide open surprised eyes, small pupils, raised eyebrows",
}
BG_STYLE = "anime background art, cel shaded, visual novel background"
BG_TAIL = "no people, no characters, no text, no signage, no written words, no letters"
# FLUX runs at cfg 0, so "no text" is ignored and props that carry writing get fake letters (spike section 7):
# rewrite those props into blank ones and describe plain surfaces instead
FLUX_BLANK = [
    (r"\b(screen|monitor|display|tv|television)s?\b[^,]*", "screen showing soft abstract color gradient"),
    (r"\bwhiteboards?\b[^,]*", "clean blank whiteboard"),
    (r"\b(sign|signs|signage|poster|posters|text|letters?|words?|notes|documents|papers)\b", ""),
]
FLUX_BG_TAIL = "empty scene, nobody around, fully painted detailed background, all surfaces plain and unmarked"
ENGINE_NAME = {"nvidia": "輝達", "comfy": "ComfyUI"}
NO_ENGINE = "設定裡沒有勾選任何生圖引擎"
COMFY_ONLY = "此角色立繪由 ComfyUI 產生，補表情需在設定勾選 ComfyUI"

P_SCENE, P_SPEAKER, P_CALM, P_EXPR = 0, 1, 2, 3


def sprite_prompt(appearance_en: str, expr: str) -> str:
    return (f"{STYLE}, {appearance_en}, {EXPR_PROMPT[expr]}, {FRAMING}, "
            f"{cutout.iso_phrase(appearance_en)}, {NO_TEXT}")


def flux_sprite_prompt(appearance_en: str, expr: str) -> str:
    # FLUX ignores a trailing background phrase and draws white, so white ears or pale sleeves were cut away
    # with the background; leading with the colour keeps it (spike section 7)
    color = cutout.iso_color(appearance_en)
    return (f"solid {color} background, {STYLE}, {appearance_en}, {EXPR_PROMPT[expr]}, {FRAMING}, "
            f"plain flat {color} backdrop behind the character")


def scene_prompt(style_en: str, image_prompt: str) -> str:
    # Drop words that invite people or lettering into the picture
    clean = re.sub(r"\b(sign|signs|signage|poster|posters|text|letters?|words?)\b", "", image_prompt, flags=re.I)
    return f"{BG_STYLE}, {style_en}, {clean}, {BG_TAIL}"


def flux_scene_prompt(style_en: str, image_prompt: str) -> str:
    for pattern, blank in FLUX_BLANK:
        image_prompt = re.sub(pattern, blank, image_prompt, flags=re.I)
    return f"{BG_STYLE}, {style_en}, {image_prompt}, {FLUX_BG_TAIL}"


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

    def engines(self) -> list[str]:
        s = self.store.load_settings()
        return [e for e, on in (("nvidia", s["image_nvidia"]), ("comfy", s["image_comfy"])) if on]

    async def _first(self, attempts: list[tuple[str, Callable[[], Awaitable]]], none_allowed: str) -> str:
        """Run the attempts whose engine is switched on, in order, until one works. Returns that engine."""
        allowed = self.engines()
        tries = [(e, fn) for e, fn in attempts if e in allowed]
        if not tries:
            raise RuntimeError(none_allowed)
        errors = []
        for engine, fn in tries:
            try:
                await fn()
                return engine
            except Exception as e:     # collected and raised below, so the player sees every engine's reason
                msg = config.mask(str(e))[:200]
                log.warning("image engine %s failed: %s", engine, msg)
                errors.append(f"{ENGINE_NAME[engine]}：{msg}")
        raise RuntimeError("；".join(errors))

    async def _scene(self, game: dict, sid: str) -> None:
        prompt, style = game["scenes"][sid]["image_prompt"], game.get("style_en", "")
        seed = game["seed"] + sum(map(ord, sid))
        dest = self.scene_path(game["id"], sid)
        # FLUX draws fake lettering on signs and scrolls (spike section 7), so a ticked ComfyUI draws every scene;
        # NVIDIA scenes are only for players without ComfyUI
        comfy = ("comfy", lambda: comfy_client.txt2img(scene_prompt(style, prompt), BG_W, BG_H, seed, dest))
        nvidia = ("nvidia", lambda: nvidia_image.txt2img(flux_scene_prompt(style, prompt), BG_W, BG_H, seed, dest))
        await self._first([comfy] if "comfy" in self.engines() else [nvidia], NO_ENGINE)

    def _char(self, game: dict, cid: str) -> dict:
        return next(c for c in game["characters"] if c["id"] == cid)

    def _meta_path(self, gid: str, cid: str) -> pathlib.Path:
        return self.sprite_path(gid, cid, "calm").parent / "meta.json"

    async def _calm(self, game: dict, cid: str) -> None:
        c = self._char(game, cid)
        raw = self.sprite_path(game["id"], cid, "calm", raw=True)
        prompt = sprite_prompt(c["appearance_en"], "calm")
        flux = flux_sprite_prompt(c["appearance_en"], "calm")
        engine = await self._first([
            ("nvidia", lambda: nvidia_image.txt2img(flux, SP_W, SP_H, c["seed"], raw)),
            ("comfy", lambda: comfy_client.txt2img(prompt, SP_W, SP_H, c["seed"], raw)),
        ], NO_ENGINE)
        await asyncio.to_thread(self._cut_calm, game["id"], cid, engine)

    def _cut_calm(self, gid: str, cid: str, engine: str) -> None:
        base = Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB")
        full = cutout.cutout_full(base, key=engine == "nvidia")
        box = cutout.padded_bbox(full)
        meta = {"crop": list(box), "face": list(cutout.face_box(full)), "engine": engine}
        self._meta_path(gid, cid).write_text(json.dumps(meta), encoding="utf-8")
        full.crop(box).save(self.sprite_path(gid, cid, "calm"))

    async def _expression(self, game: dict, cid: str, expr: str) -> None:
        gid = game["id"]
        if not self.sprite_path(gid, cid, "calm").exists():
            await self._calm(game, cid)
        c = self._char(game, cid)
        prompt = sprite_prompt(c["appearance_en"], expr)
        raw = self.sprite_path(gid, cid, expr, raw=True)
        donor = raw.with_suffix(".donor.png")

        async def by_comfy():
            await comfy_client.img2img(prompt, self.sprite_path(gid, cid, "calm", raw=True), c["seed"] + 1,
                                       EXPR_DENOISE, donor)
            await asyncio.to_thread(self._cut_expression, gid, cid, expr, donor)

        async def by_eyes():
            meta = json.loads(self._meta_path(gid, cid).read_text(encoding="utf-8"))
            face, eyes = meta["face"], meta.get("eyes") or cutout.eye_band(meta["face"])
            big, mask = raw.with_suffix(".face.png"), raw.with_suffix(".eyes.png")

            def inputs():
                crop, m = cutout.eye_inputs(Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB"),
                                            face, eyes)
                crop.save(big)
                m.save(mask)
            await asyncio.to_thread(inputs)
            # Mask words stay out: with "half black mask" in the prompt the mask grew over the eyes (145203 c2)
            looks = ", ".join(p for p in c["appearance_en"].split(",") if not cutout.COVERED_FACE.search(p))
            await comfy_client.inpaint(f"{STYLE}, close-up of the eyes, {looks}, {EYE_PROMPT[expr]}",
                                       big, mask, c["seed"] + 1, EYE_DENOISE, donor)
            await asyncio.to_thread(self._cut_eyes, gid, cid, expr, donor, face, eyes)

        async def by_nvidia():
            # No image input on the hosted endpoint: redraw the whole sprite with the calm seed (spike section 7)
            await nvidia_image.txt2img(flux_sprite_prompt(c["appearance_en"], expr), SP_W, SP_H, c["seed"], raw)
            await asyncio.to_thread(self._cut_whole, gid, cid, expr)

        # Sprites made before engines were selectable came from ComfyUI. A ComfyUI face redrawn by FLUX would
        # look like another person, so those characters only take ComfyUI expressions. NVIDIA calms also prefer
        # ComfyUI img2img: whole FLUX redraws swap non-human faces (spike section 7, real assets), so the redraw
        # is only for players without ComfyUI or when ComfyUI fails.
        engine = json.loads(self._meta_path(gid, cid).read_text(encoding="utf-8")).get("engine", "comfy")
        # Masks, respirators and robot plating must stay as they are: only the eye band is redrawn
        comfy = by_eyes if cutout.COVERED_FACE.search(c["appearance_en"]) else by_comfy
        attempts = [("comfy", comfy), ("nvidia", by_nvidia)] if engine == "nvidia" else [("comfy", comfy)]
        await self._first(attempts, NO_ENGINE if engine == "nvidia" else COMFY_ONLY)

    def _cut_whole(self, gid: str, cid: str, expr: str) -> None:
        meta = json.loads(self._meta_path(gid, cid).read_text(encoding="utf-8"))
        full = cutout.cutout_full(Image.open(self.sprite_path(gid, cid, expr, raw=True)).convert("RGB"),
                                  key=meta.get("engine") == "nvidia")
        full.crop(tuple(meta["crop"])).save(self.sprite_path(gid, cid, expr))

    def _cut_eyes(self, gid: str, cid: str, expr: str, donor_path: pathlib.Path, face, eyes) -> None:
        meta = json.loads(self._meta_path(gid, cid).read_text(encoding="utf-8"))
        base = Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB")
        merged = cutout.eye_paste(base, Image.open(donor_path).convert("RGB"), face, eyes)
        merged.save(self.sprite_path(gid, cid, expr, raw=True))
        cutout.cutout_full(merged, key=meta.get("engine") == "nvidia").crop(tuple(meta["crop"])).save(
            self.sprite_path(gid, cid, expr))

    def _cut_expression(self, gid: str, cid: str, expr: str, donor_path: pathlib.Path) -> None:
        meta = json.loads(self._meta_path(gid, cid).read_text(encoding="utf-8"))
        base = Image.open(self.sprite_path(gid, cid, "calm", raw=True)).convert("RGB")
        donor = Image.open(donor_path).convert("RGB")
        merged = cutout.region_paste(base, donor, tuple(meta["face"]))
        merged.save(self.sprite_path(gid, cid, expr, raw=True))
        cutout.cutout_full(merged, key=meta.get("engine") == "nvidia").crop(tuple(meta["crop"])).save(
            self.sprite_path(gid, cid, expr))
