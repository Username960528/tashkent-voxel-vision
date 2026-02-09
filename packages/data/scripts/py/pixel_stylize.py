import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter


INK = (17, 24, 39, 255)  # #111827


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def _clamp01(x):
    return max(0.0, min(1.0, float(x)))


def _stylize(
    img,
    *,
    pixel_scale,
    palette_size,
    dither,
    edge_threshold,
    edge_alpha,
    edge_thickness,
    contrast,
    saturation,
):
    if img.mode not in ("RGB", "RGBA"):
        img = img.convert("RGBA")

    w, h = img.size
    if w <= 0 or h <= 0:
        raise ValueError("invalid image size")

    ps = float(pixel_scale)
    if not (0.01 <= ps <= 1.0):
        raise ValueError("pixel_scale must be in [0.01, 1.0]")

    pw = max(1, int(round(w * ps)))
    ph = max(1, int(round(h * ps)))

    # Downsample with BOX (area average) to keep details but reduce noise.
    small = img.resize((pw, ph), resample=Image.Resampling.BOX)

    # Basic color tuning before quantization to get a more "illustrated" look.
    if contrast != 1.0:
        small = ImageEnhance.Contrast(small).enhance(float(contrast))
    if saturation != 1.0:
        small = ImageEnhance.Color(small).enhance(float(saturation))

    # Adaptive palette quantization.
    d = Image.Dither.FLOYDSTEINBERG if dither else Image.Dither.NONE
    # Quantize expects RGB; alpha is handled later.
    q = small.convert("RGB").quantize(colors=int(palette_size), method=Image.Quantize.MEDIANCUT, dither=d)
    small_rgb = q.convert("RGB")

    # Upscale with NEAREST to get crisp pixels.
    up = small_rgb.resize((w, h), resample=Image.Resampling.NEAREST).convert("RGBA")

    # Edges: compute on original image luminance for more stable outlines.
    edges = img.convert("L").filter(ImageFilter.FIND_EDGES)
    edges_small = edges.resize((pw, ph), resample=Image.Resampling.BILINEAR)
    edges_arr = np.array(edges_small, dtype=np.uint8)
    mask_small = (edges_arr >= int(edge_threshold)).astype(np.uint8) * 255
    mask = Image.fromarray(mask_small, mode="L")

    if int(edge_thickness) > 1:
        # Pillow MaxFilter size is the full window size.
        sz = int(edge_thickness)
        if sz % 2 == 0:
            sz += 1
        mask = mask.filter(ImageFilter.MaxFilter(size=sz))

    mask = mask.resize((w, h), resample=Image.Resampling.NEAREST)

    ink = Image.new("RGBA", (w, h), (INK[0], INK[1], INK[2], int(round(255.0 * _clamp01(edge_alpha)))))
    out = Image.composite(ink, up, mask)
    return out


def main():
    ap = argparse.ArgumentParser(description="CPU pixel-art stylizer (pixelate + palette quantize + outlines).")
    ap.add_argument("--in_png", required=True, help="Input PNG path")
    ap.add_argument("--out_png", required=True, help="Output PNG path")
    ap.add_argument("--report_json", default="", help="Optional JSON report output path")

    ap.add_argument("--pixel_scale", type=float, default=0.20, help="Downscale factor before upscaling (default: 0.20)")
    ap.add_argument("--palette", type=int, default=48, help="Palette size (default: 48)")
    ap.add_argument("--dither", action="store_true", help="Enable Floyd-Steinberg dithering (default: off)")

    ap.add_argument("--edge_threshold", type=int, default=48, help="Edge threshold 0..255 (default: 48)")
    ap.add_argument("--edge_alpha", type=float, default=0.85, help="Edge alpha 0..1 (default: 0.85)")
    ap.add_argument("--edge_thickness", type=int, default=2, help="Edge thickness in pixels at low-res (default: 2)")

    ap.add_argument("--contrast", type=float, default=1.10, help="Pre-quantize contrast boost (default: 1.10)")
    ap.add_argument("--saturation", type=float, default=1.05, help="Pre-quantize saturation boost (default: 1.05)")
    args = ap.parse_args()

    if args.palette < 2 or args.palette > 256:
        raise SystemExit("--palette must be in [2, 256]")
    if args.edge_threshold < 0 or args.edge_threshold > 255:
        raise SystemExit("--edge_threshold must be in [0, 255]")
    if not (0.0 <= args.edge_alpha <= 1.0 and math.isfinite(args.edge_alpha)):
        raise SystemExit("--edge_alpha must be in [0, 1]")
    if not (math.isfinite(args.pixel_scale) and 0.01 <= args.pixel_scale <= 1.0):
        raise SystemExit("--pixel_scale must be in [0.01, 1.0]")
    if args.edge_thickness < 1:
        raise SystemExit("--edge_thickness must be >= 1")
    if not math.isfinite(args.contrast) or args.contrast <= 0:
        raise SystemExit("--contrast must be > 0")
    if not math.isfinite(args.saturation) or args.saturation <= 0:
        raise SystemExit("--saturation must be > 0")

    in_path = args.in_png
    out_path = args.out_png
    if not os.path.exists(in_path):
        raise SystemExit(f"missing input: {in_path}")

    _ensure_dir(os.path.dirname(os.path.abspath(out_path)))
    img = Image.open(in_path)

    out = _stylize(
        img,
        pixel_scale=args.pixel_scale,
        palette_size=args.palette,
        dither=bool(args.dither),
        edge_threshold=args.edge_threshold,
        edge_alpha=args.edge_alpha,
        edge_thickness=args.edge_thickness,
        contrast=args.contrast,
        saturation=args.saturation,
    )

    out.save(out_path, "PNG")

    report = {
        "in_png": os.path.abspath(in_path),
        "out_png": os.path.abspath(out_path),
        "pixel_scale": float(args.pixel_scale),
        "palette": int(args.palette),
        "dither": bool(args.dither),
        "edge_threshold": int(args.edge_threshold),
        "edge_alpha": float(args.edge_alpha),
        "edge_thickness": int(args.edge_thickness),
        "contrast": float(args.contrast),
        "saturation": float(args.saturation),
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

