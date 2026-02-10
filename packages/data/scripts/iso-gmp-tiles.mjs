import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { loadDotenv } from './lib/env.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';
import { scaleBboxWgs84, splitBboxGridWgs84 } from './lib/tile-grid.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:gmp:tiles --run_id=<id> [--grid=3] [--width=768 --height=768]
                         [--heading=45 --pitch=-35] [--max_sse=4] [--bbox_scale=1]
                         [--overlap=0.10]
                         [--timeout_ms=30000 --poll_ms=250 --stable_frames=6] [--max_tiles=0]

Environment:
  GMP_API_KEY              Google Maps Platform key with Photorealistic 3D Tiles enabled (required)
  CHROME_EXECUTABLE_PATH   Path to Chrome/Chromium binary (optional; auto-detected on common setups)

Outputs:
  data/releases/<run_id>/exports/iso_gmp_tiles/grid_<N>/
    tilejson.json
    report.json
    raw/0/<x>/<y>.png

Notes:
  - This renders an NxN grid of tiles over the AOI bbox stored in the release manifest.
  - Tiles are intended as conditioning inputs for later diffusion stylization and seam handling.
  - Use --overlap to render each tile with extra padding (for later crop/inpaint stitching).
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

async function findChromeExecutablePath() {
  const fromEnv = process.env.CHROME_EXECUTABLE_PATH;
  if (fromEnv && (await fileExists(fromEnv))) return fromEnv;

  const candidates = [];
  if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env['ProgramFiles'] ?? '';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? '';
    if (localApp) candidates.push(path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
  }

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  return '';
}

function buildCesiumHtml({ apiKey, config }) {
  const CESIUM_BASE_URL = 'https://unpkg.com/cesium@1.116.0/Build/Cesium/';
  const initScript = `window.CESIUM_BASE_URL = ${JSON.stringify(CESIUM_BASE_URL)}; window.__GMP_API_KEY__ = ${JSON.stringify(apiKey)}; window.__GMP_CONFIG__ = ${JSON.stringify(config)};`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TVV GMP Tiles</title>
    <link
      href="https://unpkg.com/cesium@1.116.0/Build/Cesium/Widgets/widgets.css"
      rel="stylesheet"
    />
    <style>
      html,
      body,
      #cesiumContainer {
        width: 100%;
        height: 100%;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: #ffffff;
      }
      #creditContainer {
        position: absolute;
        right: 0;
        bottom: 0;
        max-width: 60%;
        font-size: 10px;
        line-height: 1.2;
        background: rgba(255, 255, 255, 0.75);
        color: #111;
        padding: 6px 8px;
        border-top-left-radius: 6px;
        z-index: 10;
      }
    </style>
    <script>${initScript}</script>
  </head>
  <body>
    <div id="cesiumContainer"></div>
    <div id="creditContainer"></div>
    <script src="https://unpkg.com/cesium@1.116.0/Build/Cesium/Cesium.js"></script>
    <script>
      (async () => {
        const apiKey = window.__GMP_API_KEY__;
        const cfg = window.__GMP_CONFIG__;
        if (!apiKey) throw new Error('Missing window.__GMP_API_KEY__');
        if (!cfg) throw new Error('Missing __GMP_CONFIG__');

        const creditEl = document.getElementById('creditContainer');

        try { Cesium.buildModuleUrl.setBaseUrl(window.CESIUM_BASE_URL); } catch {}

        const viewer = new Cesium.Viewer('cesiumContainer', {
          animation: false,
          timeline: false,
          baseLayerPicker: false,
          geocoder: false,
          homeButton: false,
          navigationHelpButton: false,
          sceneModePicker: false,
          fullscreenButton: false,
          infoBox: false,
          selectionIndicator: false,
          creditContainer: creditEl
        });

        viewer.scene.requestRenderMode = true;
        viewer.scene.maximumRenderTimeChange = Infinity;
        viewer.scene.fog.enabled = false;
        viewer.scene.skyBox.show = false;
        viewer.scene.skyAtmosphere.show = false;
        viewer.scene.backgroundColor = Cesium.Color.WHITE;
        viewer.scene.globe.baseColor = Cesium.Color.WHITE;
        viewer.scene.globe.enableLighting = false;
        try { viewer.imageryLayers.removeAll(); } catch {}

        const tilesetResource = new Cesium.Resource({
          url: cfg.tileset_url,
          queryParameters: { key: apiKey }
        });
        const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetResource, {
          maximumScreenSpaceError: cfg.max_sse
        });
        viewer.scene.primitives.add(tileset);
        await tileset.readyPromise;

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        async function waitStable() {
          const start = performance.now();
          let stable = 0;
          while (performance.now() - start < cfg.timeout_ms) {
            viewer.scene.requestRender();
            await sleep(cfg.poll_ms);
            if (tileset.tilesLoaded) stable++;
            else stable = 0;
            if (stable >= cfg.stable_frames) break;
          }
          viewer.scene.requestRender();
          await sleep(250);
        }

        window.__GMP_RENDER__ = async (bbox) => {
          try {
            if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('Invalid bbox');
            const [west, south, east, north] = bbox;
            const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);
            viewer.camera.setView({
              destination: rect,
              orientation: {
                heading: Cesium.Math.toRadians(cfg.heading_deg),
                pitch: Cesium.Math.toRadians(cfg.pitch_deg),
                roll: 0.0
              }
            });
            await waitStable();
            const pos = viewer.camera.positionCartographic;
            return {
              ok: true,
              tiles_loaded: Boolean(tileset.tilesLoaded),
              credits_html: creditEl.innerHTML,
              credits_text: creditEl.innerText,
              camera: {
                lon: Cesium.Math.toDegrees(pos.longitude),
                lat: Cesium.Math.toDegrees(pos.latitude),
                height_m: pos.height,
                heading_deg: Cesium.Math.toDegrees(viewer.camera.heading),
                pitch_deg: Cesium.Math.toDegrees(viewer.camera.pitch),
                roll_deg: Cesium.Math.toDegrees(viewer.camera.roll)
              }
            };
          } catch (err) {
            return { ok: false, error: String(err && err.message ? err.message : err) };
          }
        };

        window.__GMP_READY__ = true;
      })().catch((err) => {
        window.__GMP_READY__ = true;
        window.__GMP_BOOT_ERROR__ = String(err && err.message ? err.message : err);
      });
    </script>
  </body>
