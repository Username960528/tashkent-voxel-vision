import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { loadDotenv } from './lib/env.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

const DIFFUSION_VENV = '.venv-diffusion';
const DIFFUSION_REQUIREMENTS = 'packages/data/scripts/py/requirements-diffusion.txt';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:seam:inpaint --run_id=<id> --model=<hf_id_or_path> --tiles_dir=<run-rel-dir> [options]

Options:
  --layer          Input layer inside tiles_dir (default: sd)
  --out_layer      Output layer inside tiles_dir (default: <layer>_seam)
  --lora           Optional LoRA weights (HF repo id or local path)
  --lora_scale     LoRA scale (default: 0.8)
  --prompt         Positive prompt (optional)
  --negative       Negative prompt (optional)
  --strength       0..1 denoise strength for inpaint (default: 0.20)
  --steps          Inference steps (default: 16)
  --guidance       CFG guidance scale (default: 4.5)
  --seam_context   Pixels of context per side around seam (default: 0=auto from overlap)
  --mask_half      Half-width of inpaint mask band around seam in px (default: 16)
  --write_half     Half-width written back into each neighbor tile in px (default: 20)
  --max_seams      Optional cap on processed seams (default: 0=all)
  --seed           Seed base (default: 0; -1=random base)
  --device         auto|cuda|mps|cpu (default: auto)

Examples:
  pnpm data:iso:seam:inpaint --run_id=tashkent_local_2026-02-09 \\
    --tiles_dir=exports/iso_gmp_tiles/grid_5 --layer=sd \\
    --model=stabilityai/stable-diffusion-xl-base-1.0 --lora=nerijs/pixel-art-xl --device=mps
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

function defaultOutLayer(layer) {
  return `${layer}_seam`;
}

function readNumber(args, keyA, keyB, fallback) {
  const v = Number(typeof args[keyA] === 'string' ? args[keyA] : args[keyB]);
  return Number.isFinite(v) ? v : fallback;
}

export async function seamInpaintTiles({
  repoRoot,
  runId,
  model,
  tilesDirRel,
  layer = 'sd',
  outLayer = '',
  lora = '',
  loraScale = 0.8,
  prompt = '',
  negative = '',
  strength = 0.2,
  steps = 16,
  guidance = 4.5,
  seamContext = 0,
  maskHalf = 16,
  writeHalf = 20,
  maxSeams = 0,
  seed = 0,
  device = 'auto',
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof model !== 'string' || model.trim().length === 0) throw new Error('Missing required --model');
  if (typeof tilesDirRel !== 'string' || tilesDirRel.trim().length === 0) throw new Error('Missing required --tiles_dir');
  if (!/^[a-zA-Z0-9._-]+$/.test(layer)) throw new Error(`Invalid --layer: ${layer}`);

  await loadDotenv({ repoRoot });

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const baseAbs = path.join(runRoot, tilesDirRel);
  const inDirAbs = path.join(baseAbs, layer);
  if (!(await fileExists(inDirAbs))) throw new Error(`Missing tiles input layer: ${inDirAbs}`);

  const outLayerName = outLayer || defaultOutLayer(layer);
  if (!/^[a-zA-Z0-9._-]+$/.test(outLayerName)) throw new Error(`Invalid --out_layer: ${outLayerName}`);
  if (outLayerName === layer) throw new Error('--out_layer must be different from --layer');
  const outDirAbs = path.join(baseAbs, outLayerName);
  await fs.mkdir(outDirAbs, { recursive: true });

  const tilejsonAbs = path.join(baseAbs, 'tilejson.json');
  let overlap = 0;
  if (await fileExists(tilejsonAbs)) {
    try {
      const tilejson = JSON.parse(await fs.readFile(tilejsonAbs, 'utf8'));
      const ov = Number(tilejson?.overlap ?? 0);
      if (Number.isFinite(ov) && ov >= 0 && ov < 0.49) overlap = ov;
    } catch {
      // ignore
    }
  }

  const reportAbs = path.join(outDirAbs, 'seam_inpaint_report.json');
  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'seam_inpaint_tiles.py');
  await runPython({
    repoRoot,
    scriptPath,
    venvDirName: DIFFUSION_VENV,
    requirementsPath: DIFFUSION_REQUIREMENTS,
    args: [
      '--in_dir',
      inDirAbs,
      '--out_dir',
      outDirAbs,
      '--report_json',
      reportAbs,
      '--model',
      model,
      '--overlap',
      String(overlap),
      ...(lora ? ['--lora', lora, '--lora_scale', String(loraScale)] : []),
      ...(prompt ? ['--prompt', prompt] : []),
      ...(negative ? ['--negative', negative] : []),
      '--strength',
      String(strength),
      '--steps',
      String(steps),
      '--guidance',
      String(guidance),
      '--seam_context',
      String(seamContext),
      '--mask_half',
      String(maskHalf),
      '--write_half',
      String(writeHalf),
      '--max_seams',
      String(maxSeams),
      '--seed',
      String(seed),
      '--device',
      device,
    ],
  });

  if (!(await fileExists(reportAbs))) throw new Error(`Seam inpaint failed: missing report: ${reportAbs}`);
  const report = JSON.parse(await fs.readFile(reportAbs, 'utf8'));
  const seamsProcessed = Number(report?.seams_processed ?? 0);
  if (!Number.isFinite(seamsProcessed) || seamsProcessed <= 0) {
    throw new Error(`Smoke check failed: expected seams_processed > 0, got: ${String(report?.seams_processed)}`);
  }

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [reportAbs] });

  return {
    tilesDirRel,
    layer,
    outLayer: outLayerName,
    overlap,
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
    seamsProcessed,
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const model = typeof args.model === 'string' ? args.model : '';
  const tilesDirRel = ensureRelPath(typeof args.tiles_dir === 'string' ? args.tiles_dir : args.tilesDir) ?? '';
  const layer = typeof args.layer === 'string' ? args.layer : 'sd';
  const outLayer = typeof args.out_layer === 'string' ? args.out_layer : args.outLayer ?? '';
  const lora = typeof args.lora === 'string' ? args.lora : '';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await seamInpaintTiles({
      repoRoot,
      runId,
      model,
      tilesDirRel,
      layer,
      outLayer,
      lora,
      loraScale: readNumber(args, 'lora_scale', 'loraScale', 0.8),
      prompt: typeof args.prompt === 'string' ? args.prompt : '',
      negative: typeof args.negative === 'string' ? args.negative : '',
      strength: readNumber(args, 'strength', 's', 0.2),
      steps: readNumber(args, 'steps', 'n', 16),
      guidance: readNumber(args, 'guidance', 'cfg', 4.5),
      seamContext: readNumber(args, 'seam_context', 'seamContext', 0),
      maskHalf: readNumber(args, 'mask_half', 'maskHalf', 16),
      writeHalf: readNumber(args, 'write_half', 'writeHalf', 20),
      maxSeams: readNumber(args, 'max_seams', 'maxSeams', 0),
      seed: readNumber(args, 'seed', 'seed', 0),
      device: typeof args.device === 'string' ? args.device : 'auto',
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
