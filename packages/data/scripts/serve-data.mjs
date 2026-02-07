import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { startDataServer } from './lib/serve-data.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:serve [--host=127.0.0.1] [--port=8787]

Serves:
  <repo>/data/ at http://<host>:<port>/data/...

This server supports:
- CORS (for cross-port dev setups)
- HTTP Range requests (required for PMTiles)

Recommended for local dev:
  1) pnpm data:serve --port=8787
  2) NEXT_PUBLIC_BASE_DATA_URL=http://127.0.0.1:8787/data/releases
  3) pnpm dev
`);
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
  const portRaw = typeof args.port === 'string' ? args.port : '';
  const port = portRaw.trim() ? Number(portRaw) : 8787;
  const quiet = Boolean(args.quiet);

  if (!Number.isFinite(port) || port <= 0 || port >= 65536) {
    throw new Error(`Invalid --port: ${String(args.port)}`);
  }

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const { base_data_url } = await startDataServer({ repoRoot, host, port, quiet });

  // eslint-disable-next-line no-console
  console.log(`Data server: http://${host}:${port}/data/`);
  // eslint-disable-next-line no-console
  console.log(`BASE_DATA_URL: ${base_data_url}`);
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

