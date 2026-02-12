import argparse
import json
import math
import os
import sys

import numpy as np
from PIL import Image
from PIL import ImageColor


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


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


def _resolve_index_sets(x_auto, y_auto, grid_arg):
    if grid_arg and grid_arg > 0:
        v = list(range(int(grid_arg)))
        return v, v
    x_min, x_max = min(x_auto), max(x_auto)
    y_min, y_max = min(y_auto), max(y_auto)
    return list(range(int(x_min), int(x_max) + 1)), list(range(int(y_min), int(y_max) + 1))


def _crop_margin_px(size_px, overlap):
    if overlap <= 0.0:
        return 0
    # We rendered a bbox expanded by `overlap` per side in meters:
    # total = base*(1 + 2*overlap) => per-side margin fraction = overlap / (1 + 2*overlap)
    frac = float(overlap) / (1.0 + 2.0 * float(overlap))
    return int(round(size_px * frac))


def _safe_open_tile(tile_path, target_size, mode):
    tile = Image.open(tile_path)
    if tile.size != target_size:
        tile = tile.resize(target_size, resample=Image.Resampling.NEAREST)
    if tile.mode != mode:
        tile = tile.convert(mode)
    return tile


def _blend_mosaic(in_dir, x_vals, y_vals, w, h, mx, my, mode, bg, feather_px):
    cw = max(1, w - 2 * mx)
    ch = max(1, h - 2 * my)

    width = len(x_vals)
    height = len(y_vals)

    has_tile = [[False for _ in range(width)] for _ in range(height)]
    for iy, y in enumerate(y_vals):
        for ix, x in enumerate(x_vals):
            tile_path = os.path.join(in_dir, "0", str(x), f"{y}.png")
            has_tile[iy][ix] = os.path.exists(tile_path)

    bx = max(0, min(mx, int(feather_px) if feather_px > 0 else int(round(mx * 0.75))))
    by = max(0, min(my, int(feather_px) if feather_px > 0 else int(round(my * 0.75))))

    channels = 3 if mode == "RGB" else 4
    out_w = cw * width
    out_h = ch * height
    accum = np.zeros((out_h, out_w, channels), dtype=np.float32)
    wsum = np.zeros((out_h, out_w, 1), dtype=np.float32)

    bg_rgb = ImageColor.getrgb(bg)
    if channels == 4:
        bg_arr = np.array([bg_rgb[0], bg_rgb[1], bg_rgb[2], 255], dtype=np.float32)
    else:
        bg_arr = np.array([bg_rgb[0], bg_rgb[1], bg_rgb[2]], dtype=np.float32)

    missing = 0
    for iy, y in enumerate(y_vals):
        for ix, x in enumerate(x_vals):
            tile_path = os.path.join(in_dir, "0", str(x), f"{y}.png")
            if not has_tile[iy][ix]:
                missing += 1
                continue

            has_left = ix > 0 and has_tile[iy][ix - 1]
            has_right = ix < width - 1 and has_tile[iy][ix + 1]
            has_top = iy > 0 and has_tile[iy - 1][ix]
            has_bottom = iy < height - 1 and has_tile[iy + 1][ix]

            lx = bx if has_left else 0
            rx = bx if has_right else 0
            ty = by if has_top else 0
            byy = by if has_bottom else 0

            left = max(0, mx - lx)
            right = min(w, (w - mx) + rx)
            top = max(0, my - ty)
            bottom = min(h, (h - my) + byy)
            if right <= left or bottom <= top:
                missing += 1
                continue

            tile = _safe_open_tile(tile_path, (w, h), mode)
            patch = np.asarray(tile.crop((left, top, right, bottom)), dtype=np.float32)

            ph, pw = patch.shape[0], patch.shape[1]
            weight = np.ones((ph, pw), dtype=np.float32)

            if lx > 0:
                ramp = np.linspace(0.0, 1.0, lx, endpoint=False, dtype=np.float32)
                weight[:, :lx] *= ramp[None, :]
            if rx > 0:
                ramp = np.linspace(1.0, 0.0, rx, endpoint=False, dtype=np.float32)
                weight[:, pw - rx : pw] *= ramp[None, :]
            if ty > 0:
                ramp = np.linspace(0.0, 1.0, ty, endpoint=False, dtype=np.float32)
                weight[:ty, :] *= ramp[:, None]
            if byy > 0:
                ramp = np.linspace(1.0, 0.0, byy, endpoint=False, dtype=np.float32)
                weight[ph - byy : ph, :] *= ramp[:, None]

            x0 = ix * cw - lx
            y0 = iy * ch - ty
            x1 = x0 + pw
            y1 = y0 + ph

            if x0 < 0 or y0 < 0 or x1 > out_w or y1 > out_h:
                # Should not happen for valid overlap math; guard anyway.
                continue

            w3 = weight[:, :, None]
            accum[y0:y1, x0:x1, :] += patch * w3
            wsum[y0:y1, x0:x1, :] += w3

    out = np.empty_like(accum, dtype=np.float32)
    np.divide(accum, np.maximum(wsum, 1e-6), out=out)
    hole_mask = wsum[:, :, 0] <= 1e-6
    if np.any(hole_mask):
        out[hole_mask] = bg_arr

    out_u8 = np.clip(out, 0, 255).astype(np.uint8, copy=False)
    image = Image.fromarray(out_u8, mode=mode)
    return image, missing, cw, ch, bx, by


