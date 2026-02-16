# Vertex Nano Banana Pro 4x4 Pilot

Goal: run a small 4×4 stylization pilot using Vertex AI image generation (Nano Banana Pro / Gemini image on Vertex),
generate `K` candidates per tile, score seams vs already accepted neighbors, pick the best candidate, and output:

- `tiles/` (selected)
- `candidates/` (optional, all K candidates)
- `mosaic_nb_pro.png`
- `report_nb_pro.json`
- `seam_heatmap_nb_pro.png`

This is intended to answer: can we get “isometric.nyc-level” quality and what are the seam bottlenecks.

## Prereqs

- Vertex backend (default):
  - `gcloud` installed and authenticated
  - Either set `VERTEX_ACCESS_TOKEN`, or run: `gcloud auth application-default login`
  - `export IMAGE_BACKEND=vertex`
  - `export VERTEX_PROJECT="$(gcloud config get-value project)"`
  - `export VERTEX_LOCATION=global`
- Gemini backend (optional):
  - `export IMAGE_BACKEND=gemini`
  - `export GOOGLE_API_KEY=...`

## Inputs

- `--run_id`: release id under `data/releases/<run_id>/...`
- `--tiles_dir`: run-relative directory that contains `tilejson.json` and the whitebox layer.
  - Typical: `exports/iso_whitebox`
- `--layer`: input layer inside `tiles_dir` (default: `raw_whitebox`)
- Optional color reference (extra prompt image):
  - `--ref_tiles_dir`: run-relative directory with a second tile set (e.g. satellite/raw)
  - `--ref_layer`: layer inside `ref_tiles_dir` (the prompt label is `COLOR REFERENCE`)
- Patch selection:
  - `--x0 --y0 --w --h` (default `4x4`)
- Style anchors:
  - `--anchors_dir=<dir>` (3–6 images) OR `--anchors=<p1,p2,...>`
- Prompt:
  - `--prompt_file=<file>`
  - `--negative_prompt_file=<file>` (optional)

## Run

Example:

```bash
pnpm -C packages/data iso:vertex:nbpro \
  --run_id=tashkent_local_2026-02-09 \
  --tiles_dir=exports/iso_whitebox \
  --layer=raw_whitebox \
  --ref_tiles_dir=exports/iso_satellite \
  --ref_layer=raw_satellite \
  --x0=0 --y0=0 --w=4 --h=4 \
  --out_dir=exports/iso_nb_pro \
  --model=gemini-3-pro-image-preview \
  --fallback_model=gemini-2.5-flash-image \
  --anchors_dir=exports/anchors/nbpro \
  --prompt_file=exports/prompts/nbpro.txt \
  --negative_prompt_file=exports/prompts/nbpro_negative.txt \
  --k=4 \
  --overlap_px=48 \
  --neighbor_mode=left+top
```

## Outputs

Written under:

`data/releases/<run_id>/<out_dir>/`

Key files:

- `tiles/0/x/y.png`
- `candidates/<x>_<y>/vXX-seedYYYY.png`
- `mosaic_nb_pro.png`
- `report_nb_pro.json`
- `seam_heatmap_nb_pro.png`

## Troubleshooting

- HTTP 429 / Resource exhausted:
  - Keep `--fallback_model` enabled
  - Reduce `--k` and/or run later
  - Increase retry: `--retry_max`, `--retry_max_ms`
