import argparse
import base64
import hashlib
import io
import json
import math
import os
import random
import shutil
import subprocess
import time
import urllib.error
import urllib.request

import numpy as np
from PIL import Image

from seam_score import (
    load_rgb,
    normalize_weights,
    score_candidate_against_neighbors,
    score_pair,
    seam_line_rgb_l1_per_col,
    seam_line_rgb_l1_per_row,
    sha256_file,
)

PROMPT_LAYOUT_VERSION = 2


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def _read_text(path):
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


def _sha256_text(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _is_retryable(status, message):
    if status in (429, 500, 502, 503, 504):
        return True
    msg = (message or "").lower()
    for token in (
        "429",
        "rate",
        "resource exhausted",
        "unavailable",
        "internal",
        "server error",
        "timeout",
        "temporar",
        "502",
        "503",
        "504",
    ):
        if token in msg:
            return True
    return False


def _backoff_ms(attempt, base_ms, max_ms, jitter_ms):
    base = max(0.0, float(base_ms))
    cap = max(base, float(max_ms))
    delay = min(base * (2.0**attempt), cap)
    jitter = max(0.0, float(jitter_ms))
    if jitter > 0:
        delay += random.random() * jitter
    return delay


def _get_vertex_access_token():
    from_env = str(os.environ.get("VERTEX_ACCESS_TOKEN") or "").strip()
    if from_env:
        return from_env

    attempts = [
        ["gcloud", "auth", "application-default", "print-access-token"],
        ["gcloud", "auth", "print-access-token"],
    ]
    errors = []
    for cmd in attempts:
        try:
            out = subprocess.check_output(cmd, stderr=subprocess.STDOUT, timeout=15).decode("utf-8").strip()
            if out:
                return out
            errors.append(" ".join(cmd) + " returned empty token")
        except Exception as e:
            errors.append(" ".join(cmd) + " failed: " + str(e))

    raise RuntimeError(
        "Missing Vertex auth token. Set VERTEX_ACCESS_TOKEN or authorize gcloud.\n" + "\n".join(errors)
    )


def _build_vertex_url(model, project, location):
    loc = str(location or "").strip() or "us-central1"
    model_res = str(model or "").strip()
    if not model_res:
        raise ValueError("Missing model")

    if not model_res.startswith("projects/"):
        if not project:
            raise ValueError("Missing vertex_project (or env VERTEX_PROJECT)")
        if model_res.startswith("publishers/"):
            model_res = f"projects/{project}/locations/{loc}/{model_res}"
        else:
            model_res = f"projects/{project}/locations/{loc}/publishers/google/models/{model_res}"

    host = "aiplatform.googleapis.com" if loc.lower() == "global" else f"{loc}-aiplatform.googleapis.com"
    return f"https://{host}/v1/{model_res}:generateContent"


def _post_json(url, payload, *, access_token, timeout_ms):
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {access_token}",
        },
    )
    with urllib.request.urlopen(req, timeout=max(1, int(timeout_ms)) / 1000.0) as resp:
        raw = resp.read()
        return json.loads(raw.decode("utf-8"))


def _post_json_with_retries(
    url,
    payload,
    *,
    access_token,
    timeout_ms,
    retry_max,
    retry_base_ms,
    retry_max_ms,
    retry_jitter_ms,
    debug_retries,
    purpose,
):
    attempt = 0
    while True:
        try:
            return _post_json(url, payload, access_token=access_token, timeout_ms=timeout_ms)
        except urllib.error.HTTPError as e:
            status = int(getattr(e, "code", 0) or 0)
            text = ""
            try:
                text = e.read().decode("utf-8", errors="replace")
            except Exception:
                text = str(e)
            msg = f"HTTP {status}: {text[:300]}"
            if attempt >= int(retry_max) or not _is_retryable(status, msg):
                raise RuntimeError(msg) from e
            delay = _backoff_ms(attempt, retry_base_ms, retry_max_ms, retry_jitter_ms)
            if debug_retries:
                print(f"Retrying {purpose} after error ({msg}). attempt={attempt+1} delay_ms={int(delay)}")
            time.sleep(delay / 1000.0)
            attempt += 1
        except Exception as e:
            msg = str(e)
            if attempt >= int(retry_max) or not _is_retryable(0, msg):
                raise
            delay = _backoff_ms(attempt, retry_base_ms, retry_max_ms, retry_jitter_ms)
            if debug_retries:
                print(f"Retrying {purpose} after error ({msg}). attempt={attempt+1} delay_ms={int(delay)}")
            time.sleep(delay / 1000.0)
            attempt += 1


