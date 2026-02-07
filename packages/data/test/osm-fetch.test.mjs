import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { fetchOsm } from '../scripts/lib/osm-fetch.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { validateManifest } from '../scripts/lib/manifest-schema.mjs';

test('osm fetch (dry-run) updates manifest metadata + artifact entry idempotently', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-osm-fetch-'));
  try {
    const now = new Date('2026-02-07T00:00:00.000Z');
    const runId = 'test_run';

    const { manifestPath } = await initDataRelease({
      repoRoot: tmpRoot,
      runId,
      aoiId: 'tashkent',
      now,
    });

    const dummy = Buffer.from('dummy osm pbf bytes');
    const expectedSha256 = crypto.createHash('sha256').update(dummy).digest('hex');
    const expectedSize = dummy.length;

    const expectedRawRelPath = 'data/raw/osm/uzbekistan-latest.osm.pbf';
    await fs.mkdir(path.join(tmpRoot, 'data', 'raw', 'osm'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, expectedRawRelPath), dummy);

    const result1 = await fetchOsm({ repoRoot: tmpRoot, runId, region: 'uzbekistan', now, dryRun: true });
    assert.equal(result1.downloaded, false);
    assert.equal(result1.rawRelPath, expectedRawRelPath);

    const raw1 = await fs.readFile(manifestPath, 'utf8');
    const manifest1 = JSON.parse(raw1);

    assert.equal(manifest1.sources?.osm?.region, 'uzbekistan');
    assert.equal(manifest1.sources?.osm?.url, 'https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf');
    assert.equal(manifest1.sources?.osm?.path, expectedRawRelPath);
    assert.equal(manifest1.sources?.osm?.sha256, expectedSha256);
    assert.equal(manifest1.sources?.osm?.size, expectedSize);
    assert.equal(manifest1.sources?.osm?.downloaded_at, now.toISOString());
    assert.equal(manifest1.sources?.osm?.dry_run, true);

    assert.ok(Array.isArray(manifest1.artifacts));
    assert.deepEqual(manifest1.artifacts, [
      {
        path: expectedRawRelPath,
        sha256: expectedSha256,
        size: expectedSize,
      },
    ]);

    const validation1 = await validateManifest(manifest1);
    assert.equal(validation1.valid, true, JSON.stringify(validation1.errors, null, 2));

    const result2 = await fetchOsm({ repoRoot: tmpRoot, runId, region: 'uzbekistan', now, dryRun: true });
    assert.equal(result2.downloaded, false);

    const raw2 = await fs.readFile(manifestPath, 'utf8');
    assert.equal(raw2, raw1);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

