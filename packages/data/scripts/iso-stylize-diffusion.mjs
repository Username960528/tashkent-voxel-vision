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
  pnpm data:iso:stylize:diffusion --run_id=<id> --model=<hf_id_or_path> [options]

Options:
  --in             Input PNG (run-relative). Default: exports/iso_gmp_preview/preview.png
  --out            Output PNG (run-relative). Default: exports/iso_gmp_preview/preview_sd.png
  --lora           Optional LoRA weights (HF repo id or local path)
  --lora_scale     LoRA scale (default: 0.8)
  --prompt         Positive prompt (optional)
  --negative       Negative prompt (optional)
  --strength       0..1 (default: 0.35)
  --steps          Inference steps (default: 28)
  --guidance       CFG guidance scale (default: 5.5)
  --seed           Seed (default: 0; -1=random)
  --device         auto|cuda|mps|cpu (default: auto)

Notes:
  - This uses a separate python venv at packages/data/${DIFFUSION_VENV} with deps from:
      ${DIFFUSION_REQUIREMENTS}
  - It is a no-training baseline (img2img). For seam-free pyramids we will add inpaint overlap later.
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

export async function stylizeDiffusion({
  repoRoot,
  runId,
  model,
  inRel = 'exports/iso_gmp_preview/preview.png',
  outRel = 'exports/iso_gmp_preview/preview_sd.png',
  lora = '',
  loraScale = 0.8,
  prompt = '',
  negative = '',
  strength = 0.35,
  steps = 28,
  guidance = 5.5,
  seed = 0,
  device = 'auto',
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof model !== 'string' || model.trim().length === 0) throw new Error('Missing required --model');

  // Load .env/.env.local for optional HF tokens, etc.
  await loadDotenv({ repoRoot });

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);

  const inPath = path.join(runRoot, inRel);
  const outPath = path.join(runRoot, outRel);
  const reportPath = `${outPath}.json`;

  if (!(await fileExists(inPath))) {
    throw new Error(`Missing input PNG: ${inPath} (run data:iso:gmp:preview first, or pass --in=...)`);
  }
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'diffusion_img2img.py');
  await runPython({
    repoRoot,
    scriptPath,
    venvDirName: DIFFUSION_VENV,
    requirementsPath: DIFFUSION_REQUIREMENTS,
    args: [
      '--in_png',
      inPath,
      '--out_png',
      outPath,
      '--report_json',
      reportPath,
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
  const model = typeof args.model === 'string' ? args.model : '';
  const lora = typeof args.lora === 'string' ? args.lora : '';
  const loraScale = Number(typeof args.lora_scale === 'string' ? args.lora_scale : args.loraScale);

  const inRel = ensureRelPath(typeof args.in === 'string' ? args.in : '') ?? 'exports/iso_gmp_preview/preview.png';
  const outRel = ensureRelPath(typeof args.out === 'string' ? args.out : '') ?? 'exports/iso_gmp_preview/preview_sd.png';

  const prompt = typeof args.prompt === 'string' ? args.prompt : '';
  const negative = typeof args.negative === 'string' ? args.negative : '';
  const strength = Number(typeof args.strength === 'string' ? args.strength : args.s);
  const steps = Number(typeof args.steps === 'string' ? args.steps : args.n);
  const guidance = Number(typeof args.guidance === 'string' ? args.guidance : args.cfg);
  const seed = Number(typeof args.seed === 'string' ? args.seed : 0);
  const device = typeof args.device === 'string' ? args.device : 'auto';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await stylizeDiffusion({
      repoRoot,
      runId,
      model,
      inRel,
      outRel,
      lora,
      loraScale: Number.isFinite(loraScale) ? loraScale : 0.8,
      prompt,
      negative,
      strength: Number.isFinite(strength) ? strength : 0.35,
      steps: Number.isFinite(steps) ? steps : 28,
      guidance: Number.isFinite(guidance) ? guidance : 5.5,
      seed: Number.isFinite(seed) ? seed : 0,
      device,
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
