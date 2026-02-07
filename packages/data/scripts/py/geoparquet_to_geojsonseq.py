import argparse
import json
import os
import sys

import pyarrow.parquet as pq
from shapely.geometry import mapping
from shapely.wkb import loads as wkb_loads


def _as_jsonable(v):
    # Keep this conservative; tippecanoe expects JSON-compatible types.
    if v is None:
        return None
    if isinstance(v, (str, int, float, bool)):
        return v
    if isinstance(v, bytes):
        try:
            return v.decode("utf-8")
        except Exception:
            return v.hex()
    return str(v)


def main():
    ap = argparse.ArgumentParser(description="Convert GeoParquet (WKB) to GeoJSONSeq (one Feature per line).")
    ap.add_argument("--in_parquet", required=True, help="Input parquet path (geometry in WKB bytes)")
    ap.add_argument("--out_geojsonseq", required=True, help="Output GeoJSONSeq path")
    ap.add_argument("--geometry_column", default="geometry", help="Geometry column name (default: geometry)")
    ap.add_argument(
        "--properties",
        default="id,class",
        help="Comma-separated list of property columns to include (default: id,class)",
    )
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path with counts")
    args = ap.parse_args()

    prop_cols = [c.strip() for c in (args.properties or "").split(",") if c.strip()]
    cols = [args.geometry_column, *prop_cols]

    pf = pq.ParquetFile(args.in_parquet)

    written = 0
    dropped_empty = 0

    os.makedirs(os.path.dirname(args.out_geojsonseq), exist_ok=True)
    with open(args.out_geojsonseq, "w", encoding="utf-8") as out:
        for batch in pf.iter_batches(columns=cols):
            geom_list = batch.column(0).to_pylist()
            props_lists = [batch.column(i + 1).to_pylist() for i in range(len(prop_cols))]

            for i, geom_wkb in enumerate(geom_list):
                if geom_wkb is None:
                    dropped_empty += 1
                    continue

                try:
                    geom = wkb_loads(geom_wkb)
                except Exception:
                    dropped_empty += 1
                    continue

                if geom.is_empty:
                    dropped_empty += 1
                    continue

                props = {}
                for col_idx, col_name in enumerate(prop_cols):
                    props[col_name] = _as_jsonable(props_lists[col_idx][i])

                feature = {
                    "type": "Feature",
                    "properties": props,
                    "geometry": mapping(geom),
                }
                out.write("\x1e")
                out.write(json.dumps(feature, ensure_ascii=False))
                out.write("\n")
                written += 1

    smoke = {"written": written, "dropped_empty": dropped_empty, "properties": prop_cols}
    if args.smoke_json:
        os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
        with open(args.smoke_json, "w", encoding="utf-8") as f:
            json.dump(smoke, f)
            f.write("\n")

    print(json.dumps(smoke, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)

