import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { parseArgs } from './lib/args.mjs';
import { addFilesToManifest, getRunPaths } from './lib/artifacts.mjs';
import { loadDotenv } from './lib/env.mjs';
import { findRepoRoot } from './lib/repo-root.mjs';

const execFileAsync = promisify(execFile);

const VERTEX_ACCESS_TOKEN_TTL_MS = 50 * 60 * 1000;
const vertexTokenCache = { token: '', tsMs: 0 };

function printHelp() {
  console.log(`Usage:
  pnpm data:image:batch --run_id=<id> --prompts_file=<run-rel-file> [options]

Options:
  --out_dir             Output dir in run root (default: exports/gemini_images)
  --backend             gemini | vertex (default: env IMAGE_BACKEND or gemini)
  --model               Primary model id/resource (default: env IMAGE_MODEL or gemini-3-pro-image-preview)
  --fallback_model      Fallback model (optional, disabled by default; pass none/off to disable explicitly)
  --prompt_prefix       Prefix for each prompt (default: "Create an image. ")
  --image_size          1K | 2K | 4K (optional)
  --aspect_ratio        e.g. 1:1, 16:9, 9:16 (optional)
  --temperature         Model temperature (optional)
  --top_p               Nucleus sampling topP (optional)
  --candidate_count     Number of candidates per prompt (default: 1)
  --seed                Generation seed (optional)
  --thinking_budget     Thinking budget tokens (optional)
  --thinking_level      Thinking level enum (optional)
  --include_thoughts    Include model thoughts in response (optional)
  --response_modalities CSV list for generationConfig.responseModalities (default: env IMAGE_RESPONSE_MODALITIES or IMAGE)
  --concurrency         Parallel requests (default: 3)
  --max_prompts         Cap prompts from file (default: 0 = all)
  --timeout_ms          Per-request timeout (default: 30000)
  --retry_max           Retry attempts for retryable errors (default: 2)
  --retry_base_ms       Retry backoff base delay (default: 800)
  --retry_max_ms        Retry backoff cap (default: 8000)
  --retry_jitter_ms     Retry random jitter (default: 300)
  --debug_retries       Log retry attempts

Environment:
  Gemini backend:
    GOOGLE_API_KEY (required)

  Vertex backend:
    VERTEX_PROJECT (required if model is not a full resource path)
    VERTEX_LOCATION (required if model is not a full resource path, default: us-central1)
    VERTEX_ACCESS_TOKEN (optional, otherwise script tries gcloud auth commands)
    VERTEX_ACCESS_TOKEN_CMD (optional, shell command that prints an access token; overrides gcloud)

Prompts file format:
  - One prompt per line
  - Empty lines and lines starting with # are ignored
  - For IMAGE responses, candidate_count>1 is emulated via repeated requests
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

function normalizeBackend(raw) {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (!value) return 'gemini';
  if (value === 'gemini' || value === 'vertex') return value;
  throw new Error(`Unsupported --backend: ${raw}`);
}

function parseCsv(value, fallback) {
  const raw = typeof value === 'string' ? value : fallback;
  const parts = String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : ['IMAGE'];
}

function toPosInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function toNonNegInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

function toNonNegFloat(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function toFiniteFloat(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeInt32Seed(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  // Vertex validates seed strictly as int32 in some projects; keep a safe non-negative range.
  // Use bitmask to avoid out-of-range errors while preserving deterministic wrapping.
  return Math.floor(n) & 0x7fffffff;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err) {
  if (err?.name === 'AbortError') return true;
  const status = Number(err?.status);
  if (Number.isFinite(status) && (status === 429 || status >= 500)) return true;
  const message = String(err?.message || err || '').toLowerCase();
  return [
    '429',
    'rate',
    'resource exhausted',
    'unavailable',
    'internal',
    'server error',
    'timeout',
    'temporar',
    '502',
    '503',
    '504',
  ].some((token) => message.includes(token));
}

function computeBackoffMs(attempt, baseMs, maxMs, jitterMs) {
  const base = Math.max(0, baseMs);
  const capped = Math.min(base * 2 ** attempt, Math.max(base, maxMs));
  const jitter = Math.max(0, jitterMs);
  return capped + (jitter > 0 ? Math.random() * jitter : 0);
}

function mimeToExt(mimeType) {
  const m = String(mimeType || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  return 'png';
}

function promptSlug(text, maxLen = 40) {
  const slug = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen);
  return slug || 'image';
}

function trimModelName(value, fallback) {
  const v = String(value ?? fallback ?? '').trim();
  return v || String(fallback || '').trim();
}

function isForbiddenModel(model) {
  return String(model || '')
    .trim()
    .toLowerCase()
    .includes('gemini-2.');
}

function assertModelAllowed(flagName, model) {
  const modelId = String(model || '').trim();
  if (!modelId) return;
  if (isForbiddenModel(modelId)) {
    throw new Error(`${flagName}=${modelId} is not allowed in this repository. Use gemini-3-pro-image-preview.`);
  }
}

async function readPrompts(filePath, maxPrompts) {
  const raw = await fs.readFile(filePath, 'utf8');
  const prompts = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  if (maxPrompts > 0) return prompts.slice(0, maxPrompts);
  return prompts;
}

function extractImagesFromResponse(data) {
  if (!data || typeof data !== 'object') throw new Error('Empty response');
  const feedback = data.promptFeedback ?? data.prompt_feedback ?? {};
  if (feedback?.blockReason) {
    throw new Error(`Prompt blocked: ${feedback.blockReason}`);
  }

  const candidates = Array.isArray(data.candidates) ? data.candidates : [];
  if (candidates.length === 0) throw new Error('No candidates returned');

  const images = [];
  const textParts = [];

  for (let c = 0; c < candidates.length; c++) {
    const parts = candidates[c]?.content?.parts;
    const list = Array.isArray(parts) ? parts : [];
    let foundForCandidate = false;

    for (const part of list) {
      const inline = part?.inlineData ?? part?.inline_data;
      if (inline?.data) {
        const mimeType = inline.mimeType ?? inline.mime_type ?? 'image/png';
        images.push({ candidateIndex: c, kind: 'inline', mimeType, payload: inline.data });
        foundForCandidate = true;
        break;
      }

      const fileData = part?.fileData ?? part?.file_data;
      if (fileData?.fileUri || fileData?.file_uri) {
        const mimeType = fileData.mimeType ?? fileData.mime_type ?? 'image/png';
        const fileUri = fileData.fileUri ?? fileData.file_uri;
        images.push({ candidateIndex: c, kind: 'file', mimeType, payload: fileUri });
        foundForCandidate = true;
        break;
      }

      if (typeof part?.text === 'string') {
        textParts.push(part.text);
      }
    }

    if (!foundForCandidate) {
      // Keep scanning other candidates; some responses may include mixed candidate quality.
    }
  }

  if (images.length > 0) return images;
  if (textParts.length > 0) {
    const snippet = textParts[0].slice(0, 200).replaceAll('\n', ' ').trim();
    throw new Error(`No image data in response. text=${snippet}`);
  }
  throw new Error('No image data in response');
}

async function getVertexAccessToken({ forceRefresh = false } = {}) {
  const fromEnv = String(process.env.VERTEX_ACCESS_TOKEN || '').trim();
  if (fromEnv) return fromEnv;

  const now = Date.now();
  if (!forceRefresh && vertexTokenCache.token && now - vertexTokenCache.tsMs < VERTEX_ACCESS_TOKEN_TTL_MS) {
    return vertexTokenCache.token;
  }

  const tokenCmd = String(process.env.VERTEX_ACCESS_TOKEN_CMD || '').trim();
  if (tokenCmd) {
    const candidates = [];
    const envShell = String(process.env.SHELL || '').trim();
    if (envShell) candidates.push(envShell);
    candidates.push('/bin/bash', '/usr/bin/bash', '/bin/sh');
    let shellBin = 'bash';
    for (const c of candidates) {
      if (await fileExists(c)) {
        shellBin = c;
        break;
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync(shellBin, ['-c', tokenCmd], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const combined = `${String(stdout || '')}\n${String(stderr || '')}`;
      const lines = combined
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      const token = lines.length > 0 ? lines[lines.length - 1] : '';
      if (!token) throw new Error('VERTEX_ACCESS_TOKEN_CMD returned empty token');
      vertexTokenCache.token = token;
      vertexTokenCache.tsMs = now;
      return token;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`VERTEX_ACCESS_TOKEN_CMD failed: ${msg}`);
    }
  }

  const attempts = [
    ['gcloud', ['auth', 'application-default', 'print-access-token']],
    ['gcloud', ['auth', 'print-access-token']],
  ];

  const errors = [];
  for (const [bin, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(bin, args, {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      const token = String(stdout || '').trim();
      if (token) {
        vertexTokenCache.token = token;
        vertexTokenCache.tsMs = now;
        return token;
      }
      errors.push(`${bin} ${args.join(' ')} returned empty token`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${bin} ${args.join(' ')} failed: ${msg}`);
    }
  }

  throw new Error(
    `Missing Vertex auth token. Set VERTEX_ACCESS_TOKEN or authorize gcloud.\n${errors.join('\n')}`,
  );
}

