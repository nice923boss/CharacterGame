"""Build the GitHub Pages version into dist/pages: the web client running with a browser-side backend.

- copies web/ and marks index.html as local mode (<meta name="cg-local">)
- writes js/local/data.js: prompt text, parser and LLM constants and art prompts taken from the server modules,
  so the browser port uses exactly the same text; only the hosted NVIDIA models are listed, never local endpoints
- copies the demo story (final images only, no .raw intermediates) and writes demo/index.json
- bakes in the built-in relay (RELAY) so players only enter their own NVIDIA key, and copies relay/worker.js
  as relay-worker.js for anyone who wants to run their own relay
- writes sw.js, which keeps the app shell and CDN libraries in the browser cache, and stamps that version on
  every module URL (?v=), so a browser never joins modules of two builds
- refuses to finish when any secret from .env appears in the output

Run from the project root: python tools/build_pages.py
"""
import collections
import hashlib
import json
import pathlib
import re
import shutil
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from server import (asset_service, config, cutout, novel_service, nvidia_image, prompts, turn_parser,  # noqa: E402
                    turn_service)

OUT = ROOT / "dist" / "pages"
DEMO_GAMES = [config.DEMO_GAME]
SKIP_ASSET = re.compile(r"\.(raw|donor|face|eyes)\.|batch\.json$")
CDN = ["https://cdn.jsdelivr.net/npm/p5@1.11.3/lib/p5.min.js"]
# Public CORS relay: the Cloudflare Worker in relay/worker.js on the owner's account (holds no key of its own)
RELAY = "https://chienzhi-relay.cattravelworld.com"
# Hosted models only: config.CANDIDATES without the local endpoint, same ids and order
CANDIDATES = [{"label": c.label, "provider": c.provider, "model": c.model}
              for c in config.CANDIDATES if c.provider == "nvidia"]
# .env names whose values must never reach the output
SECRET_NAME = re.compile(r"(KEY|TOKEN|SECRET|PASSWORD)$|^LOCAL_LLM")
# An NVIDIA key that is not in .env (pasted into a save or a page) is caught by its shape
NVIDIA_KEY = re.compile(rb"nvapi-[A-Za-z0-9_-]{20,}")
CHARSET = '<meta charset="utf-8">'


