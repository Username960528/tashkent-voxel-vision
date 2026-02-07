import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { applyBuildingHeights } from '../scripts/lib/buildings-heights.mjs';
import { buildBuildingsLod } from '../scripts/lib/buildings-lod.mjs';
import { extractOsm } from '../scripts/lib/osm-extract.mjs';
import { ensurePythonVenv } from '../scripts/lib/python-venv.mjs';
import { findRepoRoot } from '../scripts/lib/repo-root.mjs';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function geojsonSeq(features) {
  return features.map((f) => `\x1e${JSON.stringify(f)}\n`).join('');
}

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  return res.stdout;
}

function circleRing([lon, lat], radiusDeg, n = 200) {
  const ring = [];
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    ring.push([lon + radiusDeg * Math.cos(t), lat + radiusDeg * Math.sin(t)]);
  }
  ring.push(ring[0]);
  return ring;
}

function findArtifact(manifest, relPath) {
  return (manifest.artifacts ?? []).find((a) => a.path === relPath) ?? null;
}

test('buildings LOD writes buildings_simplified.parquet with reduced geometry complexity', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_building_lod_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');

  const rawPbfAbs = path.join(repoRoot, 'data', 'raw', 'osm', 'uzbekistan-latest.osm.pbf');
  const rawPbfExisted = await fileExists(rawPbfAbs);

  try {
    await initDataRelease({ repoRoot, runId, aoiId: 'tashkent', force: false });
    await writeAoi({ repoRoot, runId, aoiId: 'tashkent', force: false });

    if (!rawPbfExisted) {
      await fs.mkdir(path.dirname(rawPbfAbs), { recursive: true });
      await fs.writeFile(rawPbfAbs, Buffer.from('dummy pbf bytes'));
    }

    const fixturesDir = path.join(runRoot, 'metrics', 'fixtures');
    await fs.mkdir(fixturesDir, { recursive: true });

    const buildingsFixture = path.join(fixturesDir, 'buildings.geojsonseq');

    const ring = circleRing([69.25, 41.35], 0.001, 240);
    const buildings = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 201, building: 'yes', height: '12m' },
        geometry: { type: 'Polygon', coordinates: [ring] },
      },
    ];
    await fs.writeFile(buildingsFixture, geojsonSeq(buildings), 'utf8');

    await extractOsm({
      repoRoot,
      runId,
      dryRun: false,
      fixtures: { buildings: buildingsFixture },
    });

    // Ensure height_m exists so LOD preserves it.
    await applyBuildingHeights({ repoRoot, runId, dryRun: false });

    const inParquet = path.join(runRoot, 'vector', 'buildings.parquet');
    const outParquet = path.join(runRoot, 'vector', 'buildings_simplified.parquet');

    const { pythonBin } = await ensurePythonVenv(repoRoot);
    const statsScript = path.join(os.tmpdir(), `tvv-${runId}-geomstats.py`);
    await fs.writeFile(
      statsScript,
      `
import json
import sys
import pyarrow.parquet as pq
from shapely.wkb import loads as wkb_loads

path = sys.argv[1]
table = pq.read_table(path)
cols = table.column_names
geom = None
for v in table['geometry'].to_pylist():
  if v is None:
    continue
  g = wkb_loads(v)
  if not g.is_empty:
    geom = g
    break

def coord_count(g):
  if g is None or g.is_empty:
    return 0
  if g.geom_type == 'Polygon':
    return len(g.exterior.coords) if g.exterior is not None else 0
  if g.geom_type == 'MultiPolygon':
    n = 0
    for gg in getattr(g, 'geoms', []):
      if gg.geom_type == 'Polygon' and gg.exterior is not None:
        n += len(gg.exterior.coords)
    return n
  return 0

print(json.dumps({'columns': cols, 'coord_count': coord_count(geom)}))
`,
      'utf8',
    );

    const beforeStats = JSON.parse(runCapture(pythonBin, [statsScript, inParquet]).trim());

    const result = await buildBuildingsLod({ repoRoot, runId, dryRun: false });
    assert.equal(result.output, path.join('data', 'releases', runId, 'vector', 'buildings_simplified.parquet').replaceAll('\\', '/'));
    assert.ok(await fileExists(outParquet));

    const afterStats = JSON.parse(runCapture(pythonBin, [statsScript, outParquet]).trim());
    assert.ok(afterStats.columns.includes('height_m'));
    assert.ok(afterStats.coord_count > 0);
    assert.ok(afterStats.coord_count < beforeStats.coord_count, `Expected simplified geometry to reduce coord count`);

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const art = findArtifact(manifest, 'vector/buildings_simplified.parquet');
    assert.ok(art?.sha256);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
    if (!rawPbfExisted) {
      await fs.rm(rawPbfAbs, { force: true });
    }
  }
});

