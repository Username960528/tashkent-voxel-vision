import path from 'node:path';

import { listAoiIds } from './lib/aoi-catalog.mjs';
import { parseArgs } from './lib/args.mjs';
import { initDataRelease } from './lib/init-data-release.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  const aois = listAoiIds().join(', ');
  console.log(`Usage:
  pnpm data:release:init --run_id=<id> --aoi=<aoi> [--force]

Options:
  --run_id   Release run id (folder name)
  --aoi      AOI id (${aois})
  --force    Overwrite existing manifest.json if present
`);
}

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
  const result = await initDataRelease({ repoRoot, runId, aoiId, force });
  console.log(`Initialized data release: ${path.relative(repoRoot, result.runRoot)}`);
  console.log(`Wrote manifest: ${path.relative(repoRoot, result.manifestPath)}`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  console.error('Run with --help for usage.');
  process.exit(1);
}