def main():
    ap = argparse.ArgumentParser(description="Stitch a grid of 0/x/y.png tiles into a single mosaic PNG.")
    ap.add_argument("--in_dir", required=True, help="Input tiles directory (expects 0/x/y.png)")
    ap.add_argument("--out_png", required=True, help="Output mosaic PNG path")
    ap.add_argument("--grid", type=int, default=0, help="Grid size N (0=auto-detect from tiles)")
    ap.add_argument("--overlap", type=float, default=0.0, help="Overlap fraction used when rendering (default: 0)")
    ap.add_argument(
        "--mode",
        default="crop",
        choices=["crop", "blend"],
        help="Stitch mode: crop (hard seams) or blend (feather overlap seams). Default: crop",
    )
    ap.add_argument(
        "--feather_px",
        type=int,
        default=0,
        help="Feather width in pixels for blend mode (0=auto from overlap margin)",
    )
    ap.add_argument("--bg", default="#ffffff", help="Background color (default: #ffffff)")
    ap.add_argument("--report_json", default="", help="Optional report JSON path")
    args = ap.parse_args()

    if not os.path.isdir(args.in_dir):
        raise SystemExit(f"missing input dir: {args.in_dir}")
    if not (math.isfinite(args.overlap) and 0.0 <= args.overlap < 0.49):
        raise SystemExit("--overlap must be in [0, 0.49)")
    if args.grid < 0:
        raise SystemExit("--grid must be >= 0")
    if args.feather_px < 0:
        raise SystemExit("--feather_px must be >= 0")

    x_auto, y_auto = _find_index_sets(args.in_dir)
    x_vals, y_vals = _resolve_index_sets(x_auto, y_auto, int(args.grid))
    x_found = sorted(set(x_auto))
    y_found = sorted(set(y_auto))

    first = None
    for y in y_vals:
        for x in x_vals:
            candidate = os.path.join(args.in_dir, "0", str(x), f"{y}.png")
            if os.path.exists(candidate):
                first = candidate
                break
        if first:
            break
    if not first:
        raise SystemExit(f"no readable tiles under: {args.in_dir}/0/<x>/<y>.png")

    img0 = Image.open(first)
    w, h = img0.size
    if w <= 0 or h <= 0:
        raise SystemExit("invalid tile image size")

    mx = _crop_margin_px(w, args.overlap)
    my = _crop_margin_px(h, args.overlap)
    cw = max(1, w - 2 * mx)
    ch = max(1, h - 2 * my)

    mode = "RGB" if img0.mode in ("RGB", "P") else "RGBA"
    bg = args.bg
    blend_x = 0
    blend_y = 0

    if args.mode == "blend":
        canvas, missing, cw, ch, blend_x, blend_y = _blend_mosaic(
            in_dir=args.in_dir,
            x_vals=x_vals,
            y_vals=y_vals,
            w=w,
            h=h,
            mx=mx,
            my=my,
            mode=mode,
            bg=bg,
            feather_px=args.feather_px,
        )
    else:
        canvas = Image.new(mode, (cw * len(x_vals), ch * len(y_vals)), bg)
        missing = 0
        for iy, y in enumerate(y_vals):
            for ix, x in enumerate(x_vals):
                tile_path = os.path.join(args.in_dir, "0", str(x), f"{y}.png")
                if not os.path.exists(tile_path):
                    missing += 1
                    continue
                tile = _safe_open_tile(tile_path, (w, h), mode)
                if mx or my:
                    tile = tile.crop((mx, my, w - mx, h - my))
                canvas.paste(tile, (ix * cw, iy * ch))

    _ensure_dir(os.path.dirname(os.path.abspath(args.out_png)))
    canvas.save(args.out_png, "PNG")

    grid_side = max(len(x_vals), len(y_vals))
    expected_tiles = int(len(x_vals) * len(y_vals))
    found_tiles = int(max(0, expected_tiles - missing))
    report = {
        "in_dir": os.path.abspath(args.in_dir),
        "out_png": os.path.abspath(args.out_png),
        "grid": int(grid_side),
        "grid_xy": {"x": int(len(x_vals)), "y": int(len(y_vals))},
        "tile_count_expected": expected_tiles,
        "tile_count_found": found_tiles,
        "index_ranges": {
            "x_min": int(min(x_vals)),
            "x_max": int(max(x_vals)),
            "y_min": int(min(y_vals)),
            "y_max": int(max(y_vals)),
        },
        "detected_index_ranges": {
            "x_min": int(min(x_found)),
            "x_max": int(max(x_found)),
            "y_min": int(min(y_found)),
            "y_max": int(max(y_found)),
        },
        "overlap": float(args.overlap),
        "mode": args.mode,
        "feather_px": int(args.feather_px),
        "blend_margin_px": {"x": int(blend_x), "y": int(blend_y)},
        "tile_size": {"w": int(w), "h": int(h)},
        "crop_margin_px": {"x": int(mx), "y": int(my)},
        "cropped_tile_size": {"w": int(cw), "h": int(ch)},
        "mosaic_size": {"w": int(cw * len(x_vals)), "h": int(ch * len(y_vals))},
        "missing_tiles": int(missing),
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
