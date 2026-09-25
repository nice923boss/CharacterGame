"""Generate the UI images with ComfyUI: title cover and three 9-slice gold frames.

Frames are drawn on black, then the top-left quadrant is mirrored into the other three so the
frame is exactly symmetric (9-slice needs matching corners), and brightness becomes alpha.
Raw renders are kept in tools/_ui_raw for inspection. Usage: python -m tools.make_ui_assets [name ...]
"""
import asyncio
import json
import pathlib
import sys

import numpy as np
from PIL import Image

from server import comfy_client, config

RAW = config.ROOT / "tools" / "_ui_raw"
OUT = config.WEB / "ui"

UI_STYLE = ("ornate antique gold filigree, art nouveau curls, fine engraved lines, warm gold on deep navy, "
            "japanese visual novel interface")
NO_TEXT = "no text, no letters, no numbers, no symbols, no watermark, no signature"
FRAME_TAIL = ("isolated on pure flat black background, empty pure black center, perfectly symmetrical, "
              "front view, flat game UI asset, " + NO_TEXT)

# name: (prompt, raw w, raw h, corner size as a fraction of the cropped short side, slice px in final image,
#        edge thickening in raw px: the button is shown ~17x smaller than raw, so its 11 px line would vanish)
FRAMES = {
    "frame_panel": ("rectangular picture frame border made of " + UI_STYLE + ", double thin gold lines along the "
                    "edges, elaborate curling ornament in each corner, " + FRAME_TAIL, 1024, 1024, 0.3, 96, 0),
    "frame_box": ("wide rectangular frame border made of " + UI_STYLE + ", single thin gold line with a second "
                  "fainter inner line, small leaf ornament in each corner, " + FRAME_TAIL, 1536, 640, 0.36, 80, 0),
    "btn": ("thin rectangular button border, " + UI_STYLE + ", one fine gold line with a tiny diamond ornament "
            "in each corner, minimal, " + FRAME_TAIL, 1024, 512, 0.42, 48, 11),
}
COVER = ("anime background art, cel shaded, visual novel title screen key art, night, a giant ancient tree on the "
         "left whose glowing golden branches split into countless forking paths across a starry sky, fog over a "
         "steampunk harbor city with a clocktower far below, lanterns, deep navy and gold palette, dark empty sky "
         "on the right half, no people, " + NO_TEXT)


def mirror_quadrant(img: np.ndarray) -> np.ndarray:
    h, w = img.shape[0] // 2, img.shape[1] // 2
    q = img[:h, :w]
    top = np.concatenate([q, q[:, ::-1]], axis=1)
    return np.concatenate([top, top[::-1]], axis=0)