function buildGenerateUrl({ backend, model, geminiApiKey, vertexProject, vertexLocation }) {
  if (backend === 'gemini') {
    if (!geminiApiKey) throw new Error('Missing GOOGLE_API_KEY for gemini backend');
    return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`;
  }

  const normalizedLocation = String(vertexLocation || '').trim() || 'us-central1';

  let modelResource = model;
  if (!modelResource.startsWith('projects/')) {
    if (!vertexProject) throw new Error('Missing VERTEX_PROJECT for vertex backend');
    if (modelResource.startsWith('publishers/')) {
      modelResource = `projects/${vertexProject}/locations/${normalizedLocation}/${modelResource}`;
    } else {
      modelResource = `projects/${vertexProject}/locations/${normalizedLocation}/publishers/google/models/${modelResource}`;
    }
  }

  const host =
    normalizedLocation.toLowerCase() === 'global'
      ? 'aiplatform.googleapis.com'
      : `${normalizedLocation}-aiplatform.googleapis.com`;

  return `https://${host}/v1/${modelResource}:generateContent`;
}

async function postJsonOnce({ url, payload, timeoutMs, headers }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (res.status >= 400) {
      const text = await res.text();
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      err.status = res.status;
      throw err;
    }

    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function postJsonWithRetries({
  url,
  payload,
  purpose,
  timeoutMs,
  headers,
  retryMax,
  retryBaseMs,
  retryMaxMs,
  retryJitterMs,
  debugRetries,
}) {
  let attempt = 0;
  while (true) {
    try {
      return await postJsonOnce({ url, payload, timeoutMs, headers });
    } catch (err) {
      if (attempt >= retryMax || !isRetryableError(err)) throw err;
      const delay = computeBackoffMs(attempt, retryBaseMs, retryMaxMs, retryJitterMs);
      if (debugRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          `Retrying ${purpose} after error (${message}). attempt=${String(attempt + 1)} delay_ms=${Math.round(delay)}`,
        );
      }
      await sleep(delay);
      attempt += 1;
    }
  }
}

async function generateImageWithPrompt({
  backend,
  model,
  prompt,
  generationConfig,
  timeoutMs,
  retryMax,
  retryBaseMs,
  retryMaxMs,
  retryJitterMs,
  debugRetries,
  geminiApiKey,
  vertexProject,
  vertexLocation,
  purpose,
}) {
  const payload = {
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }],
      },
    ],
    generationConfig,
  };

  const url = buildGenerateUrl({
    backend,
    model,
    geminiApiKey,
    vertexProject,
    vertexLocation,
  });

  const headers = {
    'Content-Type': 'application/json',
  };
  if (backend === 'vertex') {
    headers.Authorization = `Bearer ${await getVertexAccessToken()}`;
  }

  let data;
  try {
    data = await postJsonWithRetries({
      url,
      payload,
      purpose,
      timeoutMs,
      headers,
      retryMax,
      retryBaseMs,
      retryMaxMs,
      retryJitterMs,
      debugRetries,
    });
  } catch (err) {
    if (backend === 'vertex' && Number(err?.status) === 401) {
      // Token can expire during long runs; refresh once and retry.
      headers.Authorization = `Bearer ${await getVertexAccessToken({ forceRefresh: true })}`;
      data = await postJsonWithRetries({
        url,
        payload,
        purpose,
        timeoutMs,
        headers,
        retryMax,
        retryBaseMs,
        retryMaxMs,
        retryJitterMs,
        debugRetries,
      });
    } else {
      throw err;
    }
  }

  return extractImagesFromResponse(data);
}

