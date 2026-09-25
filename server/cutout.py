"""Sprite background removal: the p5-comfyui-animation SKILL cutout, without cropping each image on its own.

All five expressions of a character are cropped to the calm base's bbox so the body never jumps between
expressions (PLAN section 7). Logic of harden / speck removal / iso residue is copied from
~/.claude/skills/p5-comfyui-animation-v2/scripts/process_assets.py.
"""
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

WHITE_WORDS = re.compile(r"\b(white|cream|ivory|snow|silver|pale|tuxedo)\b", re.I)
ISO_BLUE = "isolated on a plain flat light blue background, nothing behind the subject"
ISO_GREEN = "isolated on a plain flat light green background, nothing behind the subject"
TALL = 1.35

_session = None


def session():
    global _session
    if _session is None:
        from rembg import new_session
        _session = new_session("u2net", providers=["CPUExecutionProvider"])
    return _session


def iso_phrase(appearance_en: str) -> str:
    """Coloured isolation background, so white clothes and hair are never taken for background."""
    return ISO_GREEN if re.search(r"\bblue\b", appearance_en, re.I) else ISO_BLUE


def iso_residue(rgb, a, hue_tol=18, min_sat=0.12, min_val=0.4, max_share=0.15):
    hsv = np.asarray(rgb.convert("HSV")).astype(np.float32) / 255
    border = np.concatenate([hsv[0], hsv[-1], hsv[:, 0], hsv[:, -1]])
    bg_h, bg_s = np.median(border[:, 0]), np.median(border[:, 1])
    if bg_s < min_sat:
        return np.zeros(a.shape, bool)
    dh = np.abs(hsv[..., 0] - bg_h)
    like = (np.minimum(dh, 1 - dh) * 360 < hue_tol) & (hsv[..., 1] > min_sat) & (hsv[..., 2] > min_val) & (a > 0)
    arr = np.asarray(rgb).astype(np.float32)
    bg_rgb = np.median(np.concatenate([arr[0], arr[-1], arr[:, 0], arr[:, -1]]), axis=0)
    exact = like & (np.linalg.norm(arr - bg_rgb, axis=2) < 30)
    like &= exact | ndimage.binary_dilation(ndimage.binary_opening(like, iterations=2), iterations=2)
    labels, _ = ndimage.label(like)
    touching = np.unique(labels[ndimage.binary_dilation(a < 0.05, iterations=2) & like])
    residue = np.isin(labels, touching[touching > 0])
    exact_labels, n_exact = ndimage.label(exact)
    if n_exact:
        sizes = ndimage.sum(exact, exact_labels, range(1, n_exact + 1))
        residue |= np.isin(exact_labels, np.flatnonzero(sizes >= 20) + 1)
    if residue.sum() > max_share * (a > 0.5).sum():
        return np.zeros(a.shape, bool)
    return residue


def cutout_full(rgb: Image.Image) -> Image.Image:
    """SKILL cutout, uncropped (same size as the input)."""
    from rembg import remove
    out = remove(rgb, session=session())
    a = np.asarray(out.getchannel("A")).astype(np.float32) / 255
    a = np.clip((a - 0.15) / 0.7, 0, 1)
    labels, n = ndimage.label(ndimage.binary_dilation(a > 0.3, iterations=2))
    if n > 1:
        sizes = ndimage.sum(np.ones_like(a), labels, range(1, n + 1))
        keep = np.isin(labels, [i + 1 for i, s in enumerate(sizes) if s >= 0.03 * sizes.max()])
        a = a * keep
    a = a * ~iso_residue(rgb, a)
    out.putalpha(Image.fromarray((a * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6)))
    return out


def face_box(rgba: Image.Image) -> tuple[int, int, int, int]:
    """Tall box over the head: top of hair, width of the head row, height = width x TALL (D6t)."""
    a = np.asarray(rgba.getchannel("A")) > 128
    rows = np.flatnonzero(a.sum(1) > 3)
    y0, y1 = rows[0], rows[-1]
    probe = y0 + int(0.10 * (y1 - y0))
    cols = np.flatnonzero(a[probe])
    cx = (cols[0] + cols[-1]) // 2
    size = int(1.35 * (cols[-1] - cols[0]))
    top = max(0, int(y0) - size // 10)
    left = int(np.clip(cx - size // 2, 0, rgba.width - size))
    return left, top, left + size, min(rgba.height, top + int(size * TALL))


def region_paste(base: Image.Image, donor: Image.Image, box) -> Image.Image:
    w, h = box[2] - box[0], box[3] - box[1]
    mask = Image.new("L", (w, h), 0)
    mx, my = int(w * 0.10), int(h * 0.06)
    ImageDraw.Draw(mask).ellipse((mx, my, w - mx, h - my), fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(w * 0.05))
    out = base.copy()
    out.paste(donor.crop(box), box[:2], mask)
    return out


def padded_bbox(rgba: Image.Image, pad: int = 6) -> tuple[int, int, int, int]:
    l, t, r, b = rgba.getchannel("A").getbbox()
    return max(0, l - pad), max(0, t - pad), min(rgba.width, r + pad), min(rgba.height, b + pad)
