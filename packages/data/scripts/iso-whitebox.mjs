import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:whitebox --run_id=<id> [--z_min=0 --z_max=2] [--tile_size=512] [--ppm=0.06] [--height_scale=1.6]
                         [--bbox_scale=1] [--bbox_center_lon=<lon> --bbox_center_lat=<lat>]
                         [--min_area_m2=16] [--outline_opacity=0.18]

Inputs:
  data/releases/<run_id>/vector/buildings_simplified.parquet (preferred)
  data/releases/<run_id>/vector/buildings.parquet            (fallback)

Outputs:
  data/releases/<run_id>/exports/iso_whitebox/
    tilejson.json
    report.json
    <z>/<x>/<y>.png

Notes:
  - This is the first step of the \"isometric NYC\"-style pipeline: produce a deterministic geometry render
    per tile, which later becomes the conditioning input for image-to-image stylization.
  - By default we write empty tiles too (for predictable pyramid coverage). Use --skip_empty to omit them.
  - Use --bbox_scale < 1 to render a smaller neighborhood around AOI center (or custom --bbox_center_*).
`);
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('Missing required --run_id');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function scaleBboxAroundCenter({ bbox, scale, centerLon = null, centerLat = null }) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Invalid --bbox_scale: ${String(scale)}`);
  if (Math.abs(scale - 1) < 1e-12) return bbox.slice();

  const fullW = maxLon - minLon;
  const fullH = maxLat - minLat;
  const outW = fullW * scale;
  const outH = fullH * scale;

  const cx = clamp(Number.isFinite(centerLon) ? centerLon : (minLon + maxLon) / 2, minLon, maxLon);
  const cy = clamp(Number.isFinite(centerLat) ? centerLat : (minLat + maxLat) / 2, minLat, maxLat);

  let outMinLon = cx - outW / 2;
  let outMaxLon = cx + outW / 2;
  let outMinLat = cy - outH / 2;
  let outMaxLat = cy + outH / 2;

  if (outMinLon < minLon) {
    outMaxLon += minLon - outMinLon;
    outMinLon = minLon;
  }
  if (outMaxLon > maxLon) {
    outMinLon -= outMaxLon - maxLon;
    outMaxLon = maxLon;
  }
  if (outMinLat < minLat) {
    outMaxLat += minLat - outMinLat;
    outMinLat = minLat;
  }
  if (outMaxLat > maxLat) {
    outMinLat -= outMaxLat - maxLat;
    outMaxLat = maxLat;
  }

  outMinLon = clamp(outMinLon, minLon, maxLon);
  outMaxLon = clamp(outMaxLon, minLon, maxLon);
  outMinLat = clamp(outMinLat, minLat, maxLat);
  outMaxLat = clamp(outMaxLat, minLat, maxLat);

  if (!(outMinLon < outMaxLon && outMinLat < outMaxLat)) {
    throw new Error('Computed bbox after scaling is invalid');
  }

  return [outMinLon, outMinLat, outMaxLon, outMaxLat];
}

