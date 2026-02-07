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

```bash
pnpm data:release:init --run_id=tashkent_2026-02-07 --aoi=tashkent
pnpm data:aoi:write --run_id=tashkent_2026-02-07 --aoi=tashkent

pnpm data:osm:fetch --run_id=tashkent_2026-02-07 --region=uzbekistan
pnpm data:osm:extract --run_id=tashkent_2026-02-07

pnpm data:buildings:heights --run_id=tashkent_2026-02-07
pnpm data:buildings:lod --run_id=tashkent_2026-02-07

pnpm data:tiles:buildings --run_id=tashkent_2026-02-07
pnpm data:tiles:base --run_id=tashkent_2026-02-07

pnpm data:grid --run_id=tashkent_2026-02-07 --cell=500
pnpm data:metrics:grid --run_id=tashkent_2026-02-07 --cell=500
```

Outputs (per release):
- `aoi/`: AOI GeoJSON + bbox JSON
- `vector/`: extracted GeoParquet layers (`buildings.parquet`, `roads.parquet`, `water.parquet`, `green.parquet`), plus optional `buildings_simplified.parquet`
- `tiles/`: `*.pmtiles` layers for the web app
- `metrics/`: `grid_500m_metrics.parquet` + `grid_500m_metrics.geojson` (web overlay)

Notes:
- `vector/grid_500m.parquet` is written in a projected CRS (meters) for correct areas.
- The web overlay uses `metrics/grid_500m_metrics.geojson` (WGS84 / EPSG:4326).