def data_module() -> str:
    p, tp, a = prompts, turn_parser, asset_service
    data = {
        "relay": RELAY,
        "demo": config.DEMO_GAME,
        "prompts": {k: getattr(p, k) for k in ("TURN_SYSTEM", "ENDING_RULE", "NO_ENDING_RULE", "SETUP_SYSTEM",
                                               "SETUP_USER", "TEXT", "RECENT_NODES", "MEMORY_EVERY",
                                               "MEMORY_CHARS", "LIVE_TURNS_PER_CHAPTER",
                                               "NOVEL_NOTES_SYSTEM", "NOVEL_NOTES_USER",
                                               "NOVEL_SYSTEM", "NOVEL_USER")},
        "parser": {k: getattr(tp, k) for k in ("EXPRESSIONS", "MOODS", "WEATHERS", "LANGS", "NARRATOR",
                                               "PROTAGONIST_ALIASES", "FALLBACK_OPTIONS", "MAX_OPTION_CHARS",
                                               "ENDING_TYPES", "MAX_ENDING_TITLE", "MAX_GAME_TITLE")},
        "llm": {"candidates": CANDIDATES, "extra": config.NO_THINK,
                **{k: getattr(config, k) for k in ("CONNECT_TIMEOUT_S", "FIRST_DATA_TIMEOUT_S", "IDLE_TIMEOUT_S",
                                                   "TOTAL_TIMEOUT_S", "MAX_TOKENS", "CHAR_CAP", "RPM_LIMIT",
                                                   "IMAGE_RPM_RESERVE", "TRANSIENT_BACKOFF_S", "EMPTY_BACKOFF_S", "COOLDOWN_STEPS_S",
                                                   "RETRY_AFTER_MAX_S", "JITTER", "PRIMARY_RETRY_S",
                                                   "PATIENCE_STEP_S", "PATIENCE_MAX_S", "BUSY_WINDOW_S")},
                "TRANSIENT_STATUS": sorted(config.TRANSIENT_STATUS)},
        "limits": {**{k: getattr(config, k) for k in ("BATCH_MAX_SCENES", "BATCH_MAX_NODES", "BATCH_CONCURRENCY",
                                                   "BATCH_TURN_RETRIES", "BATCH_RETRY_WAITS_S", "BATCH_TAIL_WAIT_S",
                                                   "BATCH_GROW_AFTER")},
                   "MAX_CHARACTERS": turn_service.MAX_CHARACTERS,
                   "MAX_FREE_INPUT": turn_service.MAX_FREE_INPUT, "LIMIT_SCALE": turn_service.LIMIT_SCALE,
                   "NOVEL_MAX_CHAPTERS": turn_service.NOVEL_MAX_CHAPTERS,
                   **{k: getattr(novel_service, k) for k in ("NOVEL_PART_CHARS", "NOVEL_MAX_PARTS", "NOVEL_PARALLEL",
                                                             "NOVEL_MIN_CHAPTERS")}},
        "art": {**{k: getattr(a, k) for k in ("BG_W", "BG_H", "SP_W", "SP_H", "STYLE", "FRAMING", "EXPR_PROMPT",
                                              "BG_STYLE", "FLUX_BLANK", "FLUX_BG_TAIL", "AUTO_RETRY_S",
                                              "AUTO_RETRY_ROUNDS", "IMAGE_MODES")},
                "TALL": cutout.TALL, "SOFTEN": nvidia_image.SOFTEN, "FLUX_PATH": nvidia_image.URL.split(".com", 1)[1],
                "SIZE": nvidia_image.SIZE, "STEPS": nvidia_image.STEPS, "TIMEOUT_S": nvidia_image.TIMEOUT_S,
                "RETRY_STATUS": sorted(nvidia_image.RETRY_STATUS), "RETRY_BACKOFF_S": nvidia_image.RETRY_BACKOFF_S},
    }
    body = json.dumps(data, ensure_ascii=False, indent=1)
    return ("// Generated by tools/build_pages.py from the server modules. Do not edit.\n"
            f"export const DATA = {body};\n")


def copy_demo() -> list[str]:
    files = []
    for gid in DEMO_GAMES:
        src = ROOT / "saves" / "games" / gid
        # Without these the title screen offers a demo that cannot open
        missing = [n for n in ("game.json", "tree.json") if not (src / n).is_file()]
        if missing:
            raise SystemExit(f"demo story {gid} has no {', '.join(missing)} in {src}; build stopped")
        for f in sorted(src.rglob("*")):
            rel = f.relative_to(src).as_posix()
            if f.is_dir() or SKIP_ASSET.search(rel):
                continue
            dest = OUT / "demo" / gid / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)
            files.append(f"{gid}/{rel}")
    return files


def scrub_models(files: list[str]) -> None:
    """Node and game records name the model that wrote them; a local model name is replaced by "local"."""
    local = config.ENV.get("LOCAL_LLM_MODEL")
    if not local:
        return
    for rel in files:
        if rel.endswith(".json"):
            path = OUT / "demo" / rel
            text = path.read_text(encoding="utf-8")
            if local in text:
                path.write_text(text.replace(local, "local"), encoding="utf-8")


def service_worker(version: str) -> str:
    shell = sorted(p.relative_to(OUT).as_posix() for p in OUT.rglob("*")
                   if p.is_file() and not p.relative_to(OUT).as_posix().startswith("demo/"))
    shell = ["./"] + [s for s in shell if s != "sw.js"]
    return (ROOT / "tools" / "sw_template.js").read_text(encoding="utf-8") \
        .replace("__VERSION__", version) \
        .replace("__SHELL__", json.dumps(shell, ensure_ascii=False)) \
        .replace("__CDN__", json.dumps(CDN))


# Relative module specifiers: from './x.js', import('../x.js'), import './x.js'
MODULE_SPEC = re.compile(r"""((?:\bfrom|\bimport)\s*\(?\s*)(['"])(\.{1,2}/[^'"?]+\.js)\2""")


