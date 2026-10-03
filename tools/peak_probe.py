"""Busy-hour check with a real key (J09): replay N turns of the demo story through the NVIDIA models only and report
how many succeeded, how long players waited and how often the client switched models. No story is saved (the
client's usual attempt lines still go to logs/server.log) and the key is never printed.

Usage: python tools/peak_probe.py --turns 20 --key-name NVIDIA_TEST_KEY [--prefer quality|speed]
"""
import argparse
import asyncio
import pathlib
import statistics
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.stdout.reconfigure(encoding="utf-8")

from server import config, prompts  # noqa: E402
from server.llm_client import LLMClient, LLMError, Waits  # noqa: E402
from server.story_store import Store  # noqa: E402

DEMO = "g_20260925_145203"


def say(text: str) -> None:
    print(config.mask(text), flush=True)


def turns(store: Store, count: int) -> list[list[dict]]:
    """Message lists for `count` turns: each picks a node with options and asks for the turn after its first one."""
    game = store.load_game(DEMO)
    tree = store.load_tree(DEMO)
    open_nodes = [nid for nid, n in tree["nodes"].items()
                  if n["result"].get("options") and not n["result"].get("ending")]
    out = []
    for i in range(count):
        nid = open_nodes[i * 7 % len(open_nodes)]
        node = tree["nodes"][nid]
        path = Store.path_to(tree, nid)
        scene = {"id": node["scene_id"], **game["scenes"][node["scene_id"]]}
        player_input = {"kind": "option", "text": node["result"]["options"][0]}
        out.append(prompts.turn_messages(game, path, player_input, scene))
    return out


async def probe(count: int, prefer: str) -> None:
    client = LLMClient(candidates=[c for c in config.CANDIDATES if c.provider == "nvidia"])
    rows = []
    for i, msgs in enumerate(turns(Store(), count), 1):
        seen = {"retry": 0, "switch": [], "reasons": []}

        async def emit(ev: dict) -> None:
            if ev.get("type") != "status":
                return
            if ev["state"] == "retry":
                seen["retry"] += 1   # one event per second of waiting
                if ev["remaining"] == ev["total"]:
                    seen["reasons"].append(f"{ev['model']} {ev['reason']} {ev.get('status')}")
            elif ev["state"] == "switch":
                seen["switch"].append(f"{ev['from']}→{ev['to']} ({ev['reason']} {ev.get('status')})")

        t0 = time.monotonic()
        try:
            res = await client.stream(msgs, emit, temperature=0.8, waits=Waits(prefer=prefer))
            row = {"ok": True, "model": res.candidate.label, "first_s": res.first_s, "chars": len(res.content)}
        except LLMError as e:
            row = {"ok": False, "model": "-", "first_s": 0.0, "chars": 0,
                   "errors": [f"{x['model']} {x['reason']}" for x in e.params["errors"]]}
        row.update(total_s=time.monotonic() - t0, waited_s=seen["retry"], switches=seen["switch"],
                   reasons=seen["reasons"])
        rows.append(row)
        say(f"#{i:02d} {'ok ' if row['ok'] else 'FAIL'} {row['model']:<9} total {row['total_s']:5.1f}s "
            f"first {row['first_s']:4.1f}s waited {row['waited_s']:3d}s chars {row['chars']:4d}"
            + (f" retries {row['reasons']}" if row["reasons"] else "")
            + (f" switch {row['switches']}" if row["switches"] else "")
            + (f" errors {row['errors']}" if not row["ok"] else ""))
    await client.aclose()

    ok = [r for r in rows if r["ok"]]
    say(f"\n{len(ok)}/{len(rows)} turns succeeded; models: "
        + ", ".join(f"{m} {sum(r['model'] == m for r in ok)}" for m in sorted({r['model'] for r in ok})))
    if ok:
        totals = sorted(r["total_s"] for r in ok)
        say(f"total seconds: median {statistics.median(totals):.1f}, max {totals[-1]:.1f}; "
            f"first data median {statistics.median(r['first_s'] for r in ok):.1f}s")
    say(f"turns that waited: {sum(r['waited_s'] > 0 for r in rows)}, seconds waited in all: "
        f"{sum(r['waited_s'] for r in rows)}, turns that switched model: {sum(bool(r['switches']) for r in rows)}")
    say("history outcomes: " + ", ".join(f"{k} {v}" for k, v in sorted(
        {o: sum(h['outcome'] == o for h in client.history) for o in {h['outcome'] for h in client.history}}.items())))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--turns", type=int, default=20)
    ap.add_argument("--key-name", default="NVIDIA_API_KEY", help=".env name holding the key to test with")
    ap.add_argument("--prefer", choices=["quality", "speed"], default="quality")
    args = ap.parse_args()
    key = config.ENV.get(args.key_name, "")
    if not key:
        sys.exit(f"{args.key_name} is not set in .env")
    # The NVIDIA candidates read NVIDIA_API_KEY; only this process sees the swap, .env is not touched
    config.ENV["NVIDIA_API_KEY"] = key
    if key not in config.SECRETS:
        config.SECRETS.append(key)
    say(f"peak probe {time.strftime('%Y-%m-%d %H:%M:%S %z')}, {args.turns} turns, prefer {args.prefer}, "
        f"key {args.key_name}")
    asyncio.run(probe(args.turns, args.prefer))


if __name__ == "__main__":
    main()
