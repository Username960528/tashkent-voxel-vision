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
  pnpm data:iso:stylize:diffusion:tiled --run_id=<id> --model=<hf_id_or_path> --tiles_dir=<run-rel-dir> [options]

Options:
  --layer                  Input layer inside tiles_dir (default: sd_whitebox_seam)
  --out_layer              Output layer inside tiles_dir (default: <layer>_global)
  --lora                   Optional LoRA weights (HF repo id or local path)
  --lora_scale             LoRA scale (default: 0.8)
  --prompt                 Positive prompt (optional)
  --negative               Negative prompt (optional)
  --strength               Global img2img strength (default: 0.08)
  --steps                  Inference steps for global pass (default: 12)
  --guidance               CFG guidance for global pass (default: 4.2)
  --tile_px                Window size for tiled global pass (default: 1024)
  --tile_overlap_px        Window overlap in px (default: 256)
  --tile_feather_px        Window feather in px (default: 128)
  --intersection_pass      Extra intersection-conditioned pass on seam crossings (0|1, default: 1)
  --intersection_half      Half-size of square patch around crossing (default: 120)
  --intersection_boost     Extra strength added on intersections (default: 0.08)
  --intersection_steps     Steps for intersection pass (default: 0 -> max(steps, 14))
  --max_intersections      Optional cap on processed intersections (default: 0=all)
  --seed                   Seed base (default: 0; -1=random)
  --device                 auto|cuda|mps|cpu (default: auto)
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
  return `${layer}_global`;
}

function readNumber(args, keyA, keyB, fallback) {
  const v = Number(typeof args[keyA] === 'string' ? args[keyA] : args[keyB]);
  return Number.isFinite(v) ? v : fallback;
}

export async function globalTiledDiffusionTiles({
  repoRoot,
  runId,
  model,
  tilesDirRel,
  layer = 'sd_whitebox_seam',
  outLayer = '',
  lora = '',
  loraScale = 0.8,
  prompt = '',
  negative = '',
  strength = 0.08,
  steps = 12,
  guidance = 4.2,
  tilePx = 1024,
  tileOverlapPx = 256,
  tileFeatherPx = 128,
  intersectionPass = 1,
  intersectionHalf = 120,
  intersectionBoost = 0.08,
  intersectionSteps = 0,
  maxIntersections = 0,
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
  await fs.rm(outDirAbs, { recursive: true, force: true });
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

  const reportAbs = path.join(outDirAbs, 'global_tiled_diffusion_report.json');
  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'diffusion_tiled_img2img.py');
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
      '--tile_px',
      String(tilePx),
      '--tile_overlap_px',
      String(tileOverlapPx),
      '--tile_feather_px',
      String(tileFeatherPx),
      '--intersection_pass',
      String(intersectionPass),
      '--intersection_half',
      String(intersectionHalf),
      '--intersection_boost',
      String(intersectionBoost),
      '--intersection_steps',
      String(intersectionSteps),
      '--max_intersections',
      String(maxIntersections),
      '--seed',
      String(seed),
      '--device',
      device,
    ],
  });

  if (!(await fileExists(reportAbs))) throw new Error(`Global tiled diffusion failed: missing report: ${reportAbs}`);
  const report = JSON.parse(await fs.readFile(reportAbs, 'utf8'));

  const copied = Number(report?.tile_count_written ?? 0);
  if (!Number.isFinite(copied) || copied <= 0) {
    throw new Error(`Smoke check failed: expected tile_count_written > 0, got: ${String(report?.tile_count_written)}`);
  }

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [reportAbs] });

  return {
    tilesDirRel,
    layer,
    outLayer: outLayerName,
    overlap,
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
    tileCountWritten: copied,
    globalWindowsTotal: Number(report?.global_windows_total ?? 0),
    globalWindowsProcessed: Number(report?.global_windows_processed ?? 0),
    intersectionsTotal: Number(report?.intersections_total ?? 0),
    intersectionsProcessed: Number(report?.intersections_processed ?? 0),
    intersectionsSkipped: Number(report?.intersections_skipped ?? 0),
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
  const layer = typeof args.layer === 'string' ? args.layer : 'sd_whitebox_seam';
  const outLayer = typeof args.out_layer === 'string' ? args.out_layer : args.outLayer ?? '';
  const lora = typeof args.lora === 'string' ? args.lora : '';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await globalTiledDiffusionTiles({
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
      strength: readNumber(args, 'strength', 's', 0.08),
      steps: readNumber(args, 'steps', 'n', 12),
      guidance: readNumber(args, 'guidance', 'cfg', 4.2),
      tilePx: readNumber(args, 'tile_px', 'tilePx', 1024),
      tileOverlapPx: readNumber(args, 'tile_overlap_px', 'tileOverlapPx', 256),
      tileFeatherPx: readNumber(args, 'tile_feather_px', 'tileFeatherPx', 128),
      intersectionPass: readNumber(args, 'intersection_pass', 'intersectionPass', 1),
      intersectionHalf: readNumber(args, 'intersection_half', 'intersectionHalf', 120),
      intersectionBoost: readNumber(args, 'intersection_boost', 'intersectionBoost', 0.08),
      intersectionSteps: readNumber(args, 'intersection_steps', 'intersectionSteps', 0),
      maxIntersections: readNumber(args, 'max_intersections', 'maxIntersections', 0),
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
