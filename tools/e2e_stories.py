"""Plays the test stories in tools/story_cases.py through the browser UI against the live server
(real NVIDIA text, real ComfyUI images) until the AI writes an ending, and keeps everything.

Per story: screenshots in docs/screenshots/stories, a readable transcript in docs/stories/<key>.md,
and a result summary in docs/stories/<key>.json. Games, saves and images are never deleted.
Usage: python -m tools.e2e_stories zh1_ghost_market en1_blackmoor ...   (no keys = all ten)
STORY_TAG=_r2 appends a tag to the output names, so a later round never overwrites an earlier one.
"""
import json
import os
import sys
import time

from playwright.sync_api import Page, sync_playwright

from server import config
from tools.e2e_play import api, log, open_game, path_of, wait_choices
from tools.story_cases import EN_FINAL, STORIES, ZH_FINAL

OUT = config.ROOT / "docs" / "stories"
SHOTS = config.ROOT / "docs" / "screenshots" / "stories"
MAX_PLAYER_TURNS = 30
TAG = os.environ.get("STORY_TAG", "")


def shot(page: Page, key: str, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{key}_{name}.png"))


def setup(page: Page, st: dict) -> None:
    page.click("#scr-title [data-act=new]")
    page.select_option("#world-preset", "custom")
    for k, v in st["world"].items():
        page.fill(f"#w-{k}", v)
    page.fill("#p-name", st["hero"][0])
    page.fill("#p-profile", st["hero"][1])
    while page.locator("#char-list .char-card").count():
        page.locator("#char-list .char-card header button").first.click()
    for i, c in enumerate(st["chars"]):
        page.click("#char-add")
        card = page.locator("#char-list .char-card").nth(i)
        for k, v in c.items():
            card.locator(f"[data-k={k}]").fill(v)
    shot(page, st["key"], "01_setup")
    page.click("#setup-start")
    page.wait_for_selector("#scr-game:not([hidden])", timeout=300_000)


def tree_of(gid: str) -> dict:
    return api(f"/api/games/{gid}")["tree"]


def next_input(st: dict, k: int) -> tuple[str, str | None]:
    """k = player turn number (1-based). Returns ('option', None) or ('free', text)."""
    schedule = {3: 0, 5: 1, 7: 2}
    if k in schedule:
        return "free", st["pushes"][schedule[k]]
    if k >= 8 and k % 2 == 1:
        return "free", st.get("final") or (ZH_FINAL if st["lang"] == "zh" else EN_FINAL)
    return "option", None


def play_turn(page: Page, gid: str, kind: str, text: str | None, k: int) -> str:
    """Sends one input, waits for the choices or the ending; returns the new node id (retries failed turns)."""
    for attempt in range(3):
        before = set(tree_of(gid)["nodes"])
        if kind == "free":
            page.fill("#free-input", text)
            page.click("#free-form button[type=submit]")
        else:
            opts = page.locator("#options .btn")
            opts.nth(k % opts.count()).click()
        wait_choices(page, timeout=600)
        new = set(tree_of(gid)["nodes"]) - before
        if new:
            return new.pop()
        log(f"turn not stored (toast: {page.locator('#toast').inner_text()!r}), retry {attempt + 1}")
    raise RuntimeError("turn failed 3 times")


def wait_scene(gid: str, scene_id: str, timeout: float = 240) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        if api(f"/api/games/{gid}/assets")["scenes"].get(scene_id, {}).get("state") in ("done", "error"):
            return True
        time.sleep(5)
    return False


def transcript(st: dict, game: dict, path: list[dict]) -> str:
    colon = "：" if st["lang"] == "zh" else ": "
    w = st["world"]
    out = [f"# {game['title']}", "", f"- game id: `{game['id']}`", f"- lang: {st['lang']}",
           f"- world: {w['era']} / {w['place']} / {w['genre']} / {w['tone']}", f"- extra: {w['extra']}",
           f"- goal: {w['goal']}", f"- protagonist: {st['hero'][0]} ({st['hero'][1]})",
           f"- characters: {', '.join(c['name'] for c in st['chars'])}", ""]
    for i, n in enumerate(path, 1):
        scene = game["scenes"].get(n["scene_id"], {}).get("name", n["scene_id"])
        out += [f"## {i}. {scene} ({n['id']}, model {n.get('model')})", ""]
        pi = n.get("player_input") or {}
        if pi.get("text"):
            out += [f"> **{st['hero'][0]}** ({pi['kind']}){colon}{pi['text']}", ""]
        out += [f"- {ln['text']}" if ln["kind"] == "narration" else f"- **{ln['speaker']}**{colon}{ln['text']}"
                for ln in n["lines"]]
        end = n["result"].get("ending")
        if end:
            out += ["", f"**{end['type'].upper()} ENDING: {end['title']}**"]
        else:
            out += ["", "options: " + " / ".join(n["result"]["options"])]
        out.append("")
    return "\n".join(out)


def save_to_slot(page: Page, slot: int) -> None:
    """Keep the finished story's progress in a save slot, through the save button like a player."""
    page.click("#toolbar [data-act=save]")
    page.locator("#slot-grid .slot").nth(slot).click()
    if page.locator("#mdl-confirm").is_visible():
        page.click("#confirm-ok")
    page.wait_for_selector("#toast:not([hidden])")
    page.locator("#mdl-slots [data-close]").click()   # the save dialog stays open to show the new card


def save_result(row: dict) -> None:
    # one file per story, so runners working in parallel never overwrite each other's results
    (OUT / f"{row['key']}.json").write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")


def run_story(page: Page, st: dict) -> dict:
    key = st["key"] + TAG
    open_game(page, st["lang"])
    before = {g["id"] for g in api("/api/games")}
    t0 = time.time()
    setup(page, st)
    page.wait_for_selector("#dialog-text:not(:empty)", timeout=600_000)
    wait_choices(page, timeout=600)
    # another runner may be creating a game at the same time: match the new game by its protagonist
    gid = next(g["id"] for g in api("/api/games") if g["id"] not in before
               and api(f"/api/games/{g['id']}")["game"]["protagonist"]["name"] == st["hero"][0])
    tree = tree_of(gid)
    nid = max(tree["nodes"])
    shot(page, key, "02_opening")
    log(f"[{key}] game {gid} opened in {time.time() - t0:.0f}s")
    k = 0
    while not page.locator("#ending").is_visible() and k < MAX_PLAYER_TURNS:
        k += 1
        kind, text = next_input(st, k)
        t1 = time.time()
        nid = play_turn(page, gid, kind, text, k)
        node = tree_of(gid)["nodes"][nid]
        log(f"[{key}] turn {k} {kind} {node['player_input']['text'][:40]!r} -> {nid} "
            f"scene={node['scene_id']} model={node['model']} {time.time() - t1:.0f}s")
        if k == 4:
            shot(page, key, "03_mid")
    game = api(f"/api/games/{gid}")["game"]
    path = path_of(tree_of(gid), nid)
    end = path[-1]["result"].get("ending")
    if end:
        wait_scene(gid, path[-1]["scene_id"])
        page.wait_for_timeout(4000)   # the UI polls assets every 3 s
        shot(page, key, "04_ending")
    if st.get("save_slot") is not None:
        save_to_slot(page, st["save_slot"])
        shot(page, key, "04b_saved")
        log(f"[{key}] saved to slot {st['save_slot'] + 1}")
    page.click("#toolbar [data-act=tree]")
    page.wait_for_timeout(800)
    shot(page, key, "05_tree")
    page.locator("#mdl-tree [data-close]").click()
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / f"{key}.md").write_text(transcript(st, game, path), encoding="utf-8")
    row = {"key": key, "lang": st["lang"], "aim": st["aim"], "game_id": gid, "title": game["title"],
           "turns": len(path), "player_turns": k, "scenes": len({n["scene_id"] for n in path}),
           "models": sorted({n.get("model") or "?" for n in path}),
           "ending": end, "minutes": round((time.time() - t0) / 60, 1)}
    save_result(row)
    log(f"[{key}] done: {row}")
    return row


def main(keys: list[str]) -> None:
    todo = [s for s in STORIES if s["key"] in keys or (not keys and "save_slot" not in s)]   # no keys = the ten
    with sync_playwright() as p:
        browser = p.chromium.launch()
        for st in todo:
            page = browser.new_page()
            try:
                run_story(page, st)
            except Exception as e:  # keep going with the next story; the failure is logged and screenshotted
                log(f"[{st['key']}] FAILED: {e!r}")
                shot(page, st["key"], "X_fail")
            finally:
                page.close()
        browser.close()


if __name__ == "__main__":
    main(sys.argv[1:])
