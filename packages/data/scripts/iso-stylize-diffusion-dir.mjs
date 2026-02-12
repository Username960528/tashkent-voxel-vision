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
  pnpm data:iso:stylize:diffusion:dir --run_id=<id> --model=<hf_id_or_path> --in_dir=<run-rel-dir> [options]

Options:
  --out_dir        Output dir (run-relative). Default: replaces trailing /raw with /sd, else appends _sd
  --lora           Optional LoRA weights (HF repo id or local path)
  --lora_scale     LoRA scale (default: 0.8)
  --prompt         Positive prompt (optional)
  --negative       Negative prompt (optional)
  --strength       0..1 (default: 0.35)
  --steps          Inference steps (default: 28)
  --guidance       CFG guidance scale (default: 5.5)
  --seed           Seed (default: 0; -1=random)
  --device         auto|cuda|mps|cpu (default: auto)
  --max_images     Optional cap on images processed (default: 0=all)

Notes:
  - This loads the diffusion pipeline once and processes all PNGs in --in_dir recursively.
  - Intended for tile packs produced by: pnpm data:iso:gmp:tiles
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
  if (inDirRel.endsWith('/raw')) return inDirRel.replace(/\/raw$/, '/sd');
  return `${inDirRel}_sd`;
}

export async function stylizeDiffusionDir({
  repoRoot,
  runId,
  model,
  inDirRel,
  outDirRel,
  lora = '',
  loraScale = 0.8,
  prompt = '',
  negative = '',
  strength = 0.35,
  steps = 28,
  guidance = 5.5,
  seed = 0,
  device = 'auto',
  maxImages = 0,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof model !== 'string' || model.trim().length === 0) throw new Error('Missing required --model');
  if (typeof inDirRel !== 'string' || inDirRel.trim().length === 0) throw new Error('Missing required --in_dir');

  await loadDotenv({ repoRoot });

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const inDirAbs = path.join(runRoot, inDirRel);
  if (!(await fileExists(inDirAbs))) throw new Error(`Missing --in_dir: ${inDirAbs}`);

  const outDirAbs = path.join(runRoot, outDirRel);
  await fs.mkdir(outDirAbs, { recursive: true });

  const reportAbs = path.join(outDirAbs, 'report.json');

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'diffusion_img2img_dir.py');
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
      ...(lora ? ['--lora', lora, '--lora_scale', String(loraScale)] : []),
      ...(prompt ? ['--prompt', prompt] : []),
      ...(negative ? ['--negative', negative] : []),
      '--strength',
      String(strength),
      '--steps',
      String(steps),
      '--guidance',
      String(guidance),
      '--seed',
      String(seed),
      '--device',
      device,
      ...(maxImages ? ['--max_images', String(maxImages)] : []),
    ],
  });

  if (!(await fileExists(reportAbs))) throw new Error(`Stylize failed: missing report: ${reportAbs}`);
  const report = JSON.parse(await fs.readFile(reportAbs, 'utf8'));
  const fileCount = Number(report?.file_count ?? 0);
  if (!Number.isFinite(fileCount) || fileCount <= 0) {
    throw new Error(`Smoke check failed: expected file_count > 0, got: ${String(report?.file_count)}`);
  }

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [reportAbs] });

  return {
    inDirRel,
    outDirRel,
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
    fileCount,
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
  const lora = typeof args.lora === 'string' ? args.lora : '';
  const loraScale = Number(typeof args.lora_scale === 'string' ? args.lora_scale : args.loraScale);

  const inDirRel = ensureRelPath(typeof args.in_dir === 'string' ? args.in_dir : args.inDir) ?? '';
  const outDirRel =
    ensureRelPath(typeof args.out_dir === 'string' ? args.out_dir : args.outDir) ??
    (inDirRel ? defaultOutDirRel(inDirRel) : '');

  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const negative = typeof args.negative === 'string' ? args.negative : '';
  const strength = Number(typeof args.strength === 'string' ? args.strength : args.s);
  const steps = Number(typeof args.steps === 'string' ? args.steps : args.n);
  const guidance = Number(typeof args.guidance === 'string' ? args.guidance : args.cfg);
  const seed = Number(typeof args.seed === 'string' ? args.seed : 0);
  const device = typeof args.device === 'string' ? args.device : 'auto';
  const maxImages = Number(typeof args.max_images === 'string' ? args.max_images : args.maxImages);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await stylizeDiffusionDir({
      repoRoot,
      runId,
      model,
      inDirRel,
      outDirRel,
      lora,
      loraScale: Number.isFinite(loraScale) ? loraScale : 0.8,
      prompt,
      negative,
      strength: Number.isFinite(strength) ? strength : 0.35,
      steps: Number.isFinite(steps) ? steps : 28,
      guidance: Number.isFinite(guidance) ? guidance : 5.5,
      seed: Number.isFinite(seed) ? seed : 0,
      device,
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

