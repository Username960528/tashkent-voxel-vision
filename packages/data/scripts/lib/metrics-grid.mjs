import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { addFilesToManifest, getRunPaths } from './artifacts.mjs';
import { runPython } from './python-venv.mjs';

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('Missing required --run_id');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   cell: number,
 *   dryRun?: boolean,
 * }} opts
 */
export async function buildGridGreenMetrics(opts) {
  const { repoRoot, runId, cell, dryRun = false } = opts;
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (!Number.isFinite(cell) || cell <= 0) throw new Error(`Invalid --cell: ${String(cell)}`);

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const gridAbs = path.join(runRoot, 'vector', `grid_${cell}m.parquet`);
  if (!(await fileExists(gridAbs))) {
    throw new Error(`Missing grid parquet: ${gridAbs} (run data:grid first)`);
  }

  const greenAbs = path.join(runRoot, 'vector', 'green.parquet');
  if (!(await fileExists(greenAbs))) {
    throw new Error(`Missing green parquet: ${greenAbs} (run data:osm:extract first)`);
  }

  const outParquetAbs = path.join(runRoot, 'metrics', `grid_${cell}m_metrics.parquet`);
  const outGeojsonAbs = path.join(runRoot, 'metrics', `grid_${cell}m_metrics.geojson`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-metrics-grid-'));
  try {
    const smokePath = path.join(tmpDir, `grid_${cell}m_metrics.smoke.json`);
    const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'grid_metrics_green.py');

    await runPython({
      repoRoot,
      scriptPath,
      args: [
        '--grid_parquet',
        gridAbs,
        '--green_parquet',
        greenAbs,
        '--out_metrics_parquet',
        outParquetAbs,
        '--out_metrics_geojson',
        outGeojsonAbs,
        '--smoke_json',
        smokePath,
        ...(dryRun ? ['--dry_run'] : []),
      ],
    });

    const smoke = JSON.parse(await fs.readFile(smokePath, 'utf8'));

    if (!dryRun) {
      await addFilesToManifest({ manifestPath, runRoot, absPaths: [outParquetAbs, outGeojsonAbs] });
    }

    return {
      run_id: runId,
      cell_m: cell,
      dry_run: dryRun ? true : false,
      inputs: {
        grid: path.relative(repoRoot, gridAbs).replaceAll('\\', '/'),
        green: path.relative(repoRoot, greenAbs).replaceAll('\\', '/'),
      },
      outputs: {
        metrics_parquet: path.relative(repoRoot, outParquetAbs).replaceAll('\\', '/'),
        metrics_geojson: path.relative(repoRoot, outGeojsonAbs).replaceAll('\\', '/'),
      },
      report: smoke,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

