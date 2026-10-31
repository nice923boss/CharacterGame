"""tools/build_pages.py safety checks (phase 10, P01-P10): secret scan, local-mode marker, version stamps,
demo story check, values taken from the server modules, build summary."""
import importlib.util
import json
import re
from pathlib import Path

import pytest

from server import config, cutout, turn_service

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture()
def bp(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location("build_pages", ROOT / "tools" / "build_pages.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "OUT", tmp_path / "out")
    return module


def data_of(module) -> dict:
    text = module.data_module()
    return json.loads(text.split("export const DATA = ", 1)[1].rsplit(";", 1)[0])


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


# ---------- P01-P03 secret scan ----------

def test_scan_covers_token_and_secret_names(bp, monkeypatch):
    fake = "fake-token-value-123456"
    monkeypatch.setattr(bp.config, "ENV", {"GITHUB_TOKEN": fake})
    write(bp.OUT / "js" / "a.js", f"const t = '{fake}';")
    with pytest.raises(SystemExit) as e:
        bp.secret_scan()
    assert "js" in str(e.value) and "a.js" in str(e.value)
    assert fake not in str(e.value)   # the message never repeats the secret
    assert not bp.OUT.exists()        # P03: nothing left to copy to gh-pages


def test_scan_catches_nvidia_key_shape_outside_env(bp, monkeypatch):
    monkeypatch.setattr(bp.config, "ENV", {})
    write(bp.OUT / "demo" / "g" / "game.json", '{"note": "nvapi-' + "Ab1_-" * 8 + '"}')
    with pytest.raises(SystemExit):
        bp.secret_scan()
    assert not bp.OUT.exists()


def test_scan_allows_bare_prefix_and_non_secret_names(bp, monkeypatch):
    monkeypatch.setattr(bp.config, "ENV", {"NVIDIA_KEY_SAVED_AT": "1700000000", "NVIDIA_API_KEY": ""})
    write(bp.OUT / "help.html", "<p>Keys start with nvapi-, saved at 1700000000</p>")
    bp.secret_scan()
    assert (bp.OUT / "help.html").is_file()


def test_scan_catches_local_endpoint_host(bp, monkeypatch):
    monkeypatch.setattr(bp.config, "ENV", {"LOCAL_LLM_BASE_URL": "http://studio.example.lan:1234/v1"})
    write(bp.OUT / "js" / "local" / "data.js", "fetch('http://studio.example.lan/x')")
    with pytest.raises(SystemExit):
        bp.secret_scan()


# ---------- P04, P05, P10 values from the server modules ----------

def test_candidates_are_the_hosted_config_models(bp):
    hosted = [c for c in config.CANDIDATES if c.provider == "nvidia"]
    assert [c["model"] for c in bp.CANDIDATES] == [c.model for c in hosted]
    assert [c["label"] for c in bp.CANDIDATES] == [c.label for c in hosted]
    assert all(set(c) == {"label", "provider", "model"} for c in bp.CANDIDATES)   # no base_url or key name
    assert data_of(bp)["llm"]["candidates"] == bp.CANDIDATES


def test_tall_comes_from_cutout(bp):
    assert data_of(bp)["art"]["TALL"] == cutout.TALL


def test_limit_scale_matches_i18n():
    src = (ROOT / "web" / "js" / "i18n.js").read_text(encoding="utf-8")
    m = re.search(r"export const LIMIT_SCALE = \{([^}]*)\}", src)
    assert m, "LIMIT_SCALE not found in web/js/i18n.js"
    js = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", m[1])}
    assert js == turn_service.LIMIT_SCALE


# ---------- P06 demo story ----------

def test_missing_demo_files_stop_the_build(bp, tmp_path, monkeypatch):
    monkeypatch.setattr(bp, "ROOT", tmp_path)
    monkeypatch.setattr(bp, "DEMO_GAMES", ["g1"])
    write(tmp_path / "saves" / "games" / "g1" / "game.json", "{}")
    with pytest.raises(SystemExit, match="tree.json"):
        bp.copy_demo()
    with pytest.raises(SystemExit, match="game.json, tree.json"):
        monkeypatch.setattr(bp, "DEMO_GAMES", ["absent"])
        bp.copy_demo()


def test_demo_copy_skips_intermediates(bp, tmp_path, monkeypatch):
    monkeypatch.setattr(bp, "ROOT", tmp_path)
    monkeypatch.setattr(bp, "DEMO_GAMES", ["g1"])
    src = tmp_path / "saves" / "games" / "g1"
    for rel in ("game.json", "tree.json", "batch.json", "assets/sprites/c1/smile.png",
                "assets/sprites/c1/smile.raw.png"):
        write(src / rel, "x")
    assert bp.copy_demo() == ["g1/assets/sprites/c1/smile.png", "g1/game.json", "g1/tree.json"]


# ---------- P07, P08 index.html markers ----------

def test_mark_local_inserts_meta_once(bp):
    html = bp.mark_local('<head>\n<meta charset="utf-8">\n<title>x</title>')
    assert html.count('<meta name="cg-local" content="1">') == 1
    assert html.index("cg-local") > html.index("charset")


@pytest.mark.parametrize("head", ['<meta charset="UTF-8">', '<meta charset="utf-8"><meta charset="utf-8">'])
def test_mark_local_refuses_changed_charset_line(bp, head):
    with pytest.raises(SystemExit, match="charset"):
        bp.mark_local(head)


def test_stamp_modules_stamps_and_checks_refs(bp):
    write(bp.OUT / "index.html", '<link href="css/style.css"><script type="module" src="js/main.js"></script>')
    write(bp.OUT / "js" / "main.js", "import { a } from './a.js';\nconst m = import('./local/b.js');")
    bp.stamp_modules("abc123")
    assert 'src="js/main.js?v=abc123"' in (bp.OUT / "index.html").read_text(encoding="utf-8")
    main = (bp.OUT / "js" / "main.js").read_text(encoding="utf-8")
    assert "'./a.js?v=abc123'" in main and "'./local/b.js?v=abc123'" in main
    write(bp.OUT / "index.html", '<link href="css/style.css"><script src="js/app.js"></script>')
    with pytest.raises(SystemExit, match="main.js"):
        bp.stamp_modules("abc123")


# ---------- P09 summary and the whole build ----------

def test_summary_counts_files_per_folder(bp):
    for rel in ("index.html", "sw.js", "js/main.js", "js/local/data.js", "demo/index.json"):
        write(bp.OUT / rel, "x")
    text = bp.summary("v1", "d1", 0)
    assert "5 files" in text and "version v1" in text
    assert ".: 2" in text and "js: 2" in text and "demo: 1" in text


@pytest.mark.skipif(not (ROOT / "saves" / "games" / config.DEMO_GAME / "tree.json").is_file(),
                    reason="demo story not present")
def test_full_build(bp, capsys):
    bp.main()
    out = bp.OUT
    html = (out / "index.html").read_text(encoding="utf-8")
    assert html.count('<meta name="cg-local" content="1">') == 1
    version = re.search(r"VERSION = '(\w+)'", (out / "sw.js").read_text(encoding="utf-8"))[1]
    assert f'src="js/main.js?v={version}"' in html
    files = sum(1 for f in out.rglob("*") if f.is_file())
    assert f"({files} files" in capsys.readouterr().out
