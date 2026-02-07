import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { generateGrid } from '../scripts/grid.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { findRepoRoot } from '../scripts/lib/repo-root.mjs';

test('smoke: AOI write + 500m grid writes artifacts and updates manifest', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `smoke_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');

  try {
    await initDataRelease({ repoRoot, runId, aoiId: 'tashkent', force: false });

    await writeAoi({ repoRoot, runId, aoiId: 'tashkent', force: false });
    const grid = await generateGrid({ repoRoot, runId, cell: 500, force: false });

    assert.ok(grid.cellCount > 0);
    await fs.stat(path.join(runRoot, 'vector', 'grid_500m.parquet'));

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const paths = new Set((manifest.artifacts ?? []).map((a) => a.path));

    for (const p of ['aoi/tashkent.geojson', 'aoi/tashkent.json', 'vector/grid_500m.parquet']) {
      assert.ok(paths.has(p), `Expected manifest.artifacts to include: ${p}`);
    }

    for (const a of manifest.artifacts ?? []) {
      assert.equal(typeof a.path, 'string');
      assert.match(a.sha256, /^[a-fA-F0-9]{64}$/);
      assert.ok(Number.isInteger(a.size) && a.size >= 0);
    }
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

