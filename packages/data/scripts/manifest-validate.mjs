import fs from 'node:fs/promises';
import path from 'node:path';

import { parseArgs } from './lib/args.mjs';
import { validateManifest } from './lib/manifest-schema.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:manifest:validate --manifest=<path>
  pnpm data:manifest:validate <path>

Options:
  --manifest  Path to manifest.json (relative to repo root or absolute)
`);
}

const { args, rest } = parseArgs(process.argv.slice(2));

if (args.help || args.h) {
  printHelp();
  process.exit(0);
}

const manifestArg = typeof args.manifest === 'string' ? args.manifest : rest[0];
if (!manifestArg) {
  printHelp();
  process.exit(2);
}

const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
const absPath = path.isAbsolute(manifestArg) ? manifestArg : path.join(repoRoot, manifestArg);

let manifest;
try {
  const raw = await fs.readFile(absPath, 'utf8');
  manifest = JSON.parse(raw);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Failed to read/parse JSON: ${absPath}\n${msg}`);
  process.exit(1);
}

const result = await validateManifest(manifest);
if (!result.valid) {
  console.error(`Invalid manifest: ${absPath}`);
  for (const e of result.errors) console.error(`- ${e.path}: ${e.message}`);
  process.exit(1);
}

console.log(`OK: ${absPath}`);
