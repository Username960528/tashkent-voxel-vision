import hashlib
import math

import numpy as np
from PIL import Image


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while True:
            chunk = f.read(1024 * 1024)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def load_rgb(path, *, target_size=None):
    with Image.open(path) as src:
        img = src.convert("RGB")
    if target_size is not None and img.size != target_size:
        img = img.resize(tuple(target_size), resample=Image.Resampling.LANCZOS)
    arr = np.asarray(img, dtype=np.float32) / 255.0
    return arr, img.size


def _rgb_l1_mean(a, b):
    return float(np.mean(np.abs(a - b)))


def _rgb_l2_mean(a, b):
    d = a - b
    return float(np.mean(d * d))


def _sobel_mag(lum):
    # lum: float32 in [0, 1], shape (H, W)
    if lum.ndim != 2:
        raise ValueError("expected lum to be 2D")
    h, w = lum.shape
    if h < 2 or w < 2:
        return np.zeros_like(lum, dtype=np.float32)

    p = np.pad(lum, ((1, 1), (1, 1)), mode="edge")
    gx = (
        p[0 : h, 0:w]
        + 2.0 * p[1 : h + 1, 0:w]
        + p[2 : h + 2, 0:w]
        - (p[0 : h, 2 : w + 2] + 2.0 * p[1 : h + 1, 2 : w + 2] + p[2 : h + 2, 2 : w + 2])
    )
    gy = (
        p[0 : h, 0:w]
        + 2.0 * p[0 : h, 1 : w + 1]
        + p[0 : h, 2 : w + 2]
        - (p[2 : h + 2, 0:w] + 2.0 * p[2 : h + 2, 1 : w + 1] + p[2 : h + 2, 2 : w + 2])
    )
    return np.sqrt(gx * gx + gy * gy).astype(np.float32)


def _sobel_l1_mean(a_rgb, b_rgb):
    if a_rgb.shape != b_rgb.shape:
        raise ValueError("shape mismatch")
    a_lum = (0.2126 * a_rgb[:, :, 0] + 0.7152 * a_rgb[:, :, 1] + 0.0722 * a_rgb[:, :, 2]).astype(np.float32)
    b_lum = (0.2126 * b_rgb[:, :, 0] + 0.7152 * b_rgb[:, :, 1] + 0.0722 * b_rgb[:, :, 2]).astype(np.float32)
    a_mag = _sobel_mag(a_lum)
    b_mag = _sobel_mag(b_lum)
    return float(np.mean(np.abs(a_mag - b_mag)))


def normalize_weights(weights, *, default=None):
    w = dict(weights or {})
    out = {}
    for k in ("rgb_l1", "rgb_l2", "sobel_l1"):
        v = w.get(k, None)
        if v is None:
            continue
        try:
            fv = float(v)
        except Exception:
            continue
        if math.isfinite(fv):
            out[k] = fv
    if not out:
        if default is None:
            default = {"rgb_l1": 1.0, "rgb_l2": 0.25, "sobel_l1": 0.5}
        out = dict(default)
    return out


def score_pair(a_rgb, b_rgb, *, weights):
    w = normalize_weights(weights)
    metrics = {
        "rgb_l1": _rgb_l1_mean(a_rgb, b_rgb),
        "rgb_l2": _rgb_l2_mean(a_rgb, b_rgb),
        "sobel_l1": _sobel_l1_mean(a_rgb, b_rgb),
    }
    score = float(sum(float(w.get(k, 0.0)) * float(metrics.get(k, 0.0)) for k in metrics.keys()))
    return score, metrics


def score_candidate_against_neighbors(
    cand_rgb,
    *,
    left_rgb=None,
    top_rgb=None,
    tl_rgb=None,
    overlap_px=48,
    weights=None,
    neighbor_mode="left+top",
):
    h, w, _c = cand_rgb.shape
    op = int(max(1, min(int(overlap_px), w, h)))

    seams = {}
    total = 0.0

    if left_rgb is not None and "left" in neighbor_mode:
        a = left_rgb[:, w - op : w, :]
        b = cand_rgb[:, 0:op, :]
        s, m = score_pair(a, b, weights=weights)
        seams["left"] = {"score": s, "metrics": m}
        total += s

    if top_rgb is not None and "top" in neighbor_mode:
        a = top_rgb[h - op : h, :, :]
        b = cand_rgb[0:op, :, :]
        s, m = score_pair(a, b, weights=weights)
        seams["top"] = {"score": s, "metrics": m}
        total += s

    if tl_rgb is not None and ("tl" in neighbor_mode or "top-left" in neighbor_mode):
        a = tl_rgb[h - op : h, w - op : w, :]
        b = cand_rgb[0:op, 0:op, :]
        s, m = score_pair(a, b, weights=weights)
        seams["tl"] = {"score": s, "metrics": m}
        total += s

    return float(total), seams


def seam_line_rgb_l1_per_row(left_rgb, right_rgb, *, overlap_px):
    h, w, _c = left_rgb.shape
    op = int(max(1, min(int(overlap_px), w)))
    a = left_rgb[:, w - op : w, :]
    b = right_rgb[:, 0:op, :]
    # Mean abs diff per row (collapse strip width + channels).
    return np.mean(np.abs(a - b), axis=(1, 2)).astype(np.float32)


def seam_line_rgb_l1_per_col(top_rgb, bottom_rgb, *, overlap_px):
    h, w, _c = top_rgb.shape
    op = int(max(1, min(int(overlap_px), h)))
    a = top_rgb[h - op : h, :, :]
    b = bottom_rgb[0:op, :, :]
    # Mean abs diff per column (collapse strip height + channels).
    return np.mean(np.abs(a - b), axis=(0, 2)).astype(np.float32)
