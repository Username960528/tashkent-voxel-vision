import path from 'node:path';

import { parseArgs } from './lib/args.mjs';
import { fetchOsm } from './lib/osm-fetch.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm -C packages/data osm:fetch --run_id=<id> --region=uzbekistan [--dry-run]

Options:
  --run_id    Release run id (folder name under data/releases/)
  --region    OSM extract region (currently: uzbekistan)
  --dry-run   Do not download if the file is missing; still updates manifest when possible
`);
}

const { args } = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const runId = typeof args.run_id === 'string' ? args.run_id : '';
const region = typeof args.region === 'string' ? args.region : '';
const dryRun = Boolean(args['dry-run'] ?? args.dry_run ?? args.dryRun);
const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

try {
  const result = await fetchOsm({ repoRoot, runId, region, dryRun });
  console.log(`OSM source: ${result.url}`);
  console.log(`Raw file: ${path.relative(repoRoot, result.rawAbsPath)}`);
  if (result.sha256 && result.size != null) {
    console.log(`sha256: ${result.sha256}`);
    console.log(`size: ${result.size}`);
  } else {
    console.log(`sha256: (not available)`);
    console.log(`size: (not available)`);
  }
  console.log(`Updated manifest: ${path.relative(repoRoot, result.manifestPath)}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  console.error('Run with --help for usage.');
  process.exit(1);
}

