"""Paths, secrets and tuning constants. Secrets are read here only and never leave the backend."""
import logging
import pathlib
from dataclasses import dataclass, field

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
SAVES = ROOT / "saves"
LOGS = ROOT / "logs"


def _read_env() -> dict:
    out = {}
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip()
    return out


ENV = _read_env()
SECRETS = [v for k, v in ENV.items() if k.endswith("_API_KEY") and v]


def mask(text: str) -> str:
    """Remove every known secret from a string before it reaches a log, an error or the browser."""
    for s in SECRETS:
        text = text.replace(s, "***")
    return text


@dataclass(frozen=True)
class Candidate:
    label: str          # model id for the player; the web client shows its name ("ultra")
    provider: str
    base_url: str
    key_name: str       # env var holding the key; the key itself is looked up at request time
    model: str
    extra: dict = field(default_factory=dict)

    @property
    def cooldown_key(self) -> str:
        return f"{self.provider}:{self.model}"

    @property
    def api_key(self) -> str:
        return ENV.get(self.key_name, "")


NO_THINK = {"chat_template_kwargs": {"enable_thinking": False}}
NV_BASE = "https://integrate.api.nvidia.com/v1"

# Order decided by the Owner after the spike: ultra no-think first, local qwen as fallback.
# super no-think is a last resort (fastest but weaker story logic in the spike).
CANDIDATES = [
    Candidate("ultra", "nvidia", NV_BASE, "NVIDIA_API_KEY", "nvidia/nemotron-3-ultra-550b-a55b", NO_THINK),
    Candidate("qwen", "local", ENV.get("LOCAL_LLM_BASE_URL", ""), "LOCAL_LLM_API_KEY",
              ENV.get("LOCAL_LLM_MODEL", ""), NO_THINK),
    Candidate("super", "nvidia", NV_BASE, "NVIDIA_API_KEY", "nvidia/nemotron-3-super-120b-a12b", NO_THINK),
]

# LLM tuning (PLAN section 6)
CONNECT_TIMEOUT_S = 15
FIRST_DATA_TIMEOUT_S = 30
IDLE_TIMEOUT_S = 45
TOTAL_TIMEOUT_S = 240
MAX_TOKENS = 4096
CHAR_CAP = 20000
RPM_LIMIT = 35
TRANSIENT_STATUS = {404, 408, 409, 425, 429, 500, 502, 503, 504}
TRANSIENT_BACKOFF_S = [2, 4, 8, 16, 32]
EMPTY_BACKOFF_S = [2, 5]          # then switch candidate instead of waiting 89 s
COOLDOWN_S = 90                   # a failed candidate is skipped this long

# Batch mode (whole tree written ahead). Spike 2026-09-25: 6 and 8 parallel ultra calls, no 429,
# 13-16 s typical, slowest 50 s; 6 keeps ~24 calls/min under RPM_LIMIT
BATCH_CONCURRENCY = 6
BATCH_MAX_NODES = 400
BATCH_MAX_SCENES = 8              # every new scene is ~66 s of GPU; a full tree would invent dozens
BATCH_TURN_RETRIES = 2            # a branch that still fails is left for live generation

# ComfyUI
COMFY_URL = "http://127.0.0.1:8000"
COMFY_OUTPUT = pathlib.Path(r"C:\Users\Clare\Documents\ComfyUI\output")
COMFY_INPUT = pathlib.Path(r"C:\Users\Clare\Documents\ComfyUI\input")

HOST, PORT = "127.0.0.1", 8765


def setup_logging() -> logging.Logger:
    LOGS.mkdir(exist_ok=True)
    log = logging.getLogger("cg")
    if not log.handlers:
        log.setLevel(logging.INFO)
        h = logging.FileHandler(LOGS / "server.log", encoding="utf-8")
        h.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
        log.addHandler(h)
        sh = logging.StreamHandler()
        sh.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
        log.addHandler(sh)
    return log
