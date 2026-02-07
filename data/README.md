# Data Layout

This repo keeps large data artifacts out of git.

## Releases

Each data release is stored under:

`data/releases/<run_id>/`

Layout:

- `manifest.json`
- `vector/`
- `tiles/`
- `metrics/`
- `aoi/`

Initialize a new release from the repo root:

```bash
pnpm data:release:init --run_id=<id> --aoi=tashkent
```

Validate a manifest:

```bash
pnpm data:manifest:validate --manifest=data/releases/<id>/manifest.json
```

Note: `data/releases/` is gitignored by default.

