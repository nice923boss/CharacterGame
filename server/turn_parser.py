"""Parse the hybrid LLM reply: `@speaker|expr: line` rows streamed first, then a ```json block.

Everything the spike showed going wrong is repaired here without asking the model again (PLAN section 5).
"""
import json
import re

import opencc

EXPRESSIONS = ("calm", "smile", "angry", "sad", "surprised")
MOODS = ("calm", "warm", "tense", "sad", "mysterious", "action")
WEATHERS = ("none", "rain", "snow", "fog", "fireflies", "petals")
LANGS = ("zh", "en")
NARRATOR = {"zh": "旁白", "en": "Narrator"}
PROTAGONIST_ALIASES = {"zh": ("主角", "玩家", "我"), "en": ("protagonist", "player", "me", "i")}
FALLBACK_OPTIONS = {"zh": ["繼續聽下去", "觀察四周的動靜", "問對方接下來怎麼打算", "先保持沉默"],
                    "en": ["Keep listening", "Look around carefully", "Ask what they plan to do next",
                           "Stay silent for now"]}
MAX_OPTION_CHARS = {"zh": 24, "en": 64}
ENDING_TYPES = {"zh": {"good": "好結局", "bad": "壞結局"}, "en": {"good": "Good Ending", "bad": "Bad Ending"}}
MAX_ENDING_TITLE = {"zh": 12, "en": 40}
MAX_GAME_TITLE = {"zh": 12, "en": 40}

# `@名|expr: text`, `@名: text`, `@名: expr: text` (qwen variant), full-width colons too.
# The qwen-variant expression must be a known one, so English text such as "Listen: ..." is kept whole.
LINE_RE = re.compile(r"^@\s*([^|:：]+?)\s*(?:\|\s*([A-Za-z]*)\s*[:：]|[:：]\s*(?:(" + "|".join(EXPRESSIONS) +
                     r")\s*[:：])?)\s*(.*)$", re.I)
# Markdown the dialog box would show raw: a leading *stage direction* and *emphasis* / **bold** anywhere
STAGE_RE = re.compile(r"^\*{1,2}([^*]+?)\*{1,2}\s*(?=\S)")
EMPH_RE = re.compile(r"\*{1,2}([^*]+?)\*{1,2}")


def game_lang(game: dict) -> str:
    """Story language; games made before languages existed are Chinese."""
    return game.get("lang") if game.get("lang") in LANGS else "zh"

_cc = opencc.OpenCC("s2twp")


def to_trad(text: str, protect: tuple[str, ...] = ()) -> str:
    """Simplified -> Taiwan traditional, leaving the given names untouched."""
    slots = {}
    for i, name in enumerate(n for n in protect if n):
        key = f"\u0000{i}\u0000"
        if name in text:
            slots[key] = name
            text = text.replace(name, key)
    text = _cc.convert(text)
    for key, name in slots.items():
        text = text.replace(key, name)
    return text


class Cast:
    """Who may speak: narrator, protagonist, AI characters (display name -> id)."""

    def __init__(self, characters: list[dict], protagonist_name: str, lang: str = "zh"):
        self.chars = {c["name"]: c["id"] for c in characters}
        self.protagonist = protagonist_name
        self.names = tuple(self.chars) + (protagonist_name,)
        self.lang = lang
        self.narrator = NARRATOR[lang]

    def conv(self, text: str) -> str:
        """Chinese stories get Taiwan traditional characters; English text is left as written."""
        return to_trad(text, self.names) if self.lang == "zh" else text

    def _partial(self, name: str, full: str) -> bool:
        if self.lang == "en":                            # "Mira" for "Mira Vance", whole words only
            return name.lower() in full.lower().split() or full.lower() in name.lower()
        return len(name) >= 2 and (name in full or full in name)   # "映月" for "林映月"

    def resolve(self, raw: str) -> tuple[str, str, str | None]:
        """-> (kind, display name, char id)"""
        name = raw.strip().strip("「」\"'*")
        if name in self.chars:
            return "character", name, self.chars[name]
        for full, cid in self.chars.items():
            if self._partial(name, full):
                return "character", full, cid
        if name.lower() in PROTAGONIST_ALIASES[self.lang] or name == self.protagonist:
            return "protagonist", self.protagonist, None
        return "narration", self.narrator, None


