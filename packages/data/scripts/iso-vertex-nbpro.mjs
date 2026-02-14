import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { loadDotenv } from './lib/env.mjs';
import { runPython } from './lib/python-venv.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';
import { buildIsoMosaic } from './iso-tile-mosaic.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm -C packages/data iso:vertex:nbpro --run_id=<id> --tiles_dir=<run-rel-dir> --x0=<x> --y0=<y> [options]

Options:
  --out_dir               Output dir (run-relative). Default: exports/iso_nb_pro
  --layer                 Input layer inside tiles_dir. Default: raw_whitebox
  --w --h                 Patch size in tiles. Default: 4x4

Vertex:
  --vertex_project        Vertex project (or env VERTEX_PROJECT)
  --vertex_location       Vertex location (default: global)
  --model                 Model id/resource (required)
  --fallback_model        Fallback model (optional)

Generation:
  --k                     Candidates per tile (default: 4)
  --seed_mode             fixed|random|tile_hash (default: tile_hash)
  --seed_base             Base seed (default: 0)
  --image_size            1K|2K|4K (default: 1K)
  --aspect_ratio          e.g. 1:1 (default: 1:1)
  --temperature           (default: 0.45)
  --top_p                 (default: 0.9)

Style:
  --anchors_dir           Directory with 3-6 anchor images (run-relative or absolute)
  --anchors               Comma-separated 3-6 anchor image paths (run-relative or absolute)
  --prompt_file           Prompt template file (run-relative or absolute)
  --negative_prompt_file  Optional negative instructions file (run-relative or absolute)

Neighbors:
  --use_neighbors         0|1 (default: 1)
  --neighbor_mode         left+top | left+top+tl (default: left+top)

Scoring:
  --overlap_px            Strip width for seam scoring (default: 48)
  --score_weights         JSON string or path to JSON file (optional)

Cache:
  --cache_dir             Cache dir (default: .cache/vertex_nb_pro)
  --force                 0|1 (default: 0)

Mosaic:
  --mosaic_mode           crop|blend (default: crop)
  --mosaic_feather        Feather px for blend mode (default: 0)

Examples:
  export IMAGE_BACKEND=vertex
  export VERTEX_PROJECT=\"$(gcloud config get-value project)\"
  export VERTEX_LOCATION=global

  pnpm -C packages/data iso:vertex:nbpro \\
    --run_id=tashkent_local_2026-02-09 \\
    --tiles_dir=exports/iso_whitebox \\
    --layer=raw_whitebox \\
    --x0=0 --y0=0 --w=4 --h=4 \\
    --model=gemini-3-pro-image-preview --fallback_model=gemini-2.5-flash-image \\
    --anchors_dir=exports/anchors/nbpro \\
    --prompt_file=exports/prompts/nbpro.txt \\
    --k=4 --overlap_px=48
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

function parseNumber(args, key, fallback) {
  const v = Number(args[key]);
  return Number.isFinite(v) ? v : fallback;
}

function resolvePath(runRoot, p) {
  if (typeof p !== 'string' || p.trim().length === 0) return '';
  if (path.isAbsolute(p)) return p;
  const rel = ensureRelPath(p) ?? '';
  return rel ? path.join(runRoot, rel) : '';
}

async function listAnchorsFromDir(dirAbs) {
  const entries = await fs.readdir(dirAbs);
  const files = entries
    .filter((n) => /\.(png|jpg|jpeg|webp)$/i.test(n))
    .map((n) => path.join(dirAbs, n))
    .sort();
  return files;
}

