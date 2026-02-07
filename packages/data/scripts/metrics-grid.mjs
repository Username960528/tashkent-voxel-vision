import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { buildGridGreenMetrics } from './lib/metrics-grid.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:metrics:grid --run_id=<id> [--cell=500] [--dry-run]

Inputs:
  data/releases/<run_id>/vector/grid_<cell>m.parquet
  data/releases/<run_id>/vector/green.parquet

Outputs:
  data/releases/<run_id>/metrics/grid_<cell>m_metrics.parquet
  data/releases/<run_id>/metrics/grid_<cell>m_metrics.geojson

Options:
  --run_id    Release run id (folder name under data/releases/)
  --cell      Grid cell size in meters (default: 500)
  --dry-run   Compute report only; write nothing; skip manifest updates
`);
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const cellRaw = typeof args.cell === 'string' ? args.cell : '';
  const cell = cellRaw.trim().length > 0 ? Number(cellRaw) : 500;
  const dryRun = Boolean(args['dry-run'] ?? args.dry_run ?? args.dryRun);
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const report = await buildGridGreenMetrics({ repoRoot, runId, cell, dryRun });
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

