import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { validateManifest } from './lib/manifest-schema.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';
import { runPython } from './lib/python-venv.mjs';
import { EARTH_SEARCH_V1, normalizeEarthSearchS2L2AItem, stacSearchAll } from './lib/stac-earth-search.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:green:build --run_id=<id> [--years=2017-2025] [--dry-run]

Inputs:
  data/releases/<run_id>/manifest.json
  data/releases/<run_id>/aoi/<aoi_id>.geojson
  packages/data/src/time_slices.json

Outputs:
  data/releases/<run_id>/raster/ndvi_<year>.tif
  data/releases/<run_id>/raster/green_mask_<year>.tif

Options:
  --run_id    Release run id (folder name under data/releases/)
  --years     Year list "2017,2018,2020" or range "2017-2025" (default: from time_slices.json)
  --config    Path to time_slices.json (default: packages/data/src/time_slices.json)
  --stac      Earth Search base URL (default: https://earth-search.aws.element84.com/v1)
  --dry-run   Query STAC and print plan, but do not invoke Python or write artifacts/manifest
`);
}

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

function parseYearsArg(yearsArg) {
  if (typeof yearsArg !== 'string') return null;
  const raw = yearsArg.trim();
  if (!raw) return null;

  if (raw.includes(',')) {
    const years = raw
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n));
    if (years.length === 0) throw new Error(`Invalid --years: ${yearsArg}`);
    return [...new Set(years.map((y) => Math.trunc(y)))].sort((a, b) => a - b);
  }

  if (raw.includes('-')) {
    const [a, b] = raw.split('-', 2).map((s) => Number(s.trim()));
    if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`Invalid --years range: ${yearsArg}`);
    const start = Math.trunc(Math.min(a, b));
    const end = Math.trunc(Math.max(a, b));
    if (end - start > 200) throw new Error(`Refusing huge --years range: ${yearsArg}`);
    const out = [];
    for (let y = start; y <= end; y++) out.push(y);
    return out;
  }

  const y = Number(raw);
  if (!Number.isFinite(y)) throw new Error(`Invalid --years: ${yearsArg}`);
  return [Math.trunc(y)];
}

function seasonDatetimeRange(year, { start_mm_dd, end_mm_dd }) {
  if (!Number.isFinite(year) || year < 1900 || year > 2200) throw new Error(`Invalid year: ${String(year)}`);
  if (typeof start_mm_dd !== 'string' || typeof end_mm_dd !== 'string') throw new Error('Invalid season config');
  const start = `${year}-${start_mm_dd}T00:00:00Z`;
  // End date is interpreted as inclusive for STAC searches.
  const end = `${year}-${end_mm_dd}T23:59:59Z`;
  return { start, end, range: `${start}/${end}` };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));

  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  assertSafeRunId(runId);

  const dryRun = Boolean(args['dry-run'] ?? args.dry_run ?? args.dryRun);
  const stacBaseUrl = typeof args.stac === 'string' && args.stac.length > 0 ? args.stac : EARTH_SEARCH_V1;

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const configAbs =
    typeof args.config === 'string' && args.config.length > 0
      ? path.isAbsolute(args.config)
        ? args.config
        : path.join(repoRoot, args.config)
      : path.join(repoRoot, 'packages', 'data', 'src', 'time_slices.json');

  const config = JSON.parse(await fs.readFile(configAbs, 'utf8'));
  const years = parseYearsArg(args.years) ?? config.years;
  if (!Array.isArray(years) || years.length === 0) throw new Error('No years configured (time_slices.json)');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const aoiId = manifest?.aoi?.id;
  if (typeof aoiId !== 'string' || aoiId.length === 0) throw new Error('Invalid manifest: missing aoi.id');

  const aoiGeojsonAbs = path.join(runRoot, 'aoi', `${aoiId}.geojson`);
  if (!(await fileExists(aoiGeojsonAbs))) {
    throw new Error(`Missing AOI GeoJSON: ${aoiGeojsonAbs} (run data:aoi:write first)`);
  }

  const bbox = manifest?.aoi?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || bbox.some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
    throw new Error('Invalid manifest: aoi.bbox must be [minLon,minLat,maxLon,maxLat]');
  }

  const collection = 'sentinel-2-l2a';
  const maxCloudCover = config?.dataset?.max_cloud_cover_percent;
  if (typeof maxCloudCover !== 'number' || !Number.isFinite(maxCloudCover) || maxCloudCover < 0 || maxCloudCover > 100) {
    throw new Error('Invalid config: dataset.max_cloud_cover_percent');
  }

  const rasterDirAbs = path.join(runRoot, 'raster');
  if (!dryRun) await fs.mkdir(rasterDirAbs, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tvv-green-'));
  try {
    /** @type {any[]} */
    const perYear = [];
    /** @type {number|null} */
    let outputEpsg = null;

    for (const year of years) {
      const { start, end, range } = seasonDatetimeRange(year, config.season);

      const body = {
        collections: [collection],
        bbox,
        datetime: range,
        // Earth Search uses pagination; keep limit moderate to reduce response size.
        limit: 200,
        query: {
          'eo:cloud_cover': { lte: maxCloudCover },
        },
      };

      const { features, pages } = await stacSearchAll({ baseUrl: stacBaseUrl, body });

      const items = features.map((f) => normalizeEarthSearchS2L2AItem(f, config.dataset.bands));

      const outNdviAbs = path.join(rasterDirAbs, `ndvi_${year}.tif`);
      const outMaskAbs = path.join(rasterDirAbs, `green_mask_${year}.tif`);

      const itemsJsonAbs = path.join(tmpDir, `s2_items_${year}.json`);
      await fs.writeFile(
        itemsJsonAbs,
        `${JSON.stringify({ provider: 'earth-search', stac_api: stacBaseUrl, collection, datetime: range, items }, null, 2)}\n`,
        'utf8',
      );

      /** @type {any} */
      let smoke = null;
      if (!dryRun) {
        const smokeJsonAbs = path.join(tmpDir, `green_smoke_${year}.json`);
        const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 's2_green_mask.py');

        await runPython({
          repoRoot,
          scriptPath,
          args: [
            '--aoi_geojson',
            aoiGeojsonAbs,
            '--items_json',
            itemsJsonAbs,
            '--config_json',
            configAbs,
            '--out_ndvi',
            outNdviAbs,
            '--out_mask',
            outMaskAbs,
            '--smoke_json',
            smokeJsonAbs,
          ],
        });

        smoke = JSON.parse(await fs.readFile(smokeJsonAbs, 'utf8'));
        if (outputEpsg == null && typeof smoke?.proj_epsg === 'number' && Number.isFinite(smoke.proj_epsg)) {
          outputEpsg = smoke.proj_epsg;
        }
        await addFilesToManifest({ manifestPath, runRoot, absPaths: [outNdviAbs, outMaskAbs] });
      }

      perYear.push({
        year,
        stac: {
          base_url: stacBaseUrl,
          collection,
          datetime_start: start,
          datetime_end: end,
          pages,
          item_count: items.length,
        },
        outputs: {
          ndvi: path.relative(repoRoot, outNdviAbs).replaceAll('\\', '/'),
          green_mask: path.relative(repoRoot, outMaskAbs).replaceAll('\\', '/'),
        },
        smoke,
      });
    }

    if (!dryRun) {
      const updated = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const minYear = Math.min(...years);
      const maxYear = Math.max(...years);
      const overall = {
        provider: 'earth-search',
        stac_api: stacBaseUrl,
        collection,
        datetime_start: seasonDatetimeRange(minYear, config.season).start,
        datetime_end: seasonDatetimeRange(maxYear, config.season).end,
        years,
        max_cloud_cover_percent: maxCloudCover,
        bands: config.dataset.bands,
        masking: config.masking,
        composite: config.composite,
        classification: config.classification,
        // We keep the source UTM grid for consistent 10m pixels.
        output_crs: outputEpsg ? `EPSG:${outputEpsg}` : 'EPSG:32642',
        generated_at: new Date().toISOString(),
        notes: 'NDVI median composite + thresholded green mask (see docs/time_slices.md).',
      };

      if (!updated.sources || typeof updated.sources !== 'object') updated.sources = {};
      updated.sources.sentinel2 = overall;

      const validation = await validateManifest(updated);
      if (!validation.valid) {
        const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
        throw new Error(`Updated manifest failed schema validation:\n${details}`);
      }

      await fs.writeFile(manifestPath, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
    }

    console.log(JSON.stringify({ run_id: runId, dry_run: dryRun ? true : false, years: perYear }));
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
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
  await main().catch((err) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(msg);
    console.error('Run with --help for usage.');
    process.exit(1);
  });
}
