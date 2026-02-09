import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

import { parseArgs } from './lib/args.mjs';
import { buildArtifact, getRunPaths, upsertArtifacts } from './lib/artifacts.mjs';
import { loadDotenv } from './lib/env.mjs';
import { validateManifest } from './lib/manifest-schema.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

function printHelp() {
  console.log(`Usage:
  pnpm data:iso:gmp:preview --run_id=<id> [--width=1024 --height=1024] [--heading=45 --pitch=-35] [--max_sse=4] [--bbox_scale=1]
                           [--timeout_ms=30000 --poll_ms=250 --stable_frames=6]

Environment:
  GMP_API_KEY              Google Maps Platform key with Photorealistic 3D Tiles enabled (required)
  CHROME_EXECUTABLE_PATH   Path to Chrome/Chromium binary (optional; auto-detected on common setups)

Outputs:
  data/releases/<run_id>/exports/iso_gmp_preview/
    preview.png
    preview.json

Notes:
  - This renders a single isometric-ish preview image from Google Photorealistic 3D Tiles over the AOI bbox
    stored in the release manifest. It is intended as a conditioning input for a later pixel-art stylizer.
  - Attribution/credits are captured into preview.json. Do not commit API keys; they are read from env only.
  - Use --bbox_scale < 1 to zoom in around the AOI center (useful for inspecting building-level detail).
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
    // Best-effort only; prefer CHROME_EXECUTABLE_PATH on Windows.
    const localApp = process.env.LOCALAPPDATA ?? '';
    const programFiles = process.env['ProgramFiles'] ?? '';
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? '';
    if (localApp) candidates.push(path.join(localApp, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFiles) candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    if (programFilesX86) candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else {
    // Linux common locations
    candidates.push('/usr/bin/google-chrome');
    candidates.push('/usr/bin/chromium');
    candidates.push('/usr/bin/chromium-browser');
  }

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }

  return '';
}

function scaleBbox(bbox, scale) {
  const [west, south, east, north] = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfW = ((east - west) * scale) / 2;
  const halfH = ((north - south) * scale) / 2;
  return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

function buildCesiumHtml({ apiKey, config }) {
  // Keep everything self-contained; config is injected directly into the HTML.
  // Cesium is loaded from CDN to avoid bundling it into the repo.
  // Use a CDN that serves Cesium worker scripts with CORS headers; WebWorkers require CORS.
  const CESIUM_BASE_URL = 'https://unpkg.com/cesium@1.116.0/Build/Cesium/';
  // Note: Playwright page.setContent runs at about:blank, so Cesium can't infer its asset/worker base URL.
  // Explicitly set CESIUM_BASE_URL so workers/Assets resolve correctly and we don't silently fall back.
  const initScript = `window.CESIUM_BASE_URL = ${JSON.stringify(CESIUM_BASE_URL)}; window.__GMP_API_KEY__ = ${JSON.stringify(apiKey)}; window.__GMP_CONFIG__ = ${JSON.stringify(config)};`;
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>TVV GMP Preview</title>
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
        if (!cfg || !Array.isArray(cfg.bbox) || cfg.bbox.length !== 4) throw new Error('Missing/invalid __GMP_CONFIG__.bbox');

        const creditEl = document.getElementById('creditContainer');

        // Ensure Cesium worker/asset URLs resolve correctly when running from about:blank.
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

        // Reduce visual noise and make screenshots deterministic-ish.
        viewer.scene.requestRenderMode = true;
        viewer.scene.maximumRenderTimeChange = Infinity;
        viewer.scene.fog.enabled = false;
        viewer.scene.skyBox.show = false;
        viewer.scene.skyAtmosphere.show = false;
        viewer.scene.backgroundColor = Cesium.Color.WHITE;
        viewer.scene.globe.baseColor = Cesium.Color.WHITE;
        viewer.scene.globe.enableLighting = false;
        try {
          viewer.imageryLayers.removeAll();
        } catch {}

        const tilesetResource = new Cesium.Resource({
          url: cfg.tileset_url,
          queryParameters: { key: apiKey }
        });

        const tileset = await Cesium.Cesium3DTileset.fromUrl(tilesetResource, {
          maximumScreenSpaceError: cfg.max_sse
        });
        viewer.scene.primitives.add(tileset);
        await tileset.readyPromise;

        const west = cfg.bbox[0], south = cfg.bbox[1], east = cfg.bbox[2], north = cfg.bbox[3];
        const rect = Cesium.Rectangle.fromDegrees(west, south, east, north);

        viewer.camera.setView({
          destination: rect,
          orientation: {
            heading: Cesium.Math.toRadians(cfg.heading_deg),
            pitch: Cesium.Math.toRadians(cfg.pitch_deg),
            roll: 0.0
          }
        });

        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

        const pos = viewer.camera.positionCartographic;
        const result = {
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

        window.__GMP_RESULT__ = result;
        window.__GMP_DONE__ = true;
      })().catch((err) => {
        window.__GMP_RESULT__ = { ok: false, error: String(err && err.message ? err.message : err) };
        window.__GMP_DONE__ = true;
      });
    </script>
  </body>
</html>`;
}

export async function renderIsoGmpPreview({
  repoRoot,
  runId,
  width = 1024,
  height = 1024,
  headingDeg = 45,
  pitchDeg = -35,
  maxSse = 4,
  bboxScale = 1,
  timeoutMs = 30_000,
  pollMs = 250,
  stableFrames = 6,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  // Load .env/.env.local so users don't have to export keys on every run.
  await loadDotenv({ repoRoot });

  if (!Number.isFinite(width) || width <= 0) throw new Error(`Invalid --width: ${String(width)}`);
  if (!Number.isFinite(height) || height <= 0) throw new Error(`Invalid --height: ${String(height)}`);
  if (!Number.isFinite(headingDeg)) throw new Error(`Invalid --heading: ${String(headingDeg)}`);
  if (!Number.isFinite(pitchDeg)) throw new Error(`Invalid --pitch: ${String(pitchDeg)}`);
  if (!Number.isFinite(maxSse) || maxSse <= 0) throw new Error(`Invalid --max_sse: ${String(maxSse)}`);
  if (!Number.isFinite(bboxScale) || bboxScale <= 0 || bboxScale > 1) {
    throw new Error(`Invalid --bbox_scale: ${String(bboxScale)} (expected 0 < scale <= 1)`);
  }

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
  const bboxUsed = bboxScale === 1 ? bbox : scaleBbox(bbox, bboxScale);

  const outDir = path.join(runRoot, 'exports', 'iso_gmp_preview');
  await fs.mkdir(outDir, { recursive: true });

  const outPng = path.join(outDir, 'preview.png');
  const outJson = path.join(outDir, 'preview.json');

  const html = buildCesiumHtml({
    apiKey,
    config: {
      bbox: bboxUsed,
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

    // Playwright signature is waitForFunction(fn, arg?, options). Passing an object as the 2nd param is
    // ambiguous (arg vs options), so we pass `null` for arg to ensure options are applied.
    await page.waitForFunction('window.__GMP_DONE__ === true', null, { timeout: timeoutMs + 10_000 });
    const result = await page.evaluate(() => window.__GMP_RESULT__);
    if (!result?.ok) {
      throw new Error(`GMP preview render failed: ${String(result?.error ?? 'unknown error')}`);
    }

    const canvas = await page.$('#cesiumContainer canvas');
    if (!canvas) throw new Error('Failed to locate Cesium canvas');
    await canvas.screenshot({ path: outPng });

    const createdAt = new Date().toISOString();
    const preview = {
      run_id: runId,
      created_at: createdAt,
      aoi: { id: manifest?.aoi?.id ?? null, bbox },
      renderer: {
        provider: 'google_photorealistic_3d_tiles',
        tileset_url: 'https://tile.googleapis.com/v1/3dtiles/root.json',
        api_key_env: process.env.GMP_API_KEY ? 'GMP_API_KEY' : 'GOOGLE_MAPS_PLATFORM_API_KEY',
        chrome_executable: chromePath,
      },
      view: {
        width_px: Math.floor(width),
        height_px: Math.floor(height),
        heading_deg: headingDeg,
        pitch_deg: pitchDeg,
        max_sse: maxSse,
        bbox_scale: bboxScale,
        bbox_used: bboxUsed,
      },
      capture: result,
      attribution_note:
        'This capture is sourced from Google Photorealistic 3D Tiles. Check Google Maps Platform terms and ensure required attributions are displayed in any end-user experience.',
    };
    await fs.writeFile(outJson, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');

    // Update manifest: artifacts + sources.google_photorealistic_3d_tiles
    const artifacts = [await buildArtifact(runRoot, outPng), await buildArtifact(runRoot, outJson)];
    upsertArtifacts(manifest, artifacts);
    if (!manifest.sources || typeof manifest.sources !== 'object') manifest.sources = {};
    manifest.sources.google_photorealistic_3d_tiles = {
      tileset_url: 'https://tile.googleapis.com/v1/3dtiles/root.json',
      api_key_env: process.env.GMP_API_KEY ? 'GMP_API_KEY' : 'GOOGLE_MAPS_PLATFORM_API_KEY',
      rendered_at: createdAt,
      notes: 'Attribution captured in exports/iso_gmp_preview/preview.json',
    };

    const validation = await validateManifest(manifest);
    if (!validation.valid) {
      const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
      throw new Error(`Internal error: updated manifest failed schema validation:\n${details}`);
    }
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    return {
      outDir,
      previewPngRel: path.relative(runRoot, outPng).replaceAll('\\', '/'),
      previewJsonRel: path.relative(runRoot, outJson).replaceAll('\\', '/'),
      creditsCaptured: Boolean(result?.credits_text),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const width = Number(typeof args.width === 'string' ? args.width : args.w);
  const height = Number(typeof args.height === 'string' ? args.height : args.h);
  const heading = Number(typeof args.heading === 'string' ? args.heading : args.heading_deg);
  const pitch = Number(typeof args.pitch === 'string' ? args.pitch : args.pitch_deg);
  const maxSse = Number(typeof args.max_sse === 'string' ? args.max_sse : args.maxSse);
  const bboxScale = Number(typeof args.bbox_scale === 'string' ? args.bbox_scale : args.bboxScale);
  const timeoutMs = Number(typeof args.timeout_ms === 'string' ? args.timeout_ms : args.timeoutMs);
  const pollMs = Number(typeof args.poll_ms === 'string' ? args.poll_ms : args.pollMs);
  const stableFrames = Number(typeof args.stable_frames === 'string' ? args.stable_frames : args.stableFrames);

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();

  try {
    const result = await renderIsoGmpPreview({
      repoRoot,
      runId,
      width: Number.isFinite(width) ? width : 1024,
      height: Number.isFinite(height) ? height : 1024,
      headingDeg: Number.isFinite(heading) ? heading : 45,
      pitchDeg: Number.isFinite(pitch) ? pitch : -35,
      maxSse: Number.isFinite(maxSse) ? maxSse : 4,
      bboxScale: Number.isFinite(bboxScale) ? bboxScale : 1,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 30_000,
      pollMs: Number.isFinite(pollMs) ? pollMs : 250,
      stableFrames: Number.isFinite(stableFrames) ? stableFrames : 6,
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
