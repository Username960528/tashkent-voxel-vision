import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';
import { globalTiledDiffusionTiles } from './iso-global-tiled-diffusion.mjs';
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
  7) global tiled diffusion (optional) -> sd_whitebox_seam_global
  8) post-global seam refine (optional) -> sd_whitebox_seam_global_refined
  9) mosaic global -> mosaic_sd_whitebox_seam_global.png
  10) pixel dir stylize -> pixel_whitebox_seam or pixel_whitebox_seam_global
  11) mosaic pixel -> mosaic_pixel_whitebox_seam*.png

Important options:
  --z_min=0 --z_max=0 --tile_size=1024 --ppm=0.09 --height_scale=2.1 --overlap=0.10
  --bbox_scale=0.12 --min_area_m2=30 --outline_opacity=0.06
  --lora=<hf_id_or_path> --lora_scale=0.8 --strength=0.30 --steps=12 --guidance=4.5 --seed=0 --device=auto
  --seam_strength=0.14 --seam_context=0 --mask_half=16 --write_half=20 --harmonize_half=12 --intersection_pass=1 --intersection_mask_half=10 --intersection_write_half=24 --max_intersections=0 --max_seams=0
  --global_pass=1 --global_strength=0.08 --global_steps=12 --global_guidance=4.2
  --global_tile_px=1024 --global_tile_overlap_px=256 --global_tile_feather_px=128
  --global_intersection_pass=1 --global_intersection_half=120 --global_intersection_boost=0.08 --global_max_intersections=0
  --post_global_seam_pass=0 --post_global_seam_strength=0.12 --post_global_mask_half=20 --post_global_write_half=26
  --post_global_intersection_pass=1 --post_global_intersection_mask_half=14 --post_global_intersection_write_half=30
  --seam_mosaic_mode=blend --seam_mosaic_feather=24
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
  intersectionPass = 1,
  intersectionMaskHalf = 10,
  intersectionWriteHalf = 24,
  maxIntersections = 0,
  maxSeams = 0,
  globalPass = 1,
  globalStrength = 0.08,
  globalSteps = 12,
  globalGuidance = 4.2,
  globalTilePx = 1024,
  globalTileOverlapPx = 256,
  globalTileFeatherPx = 128,
  globalIntersectionPass = 1,
  globalIntersectionHalf = 120,
  globalIntersectionBoost = 0.08,
  globalIntersectionSteps = 0,
  globalMaxIntersections = 0,
  globalSeedOffset = 1000,
  postGlobalSeamPass = 0,
  postGlobalSeamStrength = 0.12,
  postGlobalSeamContext = 0,
  postGlobalMaskHalf = 20,
  postGlobalWriteHalf = 26,
  postGlobalHarmonizeHalf = 14,
  postGlobalIntersectionPass = 1,
  postGlobalIntersectionMaskHalf = 14,
  postGlobalIntersectionWriteHalf = 30,
  postGlobalMaxIntersections = 0,
  postGlobalMaxSeams = 0,
  seamMosaicMode = 'blend',
  seamMosaicFeather = 24,
  maxImages = 0,
}) {
  if (typeof runId !== 'string' || runId.length === 0) throw new Error('Missing required --run_id');
  if (typeof model !== 'string' || model.length === 0) throw new Error('Missing required --model');

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const tilesDirRel = 'exports/iso_whitebox';
  const rawLayer = 'raw_whitebox';
  const sdLayer = 'sd_whitebox';
  const seamLayer = 'sd_whitebox_seam';
  const globalLayer = 'sd_whitebox_seam_global';
  const globalRefinedLayer = 'sd_whitebox_seam_global_refined';
  const pixelLayerSeam = 'pixel_whitebox_seam';
  const pixelLayerGlobal = 'pixel_whitebox_seam_global';
  const useGlobalPass = Number(globalPass) !== 0;
  const usePostGlobalSeamPass = useGlobalPass && Number(postGlobalSeamPass) !== 0;
  const pixelZoomPreset = {
    pixelScale: 0.18,
    palette: 72,
    dither: true,
    edgeThreshold: 96,
    edgeAlpha: 0.35,
    edgeThickness: 1,
    maxEdgeCoverage: 0.32,
    edgeDarkMinLuma: 120,
    contrast: 1.15,
    saturation: 1.08,
  };

  const rawMosaicOut = `${tilesDirRel}/mosaic_raw_whitebox.png`;
  const sdMosaicOut = `${tilesDirRel}/mosaic_sd_whitebox.png`;
  const seamMosaicOut = `${tilesDirRel}/mosaic_sd_whitebox_seam.png`;
  const globalMosaicOut = `${tilesDirRel}/mosaic_sd_whitebox_seam_global.png`;
  const pixelMosaicOutSeam = `${tilesDirRel}/mosaic_pixel_whitebox_seam.png`;
  const pixelMosaicOutGlobal = `${tilesDirRel}/mosaic_pixel_whitebox_seam_global.png`;

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
  const globalLayerAbs = path.join(runRoot, tilesDirRel, globalLayer);
  const globalRefinedLayerAbs = path.join(runRoot, tilesDirRel, globalRefinedLayer);
  const pixelLayerAbsSeam = path.join(runRoot, tilesDirRel, pixelLayerSeam);
  const pixelLayerAbsGlobal = path.join(runRoot, tilesDirRel, pixelLayerGlobal);

  await fs.rm(rawLayerAbs, { recursive: true, force: true });
  await fs.rm(sdLayerAbs, { recursive: true, force: true });
  await fs.rm(seamLayerAbs, { recursive: true, force: true });
  await fs.rm(globalLayerAbs, { recursive: true, force: true });
  await fs.rm(globalRefinedLayerAbs, { recursive: true, force: true });
  await fs.rm(pixelLayerAbsSeam, { recursive: true, force: true });
  await fs.rm(pixelLayerAbsGlobal, { recursive: true, force: true });

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
    intersectionPass,
    intersectionMaskHalf,
    intersectionWriteHalf,
    maxIntersections,
    maxSeams,
    seed,
    device,
  });

  const seamMosaic = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: seamLayer,
    mode: seamMosaicMode,
    featherPx: seamMosaicFeather,
    outRel: seamMosaicOut,
  });

  let global = null;
  let globalRefine = null;
  let globalMosaic = null;
  let finalSdLayer = seamLayer;
  if (useGlobalPass) {
    global = await globalTiledDiffusionTiles({
      repoRoot,
      runId,
      model,
      tilesDirRel,
      layer: seamLayer,
      outLayer: globalLayer,
      lora,
      loraScale,
      prompt,
      negative,
      strength: globalStrength,
      steps: Math.max(8, globalSteps),
      guidance: globalGuidance,
      tilePx: globalTilePx,
      tileOverlapPx: globalTileOverlapPx,
      tileFeatherPx: globalTileFeatherPx,
      intersectionPass: globalIntersectionPass,
      intersectionHalf: globalIntersectionHalf,
      intersectionBoost: globalIntersectionBoost,
      intersectionSteps: globalIntersectionSteps,
      maxIntersections: globalMaxIntersections,
      seed: Number(seed) + Number(globalSeedOffset),
      device,
    });
    if (usePostGlobalSeamPass) {
      globalRefine = await seamInpaintTiles({
        repoRoot,
        runId,
        model,
        tilesDirRel,
        layer: global.outLayer,
        outLayer: globalRefinedLayer,
        lora,
        loraScale,
        prompt,
        negative,
        strength: Number(postGlobalSeamStrength) > 0 ? postGlobalSeamStrength : seamStrength,
        steps: Math.max(8, globalSteps),
        guidance: globalGuidance,
        seamContext: postGlobalSeamContext,
        maskHalf: postGlobalMaskHalf,
        writeHalf: postGlobalWriteHalf,
        harmonizeHalf: postGlobalHarmonizeHalf,
        intersectionPass: postGlobalIntersectionPass,
        intersectionMaskHalf: postGlobalIntersectionMaskHalf,
        intersectionWriteHalf: postGlobalIntersectionWriteHalf,
        maxIntersections: postGlobalMaxIntersections,
        maxSeams: postGlobalMaxSeams,
        seed: Number(seed) + Number(globalSeedOffset) + 777,
        device,
      });
    }
    const finalGlobalLayer = globalRefine?.outLayer ?? global.outLayer;
    globalMosaic = await buildIsoMosaic({
      repoRoot,
      runId,
      tilesDirRel,
      layer: finalGlobalLayer,
      mode: seamMosaicMode,
      featherPx: seamMosaicFeather,
      outRel: globalMosaicOut,
    });
    finalSdLayer = finalGlobalLayer;
  }

  // Always generate the seam pixel artifact, even when global pass is enabled, so downstream reports can compare.
  const pixelSeam = await stylizePixelDir({
    repoRoot,
    runId,
    inDirRel: `${tilesDirRel}/${seamLayer}`,
    outDirRel: `${tilesDirRel}/${pixelLayerSeam}`,
    ...pixelZoomPreset,
    edgeBorderStrip: 6,
    maxImages,
  });
  const pixelMosaicSeam = await buildIsoMosaic({
    repoRoot,
    runId,
    tilesDirRel,
    layer: pixelLayerSeam,
    mode: seamMosaicMode,
    featherPx: seamMosaicFeather,
    outRel: pixelMosaicOutSeam,
  });

  const pixelLayer = useGlobalPass ? pixelLayerGlobal : pixelLayerSeam;
  let pixel = pixelSeam;
  let pixelMosaic = pixelMosaicSeam;

  if (useGlobalPass) {
    pixel = await stylizePixelDir({
      repoRoot,
      runId,
      inDirRel: `${tilesDirRel}/${finalSdLayer}`,
      outDirRel: `${tilesDirRel}/${pixelLayerGlobal}`,
      ...pixelZoomPreset,
      edgeBorderStrip: 4,
      maxImages,
    });

    pixelMosaic = await buildIsoMosaic({
      repoRoot,
      runId,
      tilesDirRel,
      layer: pixelLayerGlobal,
      mode: seamMosaicMode,
      featherPx: seamMosaicFeather,
      outRel: pixelMosaicOutGlobal,
    });
  }

  const seamReportAbs = path.join(runRoot, seam.reportRel);
  const seamReport = JSON.parse(await fs.readFile(seamReportAbs, 'utf8'));
  const globalRefineReport = globalRefine?.reportRel
    ? JSON.parse(await fs.readFile(path.join(runRoot, globalRefine.reportRel), 'utf8'))
    : null;
  const finalSeamReport = globalRefineReport ?? seamReport;
  const suspiciousSeams = Array.isArray(finalSeamReport?.suspicious_seams) ? finalSeamReport.suspicious_seams : [];

  const qualityReportAbs = path.join(runRoot, tilesDirRel, 'quality_report_whitebox_seam.json');
  const qualityReport = {
    run_id: runId,
    created_at: new Date().toISOString(),
    seams_total: Number(finalSeamReport?.seams_total ?? 0),
    seams_processed: Number(finalSeamReport?.seams_processed ?? 0),
    seams_skipped: Number(finalSeamReport?.seams_skipped ?? 0),
    intersections_total: Number(finalSeamReport?.intersections_total ?? 0),
    intersections_processed: Number(finalSeamReport?.intersections_processed ?? 0),
    intersections_skipped: Number(finalSeamReport?.intersections_skipped ?? 0),
    base_seams_total: Number(seamReport?.seams_total ?? 0),
    base_seams_processed: Number(seamReport?.seams_processed ?? 0),
    base_seams_skipped: Number(seamReport?.seams_skipped ?? 0),
    global_pass_enabled: useGlobalPass,
    post_global_seam_enabled: usePostGlobalSeamPass,
    post_global_seams_total: Number(globalRefineReport?.seams_total ?? 0),
    post_global_seams_processed: Number(globalRefineReport?.seams_processed ?? 0),
    post_global_seams_skipped: Number(globalRefineReport?.seams_skipped ?? 0),
    global_windows_total: global?.globalWindowsTotal ?? 0,
    global_windows_processed: global?.globalWindowsProcessed ?? 0,
    global_intersections_total: global?.intersectionsTotal ?? 0,
    global_intersections_processed: global?.intersectionsProcessed ?? 0,
    global_intersections_skipped: global?.intersectionsSkipped ?? 0,
    suspicious_seams_count: suspiciousSeams.length,
    suspicious_seams: suspiciousSeams,
    artifacts: {
      mosaic_raw_whitebox: rawMosaic.outRel,
      mosaic_sd_whitebox: sdMosaic.outRel,
      mosaic_sd_whitebox_seam: seamMosaic.outRel,
      mosaic_sd_whitebox_seam_global: globalMosaic?.outRel ?? null,
      mosaic_pixel_whitebox_seam: pixelMosaicSeam.outRel,
      mosaic_pixel_whitebox_seam_global: useGlobalPass ? pixelMosaic.outRel : null,
      global_final_layer: finalSdLayer,
      pixel_input_layer: finalSdLayer,
      pixel_output_layer: pixelLayer,
      seam_report: seam.reportRel,
      global_report: global?.reportRel ?? null,
      post_global_seam_report: globalRefine?.reportRel ?? null,
      seam_mosaic_mode: seamMosaicMode,
      seam_mosaic_feather: seamMosaicFeather,
    },
  };
  await fs.writeFile(qualityReportAbs, `${JSON.stringify(qualityReport, null, 2)}\n`, 'utf8');
  await addFilesToManifest({ manifestPath, runRoot, absPaths: [qualityReportAbs] });

  return {
    whitebox,
    sd,
    seam,
    global,
    globalRefine,
    pixel,
    rawMosaic: rawMosaic.outRel,
    sdMosaic: sdMosaic.outRel,
    seamMosaic: seamMosaic.outRel,
    globalMosaic: globalMosaic?.outRel ?? null,
    pixelMosaic: pixelMosaic.outRel,
    finalSdLayer,
    qualityReport: path.relative(runRoot, qualityReportAbs).replaceAll('\\', '/'),
    seamsTotal: qualityReport.seams_total,
    seamsProcessed: qualityReport.seams_processed,
    seamsSkipped: qualityReport.seams_skipped,
    intersectionsTotal: qualityReport.intersections_total,
    intersectionsProcessed: qualityReport.intersections_processed,
    intersectionsSkipped: qualityReport.intersections_skipped,
    globalWindowsTotal: qualityReport.global_windows_total,
    globalWindowsProcessed: qualityReport.global_windows_processed,
    globalIntersectionsTotal: qualityReport.global_intersections_total,
    globalIntersectionsProcessed: qualityReport.global_intersections_processed,
    globalIntersectionsSkipped: qualityReport.global_intersections_skipped,
    postGlobalSeamEnabled: qualityReport.post_global_seam_enabled,
    postGlobalSeamsTotal: qualityReport.post_global_seams_total,
    postGlobalSeamsProcessed: qualityReport.post_global_seams_processed,
    postGlobalSeamsSkipped: qualityReport.post_global_seams_skipped,
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
      intersectionPass: parseNumber(args, 'intersection_pass', 'intersectionPass', 1),
      intersectionMaskHalf: parseNumber(args, 'intersection_mask_half', 'intersectionMaskHalf', 10),
      intersectionWriteHalf: parseNumber(args, 'intersection_write_half', 'intersectionWriteHalf', 24),
      maxIntersections: parseNumber(args, 'max_intersections', 'maxIntersections', 0),
      maxSeams: parseNumber(args, 'max_seams', 'maxSeams', 0),
      globalPass: parseNumber(args, 'global_pass', 'globalPass', 1),
      globalStrength: parseNumber(args, 'global_strength', 'globalStrength', 0.08),
      globalSteps: parseNumber(args, 'global_steps', 'globalSteps', 12),
      globalGuidance: parseNumber(args, 'global_guidance', 'globalGuidance', 4.2),
      globalTilePx: parseNumber(args, 'global_tile_px', 'globalTilePx', 1024),
      globalTileOverlapPx: parseNumber(args, 'global_tile_overlap_px', 'globalTileOverlapPx', 256),
      globalTileFeatherPx: parseNumber(args, 'global_tile_feather_px', 'globalTileFeatherPx', 128),
      globalIntersectionPass: parseNumber(args, 'global_intersection_pass', 'globalIntersectionPass', 1),
      globalIntersectionHalf: parseNumber(args, 'global_intersection_half', 'globalIntersectionHalf', 120),
      globalIntersectionBoost: parseNumber(args, 'global_intersection_boost', 'globalIntersectionBoost', 0.08),
      globalIntersectionSteps: parseNumber(args, 'global_intersection_steps', 'globalIntersectionSteps', 0),
      globalMaxIntersections: parseNumber(args, 'global_max_intersections', 'globalMaxIntersections', 0),
      globalSeedOffset: parseNumber(args, 'global_seed_offset', 'globalSeedOffset', 1000),
      postGlobalSeamPass: parseNumber(args, 'post_global_seam_pass', 'postGlobalSeamPass', 0),
      postGlobalSeamStrength: parseNumber(args, 'post_global_seam_strength', 'postGlobalSeamStrength', 0.12),
      postGlobalSeamContext: parseNumber(args, 'post_global_seam_context', 'postGlobalSeamContext', 0),
      postGlobalMaskHalf: parseNumber(args, 'post_global_mask_half', 'postGlobalMaskHalf', 20),
      postGlobalWriteHalf: parseNumber(args, 'post_global_write_half', 'postGlobalWriteHalf', 26),
      postGlobalHarmonizeHalf: parseNumber(args, 'post_global_harmonize_half', 'postGlobalHarmonizeHalf', 14),
      postGlobalIntersectionPass: parseNumber(args, 'post_global_intersection_pass', 'postGlobalIntersectionPass', 1),
      postGlobalIntersectionMaskHalf: parseNumber(
        args,
        'post_global_intersection_mask_half',
        'postGlobalIntersectionMaskHalf',
        14
      ),
      postGlobalIntersectionWriteHalf: parseNumber(
        args,
        'post_global_intersection_write_half',
        'postGlobalIntersectionWriteHalf',
        30
      ),
      postGlobalMaxIntersections: parseNumber(
        args,
        'post_global_max_intersections',
        'postGlobalMaxIntersections',
        0
      ),
      postGlobalMaxSeams: parseNumber(args, 'post_global_max_seams', 'postGlobalMaxSeams', 0),
      seamMosaicMode: parseString(args, 'seam_mosaic_mode', 'seamMosaicMode', 'blend'),
      seamMosaicFeather: parseNumber(args, 'seam_mosaic_feather', 'seamMosaicFeather', 24),
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
