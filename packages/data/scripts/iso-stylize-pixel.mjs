import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:stylize:pixel --run_id=<id> [--in=<rel/path.png>] [--out=<rel/path.png>]
                              [--pixel_scale=0.20] [--palette=48] [--dither]
                              [--edge_threshold=48] [--edge_alpha=0.85] [--edge_thickness=2]

Defaults:
  --in   exports/iso_gmp_preview/preview.png
  --out  exports/iso_gmp_preview/preview_pixel.png

Notes:
  - This is a CPU-only stylizer. It cannot match a diffusion model on realism, but it provides a
    deterministic pixel-art look (pixelate + palette quantize + outlines) that runs on a small VPS.
  - Intended to be used as a stopgap, or as a baseline for later GPU-based stylization.
`);
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
}

function ensureRelPath(p) {
  if (typeof p !== 'string' || p.trim().length === 0) return null;
  const clean = p.replaceAll('\\', '/').replace(/^\/+/, '');
  if (clean.includes('..')) throw new Error(`Refusing unsafe path with '..': ${p}`);
  return clean;
}

export async function stylizePixel({
  repoRoot,
  runId,
  inRel = 'exports/iso_gmp_preview/preview.png',
  outRel = 'exports/iso_gmp_preview/preview_pixel.png',
  pixelScale = 0.2,
  palette = 48,
  dither = false,
  edgeThreshold = 48,
  edgeAlpha = 0.85,
  edgeThickness = 2,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);

  const inPath = path.join(runRoot, inRel);
  const outPath = path.join(runRoot, outRel);
  const reportPath = `${outPath}.json`;

  if (!(await fileExists(inPath))) {
    throw new Error(`Missing input PNG: ${inPath} (run data:iso:gmp:preview first, or pass --in=...)`);
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'pixel_stylize.py');
  await runPython({
    repoRoot,
    scriptPath,
    args: [
      '--in_png',
      inPath,
      '--out_png',
      outPath,
      '--report_json',
      reportPath,
      '--pixel_scale',
      String(pixelScale),
      '--palette',
      String(palette),
      ...(dither ? ['--dither'] : []),
      '--edge_threshold',
      String(edgeThreshold),
      '--edge_alpha',
      String(edgeAlpha),
      '--edge_thickness',
      String(edgeThickness),
    ],
  });

  if (!(await fileExists(outPath))) throw new Error(`Stylize failed: missing output: ${outPath}`);
  if (!(await fileExists(reportPath))) throw new Error(`Stylize failed: missing report: ${reportPath}`);

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [outPath, reportPath] });

  return {
    inRel,
    outRel,
    reportRel: path.relative(runRoot, reportPath).replaceAll('\\', '/'),
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const inRel = ensureRelPath(typeof args.in === 'string' ? args.in : '') ?? 'exports/iso_gmp_preview/preview.png';
  const outRel = ensureRelPath(typeof args.out === 'string' ? args.out : '') ?? 'exports/iso_gmp_preview/preview_pixel.png';

  const pixelScale = Number(typeof args.pixel_scale === 'string' ? args.pixel_scale : args.pixelScale);
  const palette = Number(typeof args.palette === 'string' ? args.palette : args.colors);
  const dither = Boolean(args.dither);
  const edgeThreshold = Number(typeof args.edge_threshold === 'string' ? args.edge_threshold : args.edgeThreshold);
  const edgeAlpha = Number(typeof args.edge_alpha === 'string' ? args.edge_alpha : args.edgeAlpha);
  const edgeThickness = Number(typeof args.edge_thickness === 'string' ? args.edge_thickness : args.edgeThickness);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await stylizePixel({
      repoRoot,
      runId,
      inRel,
      outRel,
      pixelScale: Number.isFinite(pixelScale) ? pixelScale : 0.2,
      palette: Number.isFinite(palette) ? palette : 48,
      dither,
      edgeThreshold: Number.isFinite(edgeThreshold) ? edgeThreshold : 48,
      edgeAlpha: Number.isFinite(edgeAlpha) ? edgeAlpha : 0.85,
      edgeThickness: Number.isFinite(edgeThickness) ? edgeThickness : 2,
    });
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

