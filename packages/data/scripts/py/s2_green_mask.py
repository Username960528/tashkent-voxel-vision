import argparse
import json
import os
import shutil
import sys
import tempfile
from contextlib import ExitStack

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.enums import Resampling
from rasterio.features import rasterize
from rasterio.merge import merge
from rasterio.shutil import copy as rio_copy
from rasterio.vrt import WarpedVRT
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


def _binary_dilate(bin01, radius):
    out = (bin01.astype(np.uint8) & 1).astype(np.uint8)
    r = int(radius)
    if r <= 0:
        return out

    for _ in range(r):
        p = np.pad(out, 1, mode="constant", constant_values=0)
        out = (
            p[:-2, :-2]
            | p[:-2, 1:-1]
            | p[:-2, 2:]
            | p[1:-1, :-2]
            | p[1:-1, 1:-1]
            | p[1:-1, 2:]
            | p[2:, :-2]
            | p[2:, 1:-1]
            | p[2:, 2:]
        ).astype(np.uint8)
    return out


def _binary_erode(bin01, radius):
    out = (bin01.astype(np.uint8) & 1).astype(np.uint8)
    r = int(radius)
    if r <= 0:
        return out

    for _ in range(r):
        p = np.pad(out, 1, mode="constant", constant_values=0)
        out = (
            p[:-2, :-2]
            & p[:-2, 1:-1]
            & p[:-2, 2:]
            & p[1:-1, :-2]
            & p[1:-1, 1:-1]
            & p[1:-1, 2:]
            & p[2:, :-2]
            & p[2:, 1:-1]
            & p[2:, 2:]
        ).astype(np.uint8)
    return out


def _binary_open_close(bin01, opening_px, closing_px):
    out = (bin01.astype(np.uint8) & 1).astype(np.uint8)
    if opening_px > 0:
        out = _binary_dilate(_binary_erode(out, opening_px), opening_px)
    if closing_px > 0:
        out = _binary_erode(_binary_dilate(out, closing_px), closing_px)
    return out.astype(np.uint8)


def _iter_chunks(width, height, block):
    b = int(block)
    if b <= 0:
        raise ValueError("block must be > 0")
    for row_off in range(0, height, b):
        h = min(b, height - row_off)
        for col_off in range(0, width, b):
            w = min(b, width - col_off)
            yield row_off, col_off, h, w


def _make_output_profile(crs, transform, width, height, dtype, nodata):
    profile = {
        "driver": "GTiff",
        "height": int(height),
        "width": int(width),
        "count": 1,
        "dtype": dtype,
        "crs": crs,
        "transform": transform,
        "nodata": nodata,
        "tiled": True,
        "blockxsize": 512,
        "blockysize": 512,
        "compress": "deflate",
        "interleave": "band",
        "bigtiff": "if_safer",
    }
    # Predictor: 2 for integer, 3 for floating point (per GDAL conventions).
    if dtype in ("float32", "float64"):
        profile["predictor"] = 3
    else:
        profile["predictor"] = 2
    return profile


