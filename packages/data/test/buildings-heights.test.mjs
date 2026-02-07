import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { writeAoi } from '../scripts/aoi-write.mjs';
import { initDataRelease } from '../scripts/lib/init-data-release.mjs';
import { applyBuildingHeights } from '../scripts/lib/buildings-heights.mjs';
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

function findArtifact(manifest, relPath) {
  return (manifest.artifacts ?? []).find((a) => a.path === relPath) ?? null;
}

test('buildings heights adds height columns and updates manifest artifact when changed', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_building_heights_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
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
        properties: { '@type': 'way', '@id': 101, building: 'yes', height: '12m' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.25, 41.35],
              [69.251, 41.35],
              [69.251, 41.351],
              [69.25, 41.351],
              [69.25, 41.35],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 102, building: 'yes', 'building:levels': '3' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.252, 41.35],
              [69.253, 41.35],
              [69.253, 41.351],
              [69.252, 41.351],
              [69.252, 41.35],
            ],
          ],
        },
      },
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 103, building: 'yes' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.254, 41.35],
              [69.255, 41.35],
              [69.255, 41.351],
              [69.254, 41.351],
              [69.254, 41.35],
            ],
          ],
        },
      },
    ];

    const roads = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 110, highway: 'residential' },
        geometry: { type: 'LineString', coordinates: [[69.25, 41.35], [69.255, 41.355]] },
      },
    ];

    const water = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 120, natural: 'water' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.26, 41.36],
              [69.261, 41.36],
              [69.261, 41.361],
              [69.26, 41.361],
              [69.26, 41.36],
            ],
          ],
        },
      },
    ];

    const green = [
      {
        type: 'Feature',
        properties: { '@type': 'way', '@id': 130, landuse: 'grass' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [69.27, 41.37],
              [69.271, 41.37],
              [69.271, 41.371],
              [69.27, 41.371],
              [69.27, 41.37],
            ],
          ],
        },
      },
    ];

    await fs.writeFile(buildingsFixture, geojsonSeq(buildings), 'utf8');
    await fs.writeFile(roadsFixture, geojsonSeq(roads), 'utf8');
    await fs.writeFile(waterFixture, geojsonSeq(water), 'utf8');
    await fs.writeFile(greenFixture, geojsonSeq(green), 'utf8');

    await extractOsm({
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

    const manifestBefore = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const artBefore = findArtifact(manifestBefore, 'vector/buildings.parquet');
    assert.ok(artBefore?.sha256);

    const result = await applyBuildingHeights({ repoRoot, runId, dryRun: false });
    assert.equal(result.changed, true);
    assert.equal(result.report?.row_count, 3);
    assert.deepEqual(result.report?.height_source_counts, { height: 1, levels: 1, heuristic: 1 });
    for (const col of ['height_m', 'levels_int', 'height_source']) {
      assert.ok(result.report?.out_columns?.includes(col), `Expected output to include column: ${col}`);
    }

    const manifestAfter = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    const artAfter = findArtifact(manifestAfter, 'vector/buildings.parquet');
    assert.ok(artAfter?.sha256);
    assert.notEqual(artAfter.sha256, artBefore.sha256);
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
    if (!rawPbfExisted) {
      await fs.rm(rawPbfAbs, { force: true });
    }
  }
});

