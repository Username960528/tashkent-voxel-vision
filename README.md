# tashkent-voxel-vision

Monorepo for building an interactive (MapLibre + PMTiles) voxel-like 3D map of Tashkent.

## Prereqs
- Node.js >= 18.17
- `pnpm` (recommended via Corepack):
  - `corepack enable`
  - `corepack prepare pnpm@9.15.4 --activate`

## Quickstart
```bash
pnpm install
pnpm dev
```

## Workspace Layout
- `apps/web`: Next.js web app (MapLibre UI)
- `packages/shared`: shared types/utils
- `packages/data`: data pipeline CLIs (AOI, OSM, tiles, metrics)

