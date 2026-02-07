import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveAoi } from './lib/aoi-catalog.mjs';
import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import {
  assertBboxCoversGeometry,
  assertPolygonOrMultiPolygon,
  computeGeometryBbox,
  extractGeometry,
} from './lib/geojson.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:aoi:write --run_id=<id> --aoi=<aoi> [--force]

Options:
  --run_id   Release run id (folder name)
  --aoi      AOI id (must match the release manifest)
  --force    Overwrite existing AOI files if present
`);
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function bboxToPolygonCoordinates(bbox) {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  return [
    [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat],
      [minLon, minLat],
    ],
  ];
}

export async function writeAoi({ repoRoot, runId, aoiId, force = false }) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
  if (typeof aoiId !== 'string' || aoiId.length === 0) throw new Error('Missing required --aoi');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));

  if (manifest?.aoi?.id !== aoiId) {
    throw new Error(`AOI mismatch: manifest has aoi.id=${manifest?.aoi?.id}; got --aoi=${aoiId}`);
  }
  if (manifest?.aoi?.crs !== 'EPSG:4326') {
    throw new Error(`AOI CRS must be EPSG:4326; got: ${manifest?.aoi?.crs}`);
  }

  const aoi = resolveAoi(aoiId);
  const bbox = manifest?.aoi?.bbox ?? aoi.bbox;

  const geometry = { type: 'Polygon', coordinates: bboxToPolygonCoordinates(bbox) };
  const geojson = {
    type: 'FeatureCollection',
    name: aoi.id,
    features: [
      {
        type: 'Feature',
        properties: { aoi_id: aoi.id, crs: aoi.crs },
        geometry,
      },
    ],
  };

  const outGeojsonPath = path.join(runRoot, 'aoi', `${aoi.id}.geojson`);
  const outJsonPath = path.join(runRoot, 'aoi', `${aoi.id}.json`);

  if (!force) {
    if (await fileExists(outGeojsonPath)) throw new Error(`Refusing to overwrite: ${outGeojsonPath} (use --force)`);
    if (await fileExists(outJsonPath)) throw new Error(`Refusing to overwrite: ${outJsonPath} (use --force)`);
  }

  await fs.mkdir(path.dirname(outGeojsonPath), { recursive: true });
  await fs.writeFile(outGeojsonPath, `${JSON.stringify(geojson, null, 2)}\n`, 'utf8');
  await fs.writeFile(
    outJsonPath,
    `${JSON.stringify({ id: aoi.id, crs: aoi.crs, bbox, geometry }, null, 2)}\n`,
    'utf8',
  );

  // Validations requested by CARD-004.
  const parsed = JSON.parse(await fs.readFile(outGeojsonPath, 'utf8'));
  const geom = extractGeometry(parsed);
  assertPolygonOrMultiPolygon(geom);
  const geomBbox = computeGeometryBbox(geom);
  assertBboxCoversGeometry(bbox, geomBbox);

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [outGeojsonPath, outJsonPath] });

  return { outGeojsonPath, outJsonPath };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const aoiId = typeof args.aoi === 'string' ? args.aoi : '';
  const force = Boolean(args.force);
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const { outGeojsonPath, outJsonPath } = await writeAoi({ repoRoot, runId, aoiId, force });
    console.log(`Wrote: ${path.relative(repoRoot, outGeojsonPath)}`);
    console.log(`Wrote: ${path.relative(repoRoot, outJsonPath)}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    console.error('Run with --help for usage.');
    process.exit(1);
  }
}

const isEntrypoint = (() => {
  try {
    const selfPath = fileURLToPath(import.meta.url);
    const argv1 = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return argv1.length > 0 && path.resolve(selfPath) === argv1;
  } catch {
    return false;
  }
})();

if (isEntrypoint) {
  await main();
}
