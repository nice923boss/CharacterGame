"""Games, node trees, save slots and autosave as JSON files with atomic writes (PLAN sections 3 and 4)."""
import json
import os
import pathlib
import shutil
import time
from datetime import datetime

from . import config

SLOT_COUNT = 10


def _write(path: pathlib.Path, data) -> None:
    """Write to a temp file then rename, so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, path)


def _read(path: pathlib.Path, default=None):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class Store:
    def __init__(self, root: pathlib.Path = config.SAVES):
        self.root = root

    # ---------- games ----------

    def game_dir(self, game_id: str) -> pathlib.Path:
        if not game_id.replace("_", "").isalnum():
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

    def list_games(self) -> list[dict]:
        out = []
        for p in sorted((self.root / "games").glob("*/game.json"), reverse=True):
            g = _read(p)
            tree = self.load_tree(g["id"])
            out.append({"id": g["id"], "title": g.get("title", ""), "created_at": g.get("created_at"),
                        "nodes": len(tree["nodes"]), "thumb": self.thumb(g["id"], g.get("first_scene")),
                        "characters": [c["name"] for c in g.get("characters", [])],
                        "lang": g.get("lang", "zh"), "latest": max(tree["nodes"], default=None),
                        "root": tree["root"], "batch": g.get("batch")})
        return out

    def thumb(self, game_id: str, scene_id: str | None) -> str | None:
        """Media URL of a scene image, or None while it is not drawn yet (so lists never request a missing file)."""
        if scene_id and (self.game_dir(game_id) / "assets" / "scenes" / f"{scene_id}.png").exists():
            return f"/media/{game_id}/assets/scenes/{scene_id}.png"
        return None

    def delete_game(self, game_id: str) -> None:
        """Delete a whole story (tree, branches, images) and every slot or autosave pointing at it."""
        folder = self.game_dir(game_id)
        if not (folder / "game.json").exists():
            raise FileNotFoundError(f"找不到遊戲 {game_id}")
        # Clear the references first, so a failed folder delete never leaves a slot pointing at nothing
        slots = [None if s and s["game_id"] == game_id else s for s in self.load_slots()]
        _write(self.root / "slots.json", slots)
        auto = self.load_autosave()
        if auto and auto["game_id"] == game_id:
            (self.root / "autosave.json").unlink()
        shutil.rmtree(folder)

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
        slots = _read(self.root / "slots.json", [])
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
        slots = self.load_slots()
        slots[slot] = None
        _write(self.root / "slots.json", slots)
        return slots

    def set_autosave(self, game_id: str, node_id: str, scene_id: str) -> None:
        _write(self.root / "autosave.json",
               {"game_id": game_id, "node_id": node_id, "scene_id": scene_id, "saved_at": now_iso()})

    def load_autosave(self) -> dict | None:
        return _read(self.root / "autosave.json")
