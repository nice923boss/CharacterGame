"""Novel import: turn a .txt novel into a new-game draft (world, protagonist, characters, chapters) for the setup form.

The book is cut into parts of about NOVEL_PART_CHARS; each part becomes short notes (NOVEL_PARALLEL calls at a time),
then one call adapts all the notes into the draft. Nothing is saved: the player edits the draft and starts the game.
"""
import asyncio
import re

from . import config, prompts
from .llm_client import LLMClient, Waits
from .turn_parser import LANGS, NARRATOR, clip, last_json, to_trad
from .turn_service import LIMIT_SCALE, MAX_CHARACTERS, NOVEL_MAX_CHAPTERS, TurnError

log = config.setup_logging()

NOVEL_PART_CHARS = 12000
NOVEL_MAX_PARTS = 20              # about 240,000 characters; longer books are refused, not sampled
NOVEL_PARALLEL = 3
NOVEL_MIN_CHAPTERS = 3
WORLD_KEYS = ("era", "place", "genre", "tone", "extra", "goal")
CHAR_LIMITS = (("appearance", 300), ("personality", 200), ("speech", 200), ("relationship", 200))


def split_parts(text: str, size: int = NOVEL_PART_CHARS) -> list[str]:
    """Cut at a line break in the last 40% of each part, so a part rarely ends mid-sentence."""
    parts = []
    while len(text) > size:
        cut = text.rfind("\n", int(size * 0.6), size)
        cut = cut if cut > 0 else size
        parts.append(text[:cut].strip())
        text = text[cut:]
    if text.strip():
        parts.append(text.strip())
    return [p for p in parts if p]


def clean_text(text: str) -> str:
    text = str(text or "").replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def title_part(title: str, lang: str) -> str:
    if not title:
        return ""
    return f"《{title}》" if lang == "zh" else f' "{title}"'


def clean_draft(d: dict, lang: str, title: str) -> dict:
    """Fit the model's draft into the setup form limits; names are unique and never the narrator's."""
    x = LIMIT_SCALE[lang]

    def s(v, limit):
        text = str(v or "").strip()
        return clip(to_trad(text) if lang == "zh" else text, limit * x)

    def obj(v):
        return v if isinstance(v, dict) else {}

    def rows(v):
        return [obj(r) for r in v] if isinstance(v, list) else []

    w, p = obj(d.get("world")), obj(d.get("protagonist"))
    world = {k: s(w.get(k), 200) for k in WORLD_KEYS}
    protagonist = {"name": s(p.get("name"), 12), "profile": s(p.get("profile"), 200)}
    taken = {protagonist["name"], *NARRATOR.values()}
    characters = []
    for c in rows(d.get("characters")):
        name = s(c.get("name"), 12)
        if name and name not in taken and len(characters) < MAX_CHARACTERS:
            taken.add(name)
            characters.append({"name": name, **{k: s(c.get(k), limit) for k, limit in CHAR_LIMITS}})
    chapters = [{"title": s(c.get("title"), 20), "summary": s(c.get("summary"), 200)}
                for c in rows(d.get("chapters"))]
    chapters = [c for c in chapters if c["title"] and c["summary"]][:NOVEL_MAX_CHAPTERS]
    if not (world["era"] and world["place"] and protagonist["name"] and characters and chapters):
        raise TurnError("novel_unusable")
    return {"world": world, "protagonist": protagonist, "characters": characters,
            "novel": {"title": clip(title, 60 * x), "chapters": chapters}}


class NovelService:
    def __init__(self, llm: LLMClient):
        self.llm = llm

    async def analyze(self, payload: dict, emit, waits: Waits | None = None) -> dict:
        lang = payload.get("lang") if payload.get("lang") in LANGS else "zh"
        text = clean_text(payload.get("text"))
        title = str(payload.get("title") or "").strip().strip("《》\"'")[:60]
        if not text:
            raise TurnError("novel_empty")
        parts = split_parts(text)
        if len(parts) > NOVEL_MAX_PARTS:
            raise TurnError("novel_too_long", limit=NOVEL_PART_CHARS * NOVEL_MAX_PARTS, length=len(text))

        async def status_only(ev):
            if ev["type"] == "status":
                await emit(ev)

        sem = asyncio.Semaphore(NOVEL_PARALLEL)
        done = [0]
        await emit({"type": "progress", "done": 0, "total": len(parts)})

        async def notes(i: int, part: str) -> str:
            async with sem:
                res = await self.llm.stream(prompts.novel_notes_messages(title_part(title, lang), i, len(parts),
                                                                         part, lang), status_only, temperature=0.3,
                                            waits=waits)
            done[0] += 1
            await emit({"type": "progress", "done": done[0], "total": len(parts)})
            return res.content.strip()

        all_notes = await asyncio.gather(*(notes(i, p) for i, p in enumerate(parts, 1)))
        await emit({"type": "phase", "code": "novel_outline"})
        res = await self.llm.stream(prompts.novel_messages(title_part(title, lang), all_notes, lang, MAX_CHARACTERS,
                                                           NOVEL_MIN_CHAPTERS, NOVEL_MAX_CHAPTERS),
                                    status_only, temperature=0.4, waits=waits)
        d = last_json(res.content)
        if not isinstance(d, dict):
            log.warning("novel draft unusable: %s", config.mask(res.content[:800]))
            raise TurnError("novel_unusable")
        draft = clean_draft(d, lang, title)
        log.info("novel analysed: %d chars, %d parts, %d characters, %d chapters", len(text), len(parts),
                 len(draft["characters"]), len(draft["novel"]["chapters"]))
        await emit({"type": "final", "draft": draft})
        return draft
