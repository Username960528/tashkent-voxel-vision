import argparse
import json
import math
import os
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely.geometry import mapping
from shapely.ops import transform as shapely_transform
from shapely.strtree import STRtree
from shapely.wkb import loads as wkb_loads


def _read_geo_epsg(parquet_path):
    pf = pq.ParquetFile(parquet_path)
    meta = pf.schema_arrow.metadata or {}
    raw = meta.get(b"geo")
    if not raw:
        return None
    try:
        obj = json.loads(raw.decode("utf-8"))
        cols = (obj.get("columns") or {}).get("geometry") or {}
        crs = cols.get("crs") or {}
        cid = crs.get("id") or {}
        if cid.get("authority") == "EPSG":
            return int(cid.get("code"))
    except Exception:
        return None
    return None


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def main():
    ap = argparse.ArgumentParser(description="Compute green_share metrics over a meter grid (WKB GeoParquet).")
    ap.add_argument("--grid_parquet", required=True, help="Input grid parquet (WKB; projected CRS, meters)")
    ap.add_argument("--green_parquet", required=True, help="Input green parquet (WKB; EPSG:4326)")
    ap.add_argument("--out_metrics_parquet", required=True, help="Output parquet path (cell_id + metrics)")
    ap.add_argument("--out_metrics_geojson", default="", help="Optional output GeoJSON FeatureCollection (EPSG:4326)")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    ap.add_argument("--dry_run", action="store_true", help="Compute report only; do not write outputs")
    args = ap.parse_args()

    grid_epsg = _read_geo_epsg(args.grid_parquet) or 32642
    green_epsg = _read_geo_epsg(args.green_parquet) or 4326

    # Transform green geometries to the grid CRS for intersection/area.
    to_grid = Transformer.from_crs(f"EPSG:{green_epsg}", f"EPSG:{grid_epsg}", always_xy=True).transform
    to_wgs84 = Transformer.from_crs(f"EPSG:{grid_epsg}", "EPSG:4326", always_xy=True).transform

    green_geoms = []
    pf_green = pq.ParquetFile(args.green_parquet)
    for batch in pf_green.iter_batches(batch_size=4096, columns=["geometry"]):
        for geom_wkb in batch.column(0).to_pylist():
            if geom_wkb is None:
                continue
            try:
                g = wkb_loads(geom_wkb)
            except Exception:
                continue
            if g.is_empty:
                continue
            try:
                g_m = shapely_transform(to_grid, g)
            except Exception:
                continue
            if g_m.is_empty:
                continue
            green_geoms.append(g_m)

    tree = STRtree(green_geoms) if green_geoms else None

    grid = pq.read_table(args.grid_parquet, columns=["cell_id", "cell_area_m2", "geometry"])
    cell_ids = grid["cell_id"].to_pylist()
    cell_areas = grid["cell_area_m2"].to_pylist()
    cell_wkbs = grid["geometry"].to_pylist()

    out_green_area = []
    out_share = []

    total_cells = len(cell_ids)
    intersected_cells = 0

    for area_m2, wkb in zip(cell_areas, cell_wkbs):
        if wkb is None or tree is None:
            out_green_area.append(0.0)
            out_share.append(0.0)
            continue

        try:
            cell = wkb_loads(wkb)
        except Exception:
            out_green_area.append(0.0)
            out_share.append(0.0)
            continue

        if cell.is_empty:
            out_green_area.append(0.0)
            out_share.append(0.0)
            continue

        idxs = tree.query(cell)
        if idxs is None or len(idxs) == 0:
            out_green_area.append(0.0)
            out_share.append(0.0)
            continue

        a = 0.0
        for i in idxs.tolist():
            try:
                inter = cell.intersection(green_geoms[i])
            except Exception:
                continue
            if inter.is_empty:
                continue
            a += float(inter.area)

        if a > 0:
            intersected_cells += 1

        out_green_area.append(a)
        denom = float(area_m2) if area_m2 and float(area_m2) > 0 else 0.0
        out_share.append(_clamp(a / denom, 0.0, 1.0) if denom > 0 else 0.0)

    metrics_table = pa.Table.from_arrays(
        [
            pa.array(cell_ids, type=pa.string()),
            pa.array(cell_areas, type=pa.float64()),
            pa.array(out_green_area, type=pa.float64()),
            pa.array(out_share, type=pa.float64()),
        ],
        names=["cell_id", "cell_area_m2", "green_area_m2", "green_share"],
    )

    shares = [v for v in out_share if isinstance(v, (int, float)) and math.isfinite(v)]
    report = {
        "grid_epsg": int(grid_epsg),
        "green_epsg": int(green_epsg),
        "total_cells": int(total_cells),
        "intersected_cells": int(intersected_cells),
        "green_share_min": float(min(shares)) if shares else None,
        "green_share_max": float(max(shares)) if shares else None,
        "green_share_avg": (float(sum(shares)) / len(shares)) if shares else None,
        "dry_run": bool(args.dry_run),
    }

    if args.smoke_json:
        os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
        with open(args.smoke_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(json.dumps(report, separators=(",", ":")))

    if args.dry_run:
        return

    os.makedirs(os.path.dirname(args.out_metrics_parquet), exist_ok=True)
    pq.write_table(metrics_table, args.out_metrics_parquet)

    if args.out_metrics_geojson:
        features = []
        for cid, area_m2, green_m2, share, wkb in zip(cell_ids, cell_areas, out_green_area, out_share, cell_wkbs):
            if wkb is None:
                continue
            try:
                cell = wkb_loads(wkb)
            except Exception:
                continue
            if cell.is_empty:
                continue
            g_wgs = shapely_transform(to_wgs84, cell)
            features.append(
                {
                    "type": "Feature",
                    "properties": {
                        "cell_id": cid,
                        "cell_area_m2": float(area_m2) if area_m2 is not None else None,
                        "green_area_m2": float(green_m2),
                        "green_share": float(share),
                    },
                    "geometry": mapping(g_wgs),
                }
            )

        os.makedirs(os.path.dirname(args.out_metrics_geojson), exist_ok=True)
        with open(args.out_metrics_geojson, "w", encoding="utf-8") as f:
            json.dump({"type": "FeatureCollection", "features": features}, f)
            f.write("\n")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
