import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { buildBuildingsLod } from './lib/buildings-lod.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  node packages/data/scripts/buildings-lod.mjs --run_id=<id> [--dry-run]

Input:
  data/releases/<run_id>/vector/buildings.parquet

Output:
  data/releases/<run_id>/vector/buildings_simplified.parquet

Options:
  --run_id    Release run id (folder name under data/releases/)
  --dry-run   Compute report but do not write output parquet or update manifest
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
    const report = await buildBuildingsLod({ repoRoot, runId, dryRun });
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

