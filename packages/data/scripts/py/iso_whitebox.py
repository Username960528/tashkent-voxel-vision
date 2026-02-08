import argparse
import json
import math
import os
import sys

import pyarrow.parquet as pq
from PIL import Image, ImageDraw
from pyproj import Transformer
from shapely import wkb
from shapely.geometry import Polygon
from shapely.ops import transform as shp_transform
from shapely.strtree import STRtree


BG = (246, 242, 232, 255)  # #f6f2e8
WALL_A = (209, 213, 219, 255)  # #d1d5db
WALL_B = (156, 163, 175, 255)  # #9ca3af
ROOF = (229, 231, 235, 255)  # #e5e7eb
OUTLINE = (17, 24, 39, 255)  # #111827


def _parse_bbox(raw):
    parts = [p.strip() for p in raw.split(",")]
    if len(parts) != 4:
        raise ValueError("bbox must have 4 comma-separated values: minLon,minLat,maxLon,maxLat")
    vals = [float(p) for p in parts]
    if not all(math.isfinite(v) for v in vals):
        raise ValueError("bbox contains non-finite numbers")
    min_lon, min_lat, max_lon, max_lat = vals
    if min_lon >= max_lon or min_lat >= max_lat:
        raise ValueError("bbox must satisfy min < max")
    return (min_lon, min_lat, max_lon, max_lat)


def _project_xy(x_m, y_m, z_m, s_xy, s_z):
    # Classic iso-ish affine projection (orthographic). For ground plane z=0:
    # u = s*(x - y), v = 0.5*s*(x + y)
    u = s_xy * (x_m - y_m)
    v = (0.5 * s_xy) * (x_m + y_m) - (s_z * z_m)
    return (u, v)


def _unproject_xy(u, v, s_xy):
    # Inverse of the ground-plane transform:
    # u = s*(x - y)
    # v = 0.5*s*(x + y)
    # => x = (u + 2v)/(2s), y = (2v - u)/(2s)
    x_m = (u + 2.0 * v) / (2.0 * s_xy)
    y_m = (2.0 * v - u) / (2.0 * s_xy)
    return (x_m, y_m)


def _ensure_dir(p):
    os.makedirs(p, exist_ok=True)


def _iter_polygons(geom):
    gt = geom.geom_type
    if gt == "Polygon":
        yield geom
    elif gt == "MultiPolygon":
        for g in getattr(geom, "geoms", []):
            if g.geom_type == "Polygon" and not g.is_empty:
                yield g


def _draw_building(draw, poly, height_m, *, u0, v0, s_xy, s_z):
    coords = list(poly.exterior.coords)
    if len(coords) < 4:
        return

    # Drop the repeated last point.
    coords = coords[:-1]

    base = []
    roof = []
    for (x, y) in coords:
        u_b, v_b = _project_xy(x, y, 0.0, s_xy, s_z)
        u_r, v_r = _project_xy(x, y, float(height_m), s_xy, s_z)
        base.append((u_b - u0, v_b - v0))
        roof.append((u_r - u0, v_r - v0))

    # Wall faces: only those facing the camera (simple normal test).
    camera = (-1.0, -1.0)  # camera sits "south-west" of the scene
    is_ccw = getattr(poly.exterior, "is_ccw", None)
    if is_ccw is None:
        # Fallback: assume CCW.
        is_ccw = True

    for i in range(len(coords)):
        j = (i + 1) % len(coords)
        x0, y0_w = coords[i]
        x1, y1_w = coords[j]
        dx = x1 - x0
        dy = y1_w - y0_w

        # Outward normal depends on ring orientation.
        if is_ccw:
            nx, ny = (dy, -dx)
        else:
            nx, ny = (-dy, dx)

        if (nx * camera[0] + ny * camera[1]) <= 0:
            continue

        color = WALL_A if (nx + ny) < 0 else WALL_B
        wall = [base[i], base[j], roof[j], roof[i]]
        draw.polygon(wall, fill=color)

    draw.polygon(roof, fill=ROOF, outline=OUTLINE)