export async function renderIsoWhitebox({
  repoRoot,
  runId,
  zMin = 0,
  zMax = 0,
  tileSize = 512,
  ppm = 0.06,
  heightScale = 1.6,
  bboxScale = 1,
  bboxCenterLon = null,
  bboxCenterLat = null,
  minAreaM2 = 16,
  outlineOpacity = 0.18,
  skipEmpty = false,
  maxTiles = 0,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (!Number.isInteger(zMin) || !Number.isInteger(zMax) || zMin < 0 || zMax < 0 || zMin > zMax) {
    throw new Error(`Invalid zoom range: z_min=${String(zMin)} z_max=${String(zMax)}`);
  }
  if (!Number.isFinite(tileSize) || tileSize <= 0) throw new Error(`Invalid --tile_size: ${String(tileSize)}`);
  if (!Number.isFinite(ppm) || ppm <= 0) throw new Error(`Invalid --ppm: ${String(ppm)}`);
  if (!Number.isFinite(heightScale) || heightScale <= 0) throw new Error(`Invalid --height_scale: ${String(heightScale)}`);
  if (!Number.isFinite(minAreaM2) || minAreaM2 < 0) throw new Error(`Invalid --min_area_m2: ${String(minAreaM2)}`);
  if (!Number.isFinite(outlineOpacity) || outlineOpacity < 0 || outlineOpacity > 1) {
    throw new Error(`Invalid --outline_opacity: ${String(outlineOpacity)}`);
  }
  if (!Number.isFinite(maxTiles) || maxTiles < 0) throw new Error(`Invalid --max_tiles: ${String(maxTiles)}`);

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  const bbox = manifest?.aoi?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('Invalid manifest: missing aoi.bbox');
  }
  const bboxUsed = scaleBboxAroundCenter({
    bbox,
    scale: Number.isFinite(bboxScale) ? bboxScale : 1,
    centerLon: bboxCenterLon,
    centerLat: bboxCenterLat,
  });

  const inCandidates = [
    path.join(runRoot, 'vector', 'buildings_simplified.parquet'),
    path.join(runRoot, 'vector', 'buildings.parquet'),
  ];
  const inParquet = (await fileExists(inCandidates[0])) ? inCandidates[0] : inCandidates[1];
  if (!(await fileExists(inParquet))) {
    throw new Error(`Missing buildings parquet: ${inParquet} (run data:osm:extract + data:buildings:heights first)`);
  }

  const outDir = path.join(runRoot, 'exports', 'iso_whitebox');
  await fs.mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.json');

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'iso_whitebox.py');
  await runPython({
    repoRoot,
    scriptPath,
    args: [
      '--in_parquet',
      inParquet,
      '--out_dir',
      outDir,
      '--bbox',
      bboxUsed.join(','),
      '--tile_size',
      String(tileSize),
      '--z_min',
      String(zMin),
      '--z_max',
      String(zMax),
      '--ppm',
      String(ppm),
      '--height_scale',
      String(heightScale),
      '--min_area_m2',
      String(minAreaM2),
      '--outline_opacity',
      String(outlineOpacity),
      ...(skipEmpty ? ['--skip_empty'] : []),
      ...(maxTiles ? ['--max_tiles', String(maxTiles)] : []),
      '--report_json',
      reportPath,
    ],
  });

  const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
  const tileCount = Number(report?.tile_count ?? 0);
  if (!Number.isFinite(tileCount) || tileCount <= 0) {
    throw new Error(`Smoke check failed: expected tile_count > 0, got: ${String(report?.tile_count)}`);
  }

  const tilejsonAbs = path.join(outDir, 'tilejson.json');
  if (!(await fileExists(tilejsonAbs))) throw new Error(`Missing tilejson.json: ${tilejsonAbs}`);

  // For now, we only record the metadata files. Recording every tile would bloat manifest.json.
  await addFilesToManifest({ manifestPath, runRoot, absPaths: [tilejsonAbs, reportPath] });

  return {
    inParquet,
    outDir,
    bboxUsed,
    tileCount,
    tilejsonRel: path.relative(runRoot, tilejsonAbs).replaceAll('\\', '/'),
    reportRel: path.relative(runRoot, reportPath).replaceAll('\\', '/'),
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const zMin = Number(typeof args.z_min === 'string' ? args.z_min : args.zMin);
  const zMax = Number(typeof args.z_max === 'string' ? args.z_max : args.zMax);
  const tileSize = Number(typeof args.tile_size === 'string' ? args.tile_size : args.tileSize);
  const ppm = Number(typeof args.ppm === 'string' ? args.ppm : args.pixels_per_meter);
  const heightScale = Number(typeof args.height_scale === 'string' ? args.height_scale : args.heightScale);
  const bboxScale = Number(typeof args.bbox_scale === 'string' ? args.bbox_scale : args.bboxScale);
  const bboxCenterLon = Number(typeof args.bbox_center_lon === 'string' ? args.bbox_center_lon : args.bboxCenterLon);
  const bboxCenterLat = Number(typeof args.bbox_center_lat === 'string' ? args.bbox_center_lat : args.bboxCenterLat);
  const minAreaM2 = Number(typeof args.min_area_m2 === 'string' ? args.min_area_m2 : args.minAreaM2);
  const outlineOpacity = Number(typeof args.outline_opacity === 'string' ? args.outline_opacity : args.outlineOpacity);
  const skipEmpty = Boolean(args.skip_empty ?? args.skipEmpty);
  const maxTiles = Number(typeof args.max_tiles === 'string' ? args.max_tiles : args.maxTiles);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await renderIsoWhitebox({
      repoRoot,
      runId,
      zMin: Number.isFinite(zMin) ? zMin : 0,
      zMax: Number.isFinite(zMax) ? zMax : 0,
      tileSize: Number.isFinite(tileSize) ? tileSize : 512,
      ppm: Number.isFinite(ppm) ? ppm : 0.06,
      heightScale: Number.isFinite(heightScale) ? heightScale : 1.6,
      bboxScale: Number.isFinite(bboxScale) ? bboxScale : 1,
      bboxCenterLon: Number.isFinite(bboxCenterLon) ? bboxCenterLon : null,
      bboxCenterLat: Number.isFinite(bboxCenterLat) ? bboxCenterLat : null,
      minAreaM2: Number.isFinite(minAreaM2) ? minAreaM2 : 16,
      outlineOpacity: Number.isFinite(outlineOpacity) ? outlineOpacity : 0.18,
      skipEmpty,
      maxTiles: Number.isFinite(maxTiles) ? maxTiles : 0,
    });
    console.log(JSON.stringify(result));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    console.error('Run with --help for usage.');
    process.exit(1);
  }
}

const isEntrypoint = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return argv1.length > 0 && path.resolve(selfPath) === argv1;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  await main();
}
