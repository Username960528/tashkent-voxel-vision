import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { buildPmtilesLayer } from '../scripts/lib/tiles.mjs';
import { ensurePythonVenv } from '../scripts/lib/python-venv.mjs';
import { findRepoRoot } from '../scripts/lib/repo-root.mjs';

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
}

test('geoparquet_to_geojsonseq converts WKB parquet to GeoJSONSeq', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_tiles_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);

  try {
    await initDataRelease({ repoRoot, runId, aoiId: 'tashkent', force: false });
    await writeAoi({ repoRoot, runId, aoiId: 'tashkent', force: false });

    const vectorDir = path.join(runRoot, 'vector');
    await fs.mkdir(vectorDir, { recursive: true });

    const buildingsParquet = path.join(vectorDir, 'buildings.parquet');
    const outGeojsonSeq = path.join(os.tmpdir(), `tvv-${runId}-buildings.geojsonseq`);

    const tmpPy = path.join(os.tmpdir(), `tvv-${runId}-write-fixture.py`);
    await fs.writeFile(
      tmpPy,
      `
import pyarrow as pa
import pyarrow.parquet as pq
from shapely.geometry import Polygon

poly = Polygon([(69.2,41.3),(69.201,41.3),(69.201,41.301),(69.2,41.301),(69.2,41.3)])

table = pa.Table.from_arrays(
  [
    pa.array(['way/1']),
    pa.array(['building']),
    pa.array([12.0]),
    pa.array(['height']),
    pa.array([poly.wkb]),
  ],
  names=['id','class','height_m','height_source','geometry'],
)

pq.write_table(table, r'''${buildingsParquet}''')
`,
      'utf8',
    );

    const { pythonBin } = await ensurePythonVenv(repoRoot);
    run(pythonBin, [tmpPy]);

    const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'geoparquet_to_geojsonseq.py');
    run(pythonBin, [
      scriptPath,
      '--in_parquet',
      buildingsParquet,
      '--out_geojsonseq',
      outGeojsonSeq,
      '--properties',
      'id,height_m,height_source',
    ]);

    const raw = await fs.readFile(outGeojsonSeq, 'utf8');
    assert.ok(raw.includes('"id": "way/1"'));
    assert.ok(raw.includes('"height_m": 12.0'));
    assert.ok(raw.includes('"height_source": "height"'));
    assert.ok(raw.startsWith('\x1e'));
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

test('tiles scripts support dry-run without external tooling', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_tiles_dryrun_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);

  try {
    await initDataRelease({ repoRoot, runId, aoiId: 'tashkent', force: false });
    await writeAoi({ repoRoot, runId, aoiId: 'tashkent', force: false });

    const vectorDir = path.join(runRoot, 'vector');
    await fs.mkdir(vectorDir, { recursive: true });

    for (const name of ['buildings', 'green', 'roads', 'water']) {
      await fs.writeFile(path.join(vectorDir, `${name}.parquet`), Buffer.from('not-a-real-parquet'));
    }

    const buildingsReport = await buildPmtilesLayer({
      repoRoot,
      runId,
      layer: 'buildings',
      inParquetRel: 'vector/buildings.parquet',
      outPmtilesRel: 'tiles/buildings.pmtiles',
      include: ['id', 'height_m', 'height_source'],
      minzoom: 10,
      maxzoom: 15,
      dryRun: true,
    });

    assert.equal(buildingsReport.dry_run, true);
    assert.equal(buildingsReport.output, 'tiles/buildings.pmtiles');

    const greenReport = await buildPmtilesLayer({
      repoRoot,
      runId,
      layer: 'green',
      inParquetRel: 'vector/green.parquet',
      outPmtilesRel: 'tiles/green.pmtiles',
      include: ['class'],
      minzoom: 8,
      maxzoom: 14,
      dryRun: true,
    });

    assert.equal(greenReport.dry_run, true);
    assert.equal(greenReport.output, 'tiles/green.pmtiles');
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