def thicken(a: np.ndarray, axis: int, k: int) -> np.ndarray:
    """Max filter of width k along one axis (makes a thin line k-1 px thicker)."""
    if k <= 1:
        return a
    pad = [(0, 0)] * a.ndim
    pad[axis] = (k // 2, k // 2)
    p = np.pad(a, pad)
    n = a.shape[axis]
    return np.max([np.take(p, range(i, i + n), axis=axis) for i in range(k)], axis=0)


def nine_slice(img: np.ndarray, corner_frac: float, slice_px: int, edge_px: int = 0) -> Image.Image:
    """Crop to the frame, keep the four corners, rebuild each edge from its plainest strip.

    The edge middle is one repeated strip, so CSS border-image stretch cannot smear an ornament.
    edge_px thickens only those strips. Output corners are exactly slice_px, with a 16 px middle.
    """
    lum = img.max(axis=2)
    ys, xs = np.nonzero(lum > 40)
    img = img[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    h, w = img.shape[:2]
    c = int(min(h, w) * corner_frac)
    col = min(range(c, w // 2), key=lambda x: int(img[:c, x].sum()))    # plainest column of the top band
    row = min(range(c, h // 2), key=lambda y: int(img[y, :c].sum()))    # plainest row of the left band
    m = max(1, round(16 * c / slice_px))
    out = np.zeros((2 * c + m, 2 * c + m, 3), np.uint8)
    out[:c, :c] = img[:c, :c]
    out[:c, c + m:] = img[:c, w - c:]
    out[c + m:, :c] = img[h - c:, :c]
    out[c + m:, c + m:] = img[h - c:, w - c:]
    out[:c, c:c + m] = thicken(img[:c, col:col + 1], 0, edge_px)
    out[c + m:, c:c + m] = thicken(img[h - c:, col:col + 1], 0, edge_px)
    out[c:c + m, :c] = thicken(img[row:row + 1, :c], 1, edge_px)
    out[c:c + m, c + m:] = thicken(img[row:row + 1, w - c:], 1, edge_px)
    rgba = luminance_to_alpha(out)
    size = 2 * slice_px + 16
    return Image.fromarray(rgba, "RGBA").resize((size, size), Image.LANCZOS)


def luminance_to_alpha(rgb: np.ndarray) -> np.ndarray:
    """Gold on black -> RGBA: alpha from brightness, colour un-premultiplied so edges stay gold."""
    f = rgb.astype(np.float32) / 255
    lum = f.max(axis=2)
    alpha = np.clip((lum - 0.08) / 0.42, 0, 1)
    color = np.clip(f / np.maximum(lum[..., None], 1e-3), 0, 1) * np.clip(lum / 0.5, 0, 1)[..., None]
    color = np.clip(color * 1.15, 0, 1)
    return (np.dstack([color, alpha]) * 255).astype(np.uint8)


async def render(name: str, prompt: str, w: int, h: int, seed: int) -> pathlib.Path:
    """Renders once; delete the raw file to render again."""
    dest = RAW / f"{name}.png"
    if dest.exists():
        return dest
    secs = await comfy_client.txt2img(prompt, w, h, seed, dest)
    print(f"{name}: {secs:.1f}s -> {dest}")
    return dest


async def main(names: list[str]) -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    if not await comfy_client.online():
        sys.exit("ComfyUI 未連線")
    if not names or "cover" in names:
        src = await render("cover", COVER, 1280, 720, 7101)
        Image.open(src).convert("RGB").save(OUT / "cover.png")
    for i, (name, (prompt, rw, rh, frac, slice_px, edge_px)) in enumerate(FRAMES.items()):
        if names and name not in names:
            continue
        src = await render(name, prompt, rw, rh, 7200 + i)
        rgb = np.asarray(Image.open(src).convert("RGB"))
        nine_slice(mirror_quadrant(rgb), frac, slice_px, edge_px).save(OUT / f"{name}.png")
    spec = {
        "style": UI_STYLE,
        "no_text_rule": NO_TEXT,
        "palette": {"bg": "#0c1020", "panel": "rgba(18,24,44,0.96)", "gold": "#d2ae68", "gold_dim": "#8f7443",
                    "ink": "#f4ecdc", "muted": "#b3ab9c", "accent": "#7f9ed8", "danger": "#d8847f"},
        "fonts": {"title_and_buttons": "Noto Serif TC 700/900", "body": "Noto Sans TC 400/500"},
        "components": {name: {"file": f"ui/{name}.png", "size": [2 * f[4] + 16] * 2, "slice": f[4],
                              "css": f"border-image: url(../ui/{name}.png) {f[4]} / <border width> stretch"}
                       for name, f in FRAMES.items()},
        "cover": {"file": "ui/cover.png", "size": [1280, 720], "note": "right half kept dark for the title menu"},
        "screens": ["title", "setup", "game", "dialog box", "options", "save/load", "node tree", "settings",
                    "confirm"],
        "usage": {"panel": ".panel (setup, save/load, tree, settings, confirm, progress)",
                  "box": ".box (dialog box)", "btn": ".btn (all buttons, options)"},
    }
    (OUT / "ui-spec.json").write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    asyncio.run(main(sys.argv[1:]))
