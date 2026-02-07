import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:grid --run_id=<id> --cell=<meters> [--force]

Options:
  --run_id   Release run id (folder name)
  --cell     Grid cell size in meters (e.g. 500)
  --force    Overwrite existing output parquet if present
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

function outParquetRelPath(cell) {
  return path.join('vector', `grid_${cell}m.parquet`);
}

export async function generateGrid({ repoRoot, runId, cell, force = false }) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
  if (!Number.isFinite(cell) || cell <= 0) throw new Error(`Invalid --cell: ${String(cell)}`);

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const aoiId = manifest?.aoi?.id;
  if (typeof aoiId !== 'string' || aoiId.length === 0) throw new Error('Invalid manifest: missing aoi.id');

  const aoiGeojsonPath = path.join(runRoot, 'aoi', `${aoiId}.geojson`);
  if (!(await fileExists(aoiGeojsonPath))) {
    throw new Error(`Missing AOI GeoJSON: ${aoiGeojsonPath} (run data:aoi:write first)`);
  }

  const outRel = outParquetRelPath(cell);
  const outAbs = path.join(runRoot, outRel);
  if (!force && (await fileExists(outAbs))) {
    throw new Error(`Refusing to overwrite: ${outAbs} (use --force)`);
  }
  await fs.mkdir(path.dirname(outAbs), { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-grid-'));
  const smokePath = path.join(tmpDir, `grid_${cell}m.smoke.json`);
  try {
    const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'grid.py');
    await runPython({
      repoRoot,
      scriptPath,
      args: [
        '--aoi_geojson',
        aoiGeojsonPath,
        '--out_parquet',
        outAbs,
        '--cell',
        String(cell),
        '--smoke_json',
        smokePath,
      ],
    });

    const smoke = JSON.parse(await fs.readFile(smokePath, 'utf8'));
    const cellCount = Number(smoke?.cell_count ?? 0);
    if (!Number.isFinite(cellCount) || cellCount <= 0) {
      throw new Error(`Smoke check failed: expected cell_count > 0, got: ${String(smoke?.cell_count)}`);
    }

    await addFilesToManifest({ manifestPath, runRoot, absPaths: [outAbs] });
    return { outAbs, outRel, cellCount };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const cellRaw = typeof args.cell === 'string' ? args.cell : '';
  const cell = Number(cellRaw);
  const force = Boolean(args.force);
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const { outAbs, outRel, cellCount } = await generateGrid({ repoRoot, runId, cell, force });
    console.log(`Wrote: ${path.relative(repoRoot, outAbs)} (${cellCount} cells)`);
    console.log(`Updated manifest artifacts: ${outRel}`);
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
