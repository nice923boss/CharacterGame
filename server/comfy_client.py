"""Async ComfyUI client: Z-Image Turbo txt2img / img2img (graphs from spikes/comfy.py, verified in the spike).

cfg 1.0 means there is no negative prompt, so every "no text" rule lives in the positive prompt.
"""
import asyncio
import copy
import json
import pathlib
import shutil
import time
import uuid

import httpx

from . import config

_BASE = {
    "1": {"class_type": "UNETLoader",
          "inputs": {"unet_name": "zImageTurboQuantized_fp8E4m3fn.safetensors", "weight_dtype": "default"}},
    "2": {"class_type": "CLIPLoader",
          "inputs": {"clip_name": "qwen_3_4b.safetensors", "type": "lumina2", "device": "default"}},
    "3": {"class_type": "VAELoader", "inputs": {"vae_name": "ae.safetensors"}},
    "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
    "5": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["4", 0]}},
    "7": {"class_type": "ModelSamplingAuraFlow", "inputs": {"model": ["1", 0], "shift": 3.0}},
    "8": {"class_type": "KSampler",
          "inputs": {"model": ["7", 0], "positive": ["4", 0], "negative": ["5", 0], "latent_image": ["6", 0],
                     "seed": 0, "steps": 8, "cfg": 1.0, "sampler_name": "res_multistep",
                     "scheduler": "simple", "denoise": 1.0}},
    "9": {"class_type": "VAEDecode", "inputs": {"samples": ["8", 0], "vae": ["3", 0]}},
    "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "charactergame"}},
}
JOB_TIMEOUT_S = 600


class ComfyError(Exception):
    pass


async def online() -> bool:
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            return (await c.get(f"{config.COMFY_URL}/system_stats")).status_code == 200
    except httpx.HTTPError:
        return False


async def _run(graph: dict, dest: pathlib.Path) -> float:
    """Queue a graph, poll /history, copy the first output image to dest. Returns seconds taken."""
    t0 = time.monotonic()
    async with httpx.AsyncClient(timeout=30) as c:
        try:
            r = await c.post(f"{config.COMFY_URL}/prompt", json={"prompt": graph, "client_id": uuid.uuid4().hex})
        except httpx.HTTPError as e:
            raise ComfyError(f"連不上 ComfyUI（{type(e).__name__}）") from e
        if r.status_code != 200:
            raise ComfyError(f"ComfyUI 拒絕工作：HTTP {r.status_code} {r.text[:300]}")
        pid = r.json()["prompt_id"]
        while time.monotonic() - t0 < JOB_TIMEOUT_S:
            await asyncio.sleep(1)
            try:
                h = (await c.get(f"{config.COMFY_URL}/history/{pid}")).json().get(pid)
            except httpx.HTTPError:
                continue
            if not h:
                continue
            status = h.get("status", {})
            if status.get("status_str") == "error":
                raise ComfyError(f"ComfyUI 執行錯誤：{json.dumps(status.get('messages', []))[:400]}")
            for out in h.get("outputs", {}).values():
                for img in out.get("images", []):
                    src = config.COMFY_OUTPUT / img.get("subfolder", "") / img["filename"]
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy(src, dest)
                    return time.monotonic() - t0
    raise ComfyError(f"ComfyUI 工作 {JOB_TIMEOUT_S} 秒未完成")


async def txt2img(prompt: str, width: int, height: int, seed: int, dest: pathlib.Path) -> float:
    g = copy.deepcopy(_BASE)
    g["4"]["inputs"]["text"] = prompt
    g["6"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
    g["8"]["inputs"]["seed"] = seed
    return await _run(g, dest)


async def _upload(path: pathlib.Path) -> str:
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(f"{config.COMFY_URL}/upload/image",
                         files={"image": (f"cg_{uuid.uuid4().hex[:8]}_{path.name}", path.read_bytes(), "image/png")},
                         data={"overwrite": "true"})
    if r.status_code != 200:
        raise ComfyError(f"上傳圖片到 ComfyUI 失敗：HTTP {r.status_code}")
    return r.json()["name"]


async def img2img(prompt: str, src: pathlib.Path, seed: int, denoise: float, dest: pathlib.Path) -> float:
    g = copy.deepcopy(_BASE)
    g["4"]["inputs"]["text"] = prompt
    g["11"] = {"class_type": "LoadImage", "inputs": {"image": await _upload(src)}}
    g["6"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
    g["8"]["inputs"].update(seed=seed, denoise=denoise)
    return await _run(g, dest)
