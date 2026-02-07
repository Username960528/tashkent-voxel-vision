import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { validateManifest } from '../scripts/lib/manifest-schema.mjs';

test('initDataRelease writes a schema-valid manifest and release layout', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-data-release-'));
  try {
    const now = new Date('2026-02-07T00:00:00.000Z');
    const { runRoot, manifestPath } = await initDataRelease({
      repoRoot: tmpRoot,
      runId: 'test_run',
      aoiId: 'tashkent',
      now,
    });

    // Layout check
    for (const dir of ['vector', 'tiles', 'metrics', 'aoi']) {
      await fs.stat(path.join(runRoot, dir));
    }

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

    // Basic field check
    assert.equal(manifest.run_id, 'test_run');
    assert.equal(manifest.created_at, now.toISOString());
    assert.equal(manifest.aoi?.crs, 'EPSG:4326');
    assert.ok(Array.isArray(manifest.artifacts));

    const validation = await validateManifest(manifest);
    assert.equal(validation.valid, true, JSON.stringify(validation.errors, null, 2));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

