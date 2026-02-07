import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { addFilesToManifest } from '../scripts/lib/artifacts.mjs';
import { buildGridGreenMetrics } from '../scripts/lib/metrics-grid.mjs';
import { ensurePythonVenv } from '../scripts/lib/python-venv.mjs';
import { findRepoRoot } from '../scripts/lib/repo-root.mjs';

function runCapture(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
  return res.stdout;
}

function findArtifact(manifest, relPath) {
  return (manifest.artifacts ?? []).find((a) => a.path === relPath) ?? null;
}

test('grid metrics computes green_share and writes parquet + geojson', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_metrics_grid_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');

  try {
    await initDataRelease({ repoRoot, runId, aoiId: 'tashkent', force: false });
    await writeAoi({ repoRoot, runId, aoiId: 'tashkent', force: false });

    const vectorDir = path.join(runRoot, 'vector');
    await fs.mkdir(vectorDir, { recursive: true });

    const gridParquet = path.join(vectorDir, 'grid_500m.parquet');
    const greenParquet = path.join(vectorDir, 'green.parquet');

    const { pythonBin } = await ensurePythonVenv(repoRoot);
    const fixtureScript = path.join(os.tmpdir(), `tvv-${runId}-metrics-fixture.py`);
    await fs.writeFile(
      fixtureScript,
      `
import json
import pyarrow as pa
import pyarrow.parquet as pq
from pyproj import Transformer
from shapely.geometry import box
from shapely.ops import transform as shapely_transform

grid_epsg = 32642
green_epsg = 4326

# A single 500m cell (UTM meters, realistic-ish coordinates).
cell = box(500000, 4570000, 500500, 4570500)
cell_area = float(cell.area)

# Green polygon covers half the cell by area.
green_m = box(500000, 4570000, 500250, 4570500)

to_wgs = Transformer.from_crs(f"EPSG:{grid_epsg}", f"EPSG:{green_epsg}", always_xy=True).transform
green_wgs = shapely_transform(to_wgs, green_m)

grid = pa.Table.from_arrays(
  [pa.array(['test_0_0']), pa.array([cell_area]), pa.array([cell.wkb])],
  names=['cell_id','cell_area_m2','geometry'],
)
grid_geo = {
  'version': '1.0.0',
  'primary_column': 'geometry',
  'columns': {'geometry': {'encoding':'WKB','geometry_type':['Polygon'], 'crs': {'id': {'authority':'EPSG','code': grid_epsg}}}},
}
grid = grid.replace_schema_metadata({**(grid.schema.metadata or {}), b'geo': json.dumps(grid_geo).encode('utf-8')})
pq.write_table(grid, r'''${gridParquet}''')

green = pa.Table.from_arrays(
  [pa.array(['way/1']), pa.array(['osm']), pa.array(['grass']), pa.array([green_wgs.wkb])],
  names=['id','source','class','geometry'],
)
green_geo = {
  'version': '1.0.0',
  'primary_column': 'geometry',
  'columns': {'geometry': {'encoding':'WKB','geometry_type':['Polygon'], 'crs': {'id': {'authority':'EPSG','code': green_epsg}}}},
}
green = green.replace_schema_metadata({**(green.schema.metadata or {}), b'geo': json.dumps(green_geo).encode('utf-8')})
pq.write_table(green, r'''${greenParquet}''')
`,
      'utf8',
    );
    runCapture(pythonBin, [fixtureScript]);

    // Ensure fixture inputs are tracked in artifacts for parity with real runs.
    await addFilesToManifest({ manifestPath, runRoot, absPaths: [gridParquet, greenParquet] });

    const report = await buildGridGreenMetrics({ repoRoot, runId, cell: 500, dryRun: false });
    assert.equal(report.cell_m, 500);
    assert.ok(report.report?.total_cells === 1);

    const outParquet = path.join(runRoot, 'metrics', 'grid_500m_metrics.parquet');
    const outGeojson = path.join(runRoot, 'metrics', 'grid_500m_metrics.geojson');
    assert.ok(await fs.stat(outParquet));
    assert.ok(await fs.stat(outGeojson));

    const readOutScript = path.join(os.tmpdir(), `tvv-${runId}-metrics-readout.py`);
    await fs.writeFile(
      readOutScript,
      `
import json
import pyarrow.parquet as pq

t = pq.read_table(r'''${outParquet}''')
row = {k: t[k][0].as_py() for k in t.column_names}
print(json.dumps(row))
`,
      'utf8',
    );
    const row = JSON.parse(runCapture(pythonBin, [readOutScript]).trim());
    assert.equal(row.cell_id, 'test_0_0');
    assert.ok(Math.abs(row.green_share - 0.5) < 0.02, `Expected green_share ~ 0.5, got ${row.green_share}`);
    assert.ok(Math.abs(row.green_area_m2 - 125000) < 2500, `Expected green_area_m2 ~ 125000, got ${row.green_area_m2}`);

    const geojson = JSON.parse(await fs.readFile(outGeojson, 'utf8'));
    assert.equal(geojson.type, 'FeatureCollection');
    assert.equal(geojson.features.length, 1);
    assert.equal(geojson.features[0].properties.cell_id, 'test_0_0');

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    assert.ok(findArtifact(manifest, 'metrics/grid_500m_metrics.parquet')?.sha256);
    assert.ok(findArtifact(manifest, 'metrics/grid_500m_metrics.geojson')?.sha256);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

