import argparse
import json
import math
import os
import sys

from PIL import Image


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


def main():
    ap = argparse.ArgumentParser(description="Stitch a grid of 0/x/y.png tiles into a single mosaic PNG.")
    ap.add_argument("--in_dir", required=True, help="Input tiles directory (expects 0/x/y.png)")
    ap.add_argument("--out_png", required=True, help="Output mosaic PNG path")
    ap.add_argument("--grid", type=int, default=0, help="Grid size N (0=auto-detect from tiles)")
    ap.add_argument("--overlap", type=float, default=0.0, help="Overlap fraction used when rendering (default: 0)")
    ap.add_argument("--bg", default="#ffffff", help="Background color (default: #ffffff)")
    ap.add_argument("--report_json", default="", help="Optional report JSON path")
    args = ap.parse_args()

    if not os.path.isdir(args.in_dir):
        raise SystemExit(f"missing input dir: {args.in_dir}")
    if not (math.isfinite(args.overlap) and 0.0 <= args.overlap < 0.49):
        raise SystemExit("--overlap must be in [0, 0.49)")
    if args.grid < 0:
        raise SystemExit("--grid must be >= 0")

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
    canvas = Image.new(mode, (cw * grid, ch * grid), bg)

    missing = 0
    for y in range(grid):
        for x in range(grid):
            tile_path = os.path.join(args.in_dir, "0", str(x), f"{y}.png")
            if not os.path.exists(tile_path):
                missing += 1
                continue
            tile = Image.open(tile_path)
            if tile.size != (w, h):
                tile = tile.resize((w, h), resample=Image.Resampling.NEAREST)
            if mx or my:
                tile = tile.crop((mx, my, w - mx, h - my))
            if tile.mode != mode:
                tile = tile.convert(mode)
            canvas.paste(tile, (x * cw, y * ch))

    _ensure_dir(os.path.dirname(os.path.abspath(args.out_png)))
    canvas.save(args.out_png, "PNG")

    report = {
        "in_dir": os.path.abspath(args.in_dir),
        "out_png": os.path.abspath(args.out_png),
        "grid": int(grid),
        "overlap": float(args.overlap),
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

