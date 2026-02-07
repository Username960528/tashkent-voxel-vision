import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { addFilesToManifest, getRunPaths } from './artifacts.mjs';
import { runPython } from './python-venv.mjs';

const LAYERS = /** @type {const} */ (['buildings', 'roads', 'water', 'green']);

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

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
}

function getOsmRawRelPathFromManifest(manifest) {
  const p = manifest?.sources?.osm?.path;
  if (typeof p === 'string' && p.length > 0) return p;
  return path.join('data', 'raw', 'osm', 'uzbekistan-latest.osm.pbf').replaceAll('\\', '/');
}

function layerFilters(layer) {
  if (layer === 'buildings') return ['a/building'];
  if (layer === 'roads') return ['w/highway'];
  if (layer === 'water') return ['w/waterway', 'a/natural=water', 'a/waterway=riverbank', 'a/natural=wetland'];
  if (layer === 'green') return ['a/leisure=park,garden', 'a/landuse=grass,forest', 'a/natural=wood,grassland'];
  throw new Error(`Unknown layer: ${layer}`);
}

function outParquetRelPath(layer) {
  return path.join('vector', `${layer}.parquet`).replaceAll('\\', '/');
}

/**
 * Extract OSM-derived vector layers for a release.
 *
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   dryRun?: boolean,
 *   fixtures?: Partial<Record<'buildings'|'roads'|'water'|'green', string>>,
 * }} opts
 */
export async function extractOsm(opts) {
  const { repoRoot, runId, dryRun = false, fixtures } = opts;

  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const aoiId = manifest?.aoi?.id;
  if (typeof aoiId !== 'string' || aoiId.length === 0) {
    throw new Error('Invalid manifest: missing aoi.id');
  }

  const aoiGeojsonAbsPath = path.join(runRoot, 'aoi', `${aoiId}.geojson`);
  if (!(await fileExists(aoiGeojsonAbsPath))) {
    throw new Error(`Missing AOI GeoJSON: ${aoiGeojsonAbsPath} (run data:aoi:write first)`);
  }

  const rawRelPath = getOsmRawRelPathFromManifest(manifest);
  const rawAbsPath = path.join(repoRoot, rawRelPath);
  if (!(await fileExists(rawAbsPath))) {
    throw new Error(`Missing OSM PBF: ${rawAbsPath} (run osm:fetch first)`);
  }

  /** @type {Record<string, string>} */
  const outputs = {};
  for (const layer of LAYERS) {
    outputs[layer] = path.join(runRoot, outParquetRelPath(layer));
  }

  /** @type {Record<string, any>} */
  const report = {
    run_id: runId,
    dry_run: dryRun ? true : false,
    inputs: {
      manifest: path.relative(repoRoot, manifestPath).replaceAll('\\', '/'),
      raw_pbf: rawRelPath,
      aoi_geojson: path.relative(repoRoot, aoiGeojsonAbsPath).replaceAll('\\', '/'),
      aoi_bbox: Array.isArray(manifest?.aoi?.bbox) ? manifest.aoi.bbox : null,
    },
    outputs: Object.fromEntries(
      Object.entries(outputs).map(([k, abs]) => [k, path.relative(repoRoot, abs).replaceAll('\\', '/')]),
    ),
    layers: Object.fromEntries(LAYERS.map((l) => [l, null])),
    updated_manifest: false,
  };

  if (dryRun) return report;

  await fs.mkdir(path.join(runRoot, 'vector'), { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-osm-extract-'));
  try {
    const converterScript = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'geojsonseq_to_geoparquet.py');

    if (fixtures && Object.keys(fixtures).length > 0) {
      // Fixture mode: bypass osmium (CI-safe). Convert the provided GeoJSONSeq files per layer.
      for (const layer of LAYERS) {
        const inPath = fixtures[layer] ? path.resolve(fixtures[layer]) : path.join(tmpDir, `${layer}.empty.geojsonseq`);
        if (!(await fileExists(inPath))) {
          await fs.writeFile(inPath, '', 'utf8');
        }

        const outAbs = outputs[layer];
        const smokePath = path.join(tmpDir, `${layer}.smoke.json`);
        await runPython({
          repoRoot,
          scriptPath: converterScript,
          args: ['--layer', layer, '--in_geojsonseq', inPath, '--out_parquet', outAbs, '--smoke_json', smokePath],
        });
        report.layers[layer] = JSON.parse(await fs.readFile(smokePath, 'utf8'));
      }
    } else {
      // Osmium pipeline: clip to AOI, filter per layer by tags, export GeoJSONSeq, then convert to GeoParquet.
      const aoiPbf = path.join(tmpDir, 'aoi.osm.pbf');
      const bbox = Array.isArray(manifest?.aoi?.bbox) ? manifest.aoi.bbox : null;
      const bboxStr =
        Array.isArray(bbox) &&
        bbox.length === 4 &&
        bbox.every((n) => typeof n === 'number' && Number.isFinite(n))
          ? bbox.join(',')
          : null;

      if (bboxStr) {
        run('osmium', ['extract', '--bbox', bboxStr, '--no-progress', '-O', '-o', aoiPbf, rawAbsPath]);
      } else {
        // Note: `osmium extract --polygon` expects Osmium's polygon format (usually `.poly`).
        // We keep this fallback for future support, but prefer bbox extracts for compatibility.
        run('osmium', ['extract', '--polygon', aoiGeojsonAbsPath, '--no-progress', '-O', '-o', aoiPbf, rawAbsPath]);
      }

      for (const layer of LAYERS) {
        const filteredPbf = path.join(tmpDir, `${layer}.osm.pbf`);
        const expressions = layerFilters(layer);
        run('osmium', ['tags-filter', '--no-progress', '-O', '-o', filteredPbf, aoiPbf, ...expressions]);

        const geojsonSeq = path.join(tmpDir, `${layer}.geojsonseq`);
        run('osmium', [
          'export',
          '--no-progress',
          '-f',
          'geojsonseq',
          '-O',
          '-a',
          'type,id',
          '-o',
          geojsonSeq,
          filteredPbf,
        ]);

        const outAbs = outputs[layer];
        const smokePath = path.join(tmpDir, `${layer}.smoke.json`);
        await runPython({
          repoRoot,
          scriptPath: converterScript,
          args: ['--layer', layer, '--in_geojsonseq', geojsonSeq, '--out_parquet', outAbs, '--smoke_json', smokePath],
        });
        report.layers[layer] = JSON.parse(await fs.readFile(smokePath, 'utf8'));
      }
    }

    const outAbsPaths = LAYERS.map((l) => outputs[l]);
    await addFilesToManifest({ manifestPath, runRoot, absPaths: outAbsPaths });
    report.updated_manifest = true;
    return report;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}
