import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
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

async function sha256Stream(absPath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const s = createReadStream(absPath);
    s.on('data', (chunk) => hash.update(chunk));
    s.on('error', reject);
    s.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   dryRun?: boolean,
 * }} opts
 */
export async function applyBuildingHeights(opts) {
  const { repoRoot, runId, dryRun = false } = opts;
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const buildingsAbsPath = path.join(runRoot, 'vector', 'buildings.parquet');
  if (!(await fileExists(buildingsAbsPath))) {
    throw new Error(`Missing input parquet: ${buildingsAbsPath} (run osm-extract first)`);
  }

  const beforeSha = dryRun ? null : await sha256Stream(buildingsAbsPath);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-building-heights-'));
  try {
    const smokePath = path.join(tmpDir, 'building_heights.smoke.json');
    const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'building_heights.py');

    await runPython({
      repoRoot,
      scriptPath,
      args: [
        '--in_parquet',
        buildingsAbsPath,
        '--out_parquet',
        buildingsAbsPath,
        '--smoke_json',
        smokePath,
        ...(dryRun ? ['--dry_run'] : []),
      ],
    });

    const smoke = JSON.parse(await fs.readFile(smokePath, 'utf8'));

    let changed = false;
    if (!dryRun) {
      const afterSha = await sha256Stream(buildingsAbsPath);
      changed = beforeSha !== afterSha;
      if (changed) {
        await addFilesToManifest({ manifestPath, runRoot, absPaths: [buildingsAbsPath] });
      }
    }

    return {
      run_id: runId,
      dry_run: dryRun ? true : false,
      input: path.relative(repoRoot, buildingsAbsPath).replaceAll('\\', '/'),
      changed,
      report: smoke,
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

