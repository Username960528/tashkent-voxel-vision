import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:mosaic --run_id=<id> --tiles_dir=<run-rel-dir> [--layer=pixel|sd|raw]
                       [--mode=crop|blend] [--feather_px=0] [--out=<run-rel-file.png>]

Example:
  pnpm data:iso:mosaic --run_id=tashkent_local_2026-02-09 --tiles_dir=exports/iso_gmp_tiles/grid_3 --layer=pixel --mode=blend

Notes:
  - Expects tiles under: <tiles_dir>/<layer>/0/x/y.png
  - Uses overlap from <tiles_dir>/tilejson.json when present, otherwise defaults to 0.
  - mode=crop preserves old behavior; mode=blend feather-blends seam areas using overlap margins.
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
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
}

function ensureRelPath(p) {
  if (typeof p !== 'string' || p.trim().length === 0) return null;
  const clean = p.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean.includes('..')) throw new Error(`Refusing unsafe path with '..': ${p}`);
  return clean;
}

export async function buildIsoMosaic({
  repoRoot,
  runId,
  tilesDirRel,
  layer = 'pixel',
  mode = 'crop',
  featherPx = 0,
  outRel = '',
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof tilesDirRel !== 'string' || tilesDirRel.trim().length === 0) throw new Error('Missing required --tiles_dir');
  if (!['raw', 'sd', 'pixel'].includes(layer)) throw new Error(`Invalid --layer: ${String(layer)}`);
  if (!['crop', 'blend'].includes(mode)) throw new Error(`Invalid --mode: ${String(mode)}`);
  if (!Number.isFinite(featherPx) || featherPx < 0) throw new Error(`Invalid --feather_px: ${String(featherPx)}`);

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);

  const baseAbs = path.join(runRoot, tilesDirRel);
  const inDirAbs = path.join(baseAbs, layer);
  if (!(await fileExists(inDirAbs))) throw new Error(`Missing tiles dir: ${inDirAbs}`);

  const tilejsonAbs = path.join(baseAbs, 'tilejson.json');
  let overlap = 0;
  if (await fileExists(tilejsonAbs)) {
    try {
      const tilejson = JSON.parse(await fs.readFile(tilejsonAbs, 'utf8'));
      const ov = Number(tilejson?.overlap ?? 0);
      if (Number.isFinite(ov) && ov >= 0 && ov < 0.49) overlap = ov;
    } catch {
      // ignore
    }
  }

  const outAbs = path.join(runRoot, outRel || path.join(tilesDirRel, `mosaic_${layer}.png`));
  await fs.mkdir(path.dirname(outAbs), { recursive: true });

  const reportAbs = `${outAbs}.json`;

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'tile_mosaic.py');
  await runPython({
    repoRoot,
    scriptPath,
    args: [
      '--in_dir',
      inDirAbs,
      '--out_png',
      outAbs,
      '--overlap',
      String(overlap),
      '--mode',
      mode,
      '--feather_px',
      String(Math.trunc(featherPx)),
      '--report_json',
      reportAbs,
    ],
  });

  if (!(await fileExists(outAbs))) throw new Error(`Mosaic failed: missing output: ${outAbs}`);
  if (!(await fileExists(reportAbs))) throw new Error(`Mosaic failed: missing report: ${reportAbs}`);

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [outAbs, reportAbs] });

  return {
    tilesDirRel,
    layer,
    overlap,
    mode,
    featherPx: Math.trunc(featherPx),
    outRel: path.relative(runRoot, outAbs).replaceAll('\\', '/'),
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const tilesDirRel = ensureRelPath(typeof args.tiles_dir === 'string' ? args.tiles_dir : args.tilesDir) ?? '';
  const layer = typeof args.layer === 'string' ? args.layer : 'pixel';
  const mode = typeof args.mode === 'string' ? args.mode : 'crop';
  const featherPx = Number(typeof args.feather_px === 'string' ? args.feather_px : args.featherPx);
  const outRel = ensureRelPath(typeof args.out === 'string' ? args.out : '') ?? '';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await buildIsoMosaic({
      repoRoot,
      runId,
      tilesDirRel,
      layer,
      mode,
      featherPx: Number.isFinite(featherPx) ? featherPx : 0,
      outRel,
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
