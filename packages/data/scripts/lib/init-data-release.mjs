import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveAoi } from './aoi-catalog.mjs';
import { validateManifest } from './manifest-schema.mjs';

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
 *   aoiId: string,
 *   now?: Date,
 *   force?: boolean
 * }} opts
 */
export async function initDataRelease(opts) {
  const { repoRoot, runId, aoiId, now = new Date(), force = false } = opts;
  assertSafeRunId(runId);

  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('Missing repoRoot');
  }
  if (typeof aoiId !== 'string' || aoiId.length === 0) {
    throw new Error('Missing required --aoi');
  }

  const aoi = resolveAoi(aoiId);
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);

  await fs.mkdir(runRoot, { recursive: true });
  for (const dir of ['vector', 'tiles', 'metrics', 'aoi']) {
    await fs.mkdir(path.join(runRoot, dir), { recursive: true });
  }

  const manifestPath = path.join(runRoot, 'manifest.json');
  if (!force && (await fileExists(manifestPath))) {
    throw new Error(`Manifest already exists: ${manifestPath} (use --force to overwrite)`);
  }

  const manifest = {
    run_id: runId,
    created_at: now.toISOString(),
    aoi: {
      id: aoi.id,
      bbox: aoi.bbox,
      crs: aoi.crs,
    },
    sources: {
      osm: {
        date: null,
        etag: null,
      },
    },
    notes: 'Initialized; populate sources.osm + artifacts as data is produced.',
    artifacts: [],
  };

  // Guardrail: ensure we only ever write manifests that validate.
  const validation = await validateManifest(manifest);
  if (!validation.valid) {
    const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    throw new Error(`Internal error: generated manifest failed schema validation:\n${details}`);
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { runRoot, manifestPath, manifest };
}