def parse_line(row: str, cast: Cast) -> dict | None:
    row = row.strip()
    if not row or row.startswith("```"):
        return None
    m = LINE_RE.match(row)
    if m:
        who, expr1, expr2, text = m.groups()
        expr = (expr1 or expr2 or "calm").lower()
    else:
        who, expr, text = cast.narrator, "calm", row     # a bare prose row reads as narration
    kind, name, cid = cast.resolve(who)
    text = cast.conv(text.strip())
    if kind != "narration":
        text = STAGE_RE.sub(r"（\1）" if cast.lang == "zh" else r"(\1) ", text)
    text = EMPH_RE.sub(r"\1", text)
    if not text:
        return None
    if kind == "character" and expr not in EXPRESSIONS:
        expr = "calm"
    return {"kind": kind, "speaker": name, "char_id": cid, "expr": expr if kind == "character" else "calm",
            "text": text}


class LineStream:
    """Feed streamed text; get dialogue rows back as soon as each row is complete."""

    def __init__(self, cast: Cast):
        self.cast = cast
        self.buf = ""
        self.in_json = False
        self.lines: list[dict] = []

    def feed(self, text: str) -> list[dict]:
        self.buf += text
        out = []
        while "\n" in self.buf and not self.in_json:
            row, self.buf = self.buf.split("\n", 1)
            out += self._row(row)
        return out

    def finish(self) -> list[dict]:
        out = [] if self.in_json else self._row(self.buf)
        self.buf = ""
        return out

    def _row(self, row: str) -> list[dict]:
        if row.strip().startswith("```") or row.strip().startswith("{"):
            self.in_json = True
            return []
        line = parse_line(row, self.cast)
        if line:
            self.lines.append(line)
            return [line]
        return []


def last_json(text: str) -> dict | None:
    """Last parsable JSON object: fenced blocks first (from the end), then the last bare {...}."""
    candidates = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)[::-1]
    if "{" in text:
        candidates.append(text[text.find("{"): text.rfind("}") + 1])
    for c in candidates:
        c = re.sub(r"(?m)//[^\n\"]*$", "", c)
        c = re.sub(r",\s*([}\]])", r"\1", c)
        try:
            d = json.loads(c)
        except json.JSONDecodeError:
            continue
        if isinstance(d, dict):
            return d
    return None


