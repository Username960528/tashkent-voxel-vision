import argparse
import json
import math
import os
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely.geometry import box, shape
from shapely.ops import transform as shapely_transform


def _load_geojson_geometry(obj):
    if not isinstance(obj, dict):
        raise ValueError("Invalid GeoJSON: expected object")

    if obj.get("type") == "FeatureCollection":
        features = obj.get("features") or []
        if not features:
            raise ValueError("Invalid FeatureCollection: missing features[0]")
        geom = (features[0] or {}).get("geometry")
        if not isinstance(geom, dict):
            raise ValueError("Invalid FeatureCollection: missing features[0].geometry")
        return geom

    if obj.get("type") == "Feature":
        geom = obj.get("geometry")
        if not isinstance(geom, dict):
            raise ValueError("Invalid Feature: missing geometry")
        return geom

    if "type" in obj and "coordinates" in obj:
        return obj

    raise ValueError("Invalid GeoJSON: expected Geometry | Feature | FeatureCollection")


def _epsg_code(crs):
    if not crs.startswith("EPSG:"):
        raise ValueError(f"Expected CRS like EPSG:XXXX, got: {crs}")
    return int(crs.split(":", 1)[1])


def main():
    ap = argparse.ArgumentParser(description="Generate a regular meter grid over an AOI and write GeoParquet (WKB).")
    ap.add_argument("--aoi_geojson", required=True, help="Path to AOI GeoJSON (EPSG:4326)")
    ap.add_argument("--out_parquet", required=True, help="Output parquet path")
    ap.add_argument("--cell", required=True, type=float, help="Grid cell size in meters (e.g. 500)")
    ap.add_argument("--out_crs", default="EPSG:32642", help="Projected CRS for output geometry (default: EPSG:32642)")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    args = ap.parse_args()

    cell = args.cell
    if not (cell > 0):
        raise SystemExit("--cell must be > 0")

    with open(args.aoi_geojson, "r", encoding="utf-8") as f:
        geojson = json.load(f)

    geom_obj = _load_geojson_geometry(geojson)
    geom = shape(geom_obj)
    if geom.geom_type not in ("Polygon", "MultiPolygon"):
        raise SystemExit(f"AOI geometry must be Polygon or MultiPolygon; got: {geom.geom_type}")

    # Project to meters for grid generation.
    transformer = Transformer.from_crs("EPSG:4326", args.out_crs, always_xy=True)
    geom_m = shapely_transform(transformer.transform, geom)

    minx, miny, maxx, maxy = geom_m.bounds
    start_ix = math.floor(minx / cell)
    end_ix = math.ceil(maxx / cell)
    start_iy = math.floor(miny / cell)
    end_iy = math.ceil(maxy / cell)

    cell_ids = []
    areas = []
    wkbs = []

    cell_int = int(cell) if float(int(cell)) == float(cell) else cell
    id_prefix = f"utm42n_{cell_int}m"

    for ix in range(start_ix, end_ix):
        x0 = ix * cell
        x1 = (ix + 1) * cell
        for iy in range(start_iy, end_iy):
            y0 = iy * cell
            y1 = (iy + 1) * cell
            poly = box(x0, y0, x1, y1)
            if not poly.intersects(geom_m):
                continue

            cell_ids.append(f"{id_prefix}_{ix}_{iy}")
            areas.append(float(poly.area))
            wkbs.append(poly.wkb)

    cell_count = len(cell_ids)
    if cell_count <= 0:
        raise SystemExit("Grid has 0 cells intersecting AOI (unexpected)")

    os.makedirs(os.path.dirname(args.out_parquet), exist_ok=True)

    table = pa.Table.from_arrays(
        [
            pa.array(cell_ids, type=pa.string()),
            pa.array(areas, type=pa.float64()),
            pa.array(wkbs, type=pa.binary()),
        ],
        names=["cell_id", "cell_area_m2", "geometry"],
    )

    epsg = _epsg_code(args.out_crs)
    geo_meta = {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_type": ["Polygon"],
                "crs": {"id": {"authority": "EPSG", "code": epsg}},
            }
        },
    }
    existing_meta = table.schema.metadata or {}
    new_meta = dict(existing_meta)
    new_meta[b"geo"] = json.dumps(geo_meta).encode("utf-8")
    table = table.replace_schema_metadata(new_meta)

    pq.write_table(table, args.out_parquet)

    if args.smoke_json:
        os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
        with open(args.smoke_json, "w", encoding="utf-8") as f:
            json.dump({"cell_count": cell_count, "out_crs": args.out_crs}, f)
            f.write("\n")

    print(f"Wrote grid: {cell_count} cells -> {args.out_parquet}")


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        # Allows piping output without stacktraces.
        sys.exit(1)

