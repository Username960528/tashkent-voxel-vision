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

## Data Pipeline
See `packages/data/README.md`.

## Deployment (VPS)
This repo can be deployed via GitHub Actions over SSH.

Required GitHub repo secrets:
- `TVV_DEPLOY_HOST`: VPS IP/hostname (example: `23.95.75.54`)
- `TVV_DEPLOY_USER`: SSH username (example: `root`)
- `TVV_DEPLOY_SSH_KEY`: private key used by Actions to SSH into the VPS

## Workspace Layout
- `apps/web`: Next.js web app (MapLibre UI)
- `packages/shared`: shared types/utils
- `packages/data`: data pipeline CLIs (AOI, OSM, tiles, metrics)

- Smoke marker: AI-gate e2e test PR.
