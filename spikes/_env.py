"""Load secrets from project .env without printing them."""
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def env():
    out = {}
    for line in (ROOT / ".env").read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def api_key():
    return env()["NVIDIA_API_KEY"]