def _write_geotiff(tmp_path, data2d, crs, transform, nodata, overview_resampling):
    h, w = data2d.shape
    profile = _make_output_profile(crs, transform, w, h, str(data2d.dtype), nodata)
    with rasterio.open(tmp_path, "w", **profile) as dst:
        dst.write(data2d, 1)

        # Overviews help with downstream range-read access. Keep them modest.
        factors = []
        f = 2
        while min(h // f, w // f) >= 256:
            factors.append(f)
            f *= 2
        if factors:
            dst.build_overviews(factors, overview_resampling)
            dst.update_tags(ns="rio_overview", resampling=str(overview_resampling))


def _write_cog_or_geotiff(out_path, data2d, crs, transform, nodata, overview_resampling):
    """
    Best-effort COG writer:
    1) write tiled GeoTIFF + internal overviews
    2) if GDAL COG driver is available, copy into a true COG
    """
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    tmp_path = f"{out_path}.tmp.tif"
    _write_geotiff(tmp_path, data2d, crs, transform, nodata, overview_resampling)

    supported = getattr(rasterio, "supported_drivers", {}) or {}
    cog_writable = supported.get("COG") == "w"

    if cog_writable:
        try:
            # Use GDAL's COG driver to reorder IFDs etc.
            rio_copy(tmp_path, out_path, driver="COG")
            os.remove(tmp_path)
            return {"driver": "COG"}
        except Exception as e:
            os.replace(tmp_path, out_path)
            return {"driver": "GTiff", "cog_error": str(e)}

    os.replace(tmp_path, out_path)
    return {"driver": "GTiff", "cog_error": "COG driver not available"}


def main():
    ap = argparse.ArgumentParser(description="Build an NDVI median composite + green mask from Sentinel-2 items.")
    ap.add_argument("--aoi_geojson", required=True, help="AOI GeoJSON (EPSG:4326)")
    ap.add_argument("--items_json", required=True, help="Items JSON (from STAC)")
    ap.add_argument("--config_json", required=True, help="time_slices.json config")
    ap.add_argument("--out_ndvi", required=True, help="Output NDVI GeoTIFF/COG path")
    ap.add_argument("--out_mask", required=True, help="Output green mask GeoTIFF/COG path")
    ap.add_argument("--smoke_json", default="", help="Optional JSON output path for smoke stats")
    ap.add_argument("--block", type=int, default=256, help="Chunk size in pixels (default: 256)")
    args = ap.parse_args()

    with open(args.config_json, "r", encoding="utf-8") as f:
        cfg = json.load(f)

    scl_exclude = list(cfg.get("masking", {}).get("scl_exclude") or [])
    min_valid = int(cfg.get("composite", {}).get("min_valid_observations") or 0)
    threshold = float(cfg.get("classification", {}).get("green_ndvi_threshold") or 0.3)

    morph = cfg.get("postprocess", {}).get("morphology") or {}
    morph_enabled = bool(morph.get("enabled"))
    opening_px = int(morph.get("opening_pixels") or 0)
    closing_px = int(morph.get("closing_pixels") or 0)

    with open(args.aoi_geojson, "r", encoding="utf-8") as f:
        aoi = json.load(f)
    aoi_geom = shape(_load_geojson_geometry(aoi))

    with open(args.items_json, "r", encoding="utf-8") as f:
        items_payload = json.load(f)
    items = items_payload.get("items") or []
    if not isinstance(items, list) or not items:
        raise SystemExit("No items provided (items_json.items is empty)")

    # Group items by MGRS tile. If tile_id is missing, treat as one group.
    groups = {}
    for it in items:
        if not isinstance(it, dict):
            continue
        tile = it.get("tile_id") or "unknown_tile"
        groups.setdefault(tile, []).append(it)

    ndvi_nodata = np.float32(-9999.0)
    mask_nodata = np.uint8(255)

    tmp_root = tempfile.mkdtemp(prefix="tvv-s2-green-")
    tmp_files = []
    smoke = {
        "items": len(items),
        "tiles": 0,
        "proj_epsg": None,
        "ndvi_nodata": float(ndvi_nodata),
        "mask_nodata": int(mask_nodata),
        "min_valid_observations": min_valid,
        "green_ndvi_threshold": threshold,
        "morphology": {"enabled": morph_enabled, "opening_pixels": opening_px, "closing_pixels": closing_px},
        "writers": {},
    }

    try:
        tile_ndvi_paths = []
        tile_mask_paths = []
        out_crs = None

        # Build a fast lookup for SCL masking.
        scl_lookup = np.zeros(256, dtype=np.uint8)
        for v in scl_exclude:
            if 0 <= int(v) < 256:
                scl_lookup[int(v)] = 1
        # Always exclude "No Data" if present.
        scl_lookup[0] = 1

        for tile_id, tile_items in sorted(groups.items()):
            # Open the first item as a reference grid.
            ref_red = tile_items[0].get("assets", {}).get("red")
            if not isinstance(ref_red, str) or not ref_red:
                continue

            with rasterio.Env():
                with rasterio.open(ref_red) as ref_ds:
                    if ref_ds.crs is None:
                        raise SystemExit(f"Missing CRS in red asset for tile {tile_id}")
                    out_crs = ref_ds.crs
                    smoke["proj_epsg"] = int(out_crs.to_epsg() or 0) or None

                    # Transform AOI to tile CRS.
                    transformer = Transformer.from_crs("EPSG:4326", out_crs, always_xy=True)
                    aoi_m = shapely_transform(transformer.transform, aoi_geom)

                    tile_bounds_poly = box(*ref_ds.bounds)
                    inter = tile_bounds_poly.intersection(aoi_m)
                    if inter.is_empty:
                        continue

                    # Window on the red/NIR 10m grid, covering the AOI intersection bbox.
                    win = ref_ds.window(*inter.bounds)
                    win = win.round_offsets().round_lengths()
                    if win.width <= 0 or win.height <= 0:
                        continue

                    w = int(win.width)
                    h = int(win.height)
                    win_transform = rasterio.windows.transform(win, ref_ds.transform)

                    # Rasterize AOI mask for this window to avoid writing outside AOI.
                    aoi_mask = rasterize(
                        [inter],
                        out_shape=(h, w),
                        transform=win_transform,
                        fill=0,
                        default_value=1,
                        dtype=np.uint8,
                        all_touched=False,
                    )

                    # Prepare intermediate outputs.
                    smoke["tiles"] += 1
                    ndvi_tile_path = os.path.join(tmp_root, f"ndvi_{tile_id}.tif")
                    mask_tile_path = os.path.join(tmp_root, f"mask_{tile_id}.tif")
                    tile_ndvi_paths.append(ndvi_tile_path)
                    tile_mask_paths.append(mask_tile_path)
                    tmp_files.extend([ndvi_tile_path, mask_tile_path])

                    ndvi_profile = _make_output_profile(out_crs, win_transform, w, h, "float32", float(ndvi_nodata))
                    # Open all remote assets once per tile for performance.
                    scenes = []
                    for it in tile_items:
                        a = it.get("assets") or {}
                        red_href = a.get("red")
                        nir_href = a.get("nir")
                        scl_href = a.get("scl")
                        if isinstance(red_href, str) and isinstance(nir_href, str) and isinstance(scl_href, str):
                            scenes.append((red_href, nir_href, scl_href))
                    if not scenes:
                        continue

                    with ExitStack() as stack:
                        ds_reds = []
                        ds_nirs = []
                        ds_scls = []
                        for red_href, nir_href, scl_href in scenes:
                            red_ds = stack.enter_context(rasterio.open(red_href))
                            nir_ds = stack.enter_context(rasterio.open(nir_href))
                            scl_ds = stack.enter_context(rasterio.open(scl_href))
                            scl_vrt = stack.enter_context(
                                WarpedVRT(
                                    scl_ds,
                                    crs=ref_ds.crs,
                                    transform=ref_ds.transform,
                                    width=ref_ds.width,
                                    height=ref_ds.height,
                                    resampling=Resampling.nearest,
                                )
                            )
                            ds_reds.append(red_ds)
                            ds_nirs.append(nir_ds)
                            ds_scls.append(scl_vrt)

                        with rasterio.open(ndvi_tile_path, "w", **ndvi_profile) as ndvi_dst:
                            mask_full = np.full((h, w), mask_nodata, dtype=np.uint8)

                            # Process chunks to keep memory bounded.
                            for row_off, col_off, ch, cw in _iter_chunks(w, h, args.block):
                                src_win = rasterio.windows.Window(
                                    col_off=win.col_off + col_off,
                                    row_off=win.row_off + row_off,
                                    width=cw,
                                    height=ch,
                                )
                                out_win = rasterio.windows.Window(
                                    col_off=col_off,
                                    row_off=row_off,
                                    width=cw,
                                    height=ch,
                                )

                                aoi_mask_chunk = aoi_mask[row_off : row_off + ch, col_off : col_off + cw]

                                n = len(ds_reds)
                                ndvi_stack = np.full((n, ch, cw), np.nan, dtype=np.float32)

                                for i in range(n):
                                    red = ds_reds[i].read(1, window=src_win).astype(np.float32, copy=False)
                                    nir = ds_nirs[i].read(1, window=src_win).astype(np.float32, copy=False)
                                    scl = ds_scls[i].read(1, window=src_win)
                                    if scl.dtype != np.uint8:
                                        scl = scl.astype(np.uint8, copy=False)

                                    valid_scl = (scl_lookup[scl] == 0).astype(bool)
                                    valid = (aoi_mask_chunk == 1) & valid_scl & (red > 0) & (nir > 0)

                                    den = nir + red
                                    ndvi = np.empty_like(red, dtype=np.float32)
                                    ndvi[:] = np.nan
                                    ndvi[valid] = (nir[valid] - red[valid]) / den[valid]
                                    ndvi_stack[i, :, :] = ndvi

                                valid_counts = np.sum(np.isfinite(ndvi_stack), axis=0)
                                ndvi_med = np.nanmedian(ndvi_stack, axis=0).astype(np.float32, copy=False)

                                ok = (valid_counts >= min_valid) & (aoi_mask_chunk == 1)
                                ndvi_out = np.full((ch, cw), ndvi_nodata, dtype=np.float32)
                                ndvi_out[ok] = ndvi_med[ok]

                                ndvi_dst.write(ndvi_out, 1, window=out_win)

                                # Raw mask (morphology applied after mosaic to avoid tile seams).
                                m = np.full((ch, cw), mask_nodata, dtype=np.uint8)
                                m[ok] = (ndvi_med[ok] >= threshold).astype(np.uint8)
                                mask_full[row_off : row_off + ch, col_off : col_off + cw] = m

                        # Write raw tile mask.
                        mask_profile = _make_output_profile(out_crs, win_transform, w, h, "uint8", int(mask_nodata))
                        with rasterio.open(mask_tile_path, "w", **mask_profile) as mask_dst:
                            mask_dst.write(mask_full, 1)

        if not tile_ndvi_paths or not tile_mask_paths:
            raise SystemExit("No tile outputs produced (AOI may be empty or outside scene footprints)")

        # Merge tiles into one mosaic per output.
        with ExitStack() as stack:
            ndvi_srcs = [stack.enter_context(rasterio.open(p)) for p in tile_ndvi_paths]
            ndvi_mosaic, ndvi_transform = merge(ndvi_srcs, nodata=float(ndvi_nodata))
            ndvi_mosaic = ndvi_mosaic[0].astype(np.float32, copy=False)

        with ExitStack() as stack:
            mask_srcs = [stack.enter_context(rasterio.open(p)) for p in tile_mask_paths]
            mask_mosaic, mask_transform = merge(mask_srcs, nodata=int(mask_nodata))
            mask_mosaic = mask_mosaic[0].astype(np.uint8, copy=False)

        # Apply morphology on the merged mask (inside valid pixels only).
        valid = mask_mosaic != mask_nodata
        bin01 = (mask_mosaic == 1).astype(np.uint8)
        if morph_enabled and (opening_px > 0 or closing_px > 0):
            bin01 = _binary_open_close(bin01, opening_px, closing_px)
        mask_final = np.where(valid, bin01, mask_nodata).astype(np.uint8)

        # Write final outputs as COG if possible (else tiled GeoTIFF).
        out_epsg = int(out_crs.to_epsg() or 0) if out_crs is not None else None
        smoke["proj_epsg"] = out_epsg

        smoke["writers"]["ndvi"] = _write_cog_or_geotiff(
            args.out_ndvi, ndvi_mosaic, out_crs, ndvi_transform, float(ndvi_nodata), Resampling.average
        )
        smoke["writers"]["mask"] = _write_cog_or_geotiff(
            args.out_mask, mask_final, out_crs, mask_transform, int(mask_nodata), Resampling.nearest
        )

        # Basic stats
        valid_px = int(np.sum(valid))
        green_px = int(np.sum(mask_final == 1))
        smoke["mosaic"] = {
            "width": int(mask_final.shape[1]),
            "height": int(mask_final.shape[0]),
            "valid_px": valid_px,
            "green_px": green_px,
            "green_share_px": float(green_px / valid_px) if valid_px > 0 else None,
        }

        if args.smoke_json:
            os.makedirs(os.path.dirname(args.smoke_json), exist_ok=True)
            with open(args.smoke_json, "w", encoding="utf-8") as f:
                json.dump(smoke, f)
                f.write("\n")

        print(f"Wrote: {args.out_ndvi}")
        print(f"Wrote: {args.out_mask}")
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


if __name__ == "__main__":
    try:
        main()
    except BrokenPipeError:
        sys.exit(1)
