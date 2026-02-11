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


def _find_grid(in_dir):
    z0 = os.path.join(in_dir, "0")
    if not os.path.isdir(z0):
        raise ValueError(f"missing tiles dir: {z0} (expected 0/x/y.png)")

    xs = []
    for name in os.listdir(z0):
        p = os.path.join(z0, name)
        if os.path.isdir(p) and name.isdigit():
            xs.append(int(name))
    if not xs:
        raise ValueError(f"no x dirs found under: {z0}")

    max_x = max(xs)
    max_y = -1
    for x in xs:
        xdir = os.path.join(z0, str(x))
        for fn in os.listdir(xdir):
            if fn.lower().endswith(".png"):
                base = fn[:-4]
                if base.isdigit():
                    max_y = max(max_y, int(base))
    if max_y < 0:
        raise ValueError(f"no y pngs found under: {z0}/<x>/")

    # Assumes a dense 0..grid-1 range.
    return max(max_x, max_y) + 1


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


def _blend_mosaic(in_dir, grid, w, h, mx, my, mode, bg, feather_px):
    cw = max(1, w - 2 * mx)
    ch = max(1, h - 2 * my)

    has_tile = [[False for _ in range(grid)] for _ in range(grid)]
    for y in range(grid):
        for x in range(grid):
            tile_path = os.path.join(in_dir, "0", str(x), f"{y}.png")
            has_tile[y][x] = os.path.exists(tile_path)

    bx = max(0, min(mx, int(feather_px) if feather_px > 0 else int(round(mx * 0.75))))
    by = max(0, min(my, int(feather_px) if feather_px > 0 else int(round(my * 0.75))))

    channels = 3 if mode == "RGB" else 4
    out_w = cw * grid
    out_h = ch * grid
    accum = np.zeros((out_h, out_w, channels), dtype=np.float32)
    wsum = np.zeros((out_h, out_w, 1), dtype=np.float32)

    bg_rgb = ImageColor.getrgb(bg)
    if channels == 4:
        bg_arr = np.array([bg_rgb[0], bg_rgb[1], bg_rgb[2], 255], dtype=np.float32)
    else:
        bg_arr = np.array([bg_rgb[0], bg_rgb[1], bg_rgb[2]], dtype=np.float32)

    missing = 0
    for y in range(grid):
        for x in range(grid):
            tile_path = os.path.join(in_dir, "0", str(x), f"{y}.png")
            if not has_tile[y][x]:
                missing += 1
                continue

            has_left = x > 0 and has_tile[y][x - 1]
            has_right = x < grid - 1 and has_tile[y][x + 1]
            has_top = y > 0 and has_tile[y - 1][x]
            has_bottom = y < grid - 1 and has_tile[y + 1][x]

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

            x0 = x * cw - lx
            y0 = y * ch - ty
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

    grid = int(args.grid) if args.grid else int(_find_grid(args.in_dir))

    first = os.path.join(args.in_dir, "0", "0", "0.png")
    if not os.path.exists(first):
        raise SystemExit(f"missing expected first tile: {first}")

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
            grid=grid,
            w=w,
            h=h,
            mx=mx,
            my=my,
            mode=mode,
            bg=bg,
            feather_px=args.feather_px,
        )
    else:
        canvas = Image.new(mode, (cw * grid, ch * grid), bg)
        missing = 0
        for y in range(grid):
            for x in range(grid):
                tile_path = os.path.join(args.in_dir, "0", str(x), f"{y}.png")
                if not os.path.exists(tile_path):
                    missing += 1
                    continue
                tile = _safe_open_tile(tile_path, (w, h), mode)
                if mx or my:
                    tile = tile.crop((mx, my, w - mx, h - my))
                canvas.paste(tile, (x * cw, y * ch))

    _ensure_dir(os.path.dirname(os.path.abspath(args.out_png)))
    canvas.save(args.out_png, "PNG")

    report = {
        "in_dir": os.path.abspath(args.in_dir),
        "out_png": os.path.abspath(args.out_png),
        "grid": int(grid),
        "overlap": float(args.overlap),
        "mode": args.mode,
        "feather_px": int(args.feather_px),
        "blend_margin_px": {"x": int(blend_x), "y": int(blend_y)},
        "tile_size": {"w": int(w), "h": int(h)},
        "crop_margin_px": {"x": int(mx), "y": int(my)},
        "cropped_tile_size": {"w": int(cw), "h": int(ch)},
        "mosaic_size": {"w": int(cw * grid), "h": int(ch * grid)},
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
