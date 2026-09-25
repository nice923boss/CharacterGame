"""Spike: measure candidate text models on one realistic game turn.

Usage:  python spike_llm.py [rounds]
Writes results/llm_runs.jsonl (one line per request, content included for quality review).

Per request it records: time to headers, first SSE data line, first visible content
(after stripping <think>), first complete dialogue line, total time, reasoning volume,
finish_reason / [DONE], dialogue-line validity, last-parsable-JSON validity and schema check.
"""
import json
import pathlib
import re
import sys
import time

import httpx

from _env import env
from game_prompt import EXPRESSIONS, MOODS, PLAYER_INPUTS, SPEAKERS, build_messages

E = env()
NV = ("nvidia", "https://integrate.api.nvidia.com/v1", E["NVIDIA_API_KEY"])
LOCAL = ("local", E["LOCAL_LLM_BASE_URL"], E["LOCAL_LLM_API_KEY"])
NO_THINK = {"chat_template_kwargs": {"enable_thinking": False}}

CONFIGS = [
    (NV, "nvidia/nemotron-3-ultra-550b-a55b", {}),
    (NV, "nvidia/nemotron-3-ultra-550b-a55b", NO_THINK),
    (NV, "nvidia/nemotron-3-super-120b-a12b", {}),
    (NV, "nvidia/nemotron-3-super-120b-a12b", NO_THINK),
    (NV, "nvidia/nemotron-3.5-lightning-30b-a3b", {}),
    (NV, "nvidia/nemotron-nano-3-30b-a3b", {}),
    (NV, "deepseek-ai/deepseek-v4.1-flash", {}),
    (NV, "moonshotai/kimi-k3", {}),
    (NV, "z-ai/glm-5.3", {}),
    (NV, "z-ai/glm-5.3-flash", {}),
    (NV, "writer/palmyra-creative-122b", {}),
    (LOCAL, E["LOCAL_LLM_MODEL"], {}),
    (LOCAL, E["LOCAL_LLM_MODEL"], NO_THINK),
]

FIRST_DATA_GATE_S = 90      # no SSE data by then -> give up this request
TOTAL_CAP_S = 240           # a game turn slower than this is unusable anyway
CHAR_CAP = 40000
NV_MIN_INTERVAL_S = 1.8     # keeps sequential NVIDIA calls under 35 RPM
LINE_RE = re.compile(r"^@([^|:：]+)\|?([a-z]*)\s*[:：]\s*(.+)$")
SECRETS = [E["NVIDIA_API_KEY"], E["LOCAL_LLM_API_KEY"]]


def mask(s):
    for k in SECRETS:
        s = s.replace(k, "***")
    return s


def visible(content):
    """Content with <think> blocks removed; None while still inside an unclosed think."""
    if "</think>" in content:
        return content.rsplit("</think>", 1)[1]
    if content.lstrip().startswith("<think>"):
        return None
    return content


