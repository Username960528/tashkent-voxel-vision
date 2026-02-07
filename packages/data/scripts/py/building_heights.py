import argparse
import hashlib
import json
import math
import os
import re
import sys

import pyarrow as pa
import pyarrow.parquet as pq


_HEIGHT_RE = re.compile(r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(m)?\s*$", re.IGNORECASE)
_LEVELS_RE = re.compile(r"^\s*([0-9]+)")


def _heuristic_height_m(id_str):
    # Deterministic 8..20m (inclusive), stable by id string.
    h = hashlib.sha256(id_str.encode("utf-8")).hexdigest()
    n = int(h[:8], 16)
    return 8.0 + (n % 1201) / 100.0


def _parse_height_m(raw):
    if raw is None:
        return None
    if not isinstance(raw, str):
        raw = str(raw)

    m = _HEIGHT_RE.match(raw)
    if not m:
        return None
    try:
        return float(m.group(1))
    except Exception:
        return None


def _parse_levels_int(raw):
    if raw is None:
        return None
    if not isinstance(raw, str):
        raw = str(raw)

    m = _LEVELS_RE.match(raw)
    if not m:
        return None
    try:
        v = int(m.group(1))
    except Exception:
        return None
    return v if v > 0 else None


def _pct(sorted_vals, p):
    if not sorted_vals:
        return None
    n = len(sorted_vals)
    # "Nearest rank" percentile.
    k = int(math.ceil(p * n)) - 1
    k = max(0, min(n - 1, k))
    return float(sorted_vals[k])


def main():
    ap = argparse.ArgumentParser(description="Add deterministic building heights to a buildings GeoParquet (WKB).")
    ap.add_argument("--in_parquet", required=True, help="Input buildings parquet path")
    ap.add_argument("--out_parquet", required=True, help="Output parquet path (may be same as input)")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    ap.add_argument("--dry_run", action="store_true", help="Compute report but do not write output parquet")
    args = ap.parse_args()

    table = pq.read_table(args.in_parquet)

    if "id" not in table.column_names:
        raise SystemExit("Invalid buildings parquet: missing required column: id")

    ids = table["id"].to_pylist()
    heights_raw = table["height"].to_pylist() if "height" in table.column_names else [None] * len(ids)
    levels_raw = (
        table["building_levels"].to_pylist() if "building_levels" in table.column_names else [None] * len(ids)
    )

    out_height_m = []
    out_levels_int = []
    out_source = []

    counts = {"height": 0, "levels": 0, "heuristic": 0}

    for id_val, h_raw, lvl_raw in zip(ids, heights_raw, levels_raw):
        id_str = "" if id_val is None else str(id_val)

        h_m = _parse_height_m(h_raw)
        if h_m is not None:
            out_height_m.append(float(h_m))
            out_levels_int.append(None)
            out_source.append("height")
            counts["height"] += 1
            continue

        levels = _parse_levels_int(lvl_raw)
        if levels is not None:
            out_height_m.append(float(levels) * 3.2)
            out_levels_int.append(int(levels))
            out_source.append("levels")
            counts["levels"] += 1
            continue

        out_height_m.append(_heuristic_height_m(id_str))
        out_levels_int.append(None)
        out_source.append("heuristic")
        counts["heuristic"] += 1

    height_arr = pa.array(out_height_m, type=pa.float64())
    levels_arr = pa.array(out_levels_int, type=pa.int32())
    src_arr = pa.array(out_source, type=pa.string())

    def upsert_column(t, name, arr):
        if name in t.column_names:
            i = t.schema.get_field_index(name)
            return t.set_column(i, name, arr)
        return t.append_column(name, arr)

    out_table = table
    out_table = upsert_column(out_table, "height_m", height_arr)
    out_table = upsert_column(out_table, "levels_int", levels_arr)
    out_table = upsert_column(out_table, "height_source", src_arr)

    heights_sorted = sorted(out_height_m)
    report = {
        "row_count": len(out_height_m),
        "height_source_counts": counts,
        "min": float(heights_sorted[0]) if heights_sorted else None,
        "median": _pct(heights_sorted, 0.50),
        "p95": _pct(heights_sorted, 0.95),
        "dry_run": bool(args.dry_run),
        "out_columns": out_table.column_names,
    }

    if args.smoke_json:
        os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
        with open(args.smoke_json, "w", encoding="utf-8") as f:
            json.dump(report, f)
            f.write("\n")

    print(json.dumps(report, separators=(",", ":")))

    if not args.dry_run:
        os.makedirs(os.path.dirname(args.out_parquet), exist_ok=True)
        pq.write_table(out_table, args.out_parquet)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)

