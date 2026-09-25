"""Real end-to-end run through the browser UI against the live server: real NVIDIA text, real ComfyUI images.

Phase play:   custom world with 2 characters, 20+ turns over 3+ scenes, save to slot 1.
Phase verify: (run after restarting the server) load slot 1, jump back to a scene-2 node and pick a
              different answer, load both branch leaves, then pick the old answer again (replay, no LLM).
Screenshots go to docs/screenshots, run state to docs/e2e_state.json.
Usage: python -m tools.e2e_play play | verify
"""
import json
import sys
import time
import urllib.request

from playwright.sync_api import Page, sync_playwright

from server import config

BASE = "http://127.0.0.1:8765"
SHOTS = config.ROOT / "docs" / "screenshots"
STATE = config.ROOT / "docs" / "e2e_state.json"
MIN_TURNS = 22          # opening + 21 player turns
MIN_SCENES = 3

WORLD = {"era": "2080 年，海平面上升後的水上城市", "place": "浮橋與高塔連成的水都「澪市」",
         "genre": "奇幻解謎", "tone": "溫柔、帶點寂寞", "extra": "城市每晚都有一座塔的燈無故熄滅"}
HERO = ("凪", "剛搬來的郵差，負責在浮橋之間送信")
CHARS = [
    {"name": "白瀨雪乃", "appearance": "17 歲少女，白色長髮及腰，淺藍瞳色，白色連身裙外罩淺灰色雨衣，胸前別著銀色羽毛胸針",
     "personality": "天真好奇，有點怕黑", "speech": "語尾常帶「呢」，說話輕快", "relationship": "主角的鄰居，塔燈守護人的孫女"},
    {"name": "韓拓", "appearance": "30 歲男性，黑色短髮，右眼戴單片眼鏡，深綠色長大衣配皮革背帶，黑色手套",
     "personality": "冷靜毒舌但可靠", "speech": "句子簡短，常用反問", "relationship": "水路管理局調查員，懷疑主角"},
]
MOVES = ["我們別待在這裡了，一起去城東那座熄燈的高塔看看。",
         "線索指向地下水道，我們現在就划船下去。",
         "去中央市場的屋頂花園，那裡看得到全城的塔。"]


def log(msg: str) -> None:
    print(time.strftime("%H:%M:%S"), msg, flush=True)


def api(path: str):
    with urllib.request.urlopen(BASE + path, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def shot(page: Page, name: str) -> None:
    SHOTS.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(SHOTS / f"{name}.png"))
    log(f"screenshot {name}")


def autosave_node() -> str | None:
    a = api("/api/autosave")
    return a and a["node_id"]


def wait_choices(page: Page, timeout: float = 480) -> None:
    """Click through the lines until the choices (or the ending card) show."""
    end = time.time() + timeout
    while time.time() < end:
        if page.locator("#choices").is_visible() or page.locator("#ending").is_visible():
            return
        page.evaluate("document.activeElement && document.activeElement.blur()")
        page.keyboard.press("Space")
        page.wait_for_timeout(350)
    raise TimeoutError("choices did not appear")


def run_turn(page: Page, send) -> tuple[str, float]:
    """Sends one input and waits until the turn is stored; retries after a failed turn."""
    before = autosave_node()
    for attempt in range(3):
        t0 = time.time()
        send()
        wait_choices(page)
        now = autosave_node()
        if now != before:
            return now, time.time() - t0
        log(f"turn not stored (toast: {page.locator('#toast').inner_text()!r}), retry {attempt + 1}")
    raise RuntimeError("turn failed 3 times")


def pick_option(page: Page, i: int):
    return lambda: page.locator("#options .btn").nth(i).click()


def free_text(page: Page, text: str):
    def send():
        page.fill("#free-input", text)
        page.click("#free-form button[type=submit]")
    return send


def path_of(tree: dict, nid: str) -> list[dict]:
    out = []
    while nid:
        out.append(tree["nodes"][nid])
        nid = out[-1]["parent"]
    return out[::-1]