export async function runIsoVertexNbpro({
  repoRoot,
  runId,
  tilesDirRel,
  layer = 'raw_whitebox',
  outDirRel = 'exports/iso_nb_pro',
  x0,
  y0,
  w = 4,
  h = 4,
  vertexProject = '',
  vertexLocation = 'global',
  model,
  fallbackModel = '',
  k = 4,
  seedMode = 'tile_hash',
  seedBase = 0,
  anchorsDir = '',
  anchors = '',
  promptFile = '',
  negativePromptFile = '',
  useNeighbors = 1,
  neighborMode = 'left+top',
  overlapPx = 48,
  scoreWeights = '',
  cacheDir = '.cache/vertex_nb_pro',
  force = 0,
  imageSize = '1K',
  aspectRatio = '1:1',
  temperature = 0.45,
  topP = 0.9,
  timeoutMs = 30000,
  retryMax = 2,
  retryBaseMs = 800,
  retryMaxMs = 8000,
  retryJitterMs = 300,
  debugRetries = 0,
  mosaicMode = 'crop',
  mosaicFeather = 0,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof tilesDirRel !== 'string' || tilesDirRel.trim().length === 0) throw new Error('Missing required --tiles_dir');
  if (!/^[a-zA-Z0-9._-]+$/.test(layer)) throw new Error(`Invalid --layer: ${layer}`);
  if (!Number.isFinite(x0) || !Number.isFinite(y0)) throw new Error('Missing required --x0/--y0');
  if (!model || String(model).trim().length === 0) throw new Error('Missing required --model');

  await loadDotenv({ repoRoot });

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const tilesDirRelSafe = ensureRelPath(tilesDirRel) ?? '';
  const outDirRelSafe = ensureRelPath(outDirRel) ?? 'exports/iso_nb_pro';

  const tilesBaseAbs = path.join(runRoot, tilesDirRelSafe);
  const outBaseAbs = path.join(runRoot, outDirRelSafe);

  const promptAbs = resolvePath(runRoot, promptFile);
  if (!promptAbs) throw new Error('Missing required --prompt_file');
  if (!(await fileExists(promptAbs))) throw new Error(`Missing --prompt_file: ${promptAbs}`);

  const negativeAbs = negativePromptFile ? resolvePath(runRoot, negativePromptFile) : '';
  if (negativeAbs && !(await fileExists(negativeAbs))) throw new Error(`Missing --negative_prompt_file: ${negativeAbs}`);

  let anchorAbsList = [];
  if (anchorsDir) {
    const dirAbs = resolvePath(runRoot, anchorsDir);
    if (!(await fileExists(dirAbs))) throw new Error(`Missing --anchors_dir: ${dirAbs}`);
    anchorAbsList = await listAnchorsFromDir(dirAbs);
  } else if (anchors) {
    const parts = String(anchors)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    anchorAbsList = parts.map((p) => resolvePath(runRoot, p));
  }
  if (anchorAbsList.length < 3 || anchorAbsList.length > 6) {
    throw new Error(`Expected 3..6 anchors, got: ${anchorAbsList.length}. Use --anchors_dir or --anchors=...`);
  }
  for (const p of anchorAbsList) {
    if (!(await fileExists(p))) throw new Error(`Missing anchor file: ${p}`);
  }

  await fs.mkdir(outBaseAbs, { recursive: true });

  // The mosaic tool reads overlap from out_dir/tilejson.json when present.
  const tilejsonInAbs = path.join(tilesBaseAbs, 'tilejson.json');
  const tilejsonOutAbs = path.join(outBaseAbs, 'tilejson.json');
  if (await fileExists(tilejsonInAbs)) {
    await fs.copyFile(tilejsonInAbs, tilejsonOutAbs);
  }

  const scriptPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'vertex_nb_pro_tiles.py');
  await runPython({
    repoRoot,
    scriptPath,
    args: [
      '--run_id',
      runId,
      '--run_root',
      runRoot,
      '--tiles_dir',
      tilesBaseAbs,
      '--layer',
      layer,
      '--out_dir',
      outBaseAbs,
      '--x0',
      String(Math.trunc(x0)),
      '--y0',
      String(Math.trunc(y0)),
      '--w',
      String(Math.trunc(w)),
      '--h',
      String(Math.trunc(h)),
      '--vertex_project',
      String(vertexProject || ''),
      '--vertex_location',
      String(vertexLocation || 'global'),
      '--model',
      String(model),
      '--fallback_model',
      String(fallbackModel || ''),
      '--k',
      String(Math.trunc(k)),
      '--seed_mode',
      String(seedMode || 'tile_hash'),
      '--seed_base',
      String(Math.trunc(seedBase)),
      '--anchors',
      anchorAbsList.join(','),
      '--prompt_file',
      promptAbs,
      ...(negativeAbs ? ['--negative_prompt_file', negativeAbs] : []),
      '--use_neighbors',
      String(Math.trunc(useNeighbors)),
      '--neighbor_mode',
      String(neighborMode || 'left+top'),
      '--overlap_px',
      String(Math.trunc(overlapPx)),
      ...(scoreWeights ? ['--score_weights', String(scoreWeights)] : []),
      '--cache_dir',
      path.isAbsolute(cacheDir) ? cacheDir : path.join(repoRoot, cacheDir),
      '--force',
      String(Math.trunc(force)),
      '--image_size',
      String(imageSize || '1K'),
      '--aspect_ratio',
      String(aspectRatio || '1:1'),
      '--temperature',
      String(temperature),
      '--top_p',
      String(topP),
      '--timeout_ms',
      String(Math.trunc(timeoutMs)),
      '--retry_max',
      String(Math.trunc(retryMax)),
      '--retry_base_ms',
      String(retryBaseMs),
      '--retry_max_ms',
      String(retryMaxMs),
      '--retry_jitter_ms',
      String(retryJitterMs),
      '--debug_retries',
      String(Math.trunc(debugRetries)),
    ],
  });

  const reportAbs = path.join(outBaseAbs, 'report_nb_pro.json');
  const heatmapAbs = path.join(outBaseAbs, 'seam_heatmap_nb_pro.png');
  const reportExists = await fileExists(reportAbs);
  const heatmapExists = await fileExists(heatmapAbs);
  const tilejsonExists = await fileExists(tilejsonOutAbs);

  await addFilesToManifest({
    manifestPath,
    runRoot,
    absPaths: [reportExists ? reportAbs : null, heatmapExists ? heatmapAbs : null, tilejsonExists ? tilejsonOutAbs : null].filter(Boolean),
  });

  if (!['crop', 'blend'].includes(mosaicMode)) throw new Error(`Invalid --mosaic_mode: ${String(mosaicMode)}`);

  const mosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel: outDirRelSafe,
    layer: 'tiles',
    mode: mosaicMode,
    featherPx: mosaicMode === 'blend' ? mosaicFeather : 0,
    outRel: `${outDirRelSafe}/mosaic_nb_pro.png`,
  });

  return {
    runId,
    tilesDirRel: tilesDirRelSafe,
    outDirRel: outDirRelSafe,
    reportRel: reportExists ? path.relative(runRoot, reportAbs).replaceAll('\\', '/') : null,
    heatmapRel: heatmapExists ? path.relative(runRoot, heatmapAbs).replaceAll('\\', '/') : null,
    mosaicRel: mosaic.outRel,
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const tilesDirRel = ensureRelPath(typeof args.tiles_dir === 'string' ? args.tiles_dir : args.tilesDir) ?? '';
  const outDirRel = ensureRelPath(typeof args.out_dir === 'string' ? args.out_dir : args.outDir) ?? 'exports/iso_nb_pro';
  const layer = typeof args.layer === 'string' ? args.layer : 'raw_whitebox';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await runIsoVertexNbpro({
      repoRoot,
      runId,
      tilesDirRel,
      layer,
      outDirRel,
      x0: parseNumber(args, 'x0', NaN),
      y0: parseNumber(args, 'y0', NaN),
      w: parseNumber(args, 'w', 4),
      h: parseNumber(args, 'h', 4),
      vertexProject: typeof args.vertex_project === 'string' ? args.vertex_project : process.env.VERTEX_PROJECT || '',
      vertexLocation: typeof args.vertex_location === 'string' ? args.vertex_location : process.env.VERTEX_LOCATION || 'global',
      model: typeof args.model === 'string' ? args.model : '',
      fallbackModel: typeof args.fallback_model === 'string' ? args.fallback_model : '',
      k: parseNumber(args, 'k', 4),
      seedMode: typeof args.seed_mode === 'string' ? args.seed_mode : 'tile_hash',
      seedBase: parseNumber(args, 'seed_base', 0),
      anchorsDir: typeof args.anchors_dir === 'string' ? args.anchors_dir : '',
      anchors: typeof args.anchors === 'string' ? args.anchors : '',
      promptFile: typeof args.prompt_file === 'string' ? args.prompt_file : '',
      negativePromptFile: typeof args.negative_prompt_file === 'string' ? args.negative_prompt_file : '',
      useNeighbors: parseNumber(args, 'use_neighbors', 1),
      neighborMode: typeof args.neighbor_mode === 'string' ? args.neighbor_mode : 'left+top',
      overlapPx: parseNumber(args, 'overlap_px', 48),
      scoreWeights: typeof args.score_weights === 'string' ? args.score_weights : '',
      cacheDir: typeof args.cache_dir === 'string' ? args.cache_dir : '.cache/vertex_nb_pro',
      force: parseNumber(args, 'force', 0),
      imageSize: typeof args.image_size === 'string' ? args.image_size : '1K',
      aspectRatio: typeof args.aspect_ratio === 'string' ? args.aspect_ratio : '1:1',
      temperature: parseNumber(args, 'temperature', 0.45),
      topP: parseNumber(args, 'top_p', 0.9),
      timeoutMs: parseNumber(args, 'timeout_ms', 30000),
      retryMax: parseNumber(args, 'retry_max', 2),
      retryBaseMs: parseNumber(args, 'retry_base_ms', 800),
      retryMaxMs: parseNumber(args, 'retry_max_ms', 8000),
      retryJitterMs: parseNumber(args, 'retry_jitter_ms', 300),
      debugRetries: parseNumber(args, 'debug_retries', 0),
      mosaicMode: typeof args.mosaic_mode === 'string' ? args.mosaic_mode : 'crop',
      mosaicFeather: parseNumber(args, 'mosaic_feather', 0),
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
