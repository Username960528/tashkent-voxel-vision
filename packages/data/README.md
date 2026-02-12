# Data Pipeline

This workspace contains reproducible CLIs that generate versioned artifacts under `data/releases/<run_id>/...`.

## Prereqs
- Node.js + `pnpm`
- Python 3 (the venv is auto-managed in `packages/data/.venv/` on first run)
- External CLIs (needed for full, non-fixture runs):
  - `osmium` (OSM extract)
  - `tippecanoe` + `pmtiles` (PMTiles build)

macOS (Homebrew):
```bash
brew install osmium-tool tippecanoe pmtiles
```

## Typical Run (Tashkent)
Pick a `run_id` (example: `tashkent_2026-02-07`), then:

Tip: you can create a local `.env` (ignored by git) so you don't have to `export` keys on every run.
See `.env.example`.

```bash
pnpm data:release:init --run_id=tashkent_2026-02-07 --aoi=tashkent
pnpm data:aoi:write --run_id=tashkent_2026-02-07 --aoi=tashkent

pnpm data:osm:fetch --run_id=tashkent_2026-02-07 --region=uzbekistan
pnpm data:osm:extract --run_id=tashkent_2026-02-07

pnpm data:buildings:heights --run_id=tashkent_2026-02-07
pnpm data:buildings:lod --run_id=tashkent_2026-02-07

pnpm data:tiles:buildings --run_id=tashkent_2026-02-07
pnpm data:tiles:base --run_id=tashkent_2026-02-07

# Isometric "whitebox" tile pyramid (conditioning input for pixel stylization, optional)
pnpm data:iso:whitebox --run_id=tashkent_2026-02-07 --z_min=0 --z_max=2 --overlap=0.10

# Google Photorealistic 3D Tiles (conditioning preview, optional)
# - Requires env GMP_API_KEY and a local Chrome/Chromium (set CHROME_EXECUTABLE_PATH if auto-detect fails)
pnpm data:iso:gmp:preview --run_id=tashkent_2026-02-07 --width=1024 --height=1024

# Google Photorealistic 3D Tiles (tile pack over AOI bbox, optional)
# - Renders an NxN grid under exports/iso_gmp_tiles/grid_<N>/raw/0/x/y.png
pnpm data:iso:gmp:tiles --run_id=tashkent_2026-02-07 --grid=3 --width=768 --height=768 --overlap=0.10

# CPU pixel-art stylizer (baseline / fallback, optional)
pnpm data:iso:stylize:pixel --run_id=tashkent_2026-02-07

# No-training stylization baseline (diffusion img2img, optional)
# - Requires a separate venv (auto-managed) at packages/data/.venv-diffusion
pnpm data:iso:stylize:diffusion --run_id=tashkent_2026-02-07 --model=<hf_id_or_local_path>

# Batch diffusion stylization for a directory (tile packs)
pnpm data:iso:stylize:diffusion:dir \
  --run_id=tashkent_2026-02-07 \
  --in_dir=exports/iso_gmp_tiles/grid_3/raw \
  --model=stabilityai/stable-diffusion-xl-base-1.0 \
  --lora=nerijs/pixel-art-xl --lora_scale=0.8 \
  --device=mps --strength=0.30 --steps=12 --guidance=4.5 --seed=0

# Batch CPU pixel stylizer (post-process) for a directory (tile packs)
pnpm data:iso:stylize:pixel:dir \
  --run_id=tashkent_2026-02-07 \
  --in_dir=exports/iso_gmp_tiles/grid_3/sd \
  --out_dir=exports/iso_gmp_tiles/grid_3/pixel \
  --pixel_scale=0.22 --palette=64 --dither --edge_threshold=112 --edge_alpha=0.28 --edge_thickness=1

# Batch image generation via Gemini/Vertex (ported from tg_bot_geek image generation flow)
# 1) Put prompts into a run-relative txt file (one prompt per line)
# 2) Generate many images into exports/gemini_images/
pnpm data:image:batch \
  --run_id=tashkent_2026-02-07 \
  --prompts_file=exports/prompts/batch.txt \
  --out_dir=exports/gemini_images \
  --model=gemini-3-pro-image-preview \
  --fallback_model=gemini-2.5-flash-image \
  --image_size=2K \
  --aspect_ratio=1:1 \
  --temperature=0.45 \
  --top_p=0.9 \
  --candidate_count=3 \
  --concurrency=3

# Vertex mode (optional):
# - Set IMAGE_BACKEND=vertex
# - Set VERTEX_PROJECT and VERTEX_LOCATION
# - Provide VERTEX_ACCESS_TOKEN or run gcloud auth locally
# - For NanoBananoPro pass its model id/resource via --model=...
# - Optional thinking controls: --thinking_budget, --thinking_level, --include_thoughts
# - For gemini-3-pro-image-preview, use VERTEX_LOCATION=global
# - For IMAGE responses, --candidate_count>1 is emulated via repeated calls (variant seeds)
# - If gemini-3-pro-image-preview returns 429 (Resource exhausted), keep fallback_model enabled

# Stitch a quick mosaic for visual QA (optional)
pnpm data:iso:mosaic --run_id=tashkent_2026-02-07 --tiles_dir=exports/iso_gmp_tiles/grid_3 --layer=pixel

# Whitebox seam smoke pipeline (raw -> sd -> sd_seam -> pixel_seam + mosaics + quality report)
pnpm data:iso:whitebox:seam:smoke \
  --run_id=tashkent_2026-02-07 \
  --model=stabilityai/stable-diffusion-xl-base-1.0 \
  --z_min=0 --z_max=0 --tile_size=1024 --ppm=0.09 --height_scale=2.1 --overlap=0.10 \
  --bbox_scale=0.12 --min_area_m2=30 --outline_opacity=0.06 --device=mps

pnpm data:grid --run_id=tashkent_2026-02-07 --cell=500
pnpm data:metrics:grid --run_id=tashkent_2026-02-07 --cell=500

# Satellite Green Masks (Sentinel-2, optional)
pnpm data:green:build --run_id=tashkent_2026-02-07 --years=2024
```

Outputs (per release):
- `aoi/`: AOI GeoJSON + bbox JSON
- `vector/`: extracted GeoParquet layers (`buildings.parquet`, `roads.parquet`, `water.parquet`, `green.parquet`), plus optional `buildings_simplified.parquet`
- `tiles/`: `*.pmtiles` layers for the web app
- `metrics/`: `grid_500m_metrics.parquet` + `grid_500m_metrics.geojson` (web overlay)
- `exports/` (optional): `exports/iso_whitebox/` tile pyramid (`tilejson.json` + `z/x/y.png`)
- `raster/` (optional): Sentinel-2 NDVI composite + `green_mask_<year>.tif` (see `docs/time_slices.md`)

Notes:
- `vector/grid_500m.parquet` is written in a projected CRS (meters) for correct areas.
- The web overlay uses `metrics/grid_500m_metrics.geojson` (WGS84 / EPSG:4326).

## Serving Artifacts (Local Dev)
PMTiles are fetched in the browser via HTTP Range requests, so you need a server that supports `Range`.

This repo includes a small dev server:
```bash
pnpm data:serve --port=8787
```

Then run the web app with:
- `NEXT_PUBLIC_BASE_DATA_URL=http://127.0.0.1:8787/data/releases`
- `NEXT_PUBLIC_RUN_ID=<run_id>` (or use `?run_id=<run_id>` in the URL)
