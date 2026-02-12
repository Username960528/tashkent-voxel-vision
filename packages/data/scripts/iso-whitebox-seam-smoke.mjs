import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';
import { seamInpaintTiles } from './iso-seam-inpaint.mjs';
import { stylizeDiffusionDir } from './iso-stylize-diffusion-dir.mjs';
import { stylizePixelDir } from './iso-stylize-pixel-dir.mjs';
import { buildIsoMosaic } from './iso-tile-mosaic.mjs';
import { renderIsoWhitebox } from './iso-whitebox.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:whitebox:seam:smoke --run_id=<id> --model=<hf_id_or_path> [options]

Pipeline:
  1) whitebox render (overlap-aware)
  2) mosaic raw -> mosaic_raw_whitebox.png
  3) diffusion dir stylize -> sd_whitebox
  4) mosaic sd -> mosaic_sd_whitebox.png
  5) seam inpaint -> sd_whitebox_seam
  6) mosaic seam -> mosaic_sd_whitebox_seam.png
  7) pixel dir stylize -> pixel_whitebox_seam
  8) mosaic pixel seam -> mosaic_pixel_whitebox_seam.png

Important options:
  --z_min=0 --z_max=0 --tile_size=1024 --ppm=0.09 --height_scale=2.1 --overlap=0.10
  --bbox_scale=0.12 --min_area_m2=30 --outline_opacity=0.06
  --lora=<hf_id_or_path> --lora_scale=0.8 --strength=0.30 --steps=12 --guidance=4.5 --seed=0 --device=auto
  --seam_strength=0.14 --seam_context=0 --mask_half=16 --write_half=20 --harmonize_half=12 --max_seams=0
  --max_images=0
