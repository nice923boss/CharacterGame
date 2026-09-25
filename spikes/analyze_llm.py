"""Summarise results/llm_runs.jsonl per model config (markdown table on stdout).

Extra checks beyond spike_llm.py: image_prompt must be English (ASCII), options <= 20 chars,
and each character keeps their own form of address for the protagonist.
"""
import json
import pathlib
import re
import statistics
import sys
from collections import defaultdict

from spike_llm import last_json

sys.stdout.reconfigure(encoding="utf-8")
RUNS = pathlib.Path(__file__).parent / "results" / "llm_runs.jsonl"
# Common characters that only exist in Simplified Chinese (mixed-script output breaks immersion)
SIMPLIFIED = set("这们为问说时间过对么还没会发现应该让话从进关怀亲问题实边见觉")
WRONG_ADDRESS = {"沈硯": "記者先生", "林映月": "小記者"}


def extra_issues(content):
    issues = []
    for line in content.split("{", 1)[0].splitlines():
        m = re.match(r"^@([^|:：]+)", line.strip())
        if m and WRONG_ADDRESS.get(m.group(1)) and WRONG_ADDRESS[m.group(1)] in line:
            issues.append(f"{m.group(1)} 稱謂錯")
        if m and SIMPLIFIED & set(line):
            issues.append("台詞含簡體字")
    d = last_json(content)
    if isinstance(d, dict):
        ip = (d.get("scene") or {}).get("image_prompt", "")
        if not ip.isascii():
            issues.append("image_prompt 非英文")
        if SIMPLIFIED & set(json.dumps(d, ensure_ascii=False)):
            issues.append("JSON 含簡體字")
        if any(len(o) > 20 for o in d.get("options", []) if isinstance(o, str)):
            issues.append("選項超過 20 字")
    return issues


def med(xs):
    xs = [x for x in xs if x is not None]
    return f"{statistics.median(xs):.1f}" if xs else "-"


def main():
    groups = defaultdict(list)
    for line in RUNS.read_text(encoding="utf-8").splitlines():
        r = json.loads(line)
        groups[r["model"] + (" 關推理" if r["no_think"] else "")].append(r)
    print("| 設定 | 次數 | 成功 | 首句台詞中位(s) | 總時長中位(s) | 最慢(s) | JSON+schema 合格 | 格式錯行 | 其他問題 | 錯誤 |")
    print("|---|---|---|---|---|---|---|---|---|---|")
    for label, rs in groups.items():
        ok = [r for r in rs if r.get("status") == 200 and not r.get("error")]
        good = [r for r in ok if r["json_ok"] and not r["schema_errors"]]
        issues = [i for r in ok for i in extra_issues(r.get("content", ""))]
        errs = [f"{r.get('status')} {r.get('error', '')[:40]}" for r in rs if r not in ok]
        print(f"| {label} | {len(rs)} | {len(ok)} | {med([r.get('first_line') for r in ok])} | "
              f"{med([r['total'] for r in ok])} | {max((r['total'] for r in ok), default=0):.1f} | "
              f"{len(good)}/{len(ok)} | {sum(len(r['bad_lines']) for r in ok)} | "
              f"{'; '.join(sorted(set(issues))) or '-'} | {'; '.join(errs) or '-'} |")


if __name__ == "__main__":
    main()
