"""Single GPU queue for scene backgrounds and D6t sprites, with priority bumping (PLAN sections 1 and 2).

Priority (lower runs first): 0 current background, 1 current speaker's expression, 2 calm sprites,
3 other expressions. A job already queued is never queued twice; asking again only raises its priority.
Engines (settings): hosted NVIDIA FLUX.2 and/or local ComfyUI; with both on, ComfyUI runs only when NVIDIA fails.
While a story turn is being written only the current background is drawn, so the text gets the key's quota.
A failed image is queued again AUTO_RETRY_S later, up to AUTO_RETRY_ROUNDS times, before it shows as an error.
Image mode (settings): "all", "basic" (backgrounds and calm sprites, no expressions) or "off".
"""
import asyncio
import contextlib
import json
import pathlib
import random
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
AUTO_RETRY_S = 120
AUTO_RETRY_ROUNDS = 3
IMAGE_MODES = ("all", "basic", "off")


class ImageFailed(RuntimeError):
    """retryable: False when drawing the same image again later cannot help (no engine, filtered prompt)."""

    def __init__(self, message: str, retryable: bool = True):
        super().__init__(message)
        self.retryable = retryable


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
    def __init__(self, store: Store, rpm_gate: nvidia_image.Gate | None = None, clock=time.monotonic):
        self.store = store
        self.rpm_gate = rpm_gate           # awaited before every hosted FLUX call (LLMClient.image_slot)
        self._clock = clock
        self.jobs: dict[tuple, Job] = {}
        self.errors: dict[tuple, str] = {}
        self.later: dict[tuple, tuple[float, int, str]] = {}   # failed, queued again at: (due, priority, error)
        self.rounds: dict[tuple, int] = {}                     # automatic re-queues so far
        self.running: tuple | None = None
        self.active: str | None = None     # id of the game on screen; its images jump the queue
        self.turns = 0                     # story turns being written right now
        self.mode = store.load_settings().get("image_mode", "all")
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

    def _wanted(self, key: tuple) -> bool:
        if self.mode == "off":
            return False
        return self.mode != "basic" or key[0] == "scene" or key[3] == "calm"

    def set_mode(self, mode: str) -> None:
        """Images the new mode does not draw leave the queue; the next poll queues what it adds back."""
        self.mode = mode
        self.jobs = {k: j for k, j in self.jobs.items() if self._wanted(k)}
        self.later = {k: v for k, v in self.later.items() if self._wanted(k)}
        self._wake.set()

    def request(self, key: tuple, priority: int, retry: bool = True) -> None:
        """retry=False leaves a failed image (or one waiting for its automatic retry) alone."""
        if self._done(key) or key == self.running or not self._wanted(key):
            return
        if key in self.errors or key in self.later:
            if not retry:
                return
            self.errors.pop(key, None)
            self.later.pop(key, None)
            self.rounds.pop(key, None)
        self._enqueue(key, priority)

    def _enqueue(self, key: tuple, priority: int) -> None:
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
        self.later = {k: v for k, v in self.later.items() if k[1] != gid}
        self.rounds = {k: n for k, n in self.rounds.items() if k[1] != gid}

    def _order(self, job: Job) -> tuple:
        return (job.key[1] != self.active, job.priority, job.seq)

    @contextlib.contextmanager
    def text_turn(self):
        """Wrap the writing of a story turn: meanwhile only the background on screen is drawn."""
        self.turns += 1
        try:
            yield
        finally:
            self.turns -= 1
            self._wake.set()

    def _runnable(self, job: Job) -> bool:
        return not self.turns or (job.priority == P_SCENE and job.key[1] == self.active)

    def ensure_game(self, game: dict, scene_id: str | None = None, retry: bool = True) -> None:
        """Queue every missing asset of a game (after creation, or after a server restart).

        retry=False leaves failed images alone, so polling never re-runs a failing job every few seconds.
        """
        gid = game["id"]
        wanted = [(("scene", gid, scene_id), P_SCENE)] if scene_id else []
        wanted += [(("sprite", gid, c["id"], "calm"), P_CALM) for c in game["characters"]]
        wanted += [(("sprite", gid, c["id"], e), P_EXPR) for c in game["characters"] for e in EXPRESSIONS[1:]]
        for key, priority in wanted:
            self.request(key, priority, retry)

    def status(self, game: dict) -> dict:
        gid = game["id"]
        now = self._clock()

        def one(key):
            if self._done(key):
                path = self.scene_path(gid, key[2]) if key[0] == "scene" else self.sprite_path(gid, key[2], key[3])
                return {"state": "done", "v": int(path.stat().st_mtime)}
            if not self._wanted(key):
                return {"state": "off"}
            if key == self.running:
                return {"state": "running"}
            if key in self.errors:
                return {"state": "error", "error": self.errors[key]}
            if key in self.later:
                due, _priority, error = self.later[key]
                return {"state": "queued", "retry_in": max(0, round(due - now)), "error": error,
                        "ahead": len(self.jobs) + (1 if self.running else 0)}
            if key in self.jobs:
                mine = self._order(self.jobs[key])
                ahead = sum(1 for j in self.jobs.values() if self._order(j) < mine)
                return {"state": "queued", "ahead": ahead + (1 if self.running else 0)}
            return {"state": "missing"}

        return {
            "scenes": {sid: one(("scene", gid, sid)) for sid in game["scenes"]},
            "sprites": {c["id"]: {e: one(("sprite", gid, c["id"], e)) for e in EXPRESSIONS}
                        for c in game["characters"]},
            "queue": len(self.jobs) + len(self.later) + (1 if self.running else 0),
            "paused": self.turns > 0,
        }

    def _promote(self) -> None:
        """Move failed images whose wait is over back into the queue."""
        now = self._clock()
        for key, (due, priority, _error) in list(self.later.items()):
            if due <= now:
                del self.later[key]
                if self._wanted(key) and not self._done(key):
                    self._enqueue(key, priority)

    def _failed(self, job: Job, e: Exception) -> None:
        msg = config.mask(str(e))[:300]
        rounds = self.rounds.get(job.key, 0)
        if getattr(e, "retryable", True) and rounds < AUTO_RETRY_ROUNDS:
            self.rounds[job.key] = rounds + 1
            self.later[job.key] = (self._clock() + AUTO_RETRY_S, job.priority, msg)
            log.warning("asset failed %s (automatic retry %d in %ds): %s", job.key, rounds + 1, AUTO_RETRY_S, msg)
            return
        self.rounds.pop(job.key, None)
        self.errors[job.key] = msg
        log.error("asset failed %s: %s", job.key, msg)

    async def _loop(self) -> None:
        while True:
            self._promote()
            ready = [j for j in self.jobs.values() if self._runnable(j)]
            if not ready:
                self._wake.clear()
                timeout = min(due for due, _p, _e in self.later.values()) - self._clock() if self.later else None
                with contextlib.suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(self._wake.wait(), timeout)
                continue
            job = min(ready, key=self._order)
            del self.jobs[job.key]
            self.running = job.key
            t0 = time.monotonic()
            try:
                await self._run(job.key)
                self.rounds.pop(job.key, None)
                log.info("asset done %s %.1fs", job.key, time.monotonic() - t0)
            except Exception as e:     # a failed image must not stop the queue; the player sees the error state
                self._failed(job, e)
            finally:
                self.running = None
                folder = self.store.game_dir(job.key[1])
                if folder.exists() and not (folder / "game.json").exists():   # game deleted while rendering
                    shutil.rmtree(folder, ignore_errors=True)
                    self.forget(job.key[1])

    # ---------- redraw ----------

    def _seeds_path(self, gid: str) -> pathlib.Path:
        return self.store.game_dir(gid) / "assets" / "seeds.json"

    def _seed(self, game: dict, kind: str, target: str) -> int:
        """A redrawn image keeps its new seed in assets/seeds.json; otherwise the seed comes from the game."""
        path = self._seeds_path(game["id"])
        saved = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if f"{kind}:{target}" in saved:
            return saved[f"{kind}:{target}"]
        if kind == "scene":
            return game["seed"] + sum(map(ord, target))
        return self._char(game, target)["seed"]

    def redraw(self, game: dict, kind: str, target: str, new_seed: bool = True) -> bool:
        """Draw one background, or one character's whole sprite set, again (new_seed: with a new random seed;
        the same seed repeats the picture on FLUX). False when that image is being drawn right now."""
        gid = game["id"]
        if kind == "scene":
            keys = [("scene", gid, target)]
            files = [self.scene_path(gid, target)]
        else:
            keys = [("sprite", gid, target, e) for e in EXPRESSIONS]
            files = [p for p in self.sprite_path(gid, target, "calm").parent.glob("*") if p.is_file()]
        if self.running in keys:
            return False
        if new_seed:
            path = self._seeds_path(gid)
            saved = json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps({**saved, f"{kind}:{target}": random.randrange(2**31)}), encoding="utf-8")
        for p in files:
            p.unlink(missing_ok=True)
        for key in keys:
            self.jobs.pop(key, None)
            priority = P_SCENE if key[0] == "scene" else P_SPEAKER if key[3] == "calm" else P_EXPR
            self.request(key, priority)
        return True

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
            raise ImageFailed(none_allowed, retryable=False)
        errors, retryable = [], False
        for engine, fn in tries:
            try:
                await fn()
                return engine
            except Exception as e:     # collected and raised below, so the player sees every engine's reason
                msg = config.mask(str(e))[:200]
                log.warning("image engine %s failed: %s", engine, msg)
                errors.append(f"{ENGINE_NAME[engine]}：{msg}")
                retryable = retryable or getattr(e, "retryable", True)
        raise ImageFailed("；".join(errors), retryable)

    async def _scene(self, game: dict, sid: str) -> None:
        prompt, style = game["scenes"][sid]["image_prompt"], game.get("style_en", "")
        seed = self._seed(game, "scene", sid)
        dest = self.scene_path(game["id"], sid)
        # FLUX draws fake lettering on signs and scrolls (spike section 7), so a ticked ComfyUI draws every scene;
        # NVIDIA scenes are only for players without ComfyUI
        comfy = ("comfy", lambda: comfy_client.txt2img(scene_prompt(style, prompt), BG_W, BG_H, seed, dest))
        nvidia = ("nvidia", lambda: nvidia_image.txt2img(flux_scene_prompt(style, prompt), BG_W, BG_H, seed, dest,
                                                         self.rpm_gate))
        await self._first([comfy] if "comfy" in self.engines() else [nvidia], NO_ENGINE)

    def _char(self, game: dict, cid: str) -> dict:
        return next(c for c in game["characters"] if c["id"] == cid)

    def _meta_path(self, gid: str, cid: str) -> pathlib.Path:
        return self.sprite_path(gid, cid, "calm").parent / "meta.json"

    async def _calm(self, game: dict, cid: str) -> None:
        c = self._char(game, cid)
        seed = self._seed(game, "sprite", cid)
        raw = self.sprite_path(game["id"], cid, "calm", raw=True)
        prompt = sprite_prompt(c["appearance_en"], "calm")
        flux = flux_sprite_prompt(c["appearance_en"], "calm")
        engine = await self._first([
            ("nvidia", lambda: nvidia_image.txt2img(flux, SP_W, SP_H, seed, raw, self.rpm_gate)),
            ("comfy", lambda: comfy_client.txt2img(prompt, SP_W, SP_H, seed, raw)),
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
        seed = self._seed(game, "sprite", cid)
        prompt = sprite_prompt(c["appearance_en"], expr)
        raw = self.sprite_path(gid, cid, expr, raw=True)
        donor = raw.with_suffix(".donor.png")

        async def by_comfy():
            await comfy_client.img2img(prompt, self.sprite_path(gid, cid, "calm", raw=True), seed + 1,
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
                                       big, mask, seed + 1, EYE_DENOISE, donor)
            await asyncio.to_thread(self._cut_eyes, gid, cid, expr, donor, face, eyes)

        async def by_nvidia():
            # No image input on the hosted endpoint: redraw the whole sprite with the calm seed (spike section 7)
            await nvidia_image.txt2img(flux_sprite_prompt(c["appearance_en"], expr), SP_W, SP_H, seed, raw,
                                       self.rpm_gate)
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