def main():
    ap = argparse.ArgumentParser(description="Render a simple isometric whitebox tile pyramid from buildings GeoParquet.")
    ap.add_argument("--in_parquet", required=True, help="Input buildings parquet (WKB, EPSG:4326) with height_m")
    ap.add_argument("--out_dir", required=True, help="Output directory (writes z/x/y.png + tilejson.json)")
    ap.add_argument("--bbox", required=True, help="AOI bbox in WGS84: minLon,minLat,maxLon,maxLat")
    ap.add_argument("--tile_size", type=int, default=512, help="Tile size in pixels (default: 512)")
    ap.add_argument("--z_min", type=int, default=0, help="Min zoom (default: 0)")
    ap.add_argument("--z_max", type=int, default=0, help="Max zoom (default: 0)")
    ap.add_argument("--ppm", type=float, default=0.06, help="Pixels per meter at z=0 (default: 0.06)")
    ap.add_argument(
        "--height_scale",
        type=float,
        default=1.6,
        help="Height scale factor (pixels-per-meter multiplier for z) (default: 1.6)",
    )
    ap.add_argument("--skip_empty", action="store_true", help="Skip writing empty tiles (default: false)")
    ap.add_argument("--max_tiles", type=int, default=0, help="Optional cap on total tiles written (0 = unlimited)")
    ap.add_argument("--report_json", default="", help="Optional JSON report output path")
    args = ap.parse_args()

    if args.z_min < 0 or args.z_max < 0 or args.z_min > args.z_max:
        raise SystemExit("Invalid zoom range: require 0 <= z_min <= z_max")
    if args.tile_size <= 0:
        raise SystemExit("Invalid --tile_size")
    if not (args.ppm > 0 and math.isfinite(args.ppm)):
        raise SystemExit("Invalid --ppm")
    if not (args.height_scale > 0 and math.isfinite(args.height_scale)):
        raise SystemExit("Invalid --height_scale")

    bbox = _parse_bbox(args.bbox)
    min_lon, min_lat, max_lon, max_lat = bbox

    table = pq.read_table(args.in_parquet, columns=["id", "height_m", "geometry"])
    n = table.num_rows
    if n == 0:
        raise SystemExit("No buildings rows found; refusing to render empty pyramid")

    heights = table["height_m"].to_pylist()
    wkbs = table["geometry"].to_pylist()

    tf = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    min_x, min_y = tf.transform(min_lon, min_lat)
    max_x, max_y = tf.transform(max_lon, max_lat)

    origin_x = min(min_x, max_x)
    origin_y = min(min_y, max_y)
    width_m = abs(max_x - min_x)
    height_m = abs(max_y - min_y)

    geoms = []
    out_heights = []

    max_h = 0.0
    for i in range(n):
        h = heights[i]
        try:
            h_m = float(h) if h is not None else 0.0
        except Exception:
            h_m = 0.0
        if h_m > max_h:
            max_h = h_m

        geom = wkb.loads(wkbs[i])

        def _xy(x, y, z=None):
            x2, y2 = tf.transform(x, y)
            return (x2 - origin_x, y2 - origin_y)

        geom_local = shp_transform(_xy, geom)
        if geom_local.is_empty:
            continue
        geoms.append(geom_local)
        out_heights.append(h_m)

    if not geoms:
        raise SystemExit("No geometries after transform")

    tree = STRtree(geoms)

    # Screen-space bounds for ground plane (z=0), at zoom 0.
    s0 = float(args.ppm)
    corners = [(0.0, 0.0), (width_m, 0.0), (0.0, height_m), (width_m, height_m)]
    uv = [_project_xy(x, y, 0.0, s0, s0 * args.height_scale) for (x, y) in corners]
    u_vals = [p[0] for p in uv]
    v_vals = [p[1] for p in uv]

    pad = float(args.tile_size) * 0.25
    u_min = min(u_vals) - pad
    u_max = max(u_vals) + pad
    v_min = min(v_vals) - pad - (max_h * s0 * args.height_scale)
    v_max = max(v_vals) + pad

    out_root = args.out_dir
    _ensure_dir(out_root)

    written = 0
    tiles_written = []

    for z in range(args.z_min, args.z_max + 1):
        scale = float(2**z)
        s_xy = s0 * scale
        s_z = (s0 * args.height_scale) * scale

        extent_u = (u_max - u_min) * scale
        extent_v = (v_max - v_min) * scale
        tiles_x = int(math.ceil(extent_u / float(args.tile_size)))
        tiles_y = int(math.ceil(extent_v / float(args.tile_size)))

        for ty in range(tiles_y):
            for tx in range(tiles_x):
                if args.max_tiles and written >= args.max_tiles:
                    break

                tile_u0 = u_min * scale + tx * args.tile_size
                tile_v0 = v_min * scale + ty * args.tile_size

                # Expanded query rect (in screen space) -> world polygon (ground plane).
                qpad = float(args.tile_size) * 0.35
                u0 = tile_u0 - qpad
                v0 = tile_v0 - qpad
                u1 = tile_u0 + args.tile_size + qpad
                v1 = tile_v0 + args.tile_size + qpad

                x0, y0 = _unproject_xy(u0, v0, s_xy)
                x1, y1 = _unproject_xy(u1, v0, s_xy)
                x2, y2 = _unproject_xy(u1, v1, s_xy)
                x3, y3 = _unproject_xy(u0, v1, s_xy)
                qpoly = Polygon([(x0, y0), (x1, y1), (x2, y2), (x3, y3), (x0, y0)])

                idxs = tree.query(qpoly, predicate="intersects")
                if len(idxs) == 0 and args.skip_empty:
                    continue

                img = Image.new("RGBA", (args.tile_size, args.tile_size), BG)
                draw = ImageDraw.Draw(img)

                buildings = []
                for idx in idxs:
                    geom = geoms[int(idx)]
                    if geom.is_empty:
                        continue
                    c = geom.centroid
                    buildings.append((float(c.x + c.y), int(idx)))

                buildings.sort(key=lambda t: t[0])

                for _, idx in buildings:
                    geom = geoms[idx]
                    h_m = out_heights[idx]
                    for poly in _iter_polygons(geom):
                        _draw_building(draw, poly, h_m, u0=tile_u0, v0=tile_v0, s_xy=s_xy, s_z=s_z)

                out_dir = os.path.join(out_root, str(z), str(tx))
                _ensure_dir(out_dir)
                out_path = os.path.join(out_dir, f"{ty}.png")
                img.save(out_path, "PNG")

                written += 1
                tiles_written.append({"z": z, "x": tx, "y": ty, "path": out_path})

            if args.max_tiles and written >= args.max_tiles:
                break
        if args.max_tiles and written >= args.max_tiles:
            break

    tilejson = {
        "tilejson": "3.0.0",
        "name": "tvv_iso_whitebox",
        "format": "png",
        "tileSize": int(args.tile_size),
        "minzoom": int(args.z_min),
        "maxzoom": int(args.z_max),
        "tiles": ["{z}/{x}/{y}.png"],
        "bounds_wgs84": [min_lon, min_lat, max_lon, max_lat],
        "render": {
            "projection": "isometric_affine",
            "ppm_z0": float(args.ppm),
            "height_scale": float(args.height_scale),
            "bbox_3857_origin_m": [origin_x, origin_y],
        },
    }

    tilejson_path = os.path.join(out_root, "tilejson.json")
    with open(tilejson_path, "w", encoding="utf-8") as f:
        json.dump(tilejson, f, separators=(",", ":"))
        f.write("\n")

    report = {
        "in_parquet": args.in_parquet,
        "out_dir": out_root,
        "tilejson": tilejson_path,
        "tile_count": written,
        "max_height_m": float(max_h),
        "z_min": int(args.z_min),
        "z_max": int(args.z_max),
        "tile_size": int(args.tile_size),
        "skip_empty": bool(args.skip_empty),
    }

    if args.report_json:
        _ensure_dir(os.path.dirname(args.report_json))
        with open(args.report_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(json.dumps(report, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