function normalizePromptPrefix(value) {
  if (typeof value !== 'string') return 'Create an image. ';
  return value;
}

export async function generateImageBatch({
  repoRoot,
  runId,
  promptsFileRel,
  outDirRel = 'exports/gemini_images',
  backend = 'gemini',
  model = 'gemini-3-pro-image-preview',
  fallbackModel = '',
  promptPrefix = 'Create an image. ',
  responseModalities = ['IMAGE'],
  imageSize = '',
  aspectRatio = '',
  temperature = null,
  topP = null,
  candidateCount = 1,
  seed = null,
  thinkingBudget = null,
  thinkingLevel = '',
  includeThoughts = false,
  concurrency = 3,
  maxPrompts = 0,
  timeoutMs = 30000,
  retryMax = 2,
  retryBaseMs = 800,
  retryMaxMs = 8000,
  retryJitterMs = 300,
  debugRetries = false,
}) {
  assertSafeRunId(runId);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');
  if (typeof promptsFileRel !== 'string' || promptsFileRel.length === 0) {
    throw new Error('Missing required --prompts_file');
  }
  if (typeof outDirRel !== 'string' || outDirRel.length === 0) throw new Error('Invalid --out_dir');
  assertModelAllowed('--model', model);
  assertModelAllowed('--fallback_model', fallbackModel);

  const { runRoot, manifestPath } = getRunPaths(repoRoot, runId);
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const promptsPath = path.join(runRoot, promptsFileRel);
  if (!(await fileExists(promptsPath))) {
    throw new Error(`Missing --prompts_file: ${promptsPath}`);
  }

  const outDirAbs = path.join(runRoot, outDirRel);
  await fs.mkdir(outDirAbs, { recursive: true });

  const prompts = await readPrompts(promptsPath, maxPrompts);
  if (prompts.length === 0) {
    throw new Error(`No prompts found in file: ${promptsPath}`);
  }

  const geminiApiKey = String(process.env.GOOGLE_API_KEY || '').trim();
  const vertexProject =
    String(process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '').trim();
  const vertexLocation = String(process.env.VERTEX_LOCATION || process.env.GOOGLE_CLOUD_LOCATION || 'us-central1').trim();
  const normalizedImageSize = String(imageSize || '').trim().toUpperCase();
  if (normalizedImageSize && !['1K', '2K', '4K'].includes(normalizedImageSize)) {
    throw new Error(`Invalid --image_size: ${imageSize}. Allowed: 1K, 2K, 4K`);
  }
  const normalizedAspectRatio = String(aspectRatio || '').trim();
  const normalizedThinkingLevel = String(thinkingLevel || '').trim();
  const requestedCandidateCount = Math.max(1, Math.floor(candidateCount));
  const isImageResponse = responseModalities.some((m) => String(m).toUpperCase() === 'IMAGE');
  const perRequestCandidateCount = isImageResponse ? 1 : requestedCandidateCount;

  if (isImageResponse && requestedCandidateCount > 1 && debugRetries) {
    console.warn(
      `Vertex/Gemini image responses support candidate_count=1 per request; emulating ${String(
        requestedCandidateCount,
      )} variants via repeated calls.`,
    );
  }

  const generationConfigBase = {
    responseModalities,
    candidateCount: perRequestCandidateCount,
  };
  if (Number.isFinite(temperature)) generationConfigBase.temperature = temperature;
  if (Number.isFinite(topP)) generationConfigBase.topP = topP;
  if (normalizedImageSize || normalizedAspectRatio) {
    generationConfigBase.imageConfig = {};
    if (normalizedImageSize) generationConfigBase.imageConfig.imageSize = normalizedImageSize;
    if (normalizedAspectRatio) generationConfigBase.imageConfig.aspectRatio = normalizedAspectRatio;
  }
  if (Number.isFinite(thinkingBudget) || includeThoughts || normalizedThinkingLevel) {
    generationConfigBase.thinkingConfig = {};
    if (Number.isFinite(thinkingBudget)) generationConfigBase.thinkingConfig.thinkingBudget = Math.floor(thinkingBudget);
    if (includeThoughts) generationConfigBase.thinkingConfig.includeThoughts = true;
    if (normalizedThinkingLevel) generationConfigBase.thinkingConfig.thinkingLevel = normalizedThinkingLevel;
  }

  const items = new Array(prompts.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(concurrency, prompts.length));

  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= prompts.length) return;

      const promptText = prompts[index];
      const renderPrompt = `${normalizePromptPrefix(promptPrefix)}${promptText}`;

      try {
        const outputs = [];
        const failures = [];
        let usedModel = model;
        const variantCount = requestedCandidateCount;
        const baseSeed = normalizeInt32Seed(seed);

        for (let variantIndex = 0; variantIndex < variantCount; variantIndex++) {
          const generationConfig = { ...generationConfigBase };
          const variantSeed = Number.isFinite(baseSeed) ? normalizeInt32Seed(baseSeed + variantIndex) : null;
          if (Number.isFinite(variantSeed)) generationConfig.seed = variantSeed;

          let images = null;
          let variantModel = model;
          let errorMessage = '';
          try {
            images = await generateImageWithPrompt({
              backend,
              model,
              prompt: renderPrompt,
              generationConfig,
              timeoutMs,
              retryMax,
              retryBaseMs,
              retryMaxMs,
              retryJitterMs,
              debugRetries,
              geminiApiKey,
              vertexProject,
              vertexLocation,
              purpose: 'image_generate',
            });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (fallbackModel && fallbackModel !== model && !message.includes('Prompt blocked')) {
              variantModel = fallbackModel;
              try {
                images = await generateImageWithPrompt({
                  backend,
                  model: fallbackModel,
                  prompt: renderPrompt,
                  generationConfig,
                  timeoutMs,
                  retryMax,
                  retryBaseMs,
                  retryMaxMs,
                  retryJitterMs,
                  debugRetries,
                  geminiApiKey,
                  vertexProject,
                  vertexLocation,
                  purpose: 'image_generate_fallback',
                });
              } catch (fbErr) {
                errorMessage = fbErr instanceof Error ? fbErr.message : String(fbErr);
                images = null;
              }
            } else {
              errorMessage = message;
              images = null;
            }
          }

          if (!errorMessage && (!Array.isArray(images) || images.length === 0)) errorMessage = 'Image response is empty';
          if (errorMessage) {
            failures.push({
              variant_index: variantIndex,
              seed: Number.isFinite(variantSeed) ? variantSeed : null,
              model: variantModel,
              error: errorMessage,
            });
            continue;
          }

          if (variantModel === fallbackModel) usedModel = fallbackModel;

          for (const image of images) {
            if (image.kind === 'file') {
              outputs.push({
                variant_index: variantIndex,
                seed: Number.isFinite(variantSeed) ? variantSeed : null,
                candidate_index: image.candidateIndex,
                kind: 'file',
                model: variantModel,
                mime_type: image.mimeType,
                file_uri: image.payload,
              });
              continue;
            }

            const ext = mimeToExt(image.mimeType);
            const variantSuffix = `v${String(variantIndex + 1).padStart(2, '0')}`;
            const candidateSuffix = `c${String((image.candidateIndex ?? 0) + 1).padStart(2, '0')}`;
            const baseName = `${String(index + 1).padStart(4, '0')}-${promptSlug(promptText)}-${variantSuffix}-${candidateSuffix}.${ext}`;
            const firstPath = path.join(outDirAbs, baseName);
            const outAbs = (await fileExists(firstPath))
              ? path.join(
                  outDirAbs,
                  `${String(index + 1).padStart(4, '0')}-${promptSlug(promptText)}-${variantSuffix}-${candidateSuffix}-${randomUUID()}.${ext}`,
                )
              : firstPath;

            const imageBytes = Buffer.from(image.payload, 'base64');
            await fs.writeFile(outAbs, imageBytes);

            outputs.push({
              variant_index: variantIndex,
              seed: Number.isFinite(variantSeed) ? variantSeed : null,
              candidate_index: image.candidateIndex,
              kind: 'inline',
              model: variantModel,
              mime_type: image.mimeType,
              output: path.relative(runRoot, outAbs).replaceAll('\\', '/'),
              size: imageBytes.length,
            });
          }
        }

        if (outputs.length === 0) {
          const first = failures.find(Boolean);
          const suffix = first?.error ? ` First error: ${first.error}` : '';
          throw new Error(`All candidates failed.${suffix}`);
        }

        items[index] = {
          index,
          prompt: promptText,
          status: 'ok',
          model: usedModel,
          outputs,
          failures,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        items[index] = {
          index,
          prompt: promptText,
          status: 'error',
          error: message,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const okCount = items.filter((it) => it?.status === 'ok').length;
  const errorCount = items.length - okCount;
  const report = {
    run_id: runId,
    created_at: new Date().toISOString(),
    backend,
    model,
    fallback_model: fallbackModel || '',
    prompts_file: promptsFileRel,
    out_dir: outDirRel,
    prompt_count: items.length,
    ok_count: okCount,
    error_count: errorCount,
    response_modalities: responseModalities,
    image_size: normalizedImageSize || null,
    aspect_ratio: normalizedAspectRatio || null,
    temperature: Number.isFinite(temperature) ? temperature : null,
    top_p: Number.isFinite(topP) ? topP : null,
    candidate_count: requestedCandidateCount,
    per_request_candidate_count: perRequestCandidateCount,
    seed: normalizeInt32Seed(seed),
    thinking_budget: Number.isFinite(thinkingBudget) ? Math.floor(thinkingBudget) : null,
    thinking_level: normalizedThinkingLevel || null,
    include_thoughts: Boolean(includeThoughts),
    timeout_ms: timeoutMs,
    retry_max: retryMax,
    retry_base_ms: retryBaseMs,
    retry_max_ms: retryMaxMs,
    retry_jitter_ms: retryJitterMs,
    results: items,
  };

  const reportAbs = path.join(outDirAbs, 'report.json');
  await fs.writeFile(reportAbs, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await addFilesToManifest({ manifestPath, runRoot, absPaths: [reportAbs] });

  if (okCount <= 0) {
    throw new Error(`All prompts failed. See report: ${path.relative(runRoot, reportAbs).replaceAll('\\', '/')}`);
  }

  return {
    runId,
    backend,
    model,
    fallbackModel,
    promptsFileRel,
    outDirRel,
    promptCount: items.length,
    candidateCount: requestedCandidateCount,
    okCount,
    errorCount,
    reportRel: path.relative(runRoot, reportAbs).replaceAll('\\', '/'),
  };
}

async function main() {
  const { args } = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    printHelp();
    process.exit(0);
  }

  const runId = typeof args.run_id === 'string' ? args.run_id : '';
  const promptsFileRel = ensureRelPath(typeof args.prompts_file === 'string' ? args.prompts_file : args.promptsFile) ?? '';
  const outDirRel =
    ensureRelPath(typeof args.out_dir === 'string' ? args.out_dir : args.outDir) ?? 'exports/gemini_images';

  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  await loadDotenv({ repoRoot });

  const backend = normalizeBackend(
    typeof args.backend === 'string' ? args.backend : process.env.IMAGE_BACKEND || 'gemini',
  );
  const model = trimModelName(args.model, process.env.IMAGE_MODEL || 'gemini-3-pro-image-preview');
  const fallbackModelRaw = trimModelName(
    args.fallback_model ?? args.fallbackModel,
    process.env.IMAGE_FALLBACK_MODEL || '',
  );
  const fallbackModel =
    fallbackModelRaw.toLowerCase() === 'none' || fallbackModelRaw.toLowerCase() === 'off' ? '' : fallbackModelRaw;
  const promptPrefix = normalizePromptPrefix(
    typeof args.prompt_prefix === 'string' ? args.prompt_prefix : process.env.IMAGE_PROMPT_PREFIX || 'Create an image. ',
  );
  const imageSize = String(args.image_size ?? process.env.IMAGE_SIZE ?? '').trim();
  const aspectRatio = String(args.aspect_ratio ?? process.env.IMAGE_ASPECT_RATIO ?? '').trim();
  const temperature = toFiniteFloat(args.temperature ?? process.env.IMAGE_TEMPERATURE, null);
  const topP = toFiniteFloat(args.top_p ?? args.topP ?? process.env.IMAGE_TOP_P, null);
  const candidateCount = toPosInt(args.candidate_count ?? args.candidateCount ?? process.env.IMAGE_CANDIDATE_COUNT, 1);
  const seed = toFiniteFloat(args.seed ?? process.env.IMAGE_SEED, null);
  const thinkingBudget = toFiniteFloat(args.thinking_budget ?? args.thinkingBudget ?? process.env.THINKING_BUDGET, null);
  const thinkingLevel = String(args.thinking_level ?? args.thinkingLevel ?? process.env.THINKING_LEVEL ?? '').trim();
  const includeThoughts = Boolean(args.include_thoughts);

  const responseModalities = parseCsv(args.response_modalities, process.env.IMAGE_RESPONSE_MODALITIES || 'IMAGE');
  const concurrency = toPosInt(args.concurrency, 3);
  const maxPrompts = toNonNegInt(args.max_prompts ?? args.maxPrompts, 0);
  const timeoutMs = toPosInt(args.timeout_ms ?? args.timeoutMs, 30000);
  const retryMax = toNonNegInt(args.retry_max ?? args.retryMax, 2);
  const retryBaseMs = toNonNegFloat(args.retry_base_ms ?? args.retryBaseMs, 800);
  const retryMaxMs = toNonNegFloat(args.retry_max_ms ?? args.retryMaxMs, 8000);
  const retryJitterMs = toNonNegFloat(args.retry_jitter_ms ?? args.retryJitterMs, 300);
  const debugRetries = Boolean(args.debug_retries);

  try {
    const result = await generateImageBatch({
      repoRoot,
      runId,
      promptsFileRel,
      outDirRel,
      backend,
      model,
      fallbackModel,
      promptPrefix,
      responseModalities,
      imageSize,
      aspectRatio,
      temperature,
      topP,
      candidateCount,
      seed,
      thinkingBudget,
      thinkingLevel,
      includeThoughts,
      concurrency,
      maxPrompts,
      timeoutMs,
      retryMax,
      retryBaseMs,
      retryMaxMs,
      retryJitterMs,
      debugRetries,
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
