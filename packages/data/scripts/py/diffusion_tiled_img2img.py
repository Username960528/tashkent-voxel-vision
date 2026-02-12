import argparse
import json
import math
import os
import sys
import time

import numpy as np
from PIL import Image


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def _pick_device(requested, torch):
    req = (requested or "").strip().lower()
    if req in ("auto", ""):
        if torch.cuda.is_available():
            return "cuda"
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"
    if req in ("cuda", "cpu", "mps"):
        return req
    raise ValueError(f"unsupported --device: {requested}")


def _pick_dtype(device, torch):
    if device == "cuda":
        return torch.float16
    return torch.float32


def _to_multiple_of_8(img):
    w, h = img.size
    w2 = max(8, (w // 8) * 8)
    h2 = max(8, (h // 8) * 8)
    if (w2, h2) == (w, h):
        return img, (w, h), (w, h)
    resized = img.resize((w2, h2), resample=Image.Resampling.LANCZOS)
    return resized, (w, h), (w2, h2)


def _crop_margin_px(size_px, overlap):
    if overlap <= 0.0:
        return 0
    frac = float(overlap) / (1.0 + 2.0 * float(overlap))
    return int(round(size_px * frac))


def _find_index_sets(in_dir):
    z0 = os.path.join(in_dir, "0")
    if not os.path.isdir(z0):
        raise ValueError(f"missing tiles dir: {z0} (expected 0/x/y.png)")

    x_vals = []
    for name in os.listdir(z0):
        p = os.path.join(z0, name)
        if os.path.isdir(p) and name.isdigit():
            x_vals.append(int(name))
    if not x_vals:
        raise ValueError(f"no x dirs found under: {z0}")
    x_vals = sorted(set(x_vals))

    y_vals = set()
    for x in x_vals:
        xdir = os.path.join(z0, str(x))
        for fn in os.listdir(xdir):
            if fn.lower().endswith(".png"):
                base = fn[:-4]
                if base.isdigit():
                    y_vals.add(int(base))
    if not y_vals:
        raise ValueError(f"no y pngs found under: {z0}/<x>/")
    return x_vals, sorted(y_vals)


def _safe_open_tile(tile_path, target_size, mode):
    tile = Image.open(tile_path)
    if tile.size != target_size:
        tile = tile.resize(target_size, resample=Image.Resampling.NEAREST)
    if tile.mode != mode:
        tile = tile.convert(mode)
    return tile


def _window_starts(total, win, overlap):
    win = int(max(64, win))
    if total <= win:
        return [0]
    stride = int(max(1, win - overlap))
    starts = list(range(0, total - win + 1, stride))
    last = total - win
    if not starts or starts[-1] != last:
        starts.append(last)
    return starts


def _weight_axis(length, fade_left, fade_right):
    w = np.ones((length,), dtype=np.float32)
    fl = int(max(0, min(fade_left, length // 2)))
    fr = int(max(0, min(fade_right, length // 2)))
    if fl > 0:
        ramp = np.linspace(0.0, 1.0, fl, endpoint=False, dtype=np.float32)
        w[:fl] *= ramp
    if fr > 0:
        ramp = np.linspace(1.0, 0.0, fr, endpoint=False, dtype=np.float32)
        w[length - fr :] *= ramp
    return w


def _window_weight(width, height, fade_px, has_left, has_right, has_top, has_bottom):
    fade_x = int(max(0, min(fade_px, width // 2)))
    fade_y = int(max(0, min(fade_px, height // 2)))
    wx = _weight_axis(width, fade_x if has_left else 0, fade_x if has_right else 0)
    wy = _weight_axis(height, fade_y if has_top else 0, fade_y if has_bottom else 0)
    return wy[:, None] * wx[None, :]


def _radial_mask(width, height):
    if width <= 0 or height <= 0:
        return None
    cx = (float(width) - 1.0) * 0.5
    cy = (float(height) - 1.0) * 0.5
    r = max(1.0, 0.5 * float(min(width, height)))
    inv_r = 1.0 / r
    arr = np.zeros((height, width), dtype=np.uint8)
    for y in range(height):
        dy = float(y) - cy
        for x in range(width):
            dx = float(x) - cx
            t = max(0.0, 1.0 - math.hypot(dx, dy) * inv_r)
            arr[y, x] = int(round(255.0 * t * t))
    return Image.fromarray(arr, mode="L")


def _make_generator(torch, device, seed):
    try:
        return torch.Generator(device=device).manual_seed(int(seed))
    except Exception:
        return torch.manual_seed(int(seed))


def _run_patch(pipe, patch, *, prompt, negative, strength, steps, guidance, generator, cross_attention_kwargs):
    patch8, orig_size, _resized_size = _to_multiple_of_8(patch)
    call_kwargs = dict(
        prompt=prompt,
        negative_prompt=negative,
        image=patch8,
        strength=float(strength),
        num_inference_steps=int(steps),
        guidance_scale=float(guidance),
        generator=generator,
    )
    if cross_attention_kwargs is not None:
        call_kwargs["cross_attention_kwargs"] = cross_attention_kwargs
    try:
        out = pipe(**call_kwargs).images[0]
    except TypeError:
        call_kwargs.pop("cross_attention_kwargs", None)
        out = pipe(**call_kwargs).images[0]
    if out.size != orig_size:
        out = out.resize(orig_size, resample=Image.Resampling.LANCZOS)
    return out


def _build_cropped_mosaic(in_dir, x_vals, y_vals, w, h, mx, my):
    cw = max(1, w - 2 * mx)
    ch = max(1, h - 2 * my)
    canvas = Image.new("RGB", (cw * len(x_vals), ch * len(y_vals)), "#ffffff")

    missing = 0
    copied = 0
    for iy, y in enumerate(y_vals):
        for ix, x in enumerate(x_vals):
            tile_path = os.path.join(in_dir, "0", str(x), f"{y}.png")
            if not os.path.exists(tile_path):
                missing += 1
                continue
            tile = _safe_open_tile(tile_path, (w, h), "RGB")
            if mx > 0 or my > 0:
                crop = tile.crop((mx, my, w - mx, h - my))
            else:
                crop = tile
            canvas.paste(crop, (ix * cw, iy * ch))
            copied += 1
    return canvas, copied, missing, cw, ch


def _write_back_tiles(in_dir, out_dir, mosaic_out, x_vals, y_vals, w, h, mx, my, cw, ch):
    written = 0
    missing = 0
    for iy, y in enumerate(y_vals):
        for ix, x in enumerate(x_vals):
            in_tile = os.path.join(in_dir, "0", str(x), f"{y}.png")
            if not os.path.exists(in_tile):
                missing += 1
                continue
            out_tile = os.path.join(out_dir, "0", str(x), f"{y}.png")
            _ensure_dir(os.path.dirname(os.path.abspath(out_tile)))

            tile = _safe_open_tile(in_tile, (w, h), "RGB")
            patch = mosaic_out.crop((ix * cw, iy * ch, (ix + 1) * cw, (iy + 1) * ch))
            tile.paste(patch, (mx, my))
            tile.save(out_tile, "PNG")
            written += 1
    return written, missing


def main():
    ap = argparse.ArgumentParser(description="Global tiled diffusion pass for tile layers with intersection conditioning.")
    ap.add_argument("--in_dir", required=True, help="Input tiles dir (expects 0/x/y.png)")
    ap.add_argument("--out_dir", required=True, help="Output tiles dir (writes 0/x/y.png)")
    ap.add_argument("--report_json", default="", help="Optional report JSON output")
    ap.add_argument("--debug_mosaic_in_png", default="", help="Optional input mosaic preview output")
    ap.add_argument("--debug_mosaic_out_png", default="", help="Optional output mosaic preview output")

    ap.add_argument("--model", required=True, help="Diffusers model id or local path")
    ap.add_argument("--lora", default="", help="Optional LoRA weights (HF repo id or local path)")
    ap.add_argument("--lora_scale", type=float, default=0.8, help="LoRA scale (default: 0.8)")
    ap.add_argument(
        "--prompt",
        default="isometric pixel art city, crisp pixels, game art, clean outlines, detailed buildings, high quality",
        help="Positive prompt",
    )
    ap.add_argument(
        "--negative",
        default="blurry, low quality, artifacts, watermark, text, logo, deformed, noisy",
        help="Negative prompt",
    )
    ap.add_argument("--strength", type=float, default=0.08, help="Global tiled img2img strength (default: 0.08)")
    ap.add_argument("--steps", type=int, default=12, help="Global tiled inference steps (default: 12)")
    ap.add_argument("--guidance", type=float, default=4.2, help="Global tiled CFG guidance (default: 4.2)")
    ap.add_argument("--seed", type=int, default=0, help="Seed base (default: 0; -1=random base)")
    ap.add_argument("--device", default="auto", help="auto|cuda|mps|cpu")

    ap.add_argument("--overlap", type=float, default=0.0, help="Tile overlap fraction from tilejson (default: 0)")
    ap.add_argument("--tile_px", type=int, default=1024, help="Window size for global tiled pass (default: 1024)")
    ap.add_argument("--tile_overlap_px", type=int, default=256, help="Window overlap for global tiled pass (default: 256)")
    ap.add_argument("--tile_feather_px", type=int, default=128, help="Window feather blend width (default: 128)")

    ap.add_argument(
        "--intersection_pass",
        type=int,
        default=1,
        help="Run extra intersection-conditioned pass on seam crossings (default: 1)",
    )
    ap.add_argument("--intersection_half", type=int, default=120, help="Intersection patch half-size (default: 120)")
    ap.add_argument(
        "--intersection_boost",
        type=float,
        default=0.08,
        help="Additional strength for intersection pass (default: 0.08)",
    )
    ap.add_argument(
        "--intersection_steps",
        type=int,
        default=0,
        help="Intersection pass steps (default: 0 -> max(global steps, 14))",
    )
    ap.add_argument("--max_intersections", type=int, default=0, help="Optional cap on processed intersections (0=all)")
    args = ap.parse_args()

    if not os.path.isdir(args.in_dir):
        raise SystemExit(f"missing input dir: {args.in_dir}")
    _ensure_dir(os.path.abspath(args.out_dir))

    if not (math.isfinite(args.overlap) and 0.0 <= args.overlap < 0.49):
        raise SystemExit("--overlap must be in [0, 0.49)")
    if not (math.isfinite(args.strength) and 0.0 < args.strength <= 1.0):
        raise SystemExit("--strength must be in (0, 1]")
    if args.steps <= 0:
        raise SystemExit("--steps must be > 0")
    if not (math.isfinite(args.guidance) and args.guidance >= 0.0):
        raise SystemExit("--guidance must be >= 0")
    if not (math.isfinite(args.lora_scale) and 0.0 <= args.lora_scale <= 2.0):
        raise SystemExit("--lora_scale must be in [0, 2]")
    if args.tile_px < 64:
        raise SystemExit("--tile_px must be >= 64")
    if args.tile_overlap_px < 0:
        raise SystemExit("--tile_overlap_px must be >= 0")
    if args.tile_overlap_px >= args.tile_px:
        raise SystemExit("--tile_overlap_px must be < --tile_px")
    if args.tile_feather_px < 0:
        raise SystemExit("--tile_feather_px must be >= 0")
    if args.intersection_pass not in (0, 1):
        raise SystemExit("--intersection_pass must be 0 or 1")
    if args.intersection_half <= 0:
        raise SystemExit("--intersection_half must be > 0")
    if not (math.isfinite(args.intersection_boost) and args.intersection_boost >= 0.0):
        raise SystemExit("--intersection_boost must be >= 0")
    if args.intersection_steps < 0:
        raise SystemExit("--intersection_steps must be >= 0")
    if args.max_intersections < 0:
        raise SystemExit("--max_intersections must be >= 0")

    if os.environ.get("HUGGINGFACE_HUB_TOKEN") and not os.environ.get("HF_TOKEN"):
        os.environ["HF_TOKEN"] = os.environ["HUGGINGFACE_HUB_TOKEN"]
    try:
        import hf_transfer  # noqa: F401

        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    except Exception:
        pass

    try:
        import torch  # noqa: F401
        from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline  # noqa: F401
    except Exception as e:
        msg = str(e)
        raise SystemExit(
            "Missing diffusion dependencies. Install the optional venv:\n"
            "  python3 -m venv packages/data/.venv-diffusion\n"
            "  packages/data/.venv-diffusion/bin/pip install -r packages/data/scripts/py/requirements-diffusion.txt\n"
            f"\nImport error: {msg}"
        )

    import torch
    from diffusers import StableDiffusionImg2ImgPipeline, StableDiffusionXLImg2ImgPipeline

    device = _pick_device(args.device, torch)
    dtype = _pick_dtype(device, torch)

    from_pretrained_kwargs = {"torch_dtype": dtype, "use_safetensors": True}
    if dtype == torch.float16:
        from_pretrained_kwargs["variant"] = "fp16"

    pipe = None
    pipe_kind = None
    errors = []
    for kind, cls in (
        ("sdxl_img2img", StableDiffusionXLImg2ImgPipeline),
        ("sd_img2img", StableDiffusionImg2ImgPipeline),
    ):
        try:
            try:
                pipe = cls.from_pretrained(args.model, **from_pretrained_kwargs)
            except Exception as e:
                if from_pretrained_kwargs.get("variant"):
                    kwargs2 = dict(from_pretrained_kwargs)
                    kwargs2.pop("variant", None)
                    pipe = cls.from_pretrained(args.model, **kwargs2)
                else:
                    raise e
            pipe_kind = kind
            break
        except Exception as e:
            errors.append(f"{kind}: {e}")
            pipe = None
            pipe_kind = None
    if pipe is None:
        joined = "\n".join(errors) if errors else "(no details)"
        raise SystemExit(f"Failed to load img2img pipeline for model '{args.model}':\n{joined}")

    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass

    lora = (args.lora or "").strip()
    lora_scale = float(args.lora_scale)
    cross_attention_kwargs = None
    if lora:
        try:
            pipe.load_lora_weights(lora)
            cross_attention_kwargs = {"scale": lora_scale}
        except Exception as e:
            raise SystemExit(f"Failed to load LoRA weights '{lora}': {e}")

    pipe = pipe.to(device)

    seed_base = int(args.seed)
    if seed_base == -1:
        seed_base = int.from_bytes(os.urandom(2), "big")

    t0 = time.time()

    x_vals, y_vals = _find_index_sets(args.in_dir)
    grid_x = len(x_vals)
    grid_y = len(y_vals)

    first_tile = None
    for y in y_vals:
        for x in x_vals:
            candidate = os.path.join(args.in_dir, "0", str(x), f"{y}.png")
            if os.path.exists(candidate):
                first_tile = candidate
                break
        if first_tile:
            break
    if not first_tile:
        raise SystemExit(f"no readable tiles under: {args.in_dir}/0/<x>/<y>.png")

    img0 = Image.open(first_tile).convert("RGB")
    w, h = img0.size
    if w <= 0 or h <= 0:
        raise SystemExit("invalid tile image size")

    mx = _crop_margin_px(w, args.overlap)
    my = _crop_margin_px(h, args.overlap)

    mosaic_in, copied_tiles, missing_tiles, cw, ch = _build_cropped_mosaic(args.in_dir, x_vals, y_vals, w, h, mx, my)
    if copied_tiles <= 0:
        raise SystemExit("no tiles copied into global mosaic")

    if args.debug_mosaic_in_png:
        _ensure_dir(os.path.dirname(os.path.abspath(args.debug_mosaic_in_png)))
        mosaic_in.save(args.debug_mosaic_in_png, "PNG")

    mw, mh = mosaic_in.size
    x_starts = _window_starts(mw, int(args.tile_px), int(args.tile_overlap_px))
    y_starts = _window_starts(mh, int(args.tile_px), int(args.tile_overlap_px))

    base_arr = np.asarray(mosaic_in, dtype=np.float32)
    accum = np.zeros_like(base_arr, dtype=np.float32)
    wsum = np.zeros((mh, mw, 1), dtype=np.float32)

    global_windows_total = int(len(x_starts) * len(y_starts))
    global_windows_processed = 0
    global_windows_skipped = 0

    win_idx = 0
    for y0 in y_starts:
        for x0 in x_starts:
            x1 = min(mw, x0 + int(args.tile_px))
            y1 = min(mh, y0 + int(args.tile_px))
            if x1 <= x0 or y1 <= y0:
                global_windows_skipped += 1
                continue

            patch = mosaic_in.crop((x0, y0, x1, y1))
            generator = _make_generator(torch, device, seed_base + win_idx)
            out_patch = _run_patch(
                pipe,
                patch,
                prompt=args.prompt,
                negative=args.negative,
                strength=float(args.strength),
                steps=int(args.steps),
                guidance=float(args.guidance),
                generator=generator,
                cross_attention_kwargs=cross_attention_kwargs,
            )

            has_left = x0 > 0
            has_right = x1 < mw
            has_top = y0 > 0
            has_bottom = y1 < mh
            weight = _window_weight(
                width=x1 - x0,
                height=y1 - y0,
                fade_px=int(args.tile_feather_px),
                has_left=has_left,
                has_right=has_right,
                has_top=has_top,
                has_bottom=has_bottom,
            )

            out_arr = np.asarray(out_patch, dtype=np.float32)
            w3 = weight[:, :, None]
            accum[y0:y1, x0:x1, :] += out_arr * w3
            wsum[y0:y1, x0:x1, :] += w3

            global_windows_processed += 1
            win_idx += 1

    out_arr = np.array(base_arr, copy=True)
    covered = wsum[:, :, 0] > 1e-6
    out_arr[covered] = accum[covered] / wsum[:, :, :][covered]
    mosaic_out = Image.fromarray(np.clip(out_arr, 0, 255).astype(np.uint8), mode="RGB")

    seam_x_vals = [i * cw for i in range(1, grid_x)]
    seam_y_vals = [i * ch for i in range(1, grid_y)]
    intersections_total = int(len(seam_x_vals) * len(seam_y_vals))
    intersections_processed = 0
    intersections_skipped = 0
    run_intersection_pass = bool(int(args.intersection_pass))

    if run_intersection_pass and intersections_total > 0:
        centers = [(sx, sy) for sy in seam_y_vals for sx in seam_x_vals]
        if args.max_intersections and args.max_intersections > 0:
            centers = centers[: int(args.max_intersections)]

        i_steps = int(args.intersection_steps) if int(args.intersection_steps) > 0 else int(max(args.steps, 14))
        i_strength = float(min(1.0, max(0.01, float(args.strength) + float(args.intersection_boost))))

        for idx, (cx, cy) in enumerate(centers):
            half = int(max(8, args.intersection_half))
            x0 = max(0, int(cx - half))
            y0 = max(0, int(cy - half))
            x1 = min(mw, int(cx + half))
            y1 = min(mh, int(cy + half))
            pw = int(x1 - x0)
            ph = int(y1 - y0)
            if pw < 16 or ph < 16:
                intersections_skipped += 1
                continue

            patch = mosaic_out.crop((x0, y0, x1, y1))
            generator = _make_generator(torch, device, seed_base + 100000 + idx)
            out_patch = _run_patch(
                pipe,
                patch,
                prompt=args.prompt,
                negative=args.negative,
                strength=i_strength,
                steps=i_steps,
                guidance=float(args.guidance),
                generator=generator,
                cross_attention_kwargs=cross_attention_kwargs,
            )

            mask = _radial_mask(pw, ph)
            if mask is None:
                intersections_skipped += 1
                continue
            blended = Image.composite(out_patch, patch, mask)
            mosaic_out.paste(blended, (x0, y0))
            intersections_processed += 1

    if args.debug_mosaic_out_png:
        _ensure_dir(os.path.dirname(os.path.abspath(args.debug_mosaic_out_png)))
        mosaic_out.save(args.debug_mosaic_out_png, "PNG")

    tile_count_written, tile_count_missing_out = _write_back_tiles(
        in_dir=args.in_dir,
        out_dir=args.out_dir,
        mosaic_out=mosaic_out,
        x_vals=x_vals,
        y_vals=y_vals,
        w=w,
        h=h,
        mx=mx,
        my=my,
        cw=cw,
        ch=ch,
    )

    dt = time.time() - t0
    report = {
        "in_dir": os.path.abspath(args.in_dir),
        "out_dir": os.path.abspath(args.out_dir),
        "model": args.model,
        "pipeline": pipe_kind,
        "lora": lora if lora else None,
        "lora_scale": lora_scale if lora else None,
        "prompt": args.prompt,
        "negative": args.negative,
        "strength": float(args.strength),
        "steps": int(args.steps),
        "guidance": float(args.guidance),
        "seed_base": int(seed_base),
        "device": device,
        "dtype": "float16" if dtype == torch.float16 else "float32",
        "grid_xy": {"x": int(grid_x), "y": int(grid_y)},
        "x_values": [int(v) for v in x_vals],
        "y_values": [int(v) for v in y_vals],
        "tile_size": {"w": int(w), "h": int(h)},
        "overlap": float(args.overlap),
        "crop_margin_px": {"x": int(mx), "y": int(my)},
        "cropped_tile_size": {"w": int(cw), "h": int(ch)},
        "mosaic_size": {"w": int(mw), "h": int(mh)},
        "tile_count_expected": int(grid_x * grid_y),
        "tile_count_found": int(copied_tiles),
        "tile_count_missing_in": int(missing_tiles),
        "tile_count_written": int(tile_count_written),
        "tile_count_missing_out": int(tile_count_missing_out),
        "global_tile_px": int(args.tile_px),
        "global_tile_overlap_px": int(args.tile_overlap_px),
        "global_tile_feather_px": int(args.tile_feather_px),
        "global_windows_total": int(global_windows_total),
        "global_windows_processed": int(global_windows_processed),
        "global_windows_skipped": int(global_windows_skipped),
        "intersections_total": int(intersections_total),
        "intersections_processed": int(intersections_processed),
        "intersections_skipped": int(intersections_skipped),
        "intersection_pass_executed": bool(run_intersection_pass),
        "intersection_half": int(args.intersection_half),
        "intersection_boost": float(args.intersection_boost),
        "intersection_steps": int(args.intersection_steps),
        "duration_s": float(dt),
    }

    if args.debug_mosaic_in_png:
        report["debug_mosaic_in_png"] = os.path.abspath(args.debug_mosaic_in_png)
    if args.debug_mosaic_out_png:
        report["debug_mosaic_out_png"] = os.path.abspath(args.debug_mosaic_out_png)

    if args.report_json:
        _ensure_dir(os.path.dirname(os.path.abspath(args.report_json)))
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(
        json.dumps(
            {
                "ok": True,
                "tile_count_written": int(tile_count_written),
                "global_windows_processed": int(global_windows_processed),
                "intersections_processed": int(intersections_processed),
                "duration_s": float(dt),
            },
            separators=(",", ":"),
        )
    )


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
