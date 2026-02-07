import argparse
import json
import math
import os
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely.ops import transform as shapely_transform
from shapely.wkb import dumps as wkb_dumps
from shapely.wkb import loads as wkb_loads

try:
    # Shapely >= 2
    from shapely.validation import make_valid  # type: ignore
except Exception:  # pragma: no cover
    make_valid = None


def _utm_epsg_for_lon_lat(lon, lat):
    zone = int((lon + 180) // 6) + 1
    if lat >= 0:
        return 32600 + zone
    return 32700 + zone


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _coord_count(geom):
    # A cheap proxy for "complexity" for reports/tests.
    if geom is None or geom.is_empty:
        return 0
    t = geom.geom_type
    if t == "Polygon":
        return len(geom.exterior.coords) if geom.exterior is not None else 0
    if t == "MultiPolygon":
        n = 0
        for g in getattr(geom, "geoms", []):
            if g.geom_type == "Polygon" and g.exterior is not None:
                n += len(g.exterior.coords)
        return n
    return 0


def main():
    ap = argparse.ArgumentParser(description="Simplify buildings geometry for LOD rendering (GeoParquet WKB, WGS84).")
    ap.add_argument("--in_parquet", required=True, help="Input buildings parquet path (WKB geometry in EPSG:4326)")
    ap.add_argument("--out_parquet", required=True, help="Output parquet path (same schema/columns; simplified geometry)")
    ap.add_argument("--geometry_column", default="geometry", help="Geometry column name (default: geometry)")
    ap.add_argument("--min_tolerance_m", type=float, default=0.5, help="Minimum simplify tolerance in meters (default: 0.5)")
    ap.add_argument("--max_tolerance_m", type=float, default=8.0, help="Maximum simplify tolerance in meters (default: 8.0)")
    ap.add_argument(
        "--tolerance_scale",
        type=float,
        default=0.02,
        help="Tolerance scale multiplier vs sqrt(area_m2) in projected CRS (default: 0.02)",
    )
    ap.add_argument("--utm_epsg", type=int, default=0, help="Override projected CRS EPSG (default: infer UTM zone)")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    ap.add_argument("--dry_run", action="store_true", help="Compute report but do not write output parquet")
    args = ap.parse_args()

    pf = pq.ParquetFile(args.in_parquet)
    schema = pf.schema_arrow

    if args.geometry_column not in schema.names:
        raise SystemExit(f"Missing geometry column: {args.geometry_column}")

    geom_idx = schema.get_field_index(args.geometry_column)

    # Infer a UTM EPSG code from the first non-empty geometry if not provided.
    utm_epsg = int(args.utm_epsg) if int(args.utm_epsg) > 0 else None
    if utm_epsg is None:
        for batch in pf.iter_batches(batch_size=256, columns=[args.geometry_column]):
            for geom_wkb in batch.column(0).to_pylist():
                if geom_wkb is None:
                    continue
                try:
                    geom0 = wkb_loads(geom_wkb)
                except Exception:
                    continue
                if geom0.is_empty:
                    continue
                try:
                    c = geom0.representative_point()
                    lon, lat = c.x, c.y
                except Exception:
                    lon, lat = geom0.centroid.x, geom0.centroid.y
                utm_epsg = _utm_epsg_for_lon_lat(lon, lat)
                break
            if utm_epsg is not None:
                break
    if utm_epsg is None:
        # No geometries; fall back to WebMercator. Areas/tolerances won't be meaningful, but we keep it deterministic.
        utm_epsg = 3857

    to_utm = Transformer.from_crs("EPSG:4326", f"EPSG:{utm_epsg}", always_xy=True).transform
    to_wgs84 = Transformer.from_crs(f"EPSG:{utm_epsg}", "EPSG:4326", always_xy=True).transform

    written = 0
    dropped_empty = 0
    simplified = 0
    failed = 0
    total_in_coords = 0
    total_out_coords = 0

    if not args.dry_run:
        os.makedirs(os.path.dirname(args.out_parquet), exist_ok=True)
        writer = pq.ParquetWriter(args.out_parquet, schema)
    else:
        writer = None

    try:
        for batch in pf.iter_batches(batch_size=2048):
            cols = [batch.column(i) for i in range(batch.num_columns)]
            geom_list = cols[geom_idx].to_pylist()

            out_geoms = []
            for geom_wkb in geom_list:
                if geom_wkb is None:
                    out_geoms.append(None)
                    dropped_empty += 1
                    continue

                try:
                    geom = wkb_loads(geom_wkb)
                except Exception:
                    out_geoms.append(geom_wkb)
                    failed += 1
                    continue

                if geom.is_empty:
                    out_geoms.append(geom_wkb)
                    dropped_empty += 1
                    continue

                try:
                    g_utm = shapely_transform(to_utm, geom)
                    area_m2 = float(g_utm.area)
                    tol = _clamp(
                        math.sqrt(area_m2) * float(args.tolerance_scale),
                        float(args.min_tolerance_m),
                        float(args.max_tolerance_m),
                    )

                    in_coords = _coord_count(g_utm)
                    g_s = g_utm.simplify(tol, preserve_topology=True)
                    if g_s.is_empty:
                        out_geoms.append(geom_wkb)
                        total_in_coords += in_coords
                        total_out_coords += in_coords
                        written += 1
                        continue

                    if not g_s.is_valid:
                        fixed = None
                        if make_valid is not None:
                            try:
                                fixed = make_valid(g_s)
                            except Exception:
                                fixed = None
                        if fixed is None or fixed.is_empty:
                            try:
                                fixed = g_s.buffer(0)
                            except Exception:
                                fixed = None
                        if fixed is not None and (not fixed.is_empty) and fixed.geom_type in ("Polygon", "MultiPolygon"):
                            g_s = fixed

                    out_coords = _coord_count(g_s)
                    total_in_coords += in_coords
                    total_out_coords += out_coords
                    if out_coords > 0 and out_coords < in_coords:
                        simplified += 1

                    g_out = shapely_transform(to_wgs84, g_s)
                    out_geoms.append(wkb_dumps(g_out))
                    written += 1
                except Exception:
                    out_geoms.append(geom_wkb)
                    failed += 1

            geom_type = cols[geom_idx].type
            cols[geom_idx] = pa.array(out_geoms, type=geom_type)
            out_batch = pa.RecordBatch.from_arrays(cols, schema=schema)

            if writer is not None:
                writer.write_table(pa.Table.from_batches([out_batch], schema=schema))

        report = {
            "utm_epsg": int(utm_epsg),
            "written": int(written),
            "dropped_empty": int(dropped_empty),
            "simplified": int(simplified),
            "failed": int(failed),
            "avg_in_coords": (total_in_coords / written) if written else 0.0,
            "avg_out_coords": (total_out_coords / written) if written else 0.0,
            "dry_run": bool(args.dry_run),
        }

        if args.smoke_json:
            os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
            with open(args.smoke_json, "w", encoding="utf-8") as f:
                json.dump(report, f)
                f.write("\n")

        print(json.dumps(report, separators=(",", ":")))
    finally:
        if writer is not None:
            writer.close()


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
