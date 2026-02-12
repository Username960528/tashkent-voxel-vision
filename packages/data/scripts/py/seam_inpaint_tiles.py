import argparse
import json
import math
import os
import shutil
import sys
import time

from PIL import Image
from PIL import ImageDraw


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


def _to_multiple_of_8(image, is_mask=False):
    w, h = image.size
    w2 = max(8, (w // 8) * 8)
    h2 = max(8, (h // 8) * 8)
    if (w2, h2) == (w, h):
        return image, (w, h), (w, h)
    if is_mask:
        resized = image.resize((w2, h2), resample=Image.Resampling.NEAREST)
    else:
        resized = image.resize((w2, h2), resample=Image.Resampling.LANCZOS)
    return resized, (w, h), (w2, h2)


def _crop_margin_px(size_px, overlap):
    if overlap <= 0.0:
        return 0
    frac = float(overlap) / (1.0 + 2.0 * float(overlap))
    return int(round(size_px * frac))


def _copy_png_tree(in_dir, out_dir):
    copied = 0
    for root, _, files in os.walk(in_dir):
        rel = os.path.relpath(root, in_dir)
        rel = "" if rel == "." else rel
        dst_root = os.path.join(out_dir, rel)
        _ensure_dir(dst_root)
        for fn in files:
            if not fn.lower().endswith(".png"):
                continue
            src = os.path.join(root, fn)
            dst = os.path.join(dst_root, fn)
            shutil.copy2(src, dst)
            copied += 1
    return copied


def _find_index_sets(tile_layer_dir):
    z0 = os.path.join(tile_layer_dir, "0")
    if not os.path.isdir(z0):
        raise ValueError(f"missing tiles dir: {z0} (expected 0/x/y.png)")

    x_vals = []
    y_vals = set()
    for xname in os.listdir(z0):
        xdir = os.path.join(z0, xname)
        if not (os.path.isdir(xdir) and xname.isdigit()):
            continue
        x_vals.append(int(xname))
        for fn in os.listdir(xdir):
            if not fn.lower().endswith(".png"):
                continue
            yname = fn[:-4]
            if yname.isdigit():
                y_vals.add(int(yname))

    if not x_vals or not y_vals:
        raise ValueError(f"no tile coords found under: {z0}")

    return sorted(set(x_vals)), sorted(y_vals)


def _tile_path(layer_dir, x, y):
    return os.path.join(layer_dir, "0", str(x), f"{y}.png")


def _run_inpaint(
    pipe,
    torch,
    patch,
    mask,
    prompt,
    negative,
    strength,
    steps,
    guidance,
    seed,
    device,
    cross_attention_kwargs,
):
    patch8, orig_size, _ = _to_multiple_of_8(patch, is_mask=False)
    mask8, _, _ = _to_multiple_of_8(mask, is_mask=True)

    try:
        generator = torch.Generator(device=device).manual_seed(int(seed))
    except Exception:
        generator = torch.manual_seed(int(seed))

    kwargs = dict(
        prompt=prompt,
        negative_prompt=negative,
        image=patch8,
        mask_image=mask8,
        strength=float(strength),
        num_inference_steps=int(steps),
        guidance_scale=float(guidance),
        generator=generator,
    )
    if cross_attention_kwargs is not None:
        kwargs["cross_attention_kwargs"] = cross_attention_kwargs

    try:
        out = pipe(**kwargs).images[0]
    except TypeError:
        kwargs.pop("cross_attention_kwargs", None)
        out = pipe(**kwargs).images[0]

    if out.size != orig_size:
        out = out.resize(orig_size, resample=Image.Resampling.LANCZOS)
    return out.convert("RGB")


def _ramp_values(length, start, end):
    if length <= 0:
        return []
    if length == 1:
        return [int(round(end))]
    vals = []
    for i in range(length):
        t = float(i) / float(length - 1)
        vals.append(int(round(float(start) + (float(end) - float(start)) * t)))
    return vals


def _blend_paste_x(tile_img, strip, x, y, alpha_start, alpha_end):
    sw, sh = strip.size
    if sw <= 0 or sh <= 0:
        return
    base = tile_img.crop((x, y, x + sw, y + sh))
    if sw == 1:
        tile_img.paste(strip, (x, y))
        return
    row = Image.new("L", (sw, 1))
    row.putdata(_ramp_values(sw, alpha_start, alpha_end))
    mask = row.resize((sw, sh), resample=Image.Resampling.NEAREST)
    blended = Image.composite(strip, base, mask)
    tile_img.paste(blended, (x, y))


def _blend_paste_y(tile_img, strip, x, y, alpha_start, alpha_end):
    sw, sh = strip.size
    if sw <= 0 or sh <= 0:
        return
    base = tile_img.crop((x, y, x + sw, y + sh))
    if sh == 1:
        tile_img.paste(strip, (x, y))
        return
    col = Image.new("L", (1, sh))
    col.putdata(_ramp_values(sh, alpha_start, alpha_end))
    mask = col.resize((sw, sh), resample=Image.Resampling.NEAREST)
    blended = Image.composite(strip, base, mask)
    tile_img.paste(blended, (x, y))


def _harmonize_vertical_columns(left, right, seam_left_x, seam_right_x, top, bottom, half):
    if half <= 0 or bottom <= top:
        return
    for d in range(int(half)):
        lx = int(seam_left_x - d)
        rx = int(seam_right_x + d)
        if lx < 0 or rx < 0:
            break
        lcol = left.crop((lx, top, lx + 1, bottom))
        rcol = right.crop((rx, top, rx + 1, bottom))
        avg = Image.blend(lcol, rcol, 0.5)
        if int(half) <= 1:
            t = 1.0
        else:
            t = 1.0 - float(d) / float(int(half) - 1)
        left.paste(Image.blend(lcol, avg, t), (lx, top))
        right.paste(Image.blend(rcol, avg, t), (rx, top))


def _harmonize_horizontal_rows(top_img, bottom_img, seam_top_y, seam_bottom_y, left, right, half):
    if half <= 0 or right <= left:
        return
    for d in range(int(half)):
        ty = int(seam_top_y - d)
        by = int(seam_bottom_y + d)
        if ty < 0 or by < 0:
            break
        trow = top_img.crop((left, ty, right, ty + 1))
        brow = bottom_img.crop((left, by, right, by + 1))
        avg = Image.blend(trow, brow, 0.5)
        if int(half) <= 1:
            t = 1.0
        else:
            t = 1.0 - float(d) / float(int(half) - 1)
        top_img.paste(Image.blend(trow, avg, t), (left, ty))
        bottom_img.paste(Image.blend(brow, avg, t), (left, by))


def _process_vertical(
    *,
    layer_dir,
    x_left,
    x_right,
    y,
    w,
    h,
    mx,
    my,
    seam_context,
    mask_half,
    write_half,
    harmonize_half,
    run_inpaint,
):
    left_path = _tile_path(layer_dir, x_left, y)
    right_path = _tile_path(layer_dir, x_right, y)
    if not (os.path.exists(left_path) and os.path.exists(right_path)):
        return False, "missing_tiles"

    top = my
    bottom = h - my
    if bottom <= top:
        return False, "invalid_core"

    lc0 = max(0, w - mx - seam_context)
    lc1 = min(w, w - mx + seam_context)
    rc0 = max(0, mx - seam_context)
    rc1 = min(w, mx + seam_context)
    if lc1 <= lc0 or rc1 <= rc0:
        return False, "invalid_context"

    left = Image.open(left_path).convert("RGB")
    right = Image.open(right_path).convert("RGB")

    lseg = left.crop((lc0, top, lc1, bottom))
    rseg = right.crop((rc0, top, rc1, bottom))
    if lseg.height <= 0 or rseg.height <= 0:
        return False, "empty_patch"

    patch_w = lseg.width + rseg.width
    patch_h = lseg.height
    split = lseg.width
    half_limit = min(split, patch_w - split) - 1
    if half_limit <= 0:
        return False, "tiny_patch"
    mhalf = max(1, min(mask_half, half_limit))
    whalf = max(1, min(write_half, half_limit))

    patch = Image.new("RGB", (patch_w, patch_h), "#808080")
    patch.paste(lseg, (0, 0))
    patch.paste(rseg, (split, 0))

    mask = Image.new("L", patch.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((split - mhalf, 0, split + mhalf, patch_h), fill=255)

    out = run_inpaint(patch, mask)

    left_strip = out.crop((split - whalf, 0, split, patch_h))
    right_strip = out.crop((split, 0, split + whalf, patch_h))

    # Feather write-back from old tile content to inpainted seam strip to avoid
    # visible "write band" edges at strip boundaries.
    _blend_paste_x(
        tile_img=left,
        strip=left_strip,
        x=w - mx - whalf,
        y=top,
        alpha_start=0,
        alpha_end=255,
    )
    _blend_paste_x(
        tile_img=right,
        strip=right_strip,
        x=mx,
        y=top,
        alpha_start=255,
        alpha_end=0,
    )
    hhalf = max(0, min(int(harmonize_half), int(whalf)))
    _harmonize_vertical_columns(
        left=left,
        right=right,
        seam_left_x=int(w - mx - 1),
        seam_right_x=int(mx),
        top=int(top),
        bottom=int(bottom),
        half=hhalf,
    )
    left.save(left_path, "PNG")
    right.save(right_path, "PNG")
    return True, "ok"


def _process_horizontal(
    *,
    layer_dir,
    x,
    y_top,
    y_bottom,
    w,
    h,
    mx,
    my,
    seam_context,
    mask_half,
    write_half,
    harmonize_half,
    run_inpaint,
):
    top_path = _tile_path(layer_dir, x, y_top)
    bottom_path = _tile_path(layer_dir, x, y_bottom)
    if not (os.path.exists(top_path) and os.path.exists(bottom_path)):
        return False, "missing_tiles"

    left = mx
    right = w - mx
    if right <= left:
        return False, "invalid_core"

    tc0 = max(0, h - my - seam_context)
    tc1 = min(h, h - my + seam_context)
    bc0 = max(0, my - seam_context)
    bc1 = min(h, my + seam_context)
    if tc1 <= tc0 or bc1 <= bc0:
        return False, "invalid_context"

    top_img = Image.open(top_path).convert("RGB")
    bottom_img = Image.open(bottom_path).convert("RGB")

    tseg = top_img.crop((left, tc0, right, tc1))
    bseg = bottom_img.crop((left, bc0, right, bc1))
    if tseg.width <= 0 or bseg.width <= 0:
        return False, "empty_patch"

    patch_w = tseg.width
    patch_h = tseg.height + bseg.height
    split = tseg.height
    half_limit = min(split, patch_h - split) - 1
    if half_limit <= 0:
        return False, "tiny_patch"
    mhalf = max(1, min(mask_half, half_limit))
    whalf = max(1, min(write_half, half_limit))

    patch = Image.new("RGB", (patch_w, patch_h), "#808080")
    patch.paste(tseg, (0, 0))
    patch.paste(bseg, (0, split))

    mask = Image.new("L", patch.size, 0)
    draw = ImageDraw.Draw(mask)
    draw.rectangle((0, split - mhalf, patch_w, split + mhalf), fill=255)

    out = run_inpaint(patch, mask)

    top_strip = out.crop((0, split - whalf, patch_w, split))
    bottom_strip = out.crop((0, split, patch_w, split + whalf))

    _blend_paste_y(
        tile_img=top_img,
        strip=top_strip,
        x=left,
        y=h - my - whalf,
        alpha_start=0,
        alpha_end=255,
    )
    _blend_paste_y(
        tile_img=bottom_img,
        strip=bottom_strip,
        x=left,
        y=my,
        alpha_start=255,
        alpha_end=0,
    )
    hhalf = max(0, min(int(harmonize_half), int(whalf)))
    _harmonize_horizontal_rows(
        top_img=top_img,
        bottom_img=bottom_img,
        seam_top_y=int(h - my - 1),
        seam_bottom_y=int(my),
        left=int(left),
        right=int(right),
        half=hhalf,
    )
    top_img.save(top_path, "PNG")
    bottom_img.save(bottom_path, "PNG")
    return True, "ok"


def main():
    ap = argparse.ArgumentParser(description="Seam inpaint between adjacent iso tiles (0/x/y.png).")
    ap.add_argument("--in_dir", required=True, help="Input tile layer dir (expects 0/x/y.png)")
    ap.add_argument("--out_dir", required=True, help="Output tile layer dir (same layout as input)")
    ap.add_argument("--report_json", default="", help="Optional report JSON")
    ap.add_argument("--model", required=True, help="Diffusers model id/path for inpaint pipeline")
    ap.add_argument("--lora", default="", help="Optional LoRA id/path")
    ap.add_argument("--lora_scale", type=float, default=0.8, help="LoRA scale (default: 0.8)")
    ap.add_argument("--prompt", default="isometric pixel art city, crisp pixels, clean edges, game art", help="Prompt")
    ap.add_argument("--negative", default="blurry, low quality, artifacts, watermark, text, logo", help="Negative")
    ap.add_argument("--strength", type=float, default=0.2, help="Inpaint denoise strength (default: 0.2)")
    ap.add_argument("--steps", type=int, default=16, help="Inference steps (default: 16)")
    ap.add_argument("--guidance", type=float, default=4.5, help="CFG guidance (default: 4.5)")
    ap.add_argument("--overlap", type=float, default=0.0, help="Tile overlap fraction from tilejson (default: 0)")
    ap.add_argument("--seam_context", type=int, default=0, help="Context px on each side around seam (0=auto)")
    ap.add_argument("--mask_half", type=int, default=16, help="Inpaint mask half-width in px")
    ap.add_argument("--write_half", type=int, default=20, help="Writeback half-width into each tile in px")
    ap.add_argument(
        "--harmonize_half",
        type=int,
        default=12,
        help="Symmetric cross-tile blend half-width after writeback (default: 12, 0=disable)",
    )
    ap.add_argument("--max_seams", type=int, default=0, help="Optional seam cap (0=all)")
    ap.add_argument("--seed", type=int, default=0, help="Seed base; -1=random")
    ap.add_argument("--device", default="auto", help="auto|cuda|mps|cpu")
    args = ap.parse_args()

    if not os.path.isdir(args.in_dir):
        raise SystemExit(f"missing --in_dir: {args.in_dir}")
    if not (math.isfinite(args.overlap) and 0.0 <= args.overlap < 0.49):
        raise SystemExit("--overlap must be in [0, 0.49)")
    if not (math.isfinite(args.strength) and 0.0 < args.strength <= 1.0):
        raise SystemExit("--strength must be in (0, 1]")
    if args.steps <= 0:
        raise SystemExit("--steps must be > 0")
    if args.mask_half <= 0:
        raise SystemExit("--mask_half must be > 0")
    if args.write_half <= 0:
        raise SystemExit("--write_half must be > 0")
    if args.seam_context < 0:
        raise SystemExit("--seam_context must be >= 0")
    if args.harmonize_half < 0:
        raise SystemExit("--harmonize_half must be >= 0")
    if args.max_seams < 0:
        raise SystemExit("--max_seams must be >= 0")

    # HuggingFace Hub token aliases.
    if os.environ.get("HUGGINGFACE_HUB_TOKEN") and not os.environ.get("HF_TOKEN"):
        os.environ["HF_TOKEN"] = os.environ["HUGGINGFACE_HUB_TOKEN"]
    try:
        import hf_transfer  # noqa: F401

        os.environ.setdefault("HF_HUB_ENABLE_HF_TRANSFER", "1")
    except Exception:
        pass

    try:
        import torch  # noqa: F401
        from diffusers import StableDiffusionInpaintPipeline, StableDiffusionXLInpaintPipeline  # noqa: F401
    except Exception as e:
        msg = str(e)
        raise SystemExit(
            "Missing diffusion dependencies. Install the optional venv:\n"
            "  python3 -m venv packages/data/.venv-diffusion\n"
            "  packages/data/.venv-diffusion/bin/pip install -r packages/data/scripts/py/requirements-diffusion.txt\n"
            f"\nImport error: {msg}"
        )

    import torch
    from diffusers import StableDiffusionInpaintPipeline, StableDiffusionXLInpaintPipeline

    t0 = time.time()

    copied_files = _copy_png_tree(args.in_dir, args.out_dir)
    x_vals, y_vals = _find_index_sets(args.out_dir)
    grid_x = len(x_vals)
    grid_y = len(y_vals)
    grid = max(grid_x, grid_y)

    first = _tile_path(args.out_dir, x_vals[0], y_vals[0])
    if not os.path.exists(first):
        raise SystemExit(f"missing first tile in out dir: {first}")
    img0 = Image.open(first).convert("RGB")
    w, h = img0.size
    if w <= 0 or h <= 0:
        raise SystemExit("invalid tile size")

    mx = _crop_margin_px(w, args.overlap)
    my = _crop_margin_px(h, args.overlap)
    seam_context = int(args.seam_context) if args.seam_context > 0 else max(8, min(mx, my, 64))
    if seam_context <= 0:
        seam_context = 32

    device = _pick_device(args.device, torch)
    dtype = _pick_dtype(device, torch)

    kwargs = {"torch_dtype": dtype, "use_safetensors": True}
    if dtype == torch.float16:
        kwargs["variant"] = "fp16"

    pipe = None
    pipe_kind = None
    errors = []
    for kind, cls in (
        ("sdxl_inpaint", StableDiffusionXLInpaintPipeline),
        ("sd_inpaint", StableDiffusionInpaintPipeline),
    ):
        try:
            try:
                pipe = cls.from_pretrained(args.model, **kwargs)
            except Exception:
                if kwargs.get("variant"):
                    kwargs2 = dict(kwargs)
                    kwargs2.pop("variant", None)
                    pipe = cls.from_pretrained(args.model, **kwargs2)
                else:
                    raise
            pipe_kind = kind
            break
        except Exception as e:
            errors.append(f"{kind}: {e}")
            pipe = None
            pipe_kind = None

    if pipe is None:
        raise SystemExit(f"Failed to load inpaint pipeline for model '{args.model}':\n" + "\n".join(errors))

    try:
        pipe.enable_attention_slicing()
    except Exception:
        pass
    try:
        pipe.enable_vae_slicing()
    except Exception:
        pass

    cross_attention_kwargs = None
    if args.lora:
        try:
            pipe.load_lora_weights(args.lora)
            cross_attention_kwargs = {"scale": float(args.lora_scale)}
        except Exception as e:
            raise SystemExit(f"Failed to load LoRA weights '{args.lora}': {e}")

    pipe = pipe.to(device)

    seed_base = int(args.seed)
    if seed_base == -1:
        seed_base = int.from_bytes(os.urandom(2), "big")

    steps_requested = int(args.steps)
    steps_effective = int(args.steps)
    if int(math.floor(float(args.strength) * steps_effective)) < 1:
        steps_effective = int(max(1, math.ceil(1.0 / float(args.strength))))
        print(
            json.dumps(
                {
                    "warning": "steps_auto_adjusted_for_strength",
                    "steps_requested": steps_requested,
                    "steps_effective": steps_effective,
                    "strength": float(args.strength),
                }
            )
        )
        sys.stdout.flush()

    def run_inpaint(patch, mask, seam_idx):
        return _run_inpaint(
            pipe=pipe,
            torch=torch,
            patch=patch,
            mask=mask,
            prompt=args.prompt,
            negative=args.negative,
            strength=args.strength,
            steps=steps_effective,
            guidance=args.guidance,
            seed=seed_base + seam_idx,
            device=device,
            cross_attention_kwargs=cross_attention_kwargs,
        )

    vertical_pairs = []
    x_gaps = []
    for i in range(max(0, grid_x - 1)):
        left = int(x_vals[i])
        right = int(x_vals[i + 1])
        if right == left + 1:
            vertical_pairs.append((left, right))
        elif right > left + 1:
            x_gaps.append({"left": left, "right": right, "missing": int(right - left - 1)})

    horizontal_pairs = []
    y_gaps = []
    for i in range(max(0, grid_y - 1)):
        top = int(y_vals[i])
        bottom = int(y_vals[i + 1])
        if bottom == top + 1:
            horizontal_pairs.append((top, bottom))
        elif bottom > top + 1:
            y_gaps.append({"top": top, "bottom": bottom, "missing": int(bottom - top - 1)})

    seams_total = len(vertical_pairs) * grid_y + len(horizontal_pairs) * grid_x
    seam_idx = 0
    seams_processed = 0
    seams_skipped = 0
    processed_v = 0
    processed_h = 0
    skipped_reasons = {}
    suspicious_seams = []
    suspicious_limit = 256

    def add_skip(reason, seam_info):
        nonlocal seams_skipped
        seams_skipped += 1
        skipped_reasons[reason] = int(skipped_reasons.get(reason, 0)) + 1
        if len(suspicious_seams) < suspicious_limit:
            suspicious_seams.append({"reason": str(reason), **seam_info})

    for gap in x_gaps:
        if len(suspicious_seams) >= suspicious_limit:
            break
        suspicious_seams.append({"reason": "x_index_gap", **gap})
    for gap in y_gaps:
        if len(suspicious_seams) >= suspicious_limit:
            break
        suspicious_seams.append({"reason": "y_index_gap", **gap})

    # Vertical seams first.
    for y in y_vals:
        for x_left, x_right in vertical_pairs:
            if args.max_seams > 0 and seams_processed >= args.max_seams:
                break
            ok, reason = _process_vertical(
                layer_dir=args.out_dir,
                x_left=int(x_left),
                x_right=int(x_right),
                y=int(y),
                w=w,
                h=h,
                mx=mx,
                my=my,
                seam_context=seam_context,
                mask_half=int(args.mask_half),
                write_half=int(args.write_half),
                harmonize_half=int(args.harmonize_half),
                run_inpaint=lambda patch, mask, idx=seam_idx: run_inpaint(patch, mask, idx),
            )
            seam_idx += 1
            if ok:
                seams_processed += 1
                processed_v += 1
            else:
                add_skip(reason, {"seam": "v", "x_left": int(x_left), "x_right": int(x_right), "y": int(y)})
            print(
                json.dumps(
                    {"seam": "v", "x_left": int(x_left), "x_right": int(x_right), "y": int(y), "ok": bool(ok), "reason": reason}
                )
            )
            sys.stdout.flush()
        if args.max_seams > 0 and seams_processed >= args.max_seams:
            break

    # Horizontal seams.
    if not (args.max_seams > 0 and seams_processed >= args.max_seams):
        for y_top, y_bottom in horizontal_pairs:
            for x in x_vals:
                if args.max_seams > 0 and seams_processed >= args.max_seams:
                    break
                ok, reason = _process_horizontal(
                    layer_dir=args.out_dir,
                    x=int(x),
                    y_top=int(y_top),
                    y_bottom=int(y_bottom),
                    w=w,
                    h=h,
                    mx=mx,
                    my=my,
                    seam_context=seam_context,
                    mask_half=int(args.mask_half),
                    write_half=int(args.write_half),
                    harmonize_half=int(args.harmonize_half),
                    run_inpaint=lambda patch, mask, idx=seam_idx: run_inpaint(patch, mask, idx),
                )
                seam_idx += 1
                if ok:
                    seams_processed += 1
                    processed_h += 1
                else:
                    add_skip(reason, {"seam": "h", "x": int(x), "y_top": int(y_top), "y_bottom": int(y_bottom)})
                print(
                    json.dumps(
                        {
                            "seam": "h",
                            "x": int(x),
                            "y_top": int(y_top),
                            "y_bottom": int(y_bottom),
                            "ok": bool(ok),
                            "reason": reason,
                        }
                    )
                )
                sys.stdout.flush()
            if args.max_seams > 0 and seams_processed >= args.max_seams:
                break

    dt = time.time() - t0
    report = {
        "in_dir": os.path.abspath(args.in_dir),
        "out_dir": os.path.abspath(args.out_dir),
        "model": args.model,
        "pipeline": pipe_kind,
        "lora": args.lora if args.lora else None,
        "lora_scale": float(args.lora_scale) if args.lora else None,
        "copied_files": int(copied_files),
        "grid": int(grid),
        "grid_xy": {"x": int(grid_x), "y": int(grid_y)},
        "x_values": [int(v) for v in x_vals],
        "y_values": [int(v) for v in y_vals],
        "tile_size": {"w": int(w), "h": int(h)},
        "overlap": float(args.overlap),
        "crop_margin_px": {"x": int(mx), "y": int(my)},
        "seam_context": int(seam_context),
        "mask_half": int(args.mask_half),
        "write_half": int(args.write_half),
        "harmonize_half": int(args.harmonize_half),
        "vertical_pairs": int(len(vertical_pairs)),
        "horizontal_pairs": int(len(horizontal_pairs)),
        "x_index_gaps": x_gaps,
        "y_index_gaps": y_gaps,
        "seams_total": int(seams_total),
        "seams_processed": int(seams_processed),
        "seams_vertical_processed": int(processed_v),
        "seams_horizontal_processed": int(processed_h),
        "seams_skipped": int(seams_skipped),
        "skipped_reasons": skipped_reasons,
        "suspicious_seams": suspicious_seams,
        "strength": float(args.strength),
        "steps_requested": int(steps_requested),
        "steps_effective": int(steps_effective),
        "guidance": float(args.guidance),
        "seed_base": int(seed_base),
        "device": device,
        "dtype": "float16" if dtype == torch.float16 else "float32",
        "duration_s": float(dt),
    }

    if args.report_json:
        _ensure_dir(os.path.dirname(os.path.abspath(args.report_json)))
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(json.dumps(report, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
