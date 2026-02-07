import argparse
import hashlib
import json
import os
import sys

import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import shape
from shapely.ops import unary_union

try:
    # Shapely >= 2
    from shapely.validation import make_valid  # type: ignore
except Exception:  # pragma: no cover
    make_valid = None


def _iter_geojsonseq(path):
    with open(path, "r", encoding="utf-8") as f:
        for raw_line in f:
            line = raw_line.strip()
            if not line:
                continue
            if line[0] == "\x1e":  # RFC8142 record separator
                line = line[1:]
            if not line:
                continue
            yield line, json.loads(line)


def _stable_fallback_id(line):
    h = hashlib.sha256(line.encode("utf-8")).hexdigest()
    return f"hash/{h[:16]}"


def _class_for(layer, props):
    if layer == "buildings":
        v = props.get("building")
        return v if isinstance(v, str) and v else "building"
    if layer == "roads":
        v = props.get("highway")
        return v if isinstance(v, str) and v else "road"
    if layer == "water":
        for k in ("waterway", "water", "natural"):
            v = props.get(k)
            if isinstance(v, str) and v:
                return v
        return "water"
    if layer == "green":
        for k in ("landuse", "leisure", "natural"):
            v = props.get(k)
            if isinstance(v, str) and v:
                return v
        return "green"
    raise ValueError(f"Unknown layer: {layer}")


def _coerce_str(value):
    if value is None:
        return None
    if isinstance(value, str):
        return value
    return str(value)


def _default_geom_types_for_layer(layer):
    if layer == "buildings":
        return ["Polygon", "MultiPolygon"]
    if layer == "roads":
        return ["LineString", "MultiLineString"]
    if layer == "water":
        return ["Polygon", "MultiPolygon", "LineString", "MultiLineString"]
    if layer == "green":
        return ["Polygon", "MultiPolygon"]
    return []


def main():
    ap = argparse.ArgumentParser(description="Convert GeoJSONSeq (WGS84) to GeoParquet (WKB) with light normalization.")
    ap.add_argument("--layer", required=True, choices=["buildings", "roads", "water", "green"], help="Output layer name")
    ap.add_argument("--in_geojsonseq", required=True, help="Input GeoJSONSeq path (RFC8142 or line-delimited JSON)")
    ap.add_argument("--out_parquet", required=True, help="Output parquet path (GeoParquet WKB, EPSG:4326)")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    args = ap.parse_args()

    rows_id = []
    rows_source = []
    rows_class = []
    rows_name = []
    rows_height = []
    rows_building_levels = []
    rows_wkb = []

    dropped_empty = 0
    invalid_polygons = 0
    fixed_polygons = 0
    skipped_invalid = 0
    input_features = 0

    geom_types = set()

    for line, obj in _iter_geojsonseq(args.in_geojsonseq):
        input_features += 1

        if not isinstance(obj, dict) or obj.get("type") != "Feature":
            # Non-feature lines are ignored (defensive).
            dropped_empty += 1
            continue

        props = obj.get("properties") or {}
        if not isinstance(props, dict):
            props = {}

        geom_obj = obj.get("geometry")
        if not isinstance(geom_obj, dict):
            dropped_empty += 1
            continue

        try:
            geom = shape(geom_obj)
        except Exception:
            dropped_empty += 1
            continue

        if geom.is_empty:
            dropped_empty += 1
            continue

        allowed_types = set(_default_geom_types_for_layer(args.layer))
        if allowed_types and geom.geom_type not in allowed_types:
            # `osmium export` can emit Points/LineStrings when ways are incomplete (eg near AOI boundary).
            # Keep layers clean by dropping unexpected geometry types.
            dropped_empty += 1
            continue

        if geom.geom_type in ("Polygon", "MultiPolygon") and not geom.is_valid:
            invalid_polygons += 1
            fixed = None
            if make_valid is not None:
                try:
                    fixed = make_valid(geom)
                except Exception:
                    fixed = None

            if fixed is None or fixed.is_empty:
                skipped_invalid += 1
                continue

            if fixed.geom_type == "GeometryCollection":
                polys = [g for g in getattr(fixed, "geoms", []) if g.geom_type in ("Polygon", "MultiPolygon") and not g.is_empty]
                fixed = unary_union(polys) if polys else None

            if fixed is None or fixed.is_empty or fixed.geom_type not in ("Polygon", "MultiPolygon"):
                skipped_invalid += 1
                continue

            geom = fixed
            fixed_polygons += 1

        geom_types.add(geom.geom_type)

        osm_type = props.get("@type")
        osm_id = props.get("@id")
        if isinstance(osm_type, str) and osm_type and osm_id is not None:
            fid = f"{osm_type}/{osm_id}"
        else:
            fid = _stable_fallback_id(line)

        name = _coerce_str(props.get("name"))
        cls = _class_for(args.layer, props)

        rows_id.append(str(fid))
        rows_source.append("osm")
        rows_class.append(_coerce_str(cls))
        rows_name.append(name)
        rows_wkb.append(geom.wkb)

        if args.layer == "buildings":
            rows_height.append(_coerce_str(props.get("height")))
            rows_building_levels.append(_coerce_str(props.get("building:levels")))
        else:
            rows_height.append(None)
            rows_building_levels.append(None)

    # Always write an output file (even empty), so downstream steps are deterministic.
    os.makedirs(os.path.dirname(args.out_parquet), exist_ok=True)

    table = pa.Table.from_arrays(
        [
            pa.array(rows_id, type=pa.string()),
            pa.array(rows_source, type=pa.string()),
            pa.array(rows_class, type=pa.string()),
            pa.array(rows_name, type=pa.string()),
            pa.array(rows_height, type=pa.string()),
            pa.array(rows_building_levels, type=pa.string()),
            pa.array(rows_wkb, type=pa.binary()),
        ],
        names=["id", "source", "class", "name", "height", "building_levels", "geometry"],
    )

    types_out = sorted(geom_types) if geom_types else _default_geom_types_for_layer(args.layer)
    geo_meta = {
        "version": "1.0.0",
        "primary_column": "geometry",
        "columns": {
            "geometry": {
                "encoding": "WKB",
                "geometry_type": types_out,
                "crs": {"id": {"authority": "EPSG", "code": 4326}},
            }
        },
    }
    existing_meta = table.schema.metadata or {}
    new_meta = dict(existing_meta)
    new_meta[b"geo"] = json.dumps(geo_meta).encode("utf-8")
    table = table.replace_schema_metadata(new_meta)

    pq.write_table(table, args.out_parquet)

    written = table.num_rows
    smoke = {
        "layer": args.layer,
        "input_features": input_features,
        "written": written,
        "dropped_empty": dropped_empty,
        "invalid_polygons": invalid_polygons,
        "fixed_polygons": fixed_polygons,
        "skipped_invalid": skipped_invalid,
        "geometry_types": types_out,
    }

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
