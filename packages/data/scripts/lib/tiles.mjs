import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { addFilesToManifest, getRunPaths } from './artifacts.mjs';
import { runPython } from './python-venv.mjs';

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
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

function assertExecutable(cmd, checkArgs, installHint) {
  const res = spawnSync(cmd, checkArgs, { stdio: 'ignore' });
  if (res.error && res.error.code === 'ENOENT') {
    throw new Error(`Missing required executable: ${cmd}\n${installHint}`);
  }
}

function toolHints() {
  return [
    'Install dependencies:',
    '- macOS (brew): brew install tippecanoe pmtiles',
    '- Ubuntu: apt-get update && apt-get install -y tippecanoe (pmtiles: use release binary or go install)',
  ].join('\n');
}

export function assertTilesTooling() {
  assertExecutable('tippecanoe', ['--version'], toolHints());
  assertExecutable('pmtiles', ['--help'], toolHints());
}

function defaultTippecanoeArgs({ layer, minzoom, maxzoom, include }) {
  const args = [
    '--read-parallel',
    `--layer=${layer}`,
    `--minimum-zoom=${minzoom}`,
    `--maximum-zoom=${maxzoom}`,
    '--drop-densest-as-needed',
    '--extend-zooms-if-still-dropping',
    '--exclude-all',
  ];
  for (const key of include) args.push(`--include=${key}`);
  return args;
}

/**
 * Builds a PMTiles archive from a GeoParquet input (WKB geometry).
 *
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   layer: string,
 *   inParquetRel: string,
 *   outPmtilesRel: string,
 *   include: string[],
 *   minzoom: number,
 *   maxzoom: number,
 *   devMvtDirRel?: string | null,
 *   dryRun?: boolean
 * }} opts
 */
export async function buildPmtilesLayer(opts) {
  const { repoRoot, runId, layer, inParquetRel, outPmtilesRel, include, minzoom, maxzoom, devMvtDirRel, dryRun } =
    opts;

  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const inParquetAbs = path.join(runRoot, inParquetRel);
  if (!(await fileExists(inParquetAbs))) {
    throw new Error(`Missing input parquet: ${inParquetAbs}`);
  }

  const outPmtilesAbs = path.join(runRoot, outPmtilesRel);
  const outMvtDirAbs = devMvtDirRel ? path.join(runRoot, devMvtDirRel) : null;

  /** @type {any} */
  const report = {
    run_id: runId,
    layer,
    dry_run: Boolean(dryRun),
    input: inParquetRel,
    output: outPmtilesRel,
    dev_mvt_dir: devMvtDirRel ?? null,
    updated_manifest: false,
  };

  if (dryRun) return report;

  assertTilesTooling();

  await fs.mkdir(path.dirname(outPmtilesAbs), { recursive: true });
  if (outMvtDirAbs) await fs.mkdir(outMvtDirAbs, { recursive: true });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `tvv-tiles-${layer}-`));
  try {
    const geojsonSeqAbs = path.join(tmpDir, `${layer}.geojsonseq`);
    const mbtilesAbs = path.join(tmpDir, `${layer}.mbtiles`);

    const pyScript = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'geoparquet_to_geojsonseq.py');
    await runPython({
      repoRoot,
      scriptPath: pyScript,
      args: [
        '--in_parquet',
        inParquetAbs,
        '--out_geojsonseq',
        geojsonSeqAbs,
        '--properties',
        include.join(','),
      ],
    });

    run('tippecanoe', [
      `--output=${mbtilesAbs}`,
      '--force',
      ...defaultTippecanoeArgs({ layer, minzoom, maxzoom, include }),
      geojsonSeqAbs,
    ]);

    run('pmtiles', ['convert', '--force', mbtilesAbs, outPmtilesAbs]);

    if (outMvtDirAbs) {
      // Tippecanoe directory output is meant for debugging; keep it optional to avoid extra work.
      // Output files are typically `.pbf`; we keep them as-is.
      run('tippecanoe', [
        `--output-to-directory=${outMvtDirAbs}`,
        '--force',
        ...defaultTippecanoeArgs({ layer, minzoom, maxzoom, include }),
        geojsonSeqAbs,
      ]);
    }

    await addFilesToManifest({ manifestPath, runRoot, absPaths: [outPmtilesAbs] });
    report.updated_manifest = true;
    return report;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

