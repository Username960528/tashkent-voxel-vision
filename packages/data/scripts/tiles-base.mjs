import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { buildPmtilesLayer } from './lib/tiles.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  node packages/data/scripts/tiles-base.mjs --run_id=<id> [--dry-run]

Inputs:
  data/releases/<run_id>/vector/green.parquet
  data/releases/<run_id>/vector/roads.parquet
  data/releases/<run_id>/vector/water.parquet

Outputs:
  data/releases/<run_id>/tiles/green.pmtiles
  data/releases/<run_id>/tiles/roads.pmtiles
  data/releases/<run_id>/tiles/water.pmtiles

Options:
  --run_id    Release run id (folder name under data/releases/)
  --dry-run   Validate inputs only; write nothing; skip external tools
`);
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const dryRun = Boolean(args['dry-run'] ?? args.dry_run ?? args.dryRun);
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    /** @type {any[]} */
    const reports = [];
    for (const layer of ['green', 'roads', 'water']) {
      const report = await buildPmtilesLayer({
        repoRoot,
        runId,
        layer,
        inParquetRel: path.join('vector', `${layer}.parquet`).replaceAll('\\', '/'),
        outPmtilesRel: path.join('tiles', `${layer}.pmtiles`).replaceAll('\\', '/'),
        include: ['class'],
        minzoom: 8,
        maxzoom: 14,
        dryRun,
      });
      reports.push(report);
    }

    console.log(JSON.stringify({ run_id: runId, dry_run: Boolean(dryRun), layers: reports }));
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

