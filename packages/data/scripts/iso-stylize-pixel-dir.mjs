import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:stylize:pixel:dir --run_id=<id> --in_dir=<run-rel-dir> [options]

Options:
  --out_dir          Output dir (run-relative). Default: replaces trailing /sd with /pixel, else appends _pixel
  --pixel_scale      Downscale factor before upscaling (default: 0.20)
  --palette          Palette size (default: 48)
  --dither           Enable dithering
  --edge_threshold   0..255 (default: 48)
  --edge_alpha       0..1 (default: 0.85)
  --edge_thickness   >= 1 (default: 2)
  --max_images       Optional cap on images processed (default: 0=all)

Notes:
  - CPU-only; fast enough to run on a small VPS.
  - Processes all PNGs in --in_dir recursively and mirrors the tree into --out_dir.
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
  const clean = p.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean.includes('..')) throw new Error(`Refusing unsafe path with '..': ${p}`);
  return clean;
}

function defaultOutDirRel(inDirRel) {
  if (inDirRel.endsWith('/sd')) return inDirRel.replace(/\/sd$/, '/pixel');
  return `${inDirRel}_pixel`;
}

async function listPngFilesRec(dirAbs) {
  const out = [];
  const stack = [dirAbs];
  while (stack.length > 0) {
    const cur = stack.pop();
    const entries = await fs.readdir(cur, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.png')) out.push(p);
    }
  }
  out.sort();
  return out;
}

export async function stylizePixelDir({
  repoRoot,
  runId,
  inDirRel,
  outDirRel,
  pixelScale = 0.2,
  palette = 48,
  dither = false,
  edgeThreshold = 48,
  edgeAlpha = 0.85,
  edgeThickness = 2,
  maxImages = 0,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof inDirRel !== 'string' || inDirRel.trim().length === 0) throw new Error('Missing required --in_dir');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const inDirAbs = path.join(runRoot, inDirRel);
  if (!(await fileExists(inDirAbs))) throw new Error(`Missing --in_dir: ${inDirAbs}`);

  const outDirAbs = path.join(runRoot, outDirRel);
  await fs.rm(outDirAbs, { recursive: true, force: true });
  await fs.mkdir(outDirAbs, { recursive: true });

  const files = await listPngFilesRec(inDirAbs);
  const cap = maxImages > 0 ? Math.min(maxImages, files.length) : files.length;
  if (cap <= 0) throw new Error(`No PNGs found under: ${inDirAbs}`);

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'pixel_stylize.py');
  const processed = [];
  for (let i = 0; i < cap; i++) {
    const inAbs = files[i];
    const rel = path.relative(inDirAbs, inAbs).replaceAll('\\', '/');
    const outAbs = path.join(outDirAbs, rel);
    await fs.mkdir(path.dirname(outAbs), { recursive: true });

    await runPython({
      repoRoot,
      scriptPath,
      args: [
        '--in_png',
        inAbs,
        '--out_png',
        outAbs,
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

    processed.push({
      in_png: path.join(inDirRel, rel).replaceAll('\\', '/'),
      out_png: path.join(outDirRel, rel).replaceAll('\\', '/'),
    });
  }

  const reportAbs = path.join(outDirAbs, 'report.json');
  const report = {
    run_id: runId,
    created_at: new Date().toISOString(),
    in_dir: inDirRel,
    out_dir: outDirRel,
    file_count: processed.length,
    pixel_scale: pixelScale,
    palette,
    dither,
    edge_threshold: edgeThreshold,
    edge_alpha: edgeAlpha,
    edge_thickness: edgeThickness,
    files: processed,
  };
  await fs.writeFile(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [reportAbs] });

  return {
    inDirRel,
    outDirRel,
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
    fileCount: processed.length,
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const inDirRel = ensureRelPath(typeof args.in_dir === 'string' ? args.in_dir : args.inDir) ?? '';
  const outDirRel =
    ensureRelPath(typeof args.out_dir === 'string' ? args.out_dir : args.outDir) ??
    (inDirRel ? defaultOutDirRel(inDirRel) : '');

  const pixelScale = Number(typeof args.pixel_scale === 'string' ? args.pixel_scale : args.pixelScale);
  const palette = Number(typeof args.palette === 'string' ? args.palette : args.colors);
  const dither = Boolean(args.dither);
  const edgeThreshold = Number(typeof args.edge_threshold === 'string' ? args.edge_threshold : args.edgeThreshold);
  const edgeAlpha = Number(typeof args.edge_alpha === 'string' ? args.edge_alpha : args.edgeAlpha);
  const edgeThickness = Number(typeof args.edge_thickness === 'string' ? args.edge_thickness : args.edgeThickness);
  const maxImages = Number(typeof args.max_images === 'string' ? args.max_images : args.maxImages);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await stylizePixelDir({
      repoRoot,
      runId,
      inDirRel,
      outDirRel,
      pixelScale: Number.isFinite(pixelScale) ? pixelScale : 0.2,
      palette: Number.isFinite(palette) ? palette : 48,
      dither,
      edgeThreshold: Number.isFinite(edgeThreshold) ? edgeThreshold : 48,
      edgeAlpha: Number.isFinite(edgeAlpha) ? edgeAlpha : 0.85,
      edgeThickness: Number.isFinite(edgeThickness) ? edgeThickness : 2,
      maxImages: Number.isFinite(maxImages) ? maxImages : 0,
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

