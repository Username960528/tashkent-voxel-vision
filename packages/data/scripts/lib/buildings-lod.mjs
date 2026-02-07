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
 * Build a simplified buildings layer for LOD/distant zooms.
 *
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   dryRun?: boolean,
 * }} opts
 */
export async function buildBuildingsLod(opts) {
  const { repoRoot, runId, dryRun = false } = opts;
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const inAbs = path.join(runRoot, 'vector', 'buildings.parquet');
  if (!(await fileExists(inAbs))) {
    throw new Error(`Missing input parquet: ${inAbs} (run data:osm:extract first)`);
  }

  const outAbs = path.join(runRoot, 'vector', 'buildings_simplified.parquet');

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-buildings-lod-'));
  try {
    const smokePath = path.join(tmpDir, 'buildings_lod.smoke.json');
    const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'buildings_lod.py');

    await runPython({
      repoRoot,
      scriptPath,
      args: [
        '--in_parquet',
        inAbs,
        '--out_parquet',
        outAbs,
        '--smoke_json',
        smokePath,
        ...(dryRun ? ['--dry_run'] : []),
      ],
    });

    const smoke = JSON.parse(await fs.readFile(smokePath, 'utf8'));

    if (!dryRun) {
      await addFilesToManifest({ manifestPath, runRoot, absPaths: [outAbs] });
    }

    return {
      run_id: runId,
      dry_run: dryRun ? true : false,
      input: path.relative(repoRoot, inAbs).replaceAll('\\', '/'),
      output: path.relative(repoRoot, outAbs).replaceAll('\\', '/'),
      report: smoke,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