</html>`;
}

export async function renderIsoGmpTiles({
  repoRoot,
  runId,
  grid = 3,
  width = 768,
  height = 768,
  headingDeg = 45,
  pitchDeg = -35,
  maxSse = 4,
  bboxScale = 1,
  overlap = 0.1,
  timeoutMs = 30_000,
  pollMs = 250,
  stableFrames = 6,
  maxTiles = 0,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (!Number.isInteger(grid) || grid <= 0 || grid > 64) throw new Error(`Invalid --grid: ${String(grid)} (expected 1..64)`);
  if (!Number.isFinite(width) || width <= 0) throw new Error(`Invalid --width: ${String(width)}`);
  if (!Number.isFinite(height) || height <= 0) throw new Error(`Invalid --height: ${String(height)}`);
  if (!Number.isFinite(headingDeg)) throw new Error(`Invalid --heading: ${String(headingDeg)}`);
  if (!Number.isFinite(pitchDeg)) throw new Error(`Invalid --pitch: ${String(pitchDeg)}`);
  if (!Number.isFinite(maxSse) || maxSse <= 0) throw new Error(`Invalid --max_sse: ${String(maxSse)}`);
  if (!Number.isFinite(bboxScale) || bboxScale <= 0 || bboxScale > 1) {
    throw new Error(`Invalid --bbox_scale: ${String(bboxScale)} (expected 0 < scale <= 1)`);
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= 0.49) {
    throw new Error(`Invalid --overlap: ${String(overlap)} (expected 0..0.49)`);
  }
  if (!Number.isFinite(maxTiles) || maxTiles < 0) throw new Error(`Invalid --max_tiles: ${String(maxTiles)}`);

  await loadDotenv({ repoRoot });

  const apiKey = process.env.GMP_API_KEY || process.env.GOOGLE_MAPS_PLATFORM_API_KEY || '';
  if (!apiKey) {
    throw new Error('Missing env GMP_API_KEY (or GOOGLE_MAPS_PLATFORM_API_KEY)');
  }

  const chromePath = await findChromeExecutablePath();
  if (!chromePath) {
    throw new Error(
      'Could not find Chrome/Chromium. Set CHROME_EXECUTABLE_PATH or install a browser (e.g. google-chrome/chromium).',
    );
  }

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const bbox = manifest?.aoi?.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    throw new Error('Invalid manifest: missing aoi.bbox');
  }
  const bboxUsed = bboxScale === 1 ? bbox : scaleBboxWgs84(bbox, bboxScale);

  const baseOutDir = path.join(runRoot, 'exports', 'iso_gmp_tiles', `grid_${grid}`);
  const rawDir = path.join(baseOutDir, 'raw');
  await fs.mkdir(rawDir, { recursive: true });

  const tilejsonPath = path.join(baseOutDir, 'tilejson.json');
  const reportPath = path.join(baseOutDir, 'report.json');

  const tiles = splitBboxGridWgs84({ bbox: bboxUsed, grid, overlap });

  const html = buildCesiumHtml({
    apiKey,
    config: {
      tileset_url: 'https://tile.googleapis.com/v1/3dtiles/root.json',
      heading_deg: headingDeg,
      pitch_deg: pitchDeg,
      max_sse: maxSse,
      timeout_ms: timeoutMs,
      poll_ms: pollMs,
      stable_frames: stableFrames,
    },
  });

  const browser = await chromium.launch({
    executablePath: chromePath,
    headless: true,
    args: process.platform === 'linux' ? ['--no-sandbox', '--disable-dev-shm-usage'] : [],
  });

  const createdAt = new Date().toISOString();
  const tileEntries = [];

  try {
    const context = await browser.newContext({
      viewport: { width: Math.floor(width), height: Math.floor(height) },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();

    page.on('pageerror', (err) => {
      // eslint-disable-next-line no-console
      console.error(`[pageerror] ${String(err)}`);
    });

    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForFunction('window.__GMP_READY__ === true', null, { timeout: timeoutMs + 10_000 });
    const bootErr = await page.evaluate(() => window.__GMP_BOOT_ERROR__ || '');
    if (bootErr) throw new Error(`GMP tiles boot failed: ${bootErr}`);

    const canvas = await page.$('#cesiumContainer canvas');
    if (!canvas) throw new Error('Failed to locate Cesium canvas');

    const capTiles = maxTiles > 0 ? Math.min(maxTiles, tiles.length) : tiles.length;
    for (let i = 0; i < capTiles; i++) {
      const t = tiles[i];
      const outPng = path.join(rawDir, String(t.z), String(t.x), `${t.y}.png`);
      await fs.mkdir(path.dirname(outPng), { recursive: true });

      const capture = await page.evaluate((bboxArg) => window.__GMP_RENDER__(bboxArg), t.bbox_overlap);
      if (!capture?.ok) {
        throw new Error(`GMP tile render failed (x=${t.x} y=${t.y}): ${String(capture?.error ?? 'unknown error')}`);
      }

      await canvas.screenshot({ path: outPng });

      tileEntries.push({
        z: t.z,
        x: t.x,
        y: t.y,
        bbox: t.bbox,
        bbox_overlap: t.bbox_overlap,
        png: path.relative(baseOutDir, outPng).replaceAll('\\', '/'),
        capture,
      });
    }
  } finally {
    await browser.close();
  }

  const tilejson = {
    type: 'tvv_iso_gmp_tiles',
    run_id: runId,
    created_at: createdAt,
    tiles: tileEntries.map((t) => t.png),
    tiles_path_template: 'raw/0/{x}/{y}.png',
    grid,
    overlap,
    aoi_bbox: bbox,
    bbox_used: bboxUsed,
    view: {
      width_px: Math.floor(width),
      height_px: Math.floor(height),
      heading_deg: headingDeg,
      pitch_deg: pitchDeg,
      max_sse: maxSse,
      bbox_scale: bboxScale,
    },
    attribution_note:
      'This capture is sourced from Google Photorealistic 3D Tiles. Check Google Maps Platform terms and ensure required attributions are displayed in any end-user experience.',
  };

  const report = {
    ...tilejson,
    tile_count: tileEntries.length,
  };

  await fs.writeFile(tilejsonPath, `${JSON.stringify(tilejson, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  await addFilesToManifest({ manifestPath, runRoot, absPaths: [tilejsonPath, reportPath] });

  return {
    outDir: baseOutDir,
    rawDir,
    tileCount: tileEntries.length,
    tilejsonRel: path.relative(runRoot, tilejsonPath).replaceAll('\\', '/'),
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
  const grid = Number(typeof args.grid === 'string' ? args.grid : args.n);
  const width = Number(typeof args.width === 'string' ? args.width : args.w);
  const height = Number(typeof args.height === 'string' ? args.height : args.h);
  const heading = Number(typeof args.heading === 'string' ? args.heading : args.heading_deg);
  const pitch = Number(typeof args.pitch === 'string' ? args.pitch : args.pitch_deg);
  const maxSse = Number(typeof args.max_sse === 'string' ? args.max_sse : args.maxSse);
  const bboxScale = Number(typeof args.bbox_scale === 'string' ? args.bbox_scale : args.bboxScale);
  const overlap = Number(typeof args.overlap === 'string' ? args.overlap : args.pad);
  const timeoutMs = Number(typeof args.timeout_ms === 'string' ? args.timeout_ms : args.timeoutMs);
  const pollMs = Number(typeof args.poll_ms === 'string' ? args.poll_ms : args.pollMs);
  const stableFrames = Number(typeof args.stable_frames === 'string' ? args.stable_frames : args.stableFrames);
  const maxTiles = Number(typeof args.max_tiles === 'string' ? args.max_tiles : args.maxTiles);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await renderIsoGmpTiles({
      repoRoot,
      runId,
      grid: Number.isInteger(grid) ? grid : 3,
      width: Number.isFinite(width) ? width : 768,
      height: Number.isFinite(height) ? height : 768,
      headingDeg: Number.isFinite(heading) ? heading : 45,
      pitchDeg: Number.isFinite(pitch) ? pitch : -35,
      maxSse: Number.isFinite(maxSse) ? maxSse : 4,
      bboxScale: Number.isFinite(bboxScale) ? bboxScale : 1,
      overlap: Number.isFinite(overlap) ? overlap : 0.1,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000,
      pollMs: Number.isFinite(pollMs) ? pollMs : 250,
      stableFrames: Number.isFinite(stableFrames) ? stableFrames : 6,
      maxTiles: Number.isFinite(maxTiles) ? maxTiles : 0,
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
