"""Minimal ComfyUI client for the spikes: Z-Image Turbo txt2img and img2img (API-format graphs).

Graphs follow KAIJIAN's text2img-zimage.json / img2img-zimage.json (8 steps, res_multistep,
simple, cfg 1.0, shift 3). cfg 1.0 means there is no negative prompt: every "no text" rule
has to live in the positive prompt.
"""
import copy
import json
import pathlib
import shutil
import time
import uuid

import httpx

COMFY = "http://127.0.0.1:8000"
OUTPUT_DIR = pathlib.Path(r"C:\Users\Clare\Documents\ComfyUI\output")

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
    "10": {"class_type": "SaveImage", "inputs": {"images": ["9", 0], "filename_prefix": "cg-spike"}},
}


def _run(graph, dest):
    """Queue a graph, wait for it, copy the first output image to dest. Returns seconds taken."""
    t0 = time.time()
    r = httpx.post(f"{COMFY}/prompt", json={"prompt": graph, "client_id": uuid.uuid4().hex}, timeout=30)
    r.raise_for_status()
    pid = r.json()["prompt_id"]
    while True:
        time.sleep(1)
        h = httpx.get(f"{COMFY}/history/{pid}", timeout=30).json().get(pid)
        if not h:
            continue
        status = h.get("status", {})
        if status.get("status_str") == "error":
            raise RuntimeError(f"ComfyUI error: {json.dumps(status.get('messages', []))[:400]}")
        for out in h.get("outputs", {}).values():
            for img in out.get("images", []):
                src = OUTPUT_DIR / img.get("subfolder", "") / img["filename"]
                dest = pathlib.Path(dest)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy(src, dest)
                return time.time() - t0
        if time.time() - t0 > 600:
            raise TimeoutError(f"prompt {pid} not finished after 600s")


def txt2img(prompt, width, height, seed, dest):
    g = copy.deepcopy(_BASE)
    g["4"]["inputs"]["text"] = prompt
    g["6"] = {"class_type": "EmptySD3LatentImage", "inputs": {"width": width, "height": height, "batch_size": 1}}
    g["8"]["inputs"]["seed"] = seed
    return _run(g, dest)


def upload(path):
    with open(path, "rb") as f:
        r = httpx.post(f"{COMFY}/upload/image", files={"image": (pathlib.Path(path).name, f, "image/png")},
                       data={"overwrite": "true"}, timeout=60)
    r.raise_for_status()
    return r.json()["name"]


def img2img(prompt, src_path, seed, denoise, dest):
    g = copy.deepcopy(_BASE)
    g["4"]["inputs"]["text"] = prompt
    g["11"] = {"class_type": "LoadImage", "inputs": {"image": upload(src_path)}}
    g["6"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["11", 0], "vae": ["3", 0]}}
    g["8"]["inputs"].update(seed=seed, denoise=denoise)
    return _run(g, dest)