def _extract_inline_images(data):
    if not isinstance(data, dict):
        raise ValueError("empty response")
    feedback = data.get("promptFeedback") or data.get("prompt_feedback") or {}
    if isinstance(feedback, dict) and feedback.get("blockReason"):
        raise RuntimeError(f"Prompt blocked: {feedback.get('blockReason')}")

    candidates = data.get("candidates") or []
    if not isinstance(candidates, list) or len(candidates) == 0:
        raise RuntimeError("No candidates returned")

    for cand in candidates:
        content = cand.get("content") or {}
        parts = content.get("parts") or []
        if not isinstance(parts, list):
            continue
        for part in parts:
            inline = part.get("inlineData") or part.get("inline_data") or {}
            if isinstance(inline, dict) and inline.get("data"):
                mime = inline.get("mimeType") or inline.get("mime_type") or "image/png"
                return mime, inline.get("data")
            file_data = part.get("fileData") or part.get("file_data") or {}
            if isinstance(file_data, dict) and (file_data.get("fileUri") or file_data.get("file_uri")):
                # For this pilot we need bytes on disk. If the model returns file URIs (e.g. GCS),
                # we would need an authenticated download path; treat as an error for now.
                uri = file_data.get("fileUri") or file_data.get("file_uri")
                raise RuntimeError(f"Vertex returned fileUri instead of inline bytes: {uri}")

    raise RuntimeError("No image data in response")


