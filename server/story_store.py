"""Games, node trees, save slots, autosave points and recently deleted stories as JSON files with atomic
writes (PLAN sections 3 and 4)."""
import json
import os
import pathlib
import re
import shutil
import time
from datetime import datetime, timedelta

from . import config

log = config.setup_logging()

SLOT_COUNT = 10
AUTOSAVE_KEEP = 5   # autosave points kept, newest first
TRASH_DAYS = 7      # days a deleted story stays in saves/trash
# Image engines: NVIDIA only by default; with both on, ComfyUI is the fallback when NVIDIA fails
DEFAULT_SETTINGS = {"image_nvidia": True, "image_comfy": False, "image_mode": "all"}
GAME_ID_RE = re.compile(r"[A-Za-z0-9_]{1,64}")
WIN_RESERVED_RE = re.compile(r"(?i)(con|prn|aux|nul|com\d|lpt\d)")   # Windows device names, not folders
REPLACE_RETRY_S = (0.05, 0.1, 0.2)   # an antivirus scan or the indexer may hold the target for a moment


def _write(path: pathlib.Path, data) -> None:
    """Write to a temp file then rename, so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    text = json.dumps(data, ensure_ascii=False, indent=1)
    try:
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())   # the data is on disk before the rename makes it the real file
        for wait in REPLACE_RETRY_S:
            try:
                os.replace(tmp, path)
                return
            except PermissionError:
                time.sleep(wait)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)   # only left over when writing or renaming failed


def _read(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def _read_safe(path: pathlib.Path, default, kind: type):
    """_read for index files (settings, slots, autosaves, trash records): a corrupt file or one of the wrong
    shape gives `default` and a log line instead of breaking every page that lists it."""
    try:
        data = _read(path, default)
    except (OSError, ValueError) as e:
        log.warning("unreadable %s: %s", path, e)
        return default
    if not isinstance(data, kind):
        log.warning("unexpected content in %s", path)
        return default
    return data


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class Store:
    def __init__(self, root: pathlib.Path = config.SAVES):
        self.root = root

    # ---------- games ----------

    def game_dir(self, game_id: str) -> pathlib.Path:
        # ASCII only: isalnum() also passes full-width and CJK characters
        if not isinstance(game_id, str) or not GAME_ID_RE.fullmatch(game_id) or WIN_RESERVED_RE.fullmatch(game_id):
            raise ValueError(f"bad game id {game_id!r}")
        return self.root / "games" / game_id

    def new_game_id(self) -> str:
        gid = "g_" + time.strftime("%Y%m%d_%H%M%S")
        while True:   # claim the folder now, so two games created in the same second never share an id
            try:
                self.game_dir(gid).mkdir(parents=True)
                return gid
            except FileExistsError:
                gid += "x"

    def save_game(self, game: dict) -> None:
        _write(self.game_dir(game["id"]) / "game.json", game)

    def load_game(self, game_id: str) -> dict:
        game = _read(self.game_dir(game_id) / "game.json")
        if game is None:
            raise FileNotFoundError(f"找不到遊戲 {game_id}")
        return game

    # ---------- settings ----------

    def load_settings(self) -> dict:
        return {**DEFAULT_SETTINGS, **_read_safe(self.root / "settings.json", {}, dict)}

    def save_settings(self, settings: dict) -> None:
        _write(self.root / "settings.json", settings)

    def list_games(self) -> list[dict]:
        out = []
        for p in sorted((self.root / "games").glob("*/game.json"), reverse=True):
            try:
                g = _read(p)
                tree = self.load_tree(g["id"])
                out.append({"id": g["id"], "title": g.get("title", ""), "created_at": g.get("created_at"),
                            "nodes": len(tree["nodes"]), "thumb": self.thumb(g["id"], g.get("first_scene")),
                            "characters": [c["name"] for c in g.get("characters", [])],
                            "lang": g.get("lang", "zh"), "latest": max(tree["nodes"], default=None),
                            "root": tree["root"], "batch": g.get("batch")})
            except (OSError, ValueError, KeyError, TypeError, AttributeError) as e:
                # one damaged story must not hide all the others
                log.warning("story list skips %s: %s", p.parent.name, e)
        return out

    def thumb(self, game_id: str, scene_id: str | None) -> str | None:
        """Media URL of a scene image, or None while it is not drawn yet (so lists never request a missing file)."""
        try:
            folder = self.game_dir(game_id)
        except ValueError:   # a slot or autosave record with a damaged id
            return None
        if scene_id and (folder / "assets" / "scenes" / f"{scene_id}.png").exists():
            return f"/media/{game_id}/assets/scenes/{scene_id}.png"
        return None

    # ---------- recently deleted ----------

    def trash_dir(self, game_id: str) -> pathlib.Path:
        return self.root / "trash" / self.game_dir(game_id).name

    def delete_game(self, game_id: str) -> None:
        """Move a story to saves/trash for TRASH_DAYS. The slots pointing at it go along in deleted.json and come
        back on restore; its autosave points are dropped."""
        folder = self.game_dir(game_id)
        if not (folder / "game.json").exists():
            raise FileNotFoundError(f"找不到遊戲 {game_id}")
        dest = self.trash_dir(game_id)
        if dest.exists():
            shutil.rmtree(dest)
        dest.parent.mkdir(parents=True, exist_ok=True)
        folder.rename(dest)   # first, so a folder that cannot move leaves every slot as it was
        slots = self.load_slots()
        _write(dest / "deleted.json", {"deleted_at": now_iso(), "slots": [s for s in slots if s and s["game_id"] == game_id]})
        _write(self.root / "slots.json", [None if s and s["game_id"] == game_id else s for s in slots])
        _write(self.root / "autosaves.json", [a for a in self.load_autosaves() if a["game_id"] != game_id])

    def list_trash(self) -> list[dict]:
        """Recently deleted stories, newest first (the expired ones are deleted for good first)."""
        self.purge_expired()
        out = []
        for p in (self.root / "trash").glob("*/deleted.json"):
            deleted_at = self._deleted_at(p)
            expires = deleted_at + timedelta(days=TRASH_DAYS)
            game = _read_safe(p.parent / "game.json", {}, dict)
            tree = _read_safe(p.parent / "tree.json", {}, dict)
            out.append({"id": p.parent.name, "title": game.get("title", ""),
                        "deleted_at": deleted_at.isoformat(timespec="seconds"),
                        "expires_at": expires.isoformat(timespec="seconds"),
                        "nodes": len(tree.get("nodes") or {})})
        return sorted(out, key=lambda x: x["deleted_at"], reverse=True)

    @staticmethod
    def _deleted_at(record: pathlib.Path) -> datetime:
        """When a story went to the trash; a damaged deleted.json falls back to the file's own time, so the story
        is still listed, restorable and purged on schedule instead of breaking the trash page and the start."""
        try:
            at = datetime.fromisoformat(_read_safe(record, {}, dict)["deleted_at"])
            return at if at.tzinfo else at.astimezone()
        except (KeyError, TypeError, ValueError):
            log.warning("trash record without a readable date: %s", record)
            return datetime.fromtimestamp(record.stat().st_mtime).astimezone()

    def restore_game(self, game_id: str) -> None:
        """Move a story back from the trash; its slots return only where the slot is still empty."""
        src = self.trash_dir(game_id)
        if not (src / "deleted.json").exists():
            raise FileNotFoundError(f"最近刪除裡沒有 {game_id}")
        info = _read_safe(src / "deleted.json", {}, dict)
        folder = self.game_dir(game_id)
        if folder.exists():
            raise FileExistsError(f"遊戲資料夾已存在 {game_id}")
        src.rename(folder)
        (folder / "deleted.json").unlink()
        slots = self.load_slots()
        for s in info.get("slots") or []:
            n = s.get("slot") if isinstance(s, dict) else None
            # a record from a hand-edited or damaged file must not stop the restore halfway (folder already back)
            if type(n) is int and 0 <= n < SLOT_COUNT and slots[n] is None:
                slots[n] = s
        _write(self.root / "slots.json", slots)

    def purge_game(self, game_id: str) -> None:
        src = self.trash_dir(game_id)
        if not (src / "deleted.json").exists():
            raise FileNotFoundError(f"最近刪除裡沒有 {game_id}")
        shutil.rmtree(src)

    def purge_expired(self) -> None:
        cutoff = datetime.now().astimezone() - timedelta(days=TRASH_DAYS)
        for p in (self.root / "trash").glob("*/deleted.json"):
            if self._deleted_at(p) < cutoff:
                shutil.rmtree(p.parent)

    # ---------- tree ----------

    def load_tree(self, game_id: str) -> dict:
        return _read(self.game_dir(game_id) / "tree.json", {"root": None, "next": 0, "nodes": {}})

    def add_node(self, game_id: str, node: dict) -> dict:
        """Assign an id, link it under its parent and persist. Existing nodes only gain children."""
        tree = self.load_tree(game_id)
        nid = f"n_{tree['next']:04d}"
        node = {**node, "id": nid, "children": [], "created_at": now_iso()}
        parent = node.get("parent")
        if parent is None:
            if tree["root"] is not None:
                raise ValueError("tree already has a root")
            tree["root"] = nid
        else:
            tree["nodes"][parent]["children"].append(nid)
        tree["nodes"][nid] = node
        tree["next"] += 1
        _write(self.game_dir(game_id) / "tree.json", tree)
        return node

    def link(self, game_id: str, node_id: str, target_id: str, options: list[str]) -> None:
        """Merge-back: rewrite a branch node's options and hang an existing node under it as the child of the
        last one. The target keeps its own parent (path_to, summary and state follow that line)."""
        tree = self.load_tree(game_id)
        node = tree["nodes"][node_id]
        node["result"] = {**node["result"], "options": options}
        node["merged_to"] = target_id
        if target_id not in node["children"]:
            node["children"].append(target_id)
        _write(self.game_dir(game_id) / "tree.json", tree)

    @staticmethod
    def path_to(tree: dict, node_id: str | None) -> list[dict]:
        path = []
        while node_id:
            node = tree["nodes"][node_id]
            path.append(node)
            node_id = node.get("parent")
        return path[::-1]

    # ---------- slots ----------

    def load_slots(self) -> list[dict | None]:
        slots = _read_safe(self.root / "slots.json", [], list)
        # an entry that is not a save record shows as an empty slot instead of failing the whole save page
        slots = [s if isinstance(s, dict) and isinstance(s.get("game_id"), str) else None for s in slots]
        return (slots + [None] * SLOT_COUNT)[:SLOT_COUNT]

    def save_slot(self, slot: int, game_id: str, node_id: str, label: str) -> list:
        if not 0 <= slot < SLOT_COUNT:
            raise ValueError("slot out of range")
        tree = self.load_tree(game_id)
        if node_id not in tree["nodes"]:
            raise ValueError("node not found")
        slots = self.load_slots()
        slots[slot] = {"slot": slot, "game_id": game_id, "node_id": node_id, "label": label,
                       "scene_id": tree["nodes"][node_id].get("scene_id"), "saved_at": now_iso()}
        _write(self.root / "slots.json", slots)
        return slots

    def delete_slot(self, slot: int) -> list:
        if not 0 <= slot < SLOT_COUNT:   # -1 would clear the last slot
            raise ValueError("slot out of range")
        slots = self.load_slots()
        slots[slot] = None
        _write(self.root / "slots.json", slots)
        return slots

    def load_autosaves(self) -> list[dict]:
        """Newest first, one per game and node, at most AUTOSAVE_KEEP. The autosave.json of older versions
        counts as the list until the next autosave writes autosaves.json."""
        path = self.root / "autosaves.json"
        if path.exists():
            saves = _read_safe(path, [], list)
        else:
            old = _read_safe(self.root / "autosave.json", None, dict)
            saves = [old] if old else []
        return [a for a in saves if isinstance(a, dict) and isinstance(a.get("game_id"), str) and "node_id" in a]

    def set_autosave(self, game_id: str, node_id: str, scene_id: str) -> None:
        entry = {"game_id": game_id, "node_id": node_id, "scene_id": scene_id, "saved_at": now_iso()}
        rest = [a for a in self.load_autosaves() if (a["game_id"], a["node_id"]) != (game_id, node_id)]
        _write(self.root / "autosaves.json", [entry, *rest][:AUTOSAVE_KEEP])

    def load_autosave(self) -> dict | None:
        saves = self.load_autosaves()
        return saves[0] if saves else None