def slug(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", str(text).lower()).strip("_")
    return s[:40]


def clip(text: str, limit: int) -> str:
    """Cut to `limit` characters; English is cut back to the last whole word ("Proposa" reads as a typo)."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    if text[limit] != " " and " " in cut:   # the cut falls inside a word
        cut = cut.rsplit(" ", 1)[0]
    return cut.rstrip(" ,:;-")


def mostly_ascii(text: str) -> bool:
    return bool(text) and sum(ch.isascii() for ch in text) / len(text) > 0.9


def _str_list(v) -> list[str]:
    return [str(x).strip() for x in v if str(x).strip()] if isinstance(v, list) else []


def _ending(v, cast: Cast) -> dict | None:
    """{"type": "good"|"bad", "title"} or None for anything else."""
    labels = ENDING_TYPES[cast.lang]
    if not isinstance(v, dict) or v.get("type") not in labels:
        return None
    title = clip(EMPH_RE.sub(r"\1", cast.conv(str(v.get("title") or "").strip())), MAX_ENDING_TITLE[cast.lang])
    return {"type": v["type"], "title": title or labels[v["type"]]}


def repair(d: dict | None, cast: Cast, known_scenes: dict, current: dict,
           allow_ending: bool = False, n_options: int | None = None,
           allow_new_scene: bool = True) -> tuple[dict, list[str]]:
    """Validate and fix the JSON block. known_scenes: id -> {name, image_prompt}.

    current: {"scene_id", "bgm_mood", "weather"} of the parent node.
    allow_ending: the game has an ending goal and this is not the opening turn.
    n_options: batch games need exactly this many options (None: 3 or 4).
    allow_new_scene: False once a batch game has used up its scene budget; known scenes still work.
    Returns (clean result, notes about what was repaired).
    """
    notes = []
    if not isinstance(d, dict):
        notes.append("no json")
        d = {}
    conv = cast.conv
    lang = cast.lang

    scene_change = d.get("scene_change") in (True, "true", "True", 1)
    sc = d.get("scene") if isinstance(d.get("scene"), dict) else {}
    scene = None
    if scene_change:
        sid = slug(sc.get("id", ""))
        name = conv(str(sc.get("name", "")).strip())
        prompt = str(sc.get("image_prompt", "")).strip()
        by_name = next((k for k, v in known_scenes.items() if name and v.get("name") == name), None)
        if sid in known_scenes or by_name:
            sid = sid if sid in known_scenes else by_name
            scene = {"id": sid, **known_scenes[sid]}
        elif not allow_new_scene:
            notes.append(f"new scene {sid!r} dropped (scene budget used up)")
        elif sid and mostly_ascii(prompt):
            scene = {"id": sid, "name": name or sid, "image_prompt": prompt}
        else:
            notes.append(f"scene change dropped (id={sid!r}, prompt ascii={mostly_ascii(prompt)})")
        if scene and scene["id"] == current.get("scene_id"):
            scene = None
    if scene is None:
        scene_change = False

    mood = d.get("bgm_mood")
    if mood not in MOODS:
        if mood is not None:
            notes.append(f"bgm_mood {mood!r}")
        mood = current.get("bgm_mood") or "calm"
    weather = d.get("weather")
    if weather not in WEATHERS:
        weather = "none" if scene_change else (current.get("weather") or "none")

    ending = _ending(d.get("ending"), cast) if allow_ending else None
    opts = []
    for o in [] if ending else _str_list(d.get("options")):   # an ending turn has no next step
        o = EMPH_RE.sub(r"\1", conv(re.sub(r"^\s*(\d+[.、)]|[-*•])\s*", "", o)))
        limit = MAX_OPTION_CHARS[lang]
        if len(o) > limit:
            o = o[:limit - 1] + "…"
        if o not in opts:
            opts.append(o)
    lo, hi = (n_options, n_options) if n_options else (3, 4)
    if not ending and not lo <= len(opts) <= hi:
        notes.append(f"options count {len(opts)}")
    opts = opts[:hi]
    for f in [] if ending else FALLBACK_OPTIONS[lang]:
        if len(opts) >= lo:
            break
        if f not in opts:
            opts.append(f)

    st = d.get("state_changes") if isinstance(d.get("state_changes"), dict) else {}
    aff = {}
    if isinstance(st.get("affection"), dict):
        for k, v in st["affection"].items():
            kind, name, _ = cast.resolve(str(k))
            try:
                n = max(-3, min(3, int(v)))
            except (TypeError, ValueError):
                continue
            if kind == "character" and n:
                aff[name] = n
    changes = {"affection": aff,
               "flags_add": [conv(x) for x in _str_list(st.get("flags_add"))],
               "items_add": [conv(x) for x in _str_list(st.get("items_add"))],
               "items_remove": [conv(x) for x in _str_list(st.get("items_remove"))]}
    summary = conv(str(d.get("summary_update") or "").strip())
    if not summary:
        notes.append("no summary_update")

    return {"scene_change": scene_change, "scene": scene, "bgm_mood": mood, "weather": weather,
            "options": opts, "state_changes": changes, "summary_update": summary, "ending": ending}, notes


def apply_state(state: dict, changes: dict) -> dict:
    """New state snapshot; the parent's snapshot is never modified."""
    aff = dict(state.get("affection", {}))
    for name, n in changes["affection"].items():
        aff[name] = aff.get(name, 0) + n
    flags = list(dict.fromkeys(state.get("flags", []) + changes["flags_add"]))
    items = [i for i in state.get("items", []) if i not in changes["items_remove"]]
    items = list(dict.fromkeys(items + changes["items_add"]))
    return {"affection": aff, "flags": flags, "items": items}
