import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { applyBuildingHeights } from './lib/buildings-heights.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  node packages/data/scripts/buildings-heights.mjs --run_id=<id> [--dry-run]

Inputs:
  data/releases/<run_id>/vector/buildings.parquet

Output:
  data/releases/<run_id>/vector/buildings.parquet (updated in-place)

Adds columns:
  height_m (float), levels_int (nullable int), height_source ('height'|'levels'|'heuristic')

Options:
  --run_id    Release run id (folder name under data/releases/)
  --dry-run   Compute report only; write nothing
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
    const result = await applyBuildingHeights({ repoRoot, runId, dryRun });
    const r = result.report ?? {};
    console.log(
      `height_m stats: min=${String(r.min)} median=${String(r.median)} p95=${String(r.p95)} (n=${String(r.row_count)})`,
    );
    console.log(JSON.stringify(result));
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

