import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { extractOsm } from '../scripts/lib/osm-extract.mjs';
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

test('osm extract (fixtures) writes GeoParquet layers and updates manifest artifacts', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_osm_extract_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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
    const roadsFixture = path.join(fixturesDir, 'roads.geojsonseq');
    const waterFixture = path.join(fixturesDir, 'water.geojsonseq');
    const greenFixture = path.join(fixturesDir, 'green.geojsonseq');

    const buildings = [
      {
        type: 'Feature',
        properties: {
          '@type': 'way',
          '@id': 1,
          building: 'yes',
          name: 'A',
          height: '10m',
          'building:levels': '3',
        },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.2, 41.3],
              [69.201, 41.3],
              [69.201, 41.301],
              [69.2, 41.301],
              [69.2, 41.3],
            ],
          ],
        },
      },
      {
        // Self-intersecting "bowtie" polygon: should be fixed by make_valid.
        type: 'Feature',
        properties: { '@type': 'way', '@id': 2, building: 'yes', name: 'B' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.202, 41.3],
              [69.203, 41.301],
              [69.203, 41.3],
              [69.202, 41.301],
              [69.202, 41.3],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 3, building: 'yes', name: 'C' },
        geometry: null,
      },
    ];

    const roads = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 10, highway: 'primary', name: 'Main St' },
        geometry: { type: 'LineString', coordinates: [[69.2, 41.3], [69.205, 41.305]] },
      },
    ];

    const water = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 20, natural: 'water', name: 'Lake' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.21, 41.31],
              [69.211, 41.31],
              [69.211, 41.311],
              [69.21, 41.311],
              [69.21, 41.31],
            ],
          ],
        },
      },
    ];

    const green = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 30, leisure: 'park', name: 'Park' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.22, 41.32],
              [69.221, 41.32],
              [69.221, 41.321],
              [69.22, 41.321],
              [69.22, 41.32],
            ],
          ],
        },
      },
    ];

    await fs.writeFile(buildingsFixture, geojsonSeq(buildings), 'utf8');
    await fs.writeFile(roadsFixture, geojsonSeq(roads), 'utf8');
    await fs.writeFile(waterFixture, geojsonSeq(water), 'utf8');
    await fs.writeFile(greenFixture, geojsonSeq(green), 'utf8');

    const result = await extractOsm({
      repoRoot,
      runId,
      dryRun: false,
      fixtures: {
        buildings: buildingsFixture,
        roads: roadsFixture,
        water: waterFixture,
        green: greenFixture,
      },
    });

    assert.equal(result.updated_manifest, true);
    assert.equal(result.layers?.buildings?.written, 2);
    assert.equal(result.layers?.buildings?.dropped_empty, 1);
    assert.equal(result.layers?.buildings?.invalid_polygons, 1);
    assert.equal(result.layers?.buildings?.fixed_polygons, 1);
    assert.equal(result.layers?.buildings?.skipped_invalid, 0);

    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const paths = new Set((manifest.artifacts ?? []).map((a) => a.path));
    for (const p of ['vector/buildings.parquet', 'vector/roads.parquet', 'vector/water.parquet', 'vector/green.parquet']) {
      assert.ok(paths.has(p), `Expected manifest.artifacts to include: ${p}`);
    }
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
    if (!rawPbfExisted) {
      await fs.rm(rawPbfAbs, { force: true });
    }
  }
});