def stamp_modules(version: str) -> None:
    """Every relative module URL carries the build version. Without it a module fetched outside the service
    worker (first visit, or the HTTP cache) could come from another build than the module importing it."""
    for f in OUT.rglob("*.js"):
        if f.name in ("sw.js", "relay-worker.js") or "demo" in f.relative_to(OUT).parts:
            continue
        text = f.read_text(encoding="utf-8")
        stamped = MODULE_SPEC.sub(lambda m: f"{m[1]}{m[2]}{m[3]}?v={version}{m[2]}", text)
        if stamped != text:
            f.write_text(stamped, encoding="utf-8")
    index = OUT / "index.html"
    html = index.read_text(encoding="utf-8")
    for ref in ('src="js/main.js"', 'href="css/style.css"'):
        if html.count(ref) != 1:
            raise SystemExit(f"index.html must contain {ref} exactly once to stamp the version; build stopped")
        html = html.replace(ref, f'{ref[:-1]}?v={version}"')
    index.write_text(html, encoding="utf-8")


def secret_scan() -> None:
    """Every .env value that could identify a private endpoint or key must be absent from the output.
    A failed scan removes the output, so a leaking build can never be copied to gh-pages by mistake."""
    needles = [v for k, v in config.ENV.items() if v and len(v) >= 6 and SECRET_NAME.search(k)]
    for k, v in config.ENV.items():
        if k == "LOCAL_LLM_BASE_URL" and v:
            host = re.sub(r"^https?://", "", v).split("/")[0].split(":")[0]
            needles.append(host)
    for f in OUT.rglob("*"):
        if f.is_file():
            data = f.read_bytes()
            if any(n.encode() in data for n in needles) or NVIDIA_KEY.search(data):
                rel = f.relative_to(OUT)
                shutil.rmtree(OUT, ignore_errors=True)
                raise SystemExit(f"secret found in {rel}; build stopped and {OUT} removed")


def mark_local(html: str) -> str:
    """The Pages build runs the browser backend: <meta name="cg-local"> right after the charset line.
    Without it the page would look for a game server that does not exist, so a changed charset line stops the build."""
    if html.count(CHARSET) != 1:
        raise SystemExit(f"web/index.html must contain {CHARSET} exactly once; build stopped")
    return html.replace(CHARSET, f'{CHARSET}\n<meta name="cg-local" content="1">')


def summary(version: str, demo_version: str, demo_files: int) -> str:
    """Total and per-folder file counts, to compare with the gh-pages commit (CLAUDE.md step 4)."""
    out = [f.relative_to(OUT).parts for f in OUT.rglob("*") if f.is_file()]
    size = sum((OUT.joinpath(*p)).stat().st_size for p in out) / 1e6
    tops = collections.Counter(p[0] if len(p) > 1 else "." for p in out)
    return (f"built {OUT} ({len(out)} files, {size:.1f} MB, version {version}, demo {demo_version}, "
            f"{demo_files} demo files)\n  " + ", ".join(f"{k}: {n}" for k, n in sorted(tops.items())))


def main() -> None:
    if OUT.exists():
        shutil.rmtree(OUT)
    shutil.copytree(ROOT / "web", OUT)
    index = OUT / "index.html"
    index.write_text(mark_local(index.read_text(encoding="utf-8")), encoding="utf-8")
    (OUT / "js" / "local" / "data.js").write_text(data_module(), encoding="utf-8")
    shutil.copy2(ROOT / "relay" / "worker.js", OUT / "relay-worker.js")
    files = copy_demo()
    scrub_models(files)
    digest = hashlib.sha1()
    for rel in files:
        digest.update(rel.encode())
        digest.update((OUT / "demo" / rel).read_bytes())
    demo_version = digest.hexdigest()[:12]
    (OUT / "demo" / "index.json").write_text(json.dumps({"version": demo_version, "games": DEMO_GAMES,
                                                         "files": files}, indent=1), encoding="utf-8")
    shell_digest = hashlib.sha1()
    for p in sorted(OUT.rglob("*")):
        if p.is_file():
            shell_digest.update(p.relative_to(OUT).as_posix().encode())
            shell_digest.update(p.read_bytes())
    version = shell_digest.hexdigest()[:12]
    (OUT / "sw.js").write_text(service_worker(version), encoding="utf-8")
    stamp_modules(version)
    (OUT / ".nojekyll").write_text("", encoding="utf-8")
    secret_scan()
    print(summary(version, demo_version, len(files)))


if __name__ == "__main__":
    main()