def _file_to_inline_part(path, label):
    mime = "image/png"
    lower = path.lower()
    if lower.endswith(".jpg") or lower.endswith(".jpeg"):
        mime = "image/jpeg"
    elif lower.endswith(".webp"):
        mime = "image/webp"
    with open(path, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")
    return [
        {"text": str(label)},
        {"inlineData": {"mimeType": mime, "data": data}},
    ]


def _pick_seed(seed_mode, seed_base, x, y, variant_index):
    mode = str(seed_mode or "tile_hash").strip().lower()
    base = int(seed_base) if seed_base is not None else 0
    if mode == "fixed":
        seed = base + int(variant_index)
        return int(seed) & 0x7FFFFFFF
    if mode == "random":
        seed = int.from_bytes(os.urandom(4), "big")
        return int(seed) & 0x7FFFFFFF
    if mode == "tile_hash":
        raw = f"{base}:{x}:{y}:{variant_index}".encode("utf-8")
        seed = int.from_bytes(hashlib.sha256(raw).digest()[:4], "big")
        return int(seed) & 0x7FFFFFFF
    raise ValueError(f"Unsupported --seed_mode: {seed_mode}")


def _relpath_if_under(root, p):
    try:
        root_abs = os.path.abspath(root)
        p_abs = os.path.abspath(p)
        if p_abs == root_abs:
            return "."
        if p_abs.startswith(root_abs + os.sep):
            return os.path.relpath(p_abs, root_abs).replace(os.sep, "/")
    except Exception:
        pass
    return p


def _crop_margin_px(size_px, overlap):
    if overlap <= 0.0:
        return 0
    frac = float(overlap) / (1.0 + 2.0 * float(overlap))
    return int(round(size_px * frac))


def _resize_rgb_array(rgb, *, out_size):
    # rgb: float32 in [0, 1], shape (H, W, 3)
    if rgb is None:
        return None
    out_w, out_h = (int(out_size[0]), int(out_size[1]))
    if out_w <= 0 or out_h <= 0:
        raise ValueError("out_size must be positive")
    h, w, c = rgb.shape
    if c != 3:
        raise ValueError("expected 3-channel RGB")
    if w == out_w and h == out_h:
        return rgb
    img = Image.fromarray(np.clip(rgb * 255.0, 0.0, 255.0).astype(np.uint8), mode="RGB")
    img = img.resize((out_w, out_h), resample=Image.Resampling.LANCZOS)
    return (np.asarray(img, dtype=np.float32) / 255.0).astype(np.float32)


def _colormap_hot(t):
    t = float(max(0.0, min(1.0, t)))
    if t < 0.5:
        r = int(round(255.0 * (2.0 * t)))
        return (r, 0, 0)
    if t < 0.85:
        g = int(round(255.0 * (t - 0.5) / 0.35))
        return (255, g, 0)
    b = int(round(255.0 * (t - 0.85) / 0.15))
    return (255, 255, max(0, min(255, b)))


def _write_json(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
        f.write("\n")
    os.replace(tmp, path)


def _read_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description="Vertex Nano Banana Pro 4x4 pilot: K candidates per tile + seam scoring.")

    ap.add_argument("--run_id", required=True)
    ap.add_argument("--run_root", required=True, help="Absolute run root (data/releases/<run_id>)")
    ap.add_argument("--tiles_dir", required=True, help="Absolute base tiles dir (expects tilejson.json and layer/0/x/y.png)")
    ap.add_argument("--layer", default="raw_whitebox", help="Input layer inside tiles_dir (default: raw_whitebox)")
    ap.add_argument("--out_dir", required=True, help="Absolute output dir (exports/iso_nb_pro)")

    ap.add_argument("--x0", type=int, required=True)
    ap.add_argument("--y0", type=int, required=True)
    ap.add_argument("--w", type=int, default=4)
    ap.add_argument("--h", type=int, default=4)

    ap.add_argument("--vertex_project", default="")
    ap.add_argument("--vertex_location", default="global")
    ap.add_argument("--model", required=True)
    ap.add_argument("--fallback_model", default="")

    ap.add_argument("--k", type=int, default=4)
    ap.add_argument("--seed_mode", default="tile_hash", help="fixed|random|tile_hash (default: tile_hash)")
    ap.add_argument("--seed_base", type=int, default=0)

    ap.add_argument("--anchors", required=True, help="Comma-separated list of anchor image paths (3-6)")
    ap.add_argument("--prompt_file", required=True)
    ap.add_argument("--negative_prompt_file", default="")
    ap.add_argument("--use_neighbors", type=int, default=1)
    ap.add_argument("--neighbor_mode", default="left+top")
    ap.add_argument(
        "--neighbors_in_prompt",
        type=int,
        default=1,
        help="If 1, include already-accepted neighbors as images in the generation prompt (still always used for scoring).",
    )

    ap.add_argument("--overlap_px", type=int, default=48)
    ap.add_argument("--score_weights", default="")
    ap.add_argument("--structure_weight", type=float, default=0.75)
    ap.add_argument("--structure_downscale_px", type=int, default=128)
    ap.add_argument("--structure_weights", default="")
    ap.add_argument("--fallback_penalty", type=float, default=0.05)

    ap.add_argument("--cache_dir", default=".cache/vertex_nb_pro")
    ap.add_argument("--force", type=int, default=0)

    ap.add_argument("--image_size", default="1K")
    ap.add_argument("--aspect_ratio", default="1:1")
    ap.add_argument("--temperature", type=float, default=0.45)
    ap.add_argument("--top_p", type=float, default=0.9)

    ap.add_argument("--timeout_ms", type=int, default=30000)
    ap.add_argument("--retry_max", type=int, default=2)
    ap.add_argument("--retry_base_ms", type=float, default=800)
    ap.add_argument("--retry_max_ms", type=float, default=8000)
    ap.add_argument("--retry_jitter_ms", type=float, default=300)
    ap.add_argument("--debug_retries", type=int, default=0)

    args = ap.parse_args()

    run_root = os.path.abspath(args.run_root)
    tiles_dir = os.path.abspath(args.tiles_dir)
    out_dir = os.path.abspath(args.out_dir)

    if not os.path.isdir(run_root):
        raise SystemExit(f"missing run_root: {run_root}")
    if not os.path.isdir(tiles_dir):
        raise SystemExit(f"missing tiles_dir: {tiles_dir}")
    if args.w <= 0 or args.h <= 0:
        raise SystemExit("--w/--h must be > 0")
    if args.k <= 0:
        raise SystemExit("--k must be > 0")
    if args.overlap_px <= 0:
        raise SystemExit("--overlap_px must be > 0")
    if int(args.neighbors_in_prompt) not in (0, 1):
        raise SystemExit("--neighbors_in_prompt must be 0 or 1")
    if args.structure_downscale_px <= 0:
        raise SystemExit("--structure_downscale_px must be > 0")
    if not math.isfinite(float(args.structure_weight)) or float(args.structure_weight) < 0.0:
        raise SystemExit("--structure_weight must be >= 0")
    if not math.isfinite(float(args.fallback_penalty)) or float(args.fallback_penalty) < 0.0:
        raise SystemExit("--fallback_penalty must be >= 0")

    anchor_paths = [p.strip() for p in str(args.anchors).split(",") if p.strip()]
    if len(anchor_paths) < 3 or len(anchor_paths) > 6:
        raise SystemExit("--anchors must contain 3..6 images (comma-separated)")
    for p in anchor_paths:
        if not os.path.isfile(p):
            raise SystemExit(f"missing anchor: {p}")

    layer_lower = str(args.layer).strip().lower()

    prompt_user = _read_text(args.prompt_file)
    # Keep prompt templates consistent with the in-code multimodal labels (we label the input image as "INPUT TILE").
    prompt_user = str(prompt_user or "").replace("labeled WHITEBOX", "labeled INPUT TILE").replace("WHITEBOX", "INPUT TILE")
    negative_text = _read_text(args.negative_prompt_file) if args.negative_prompt_file else ""

    # Guardrails live in-code so pilots stay reproducible even when users keep prompt templates short.
    # These are appended to the user prompt and included in prompt_hash/cache keys.
    prompt_guardrails_lines = [
        "Hard constraints:",
        "- Do not copy the anchors or neighbors; use them only as style references.",
        "- Do not introduce new large objects that cross tile boundaries.",
        "- Keep global lighting/camera consistent with the anchors.",
    ]
    if "whitebox" not in layer_lower:
        prompt_guardrails_lines.insert(1, "- Preserve per-building roof colors/materials from the input tile; avoid homogenizing everything.")
    prompt_guardrails = "\n".join(prompt_guardrails_lines).strip()
    prompt_guardrails_hash = _sha256_text(prompt_guardrails) if prompt_guardrails else ""

    prompt_text = (str(prompt_user or "").strip() + "\n\n" + prompt_guardrails).strip()
    prompt_hash = _sha256_text(prompt_text)
    negative_hash = _sha256_text(negative_text) if negative_text else ""

    seam_weights = None
    if args.score_weights:
        raw = str(args.score_weights).strip()
        if raw.startswith("{"):
            seam_weights = json.loads(raw)
        elif os.path.isfile(raw):
            seam_weights = json.loads(_read_text(raw))
        else:
            raise SystemExit(f"--score_weights must be a JSON string or existing file path: {raw}")
    seam_weights_norm = normalize_weights(seam_weights)

    structure_weights_raw = None
    if args.structure_weights:
        raw = str(args.structure_weights).strip()
        if raw.startswith("{"):
            structure_weights_raw = json.loads(raw)
        elif os.path.isfile(raw):
            structure_weights_raw = json.loads(_read_text(raw))
        else:
            raise SystemExit(f"--structure_weights must be a JSON string or existing file path: {raw}")
    # For satellite/raw tiles, bias selection harder towards color/texture fidelity so we don't collapse
    # into a single "safe" roof palette just to minimize seam diffs.
    default_structure_weights = {"rgb_l1": 0.15, "rgb_l2": 0.0, "sobel_l1": 1.0}
    if "whitebox" not in layer_lower:
        default_structure_weights = {"rgb_l1": 1.0, "rgb_l2": 0.0, "sobel_l1": 0.5}
    structure_weights_norm = normalize_weights(structure_weights_raw, default=default_structure_weights)

    structure_weight = float(args.structure_weight)
    structure_downscale_px = int(args.structure_downscale_px)
    fallback_penalty = float(args.fallback_penalty)

    vertex_project = str(args.vertex_project or "").strip() or str(os.environ.get("VERTEX_PROJECT") or "").strip()
    vertex_location = str(args.vertex_location or "").strip() or str(os.environ.get("VERTEX_LOCATION") or "global").strip()
    model = str(args.model).strip()
    fallback_model = str(args.fallback_model or "").strip()

    cfg = {
        "temperature": float(args.temperature),
        "top_p": float(args.top_p),
        "image_size": str(args.image_size),
        "aspect_ratio": str(args.aspect_ratio),
        "response_modalities": ["IMAGE"],
        "candidate_count": 1,
    }
    params_hash = _sha256_text(json.dumps({"vertex": {"project": vertex_project, "location": vertex_location}, "cfg": cfg}, sort_keys=True))

    out_tiles_dir = os.path.join(out_dir, "tiles")
    out_candidates_dir = os.path.join(out_dir, "candidates")
    _ensure_dir(out_tiles_dir)
    _ensure_dir(out_candidates_dir)

    # Copy tilejson.json for downstream mosaic tool (expects overlap in out_dir/tilejson.json).
    src_tilejson = os.path.join(tiles_dir, "tilejson.json")
    if os.path.isfile(src_tilejson):
        shutil.copyfile(src_tilejson, os.path.join(out_dir, "tilejson.json"))

    anchors_info = []
    anchors_hashes = []
    for p in anchor_paths:
        h = sha256_file(p)
        anchors_hashes.append(h)
        anchors_info.append({"path": _relpath_if_under(run_root, p), "sha256": h})

    # Guard against accidentally reusing an out_dir from a different config, which would silently
    # mix old tiles with new ones due to idempotent "skip if exists" behavior.
    config_path = os.path.join(out_dir, "config_nb_pro.json")
    run_config = {
        "version": 2,
        "prompt_layout_version": PROMPT_LAYOUT_VERSION,
        "run_id": args.run_id,
        "tiles_dir": _relpath_if_under(run_root, tiles_dir),
        "layer": str(args.layer),
        "subgrid": {"x0": int(args.x0), "y0": int(args.y0), "w": int(args.w), "h": int(args.h)},
        "vertex": {
            "project": vertex_project,
            "location": vertex_location,
            "model": model,
            "fallback_model": fallback_model,
            "params_hash": params_hash,
            "generation_config": cfg,
        },
        "k": int(args.k),
        "seed_mode": str(args.seed_mode),
        "seed_base": int(args.seed_base),
        "use_neighbors": int(args.use_neighbors),
        "neighbor_mode": str(args.neighbor_mode),
        "neighbors_in_prompt": int(args.neighbors_in_prompt),
        "overlap_px": int(args.overlap_px),
        "prompt_hash": prompt_hash,
        "prompt_guardrails_hash": prompt_guardrails_hash,
        "negative_hash": negative_hash,
        "anchors_sha256": anchors_hashes,
        "score_weights": seam_weights_norm,
        "structure_weight": structure_weight,
        "structure_downscale_px": structure_downscale_px,
        "structure_weights": structure_weights_norm,
        "fallback_penalty": fallback_penalty,
    }
    run_config_hash = _sha256_text(json.dumps(run_config, sort_keys=True))
    if os.path.isfile(config_path):
        try:
            existing = _read_json(config_path)
            existing_hash = str(existing.get("config_hash") or "").strip()
        except Exception:
            existing_hash = ""
        if not existing_hash and not int(args.force):
            raise SystemExit(
                "Refusing to reuse --out_dir with a missing/invalid config file.\n"
                f"  out_dir: {out_dir}\n"
                f"  config_file: {config_path}\n"
                "Use --force=1 to regenerate tiles, or choose a different --out_dir."
            )
        if existing_hash != run_config_hash and not int(args.force):
            raise SystemExit(
                "Refusing to reuse --out_dir with a different config.\n"
                f"  out_dir: {out_dir}\n"
                f"  existing_config_hash: {existing_hash}\n"
                f"  new_config_hash:      {run_config_hash}\n"
                "Use --force=1 to regenerate tiles, or choose a different --out_dir."
            )
    if (not os.path.isfile(config_path)) or int(args.force):
        _write_json(config_path, {"config_hash": run_config_hash, "config": run_config})

    # Determine target output size from first input tile.
    sample_in = os.path.join(tiles_dir, args.layer, "0", str(args.x0), f"{args.y0}.png")
    if not os.path.isfile(sample_in):
        raise SystemExit(f"missing input tile: {sample_in}")
    with Image.open(sample_in) as _sample_src:
        sample_img = _sample_src.convert("RGB")
        target_size = sample_img.size

    selected = {}  # (x,y) -> abs path
    selected_sha = {}  # (x,y) -> sha256

    tiles_report = []

    def _selected_path(x, y):
        return os.path.join(out_tiles_dir, "0", str(x), f"{y}.png")

    t0 = time.time()

    for y in range(args.y0, args.y0 + args.h):
        for x in range(args.x0, args.x0 + args.w):
            tile_in = os.path.join(tiles_dir, args.layer, "0", str(x), f"{y}.png")
            if not os.path.isfile(tile_in):
                raise SystemExit(f"missing input tile in patch: {tile_in}")

            tile_out = _selected_path(x, y)
            _ensure_dir(os.path.dirname(tile_out))

            rel_input = _relpath_if_under(run_root, tile_in)
            tile_entry = {
                "coord": {"x": int(x), "y": int(y)},
                # Keep the historical key for compatibility; pilots may use non-whitebox layers (e.g. raw satellite).
                "input_tile_path": rel_input,
                "input_whitebox_path": rel_input,
                "neighbors_used": [],
                "prompt_hash": prompt_hash,
                "candidates": [],
                "selected": None,
            }

            if os.path.isfile(tile_out) and not int(args.force):
                sh = sha256_file(tile_out)
                selected[(x, y)] = tile_out
                selected_sha[(x, y)] = sh
                tile_entry["selected"] = {"seed": None, "path": _relpath_if_under(run_root, tile_out), "seam_score": None, "cached": True}
                tiles_report.append(tile_entry)
                continue

            # Include the input tile hash in cache keys so cache is safe across runs/updates.
            tile_in_hash = sha256_file(tile_in)
            tile_in_rgb, _ = load_rgb(tile_in, target_size=target_size)
            tile_in_rgb_struct = None
            if structure_weight > 0.0:
                tile_in_rgb_struct = _resize_rgb_array(
                    tile_in_rgb,
                    out_size=(structure_downscale_px, structure_downscale_px),
                )

            neighbors = {}
            if int(args.use_neighbors):
                if "left" in args.neighbor_mode and x > args.x0 and (x - 1, y) in selected:
                    neighbors["left"] = selected[(x - 1, y)]
                if "top" in args.neighbor_mode and y > args.y0 and (x, y - 1) in selected:
                    neighbors["top"] = selected[(x, y - 1)]
                if ("tl" in args.neighbor_mode or "top-left" in args.neighbor_mode) and x > args.x0 and y > args.y0 and (x - 1, y - 1) in selected:
                    neighbors["tl"] = selected[(x - 1, y - 1)]

            neighbor_hashes = []
            for k, p in neighbors.items():
                hsh = selected_sha.get((x - 1, y)) if k == "left" else selected_sha.get((x, y - 1)) if k == "top" else selected_sha.get((x - 1, y - 1))
                if hsh is None:
                    hsh = sha256_file(p)
                neighbor_hashes.append(hsh)
                tile_entry["neighbors_used"].append({"kind": k, "path": _relpath_if_under(run_root, p), "sha256": hsh})

            # Load neighbors once for scoring.
            left_rgb = None
            top_rgb = None
            tl_rgb = None
            if "left" in neighbors:
                left_rgb, _ = load_rgb(neighbors["left"], target_size=target_size)
            if "top" in neighbors:
                top_rgb, _ = load_rgb(neighbors["top"], target_size=target_size)
            if "tl" in neighbors:
                tl_rgb, _ = load_rgb(neighbors["tl"], target_size=target_size)

            best = None
            best_total_score = None
            best_seed = None
            best_seam_score = None
            best_structure_score = None
            best_model_used = None
            best_fallback_penalty = 0.0

            for vi in range(int(args.k)):
                seed = _pick_seed(args.seed_mode, args.seed_base, x, y, vi)
                gen_common = {
                    "prompt_layout_version": PROMPT_LAYOUT_VERSION,
                    "prompt_hash": prompt_hash,
                    "negative_hash": negative_hash,
                    "anchors": anchors_hashes,
                    "neighbors": neighbor_hashes,
                    "x": int(x),
                    "y": int(y),
                    "layer": str(args.layer),
                    "tile_in_sha256": tile_in_hash,
                    "seed": int(seed),
                    "cfg": cfg,
                    "neighbor_mode": str(args.neighbor_mode),
                    "neighbors_in_prompt": int(args.neighbors_in_prompt),
                }

                def _cache_key(model_used):
                    payload = dict(gen_common)
                    payload["model"] = str(model_used)
                    payload["vertex"] = {"project": vertex_project, "location": vertex_location}
                    return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

                used_model = model
                cache_key = _cache_key(used_model)
                cache_dir = os.path.abspath(args.cache_dir)
                _ensure_dir(cache_dir)
                cache_png = os.path.join(cache_dir, f"{cache_key}.png")

                cand_dir = os.path.join(out_candidates_dir, f"{x}_{y}")
                _ensure_dir(cand_dir)
                cand_png = os.path.join(cand_dir, f"v{vi+1:02d}-seed{seed}.png")

                started = time.time()
                cached = False
                error = ""

                if os.path.isfile(cache_png) and not int(args.force):
                    shutil.copyfile(cache_png, cand_png)
                    cached = True
                else:
                    # Build multimodal prompt: anchors + (optional) accepted neighbors + input tile.
                    parts = []
                    parts.append({"text": prompt_text.strip()})
                    if negative_text.strip():
                        parts.append({"text": "Negative instructions (avoid):\n" + negative_text.strip()})

                    parts.append({"text": "Style anchors (reference images):"})
                    for i, p in enumerate(anchor_paths):
                        parts.extend(_file_to_inline_part(p, f"ANCHOR {i+1}"))

                    if neighbors and int(args.neighbors_in_prompt):
                        parts.append(
                            {
                                "text": "Already accepted neighbor tiles (use only to match seams/global consistency; do not copy interiors):"
                            }
                        )
                        if "left" in neighbors:
                            parts.extend(_file_to_inline_part(neighbors["left"], "NEIGHBOR LEFT"))
                        if "top" in neighbors:
                            parts.extend(_file_to_inline_part(neighbors["top"], "NEIGHBOR TOP"))
                        if "tl" in neighbors:
                            parts.extend(_file_to_inline_part(neighbors["tl"], "NEIGHBOR TOP-LEFT"))

                    if "whitebox" in layer_lower:
                        input_desc = f"Input tile (layer={args.layer}, whitebox/structure guide): preserve geometry/camera/roads/building footprints."
                    else:
                        input_desc = (
                            f"Input tile (layer={args.layer}, source/aerial): preserve road layout + building footprints, "
                            "and keep local roof colors/materials (avoid homogenizing palette)."
                        )
                    parts.append({"text": input_desc})
                    parts.extend(_file_to_inline_part(tile_in, "INPUT TILE"))

                    parts.append(
                        {
                            "text": "Output: generate ONE stylized tile image corresponding to the INPUT TILE only. "
                            "Keep isometric camera, consistent lighting, and match the anchors' style. "
                            "Do not introduce new large objects that cross tile boundaries.",
                        }
                    )

                    generation_config = {
                        "responseModalities": ["IMAGE"],
                        "candidateCount": 1,
                        "seed": int(seed),
                        "temperature": float(args.temperature),
                        "topP": float(args.top_p),
                        "imageConfig": {"imageSize": str(args.image_size).upper(), "aspectRatio": str(args.aspect_ratio)},
                    }
                    payload = {"contents": [{"role": "user", "parts": parts}], "generationConfig": generation_config}

                    def _call_model(model_used):
                        url = _build_vertex_url(model_used, vertex_project, vertex_location)
                        return _post_json_with_retries(
                            url,
                            payload,
                            # Long runs can exceed the lifetime of a single access token; re-fetch per request.
                            access_token=_get_vertex_access_token(),
                            timeout_ms=args.timeout_ms,
                            retry_max=args.retry_max,
                            retry_base_ms=args.retry_base_ms,
                            retry_max_ms=args.retry_max_ms,
                            retry_jitter_ms=args.retry_jitter_ms,
                            debug_retries=bool(int(args.debug_retries)),
                            purpose="image_generate",
                        )

                    data = None
                    try:
                        data = _call_model(model)
                    except Exception as e:
                        msg = str(e)
                        if fallback_model and fallback_model != model and "prompt blocked" not in msg.lower():
                            used_model = fallback_model
                            cache_key = _cache_key(used_model)
                            cache_png = os.path.join(cache_dir, f"{cache_key}.png")
                            if os.path.isfile(cache_png) and not int(args.force):
                                shutil.copyfile(cache_png, cand_png)
                                cached = True
                            else:
                                try:
                                    data = _call_model(fallback_model)
                                except Exception as fb_e:
                                    error = str(fb_e)
                                    data = None
                        else:
                            error = msg
                            data = None

                    if data is not None and not cached:
                        try:
                            _mime, b64 = _extract_inline_images(data)
                            raw_bytes = base64.b64decode(b64)
                            with Image.open(io.BytesIO(raw_bytes)) as _src:
                                im = _src.convert("RGB")
                            if im.size != target_size:
                                im = im.resize(target_size, resample=Image.Resampling.LANCZOS)
                            im.save(cand_png, "PNG")
                            shutil.copyfile(cand_png, cache_png)
                        except Exception as e:
                            error = str(e)

                latency_ms = int(round((time.time() - started) * 1000.0))

                cand_entry = {
                    "seed": int(seed),
                    "path": _relpath_if_under(run_root, cand_png),
                    "seam_score": None,
                    "metrics": None,
                    "latency_ms": latency_ms,
                    "cached": bool(cached),
                    "model_used": used_model,
                    "error": error or None,
                }

                if not error:
                    cand_rgb, _ = load_rgb(cand_png, target_size=target_size)
                    s_total, s_seams = score_candidate_against_neighbors(
                        cand_rgb,
                        left_rgb=left_rgb,
                        top_rgb=top_rgb,
                        tl_rgb=tl_rgb,
                        overlap_px=args.overlap_px,
                        weights=seam_weights_norm,
                        neighbor_mode=args.neighbor_mode,
                    )
                    seam_score = float(s_total)
                    cand_entry["seam_score"] = seam_score
                    cand_entry["metrics"] = s_seams

                    structure_score = 0.0
                    structure_metrics = None
                    if structure_weight > 0.0 and tile_in_rgb_struct is not None:
                        cand_rgb_struct = _resize_rgb_array(
                            cand_rgb,
                            out_size=(structure_downscale_px, structure_downscale_px),
                        )
                        structure_score, structure_metrics = score_pair(
                            tile_in_rgb_struct,
                            cand_rgb_struct,
                            weights=structure_weights_norm,
                        )
                    cand_entry["structure_score"] = float(structure_score) if structure_weight > 0.0 else None
                    cand_entry["structure_metrics"] = structure_metrics

                    applied_fallback_penalty = fallback_penalty if used_model != model else 0.0
                    cand_entry["fallback_penalty"] = float(applied_fallback_penalty)

                    total_score = seam_score + structure_weight * float(structure_score) + float(applied_fallback_penalty)
                    cand_entry["total_score"] = float(total_score)

                    if best_total_score is None or total_score < best_total_score:
                        best_total_score = float(total_score)
                        best = cand_png
                        best_seed = int(seed)
                        best_seam_score = float(seam_score)
                        best_structure_score = float(structure_score) if structure_weight > 0.0 else None
                        best_model_used = used_model
                        best_fallback_penalty = float(applied_fallback_penalty)

                tile_entry["candidates"].append(cand_entry)

            if best is None:
                tile_entry["selected"] = {"seed": None, "path": None, "seam_score": None, "error": "all candidates failed"}
                tiles_report.append(tile_entry)
                continue

            shutil.copyfile(best, tile_out)
            sh = sha256_file(tile_out)
            selected[(x, y)] = tile_out
            selected_sha[(x, y)] = sh
            tile_entry["selected"] = {
                "seed": int(best_seed) if best_seed is not None else None,
                "path": _relpath_if_under(run_root, tile_out),
                "total_score": float(best_total_score) if best_total_score is not None else None,
                "seam_score": float(best_seam_score) if best_seam_score is not None else None,
                "structure_score": float(best_structure_score) if best_structure_score is not None else None,
                "model_used": best_model_used,
                "fallback_penalty": float(best_fallback_penalty),
                "cached": False,
            }
            tiles_report.append(tile_entry)

    # Seam summary + heatmap on selected tiles in the patch.
    tilejson_abs = os.path.join(out_dir, "tilejson.json")
    overlap_frac = 0.0
    if os.path.isfile(tilejson_abs):
        try:
            tj = json.loads(_read_text(tilejson_abs))
            ov = float(tj.get("overlap") or 0.0)
            if math.isfinite(ov) and 0.0 <= ov < 0.49:
                overlap_frac = ov
        except Exception:
            pass

    mx = _crop_margin_px(target_size[0], overlap_frac)
    my = _crop_margin_px(target_size[1], overlap_frac)
    cw = max(1, target_size[0] - 2 * mx)
    ch = max(1, target_size[1] - 2 * my)
    mosaic_w = cw * int(args.w)
    mosaic_h = ch * int(args.h)

    # Heatmap buffer (RGB).
    heat = Image.new("RGB", (mosaic_w, mosaic_h), (0, 0, 0))
    heat_px = heat.load()

    seam_scores = []
    worst = []

    # Preload selected images to arrays for speed.
    selected_rgb = {}
    for y in range(args.y0, args.y0 + args.h):
        for x in range(args.x0, args.x0 + args.w):
            p = _selected_path(x, y)
            if os.path.isfile(p):
                arr, _ = load_rgb(p, target_size=target_size)
                selected_rgb[(x, y)] = arr

    # Vertical seams.
    for y in range(args.y0, args.y0 + args.h):
        for x in range(args.x0, args.x0 + args.w - 1):
            a = selected_rgb.get((x, y))
            b = selected_rgb.get((x + 1, y))
            if a is None or b is None:
                continue
            wop = int(min(args.overlap_px, target_size[0]))
            a_strip = a[:, target_size[0] - wop : target_size[0], :]
            b_strip = b[:, 0:wop, :]
            s, _m = score_pair(a_strip, b_strip, weights=seam_weights_norm)
            worst.append({"type": "vertical", "coordA": {"x": x, "y": y}, "coordB": {"x": x + 1, "y": y}, "score": float(s)})
            seam_scores.append(float(s))

            per_row = seam_line_rgb_l1_per_row(a, b, overlap_px=args.overlap_px)
            per_row = per_row[my : target_size[1] - my] if per_row.shape[0] >= (my * 2 + 1) else per_row
            seam_x = (x - args.x0 + 1) * cw
            y0 = (y - args.y0) * ch
            for i, v in enumerate(per_row[:ch]):
                # Store raw intensity; normalize later.
                if seam_x - 1 >= 0:
                    heat_px[seam_x - 1, y0 + i] = (int(v * 255.0), 0, 0)
                if seam_x < mosaic_w:
                    heat_px[seam_x, y0 + i] = (int(v * 255.0), 0, 0)

    # Horizontal seams.
    for y in range(args.y0, args.y0 + args.h - 1):
        for x in range(args.x0, args.x0 + args.w):
            a = selected_rgb.get((x, y))
            b = selected_rgb.get((x, y + 1))
            if a is None or b is None:
                continue
            hop = int(min(args.overlap_px, target_size[1]))
            a_strip = a[target_size[1] - hop : target_size[1], :, :]
            b_strip = b[0:hop, :, :]
            s, _m = score_pair(a_strip, b_strip, weights=seam_weights_norm)
            worst.append({"type": "horizontal", "coordA": {"x": x, "y": y}, "coordB": {"x": x, "y": y + 1}, "score": float(s)})
            seam_scores.append(float(s))

            per_col = seam_line_rgb_l1_per_col(a, b, overlap_px=args.overlap_px)
            per_col = per_col[mx : target_size[0] - mx] if per_col.shape[0] >= (mx * 2 + 1) else per_col
            seam_y = (y - args.y0 + 1) * ch
            x0 = (x - args.x0) * cw
            for i, v in enumerate(per_col[:cw]):
                if seam_y - 1 >= 0:
                    heat_px[x0 + i, seam_y - 1] = (int(v * 255.0), 0, 0)
                if seam_y < mosaic_h:
                    heat_px[x0 + i, seam_y] = (int(v * 255.0), 0, 0)

    # Normalize heatmap pixels with simple remap over current red channel.
    # We stored raw values in 0..255*diff; treat max red as normalization.
    max_r = 0
    for y in range(mosaic_h):
        for x in range(mosaic_w):
            r, g, b = heat_px[x, y]
            if r > max_r:
                max_r = r
    if max_r <= 0:
        max_r = 1
    for y in range(mosaic_h):
        for x in range(mosaic_w):
            r, g, b = heat_px[x, y]
            if r <= 0:
                continue
            t = float(r) / float(max_r)
            heat_px[x, y] = _colormap_hot(t)

    worst = sorted(worst, key=lambda s: float(s.get("score") or 0.0), reverse=True)

    heatmap_abs = os.path.join(out_dir, "seam_heatmap_nb_pro.png")
    heat.save(heatmap_abs, "PNG")

    report = {
        "run_id": args.run_id,
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "tiles_dir": _relpath_if_under(run_root, tiles_dir),
        "out_dir": _relpath_if_under(run_root, out_dir),
        "config_hash": run_config_hash,
        "vertex": {
            "project": vertex_project,
            "location": vertex_location,
            "model": model,
            "fallback_model": fallback_model,
            "params_hash": params_hash,
            "generation_config": cfg,
        },
        "subgrid": {"x0": int(args.x0), "y0": int(args.y0), "w": int(args.w), "h": int(args.h)},
        "k": int(args.k),
        "overlap_px": int(args.overlap_px),
        "neighbor_mode": str(args.neighbor_mode),
        "anchors": anchors_info,
        "prompt_file": _relpath_if_under(run_root, args.prompt_file),
        "negative_prompt_file": _relpath_if_under(run_root, args.negative_prompt_file) if args.negative_prompt_file else None,
        "score_weights": seam_weights_norm,
        "structure": {
            "weight": float(structure_weight),
            "downscale_px": int(structure_downscale_px),
            "weights": structure_weights_norm,
        },
        "fallback_penalty": float(fallback_penalty),
        "tiles": tiles_report,
        "seams_summary": {
            "worst_seams": worst[:10],
            "seam_count": len(worst),
        },
        "artifacts": {
            "tiles_dir": _relpath_if_under(run_root, out_tiles_dir),
            "candidates_dir": _relpath_if_under(run_root, out_candidates_dir),
            "seam_heatmap": _relpath_if_under(run_root, heatmap_abs),
        },
        "duration_s": float(time.time() - t0),
    }

    report_abs = os.path.join(out_dir, "report_nb_pro.json")
    with open(report_abs, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(
        json.dumps(
            {
                "ok": True,
                "tiles_selected": len([t for t in tiles_report if t.get("selected") and t["selected"].get("path")]),
                "report_json": _relpath_if_under(run_root, report_abs),
                "seam_heatmap_png": _relpath_if_under(run_root, heatmap_abs),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    main()
