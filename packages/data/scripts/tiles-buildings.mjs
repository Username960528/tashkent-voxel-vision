import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { buildPmtilesLayer } from './lib/tiles.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function printHelp() {
  console.log(`Usage:
  node packages/data/scripts/tiles-buildings.mjs --run_id=<id> [--dev-mvt-dir] [--dry-run]

Inputs (prefers simplified if present):
  data/releases/<run_id>/vector/buildings_simplified.parquet
  data/releases/<run_id>/vector/buildings.parquet

Output:
  data/releases/<run_id>/tiles/buildings.pmtiles

Options:
  --run_id        Release run id (folder name under data/releases/)
  --dev-mvt-dir   Also write a debug tile directory to data/releases/<run_id>/tiles/buildings/
  --dry-run       Validate inputs only; write nothing; skip external tools
`);
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const devMvtDir = Boolean(args['dev-mvt-dir'] ?? args.dev_mvt_dir ?? args.devMvtDir);
  const dryRun = Boolean(args['dry-run'] ?? args.dry_run ?? args.dryRun);
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const runRoot = path.join(repoRoot, 'data', 'releases', runId);
    const simplifiedRel = path.join('vector', 'buildings_simplified.parquet').replaceAll('\\', '/');
    const simplifiedAbs = path.join(runRoot, simplifiedRel);
    const defaultRel = path.join('vector', 'buildings.parquet').replaceAll('\\', '/');
    const inParquetRel = (await fileExists(simplifiedAbs)) ? simplifiedRel : defaultRel;

    const report = await buildPmtilesLayer({
      repoRoot,
      runId,
      layer: 'buildings',
      inParquetRel,
      outPmtilesRel: path.join('tiles', 'buildings.pmtiles').replaceAll('\\', '/'),
      devMvtDirRel: devMvtDir ? path.join('tiles', 'buildings').replaceAll('\\', '/') : null,
      include: ['id', 'height_m', 'height_source'],
      minzoom: 10,
      maxzoom: 15,
      dryRun,
    });

    console.log(JSON.stringify(report));
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
