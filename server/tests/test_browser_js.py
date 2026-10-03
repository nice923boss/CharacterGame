"""Runs the Node tests in tools/js_tests against the browser modules (J07).

web/js is copied to a temporary folder with the js/local/data.js that tools/build_pages.py generates, so the
tests see the same constants as the Pages build without building it.
"""
import importlib.util
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
NODE = shutil.which("node")


def data_module() -> str:
    spec = importlib.util.spec_from_file_location("build_pages", ROOT / "tools" / "build_pages.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.data_module()


@pytest.mark.skipif(NODE is None, reason="node is not installed")
def test_browser_modules(tmp_path):
    js = tmp_path / "js"
    shutil.copytree(ROOT / "web" / "js", js)
    (js / "local" / "data.js").write_text(data_module(), encoding="utf-8")
    (js / "package.json").write_text(json.dumps({"type": "module"}), encoding="utf-8")
    tests = sorted(str(p) for p in (ROOT / "tools" / "js_tests").glob("*.test.mjs"))
    assert tests
    proc = subprocess.run([NODE, "--test", "--test-timeout=60000", *tests], cwd=ROOT,
                          env={**os.environ, "CG_JS_DIR": js.as_posix()},
                          capture_output=True, text=True, encoding="utf-8", timeout=300)
    assert proc.returncode == 0, proc.stdout[-6000:] + proc.stderr[-3000:]