def last_json(text):
    blocks = re.findall(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    candidates = blocks[::-1] or []
    if not candidates:
        start = text.rfind("{\n")
        candidates = [text[text.find("{"):]] if "{" in text else []
        if start >= 0:
            candidates.insert(0, text[start:])
    for c in candidates:
        c = re.sub(r"//[^\n]*", "", c)
        try:
            return json.loads(c)
        except json.JSONDecodeError:
            continue
    return None


def schema_errors(d):
    errs = []
    if not isinstance(d, dict):
        return ["not an object"]
    for k in ("scene_change", "scene", "bgm_mood", "options", "state_changes", "summary_update"):
        if k not in d:
            errs.append(f"missing {k}")
    if not isinstance(d.get("scene_change"), bool):
        errs.append("scene_change not bool")
    sc = d.get("scene") or {}
    if not all(isinstance(sc.get(k), str) and sc.get(k) for k in ("id", "name", "image_prompt")):
        errs.append("scene fields")
    if d.get("bgm_mood") not in MOODS:
        errs.append(f"bgm_mood {d.get('bgm_mood')!r}")
    opts = d.get("options")
    if not (isinstance(opts, list) and 3 <= len(opts) <= 4 and all(isinstance(o, str) for o in opts)):
        errs.append("options")
    st = d.get("state_changes") or {}
    if not isinstance(st.get("affection"), dict):
        errs.append("affection")
    return errs


def check_lines(text):
    body = text.split("```", 1)[0]
    lines = [l.strip() for l in body.splitlines() if l.strip().startswith("@")]
    bad = []
    for l in lines:
        m = LINE_RE.match(l)
        if not m or m.group(1).strip() not in SPEAKERS or m.group(2) not in EXPRESSIONS:
            bad.append(l[:60])
    return len(lines), bad


def run_one(cfg, player_input):
    (prov, base, key), model, extra = cfg
    body = {"model": model, "messages": build_messages(player_input), "stream": True,
            "max_tokens": 8192, "temperature": 0.8, **extra}
    rec = {"provider": prov, "model": model, "no_think": bool(extra), "input": player_input,
           "ts": time.strftime("%Y-%m-%d %H:%M:%S")}
    content, reasoning, data_lines, delta_keys = "", 0, 0, set()
    finish, saw_done, raw_non_sse = None, False, []
    t0 = time.time()
    marks = {}
    try:
        with httpx.stream("POST", f"{base}/chat/completions", json=body, timeout=httpx.Timeout(TOTAL_CAP_S, connect=15),
                          headers={"Authorization": f"Bearer {key}"}) as r:
            marks["headers"] = time.time() - t0
            rec["status"] = r.status_code
            if r.status_code != 200:
                rec["error"] = mask(r.read().decode("utf-8", "replace")[:300])
            for line in (r.iter_lines() if r.status_code == 200 else []):
                el = time.time() - t0
                if el > TOTAL_CAP_S or (data_lines == 0 and el > FIRST_DATA_GATE_S):
                    rec["error"] = "total cap" if data_lines else "first data gate"
                    break
                if not line.startswith("data:"):
                    if line.strip() and data_lines == 0:
                        raw_non_sse.append(line)
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    saw_done = True
                    break
                try:
                    chunk = json.loads(payload)
                except json.JSONDecodeError:
                    continue
                data_lines += 1
                marks.setdefault("first_data", el)
                if "error" in chunk or chunk.get("object") == "error":
                    rec["error"] = mask(json.dumps(chunk, ensure_ascii=False)[:300])
                    break
                for ch in chunk.get("choices", []):
                    delta = ch.get("delta") or {}
                    delta_keys.update(k for k, v in delta.items() if v)
                    if delta.get("reasoning_content") or delta.get("reasoning"):
                        reasoning += len(delta.get("reasoning_content") or delta.get("reasoning"))
                        marks.setdefault("first_reasoning", el)
                    if delta.get("content"):
                        content += delta["content"]
                        vis = visible(content)
                        if vis and vis.strip():
                            marks.setdefault("first_visible", el)
                            if re.search(r"^@.+[:：].+\n", vis, re.M):
                                marks.setdefault("first_line", el)
                    if ch.get("finish_reason"):
                        finish = ch["finish_reason"]
                if len(content) > CHAR_CAP:
                    rec["error"] = "char cap"
                    break
    except httpx.HTTPError as e:
        rec["error"] = mask(f"{type(e).__name__}: {e}")[:300]
    if raw_non_sse and not content:
        rec.setdefault("error", mask(" ".join(raw_non_sse)[:300]))
    rec["total"] = round(time.time() - t0, 2)
    rec.update({k: round(v, 2) for k, v in marks.items()})
    vis = visible(content) or ""
    rec.update(data_lines=data_lines, delta_keys=sorted(delta_keys), finish=finish, done=saw_done,
               reasoning_chars=reasoning, content_chars=len(content), think_in_content=len(content) - len(vis),
               empty=not vis.strip())
    n, bad = check_lines(vis)
    parsed = last_json(vis)
    rec.update(lines=n, bad_lines=bad, json_ok=parsed is not None,
               schema_errors=schema_errors(parsed) if parsed is not None else ["no json"])
    rec["content"] = vis
    return rec


def main(rounds, skip=0, start=0, configs=CONFIGS):
    """Run rounds start..rounds-1; skip drops the first N configs of the first round (resume)."""
    out = pathlib.Path(__file__).parent / "results" / "llm_runs.jsonl"
    out.parent.mkdir(exist_ok=True)
    dead = set()
    last_nv = 0.0
    for i in range(start, rounds):
        for n, cfg in enumerate(configs):
            label = f"{cfg[1]}{' no_think' if cfg[2] else ''}"
            if label in dead or (i == start and n < skip):
                continue
            if cfg[0] is NV:
                time.sleep(max(0, NV_MIN_INTERVAL_S - (time.time() - last_nv)))
                last_nv = time.time()
            rec = run_one(cfg, PLAYER_INPUTS[i % len(PLAYER_INPUTS)])
            rec["round"] = i
            with out.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
            print(f"[{i}] {label:48s} st={rec.get('status')} line={rec.get('first_line')} total={rec['total']} "
                  f"json={rec['json_ok']} schema={len(rec['schema_errors'])} lines={rec['lines']}/{len(rec['bad_lines'])}bad "
                  f"reason={rec['reasoning_chars']} think={rec['think_in_content']} err={rec.get('error', '')[:80]}", flush=True)
            # Permanent-looking failures on the first round drop the model (404/410 or no headers)
            if i == start and (rec.get("status") in (404, 410, 400, 401, 403) or rec.get("error") == "first data gate"):
                dead.add(label)


if __name__ == "__main__":
    # python spike_llm.py [rounds] [skip] [start] [model-substring,...]
    a = sys.argv[1:]
    keep = a[3].split(",") if len(a) > 3 else None
    main(int(a[0]) if a else len(PLAYER_INPUTS), int(a[1]) if len(a) > 1 else 0, int(a[2]) if len(a) > 2 else 0,
         [c for c in CONFIGS if not keep or any(k in c[1] for k in keep)])