def open_game(page: Page, lang: str = "zh") -> None:
    page.set_viewport_size({"width": 1280, "height": 720})
    page.on("console", lambda m: m.type == "error" and log(f"console error: {m.text}"))
    page.goto(BASE)
    page.wait_for_selector("#scr-title:not([hidden])")
    page.click(f"[data-lang={lang}]")    # headless Chromium reports en-US, so pick the UI language explicitly
    page.wait_for_timeout(1500)


def setup_world(page: Page) -> None:
    page.click("#scr-title [data-act=new]")
    page.select_option("#world-preset", "custom")
    for k, v in WORLD.items():
        page.fill(f"#w-{k}", v)
    page.fill("#p-name", HERO[0])
    page.fill("#p-profile", HERO[1])
    while page.locator("#char-list .char-card").count():
        page.locator("#char-list .char-card header button").first.click()
    for i, c in enumerate(CHARS):
        page.click("#char-add")
        card = page.locator("#char-list .char-card").nth(i)
        for k, v in c.items():
            card.locator(f"[data-k={k}]").fill(v)
    shot(page, "A02_setup_custom_world")
    page.click("#setup-start")
    page.wait_for_selector("#scr-game:not([hidden])", timeout=240_000)


def phase_play(page: Page) -> None:
    open_game(page)
    shot(page, "A01_title")
    t0 = time.time()
    setup_world(page)
    log(f"world created in {time.time() - t0:.0f}s")
    page.wait_for_selector("#dialog-text:not(:empty)", timeout=480_000)
    page.wait_for_timeout(1500)
    shot(page, "A03_opening_streaming")
    wait_choices(page)
    gid = api("/api/autosave")["game_id"]
    shot(page, "A04_opening_choices")
    moves = iter(MOVES)
    turn, since_change = 1, 0
    while True:
        tree = api(f"/api/games/{gid}")["tree"]
        path = path_of(tree, autosave_node())
        scenes = list(dict.fromkeys(n["scene_id"] for n in path))
        if len(path) >= MIN_TURNS and len(scenes) >= MIN_SCENES:
            break
        since_change = since_change + 1 if len(path) > 1 and path[-1]["scene_id"] == path[-2]["scene_id"] else 0
        if since_change >= 5 and len(scenes) < MIN_SCENES + 1:
            text = next(moves, None) or "我們換個地方，去城裡另一頭看看。"
            send, how = free_text(page, text), f"free: {text}"
        else:
            opts = page.locator("#options .btn").all_inner_texts()
            i = turn % len(opts)
            send, how = pick_option(page, i), f"option {i}: {opts[i]}"
        turn += 1
        nid, secs = run_turn(page, send)
        node = api(f"/api/games/{gid}")["tree"]["nodes"][nid]
        log(f"turn {len(path) + 1} {how} -> {nid} scene={node['scene_id']} model={node['model']} {secs:.0f}s")
        if turn in (3, 12):
            shot(page, f"A05_turn{turn:02d}_choices")
        if node["scene_id"] != path[-1]["scene_id"]:
            shot(page, f"A06_scene_change_turn{len(path) + 1:02d}")
    shot(page, "A07_last_turn")
    saved = autosave_node()
    page.click("#toolbar [data-act=save]")
    page.locator("#slot-grid .slot").first.click()
    if page.locator("#mdl-confirm").is_visible():
        page.click("#confirm-ok")
    page.wait_for_selector("#toast:not([hidden])")
    shot(page, "A08_saved_slot1")
    STATE.write_text(json.dumps({"game_id": gid, "saved_node": saved, "scenes": scenes, "turns": len(path)},
                                ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"saved slot 1: game={gid} node={saved} turns={len(path)} scenes={scenes}")


def jump_via_tree(page: Page, nid: str, name: str) -> None:
    page.click("#toolbar [data-act=tree]")
    page.locator(f'#tree-view g.node[data-id="{nid}"]').click()
    page.click("#confirm-ok")
    page.wait_for_selector("#choices", state="hidden")    # the old node's options must go first
    wait_choices(page)
    shot(page, name)


def assert_at(page: Page, gid: str, nid: str) -> None:
    node = api(f"/api/games/{gid}")["tree"]["nodes"][nid]
    shown = page.locator("#options .btn").all_inner_texts()
    assert [s.split("（已走過）")[0] for s in shown] == node["result"]["options"], (shown, node["result"]["options"])
    shown_text = page.locator("#dialog-text").inner_text()   # a long last line shows only its last page
    assert shown_text and node["lines"][-1]["text"].endswith(shown_text), shown_text


def phase_verify(page: Page) -> None:
    st = json.loads(STATE.read_text(encoding="utf-8"))
    gid, saved = st["game_id"], st["saved_node"]
    open_game(page)
    page.click("#scr-title [data-act=load]")
    shot(page, "B01_load_modal")
    page.locator("#slot-grid .slot").first.click()
    wait_choices(page)
    assert_at(page, gid, saved)
    shot(page, "B02_loaded_slot1")
    log("slot 1 loaded after restart, last line and options match the saved node")

    tree = api(f"/api/games/{gid}")["tree"]
    path = path_of(tree, saved)
    scene2 = st["scenes"][1]
    fork = next(n for i, n in enumerate(path[:-1])
                if n["scene_id"] == scene2 and path[i + 1]["player_input"]["kind"] == "option"
                and path[i + 1]["scene_id"] == scene2)
    old_child = path[path.index(fork) + 1]
    log(f"fork at scene-2 node {fork['id']}, old answer: {old_child['player_input']['text']}")
    jump_via_tree(page, fork["id"], "B03_jump_back_scene2")
    assert_at(page, gid, fork["id"])
    opts = page.locator("#options .btn").all_inner_texts()
    assert any("（已走過）" in o for o in opts), opts
    new_i = next(i for i, o in enumerate(opts) if "（已走過）" not in o)
    new_leaf, secs = run_turn(page, pick_option(page, new_i))
    log(f"new branch: option {new_i} {opts[new_i]} -> {new_leaf} in {secs:.0f}s")
    shot(page, "B04_new_branch_turn")
    tree = api(f"/api/games/{gid}")["tree"]
    kids = tree["nodes"][fork["id"]]["children"]
    assert old_child["id"] in kids and new_leaf in kids, kids
    page.click("#toolbar [data-act=tree]")
    page.wait_for_timeout(800)
    shot(page, "B05_tree_two_branches")
    page.locator("#mdl-tree [data-close]").click()

    jump_via_tree(page, saved, "B06_load_branch_A_leaf")
    assert_at(page, gid, saved)
    jump_via_tree(page, new_leaf, "B07_load_branch_B_leaf")
    assert_at(page, gid, new_leaf)
    log("both branch leaves load")

    count = len(tree["nodes"])
    jump_via_tree(page, fork["id"], "B08_back_to_fork")
    opts = page.locator("#options .btn").all_inner_texts()
    old_i = next(i for i, o in enumerate(opts) if o.split("（已走過）")[0] == old_child["player_input"]["text"])
    before = autosave_node()
    t0 = time.time()
    pick_option(page, old_i)()
    page.wait_for_selector("#toast:not([hidden])", timeout=30_000)
    toast, secs = page.locator("#toast").inner_text(), time.time() - t0
    shot(page, "B09_replay_toast")
    wait_choices(page)
    assert "走過了" in toast, toast
    assert autosave_node() == old_child["id"] != before
    assert len(api(f"/api/games/{gid}")["tree"]["nodes"]) == count
    log(f"replay: toast {toast!r} after {secs:.1f}s, node {old_child['id']} reused, tree still {count} nodes")
    shot(page, "B10_replay_done")


def main(phase: str) -> None:
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page()
        try:
            (phase_play if phase == "play" else phase_verify)(page)
        except Exception:
            shot(page, f"X_fail_{phase}")
            raise
        finally:
            browser.close()


if __name__ == "__main__":
    main(sys.argv[1])
