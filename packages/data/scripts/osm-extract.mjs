import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { extractOsm } from './lib/osm-extract.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  node packages/data/scripts/osm-extract.mjs --run_id=<id> [--dry-run]

Inputs:
  data/releases/<run_id>/manifest.json
  data/raw/osm/uzbekistan-latest.osm.pbf
  data/releases/<run_id>/aoi/<aoi>.geojson

Outputs:
  data/releases/<run_id>/vector/buildings.parquet
  data/releases/<run_id>/vector/roads.parquet
  data/releases/<run_id>/vector/water.parquet
  data/releases/<run_id>/vector/green.parquet

Options:
  --run_id    Release run id (folder name under data/releases/)
  --dry-run   Validate inputs only; do not run osmium; write nothing
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
    const report = await extractOsm({ repoRoot, runId, dryRun });

    for (const [layer, stats] of Object.entries(report.layers ?? {})) {
      if (!stats) continue;
      const written = Number(stats.written ?? 0);
      const invalid = Number(stats.invalid_polygons ?? 0);
      const fixed = Number(stats.fixed_polygons ?? 0);
      const skipped = Number(stats.skipped_invalid ?? 0);
      const dropped = Number(stats.dropped_empty ?? 0);
      console.log(`${layer}: written=${written} dropped_empty=${dropped} invalid=${invalid} fixed=${fixed} skipped=${skipped}`);
    }

    if (report.updated_manifest) {
      console.log(`Updated manifest artifacts: data/releases/${runId}/manifest.json`);
    }

    // Deterministic machine-readable report (useful for tests / CI logs).
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