`);
}

function parseNumber(args, keyA, keyB, fallback) {
  const raw = typeof args[keyA] === 'string' ? args[keyA] : args[keyB];
  const v = Number(raw);
  return Number.isFinite(v) ? v : fallback;
}

function parseString(args, keyA, keyB, fallback = '') {
  const raw = typeof args[keyA] === 'string' ? args[keyA] : args[keyB];
  return typeof raw === 'string' ? raw : fallback;
}

export async function runIsoWhiteboxSeamSmoke({
  repoRoot,
  runId,
  model,
  lora = '',
  loraScale = 0.8,
  prompt = '',
  negative = '',
  strength = 0.3,
  seamStrength = 0.14,
  steps = 12,
  guidance = 4.5,
  seed = 0,
  device = 'auto',
  zMin = 0,
  zMax = 0,
  tileSize = 1024,
  ppm = 0.09,
  heightScale = 2.1,
  overlap = 0.1,
  bboxScale = 0.12,
  minAreaM2 = 30,
  outlineOpacity = 0.06,
  seamContext = 0,
  maskHalf = 16,
  writeHalf = 20,
  harmonizeHalf = 12,
  maxSeams = 0,
  maxImages = 0,
}) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (typeof model !== 'string' || model.length === 0) throw new Error('Missing required --model');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const tilesDirRel = 'exports/iso_whitebox';
  const rawLayer = 'raw_whitebox';
  const sdLayer = 'sd_whitebox';
  const seamLayer = 'sd_whitebox_seam';
  const pixelLayer = 'pixel_whitebox_seam';

  const rawMosaicOut = `${tilesDirRel}/mosaic_raw_whitebox.png`;
  const sdMosaicOut = `${tilesDirRel}/mosaic_sd_whitebox.png`;
  const seamMosaicOut = `${tilesDirRel}/mosaic_sd_whitebox_seam.png`;
  const pixelMosaicOut = `${tilesDirRel}/mosaic_pixel_whitebox_seam.png`;

  const whitebox = await renderIsoWhitebox({
    repoRoot,
    runId,
    zMin,
    zMax,
    tileSize,
    ppm,
    heightScale,
    overlap,
    bboxScale,
    minAreaM2,
    outlineOpacity,
  });

  const rawLayerAbs = path.join(runRoot, tilesDirRel, rawLayer);
  const sdLayerAbs = path.join(runRoot, tilesDirRel, sdLayer);
  const seamLayerAbs = path.join(runRoot, tilesDirRel, seamLayer);
  const pixelLayerAbs = path.join(runRoot, tilesDirRel, pixelLayer);

  await fs.rm(rawLayerAbs, { recursive: true, force: true });
  await fs.rm(sdLayerAbs, { recursive: true, force: true });
  await fs.rm(seamLayerAbs, { recursive: true, force: true });
  await fs.rm(pixelLayerAbs, { recursive: true, force: true });

  await fs.mkdir(rawLayerAbs, { recursive: true });
  await fs.cp(path.join(runRoot, tilesDirRel, '0'), path.join(rawLayerAbs, '0'), {
    recursive: true,
    force: true,
  });

  const rawMosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: rawLayer,
    mode: 'crop',
    featherPx: 0,
    outRel: rawMosaicOut,
  });

  const sd = await stylizeDiffusionDir({
    repoRoot,
    runId,
    model,
    inDirRel: `${tilesDirRel}/${rawLayer}`,
    outDirRel: `${tilesDirRel}/${sdLayer}`,
    lora,
    loraScale,
    prompt,
    negative,
    strength,
    steps,
    guidance,
    seed,
    device,
    maxImages,
  });

  const sdMosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: sdLayer,
    mode: 'crop',
    featherPx: 0,
    outRel: sdMosaicOut,
  });

  const seam = await seamInpaintTiles({
    repoRoot,
    runId,
    model,
    tilesDirRel,
    layer: sdLayer,
    outLayer: seamLayer,
    lora,
    loraScale,
    prompt,
    negative,
    strength: seamStrength,
    steps: Math.max(8, steps),
    guidance,
    seamContext,
    maskHalf,
    writeHalf,
    harmonizeHalf,
    maxSeams,
    seed,
    device,
  });

  const seamMosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: seamLayer,
    mode: 'crop',
    featherPx: 0,
    outRel: seamMosaicOut,
  });

  const pixel = await stylizePixelDir({
    repoRoot,
    runId,
    inDirRel: `${tilesDirRel}/${seamLayer}`,
    outDirRel: `${tilesDirRel}/${pixelLayer}`,
    pixelScale: 0.22,
    palette: 64,
    dither: true,
    edgeThreshold: 112,
    edgeAlpha: 0.28,
    edgeThickness: 1,
    maxImages,
  });

  const pixelMosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: pixelLayer,
    mode: 'crop',
    featherPx: 0,
    outRel: pixelMosaicOut,
  });

  const seamReportAbs = path.join(runRoot, seam.reportRel);
  const seamReport = JSON.parse(await fs.readFile(seamReportAbs, 'utf8'));
  const suspiciousSeams = Array.isArray(seamReport?.suspicious_seams) ? seamReport.suspicious_seams : [];

  const qualityReportAbs = path.join(runRoot, tilesDirRel, 'quality_report_whitebox_seam.json');
  const qualityReport = {
    run_id: runId,
    created_at: new Date().toISOString(),
    seams_total: Number(seamReport?.seams_total ?? 0),
    seams_processed: Number(seamReport?.seams_processed ?? 0),
    seams_skipped: Number(seamReport?.seams_skipped ?? 0),
    suspicious_seams_count: suspiciousSeams.length,
    suspicious_seams: suspiciousSeams,
    artifacts: {
      mosaic_raw_whitebox: rawMosaic.outRel,
      mosaic_sd_whitebox: sdMosaic.outRel,
      mosaic_sd_whitebox_seam: seamMosaic.outRel,
      mosaic_pixel_whitebox_seam: pixelMosaic.outRel,
      seam_report: seam.reportRel,
    },
  };
  await fs.writeFile(qualityReportAbs, `${JSON.stringify(qualityReport, null, 2)}\n`, 'utf8');
  await addFilesToManifest({ manifestPath, runRoot, absPaths: [qualityReportAbs] });

  return {
    whitebox,
    sd,
    seam,
    pixel,
    rawMosaic: rawMosaic.outRel,
    sdMosaic: sdMosaic.outRel,
    seamMosaic: seamMosaic.outRel,
    pixelMosaic: pixelMosaic.outRel,
    qualityReport: path.relative(runRoot, qualityReportAbs).replaceAll('\\', '/'),
    seamsTotal: qualityReport.seams_total,
    seamsProcessed: qualityReport.seams_processed,
    seamsSkipped: qualityReport.seams_skipped,
    suspiciousSeams: qualityReport.suspicious_seams_count,
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = parseString(args, 'run_id', 'runId', '');
  const model = parseString(args, 'model', 'm', '');
  const lora = parseString(args, 'lora', 'l', '');

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await runIsoWhiteboxSeamSmoke({
      repoRoot,
      runId,
      model,
      lora,
      loraScale: parseNumber(args, 'lora_scale', 'loraScale', 0.8),
      prompt: parseString(args, 'prompt', 'p', ''),
      negative: parseString(args, 'negative', 'n', ''),
      strength: parseNumber(args, 'strength', 's', 0.3),
      seamStrength: parseNumber(args, 'seam_strength', 'seamStrength', 0.14),
      steps: parseNumber(args, 'steps', 'steps', 12),
      guidance: parseNumber(args, 'guidance', 'cfg', 4.5),
      seed: parseNumber(args, 'seed', 'seed', 0),
      device: parseString(args, 'device', 'device', 'auto'),
      zMin: parseNumber(args, 'z_min', 'zMin', 0),
      zMax: parseNumber(args, 'z_max', 'zMax', 0),
      tileSize: parseNumber(args, 'tile_size', 'tileSize', 1024),
      ppm: parseNumber(args, 'ppm', 'pixels_per_meter', 0.09),
      heightScale: parseNumber(args, 'height_scale', 'heightScale', 2.1),
      overlap: parseNumber(args, 'overlap', 'pad', 0.1),
      bboxScale: parseNumber(args, 'bbox_scale', 'bboxScale', 0.12),
      minAreaM2: parseNumber(args, 'min_area_m2', 'minAreaM2', 30),
      outlineOpacity: parseNumber(args, 'outline_opacity', 'outlineOpacity', 0.06),
      seamContext: parseNumber(args, 'seam_context', 'seamContext', 0),
      maskHalf: parseNumber(args, 'mask_half', 'maskHalf', 16),
      writeHalf: parseNumber(args, 'write_half', 'writeHalf', 20),
      harmonizeHalf: parseNumber(args, 'harmonize_half', 'harmonizeHalf', 12),
      maxSeams: parseNumber(args, 'max_seams', 'maxSeams', 0),
      maxImages: parseNumber(args, 'max_images', 'maxImages', 0),
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
