import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { validateManifest } from './manifest-schema.mjs';

function assertSafeRunId(runId) {
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('Missing required --run_id');
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runId)) {
    throw new Error('Invalid --run_id (allowed: [a-zA-Z0-9_-], max 128 chars)');
  }
}

function assertSafeRegion(region) {
  if (typeof region !== 'string' || region.length === 0) {
    throw new Error('Missing required --region');
  }
  // Keep strict for now; relax when we add more providers/regions.
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(region)) {
    throw new Error('Invalid --region (allowed: [a-z0-9_-], max 64 chars)');
  }
}

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveOsmDownload(region) {
  const key = region.trim().toLowerCase();

  if (key === 'uzbekistan') {
    return {
      region: 'uzbekistan',
      url: 'https://download.geofabrik.de/asia/uzbekistan-latest.osm.pbf',
    };
  }

  throw new Error(`Unsupported --region: ${region} (expected: uzbekistan)`);
}

async function readJson(absPath) {
  const raw = await fs.readFile(absPath, 'utf8');
  return JSON.parse(raw);
}

async function writeJson(absPath, json) {
  await fs.writeFile(absPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
}

function maybeParseHttpDateToIso(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return null;
  return d.toISOString();
}

async function sha256File(absPath) {
  const hash = crypto.createHash('sha256');
  const fh = await fs.open(absPath, 'r');
  try {
    const stream = fh.createReadStream();
    stream.on('data', (chunk) => hash.update(chunk));
    await new Promise((resolve, reject) => {
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
  } finally {
    await fh.close();
  }
}

async function downloadWithSha256(url, destPath) {
  if (typeof fetch !== 'function') {
    throw new Error('Global fetch() is not available; require Node.js >= 18');
  }

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to download (${res.status}): ${url}`);
  }
  if (!res.body) {
    throw new Error(`Failed to download (missing body): ${url}`);
  }

  const etag = res.headers.get('etag');
  const lastModified = res.headers.get('last-modified');

  const hash = crypto.createHash('sha256');
  let size = 0;

  const hasher = new Transform({
    transform(chunk, _enc, cb) {
      size += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  const tmpPath = `${destPath}.tmp-${crypto.randomUUID()}`;
  try {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), hasher, createWriteStream(tmpPath));
    await fs.rename(tmpPath, destPath);
  } catch (err) {
    // Best-effort cleanup of partial files.
    await fs.rm(tmpPath, { force: true }).catch(() => undefined);
    throw err;
  }

  return {
    downloaded: true,
    etag,
    date: maybeParseHttpDateToIso(lastModified),
    sha256: hash.digest('hex'),
    size,
  };
}

function upsertArtifact(artifacts, artifact) {
  const idx = artifacts.findIndex((a) => a?.path === artifact.path);
  if (idx === -1) {
    artifacts.push(artifact);
    return;
  }
  artifacts[idx] = artifact;
}

/**
 * Fetch an OSM extract into data/raw/osm and update the release manifest.
 *
 * @param {{
 *   repoRoot: string,
 *   runId: string,
 *   region: string,
 *   now?: Date,
 *   dryRun?: boolean,
 * }} opts
 */
export async function fetchOsm(opts) {
  const { repoRoot, runId, region, now = new Date(), dryRun = false } = opts;

  assertSafeRunId(runId);
  assertSafeRegion(region);
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) {
    throw new Error('Missing repoRoot');
  }

  const resolved = resolveOsmDownload(region);
  const url = resolved.url;
  const fileName = path.basename(new URL(url).pathname);
  const rawRelPath = path.join('data', 'raw', 'osm', fileName).replaceAll('\\', '/');
  const rawAbsPath = path.join(repoRoot, rawRelPath);

  const manifestPath = path.join(repoRoot, 'data', 'releases', runId, 'manifest.json');
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Manifest not found: ${manifestPath} (run packages/data release:init first)`);
  }

  const manifest = await readJson(manifestPath);

  /** @type {string | null} */
  let etag = typeof manifest?.sources?.osm?.etag === 'string' ? manifest.sources.osm.etag : null;
  /** @type {string | null} */
  let date = typeof manifest?.sources?.osm?.date === 'string' ? manifest.sources.osm.date : null;
  /** @type {string | null} */
  let downloadedAt =
    typeof manifest?.sources?.osm?.downloaded_at === 'string' ? manifest.sources.osm.downloaded_at : null;

  const alreadyExists = await fileExists(rawAbsPath);

  /** @type {string | null} */
  let sha256 = null;
  /** @type {number | null} */
  let size = null;

  let downloaded = false;
  if (!alreadyExists && !dryRun) {
    const result = await downloadWithSha256(url, rawAbsPath);
    downloaded = result.downloaded;
    etag = result.etag ?? etag;
    date = result.date ?? date;
    sha256 = result.sha256;
    size = result.size;
    downloadedAt = now.toISOString();
  } else if (alreadyExists) {
    const stat = await fs.stat(rawAbsPath);
    size = stat.size;
    sha256 = await sha256File(rawAbsPath);
    // We don't know when an existing file was originally downloaded; record when we first observed it.
    if (!downloadedAt) downloadedAt = now.toISOString();
  }

  // If we had previous values in the manifest, ensure we don't silently drift.
  if (sha256 && typeof manifest?.sources?.osm?.sha256 === 'string' && manifest.sources.osm.sha256 !== sha256) {
    throw new Error(`OSM sha256 mismatch for ${rawRelPath}: manifest=${manifest.sources.osm.sha256} actual=${sha256}`);
  }
  if (size != null && typeof manifest?.sources?.osm?.size === 'number' && manifest.sources.osm.size !== size) {
    throw new Error(`OSM size mismatch for ${rawRelPath}: manifest=${manifest.sources.osm.size} actual=${size}`);
  }

  if (!manifest.sources) manifest.sources = {};
  manifest.sources.osm = {
    region: resolved.region,
    url,
    date,
    etag,
    downloaded_at: downloadedAt,
    path: rawRelPath,
    sha256,
    size,
    dry_run: dryRun ? true : null,
  };

  if (!Array.isArray(manifest.artifacts)) manifest.artifacts = [];
  if (sha256 && size != null) {
    upsertArtifact(manifest.artifacts, {
      path: rawRelPath,
      sha256,
      size,
    });
  }

  const validation = await validateManifest(manifest);
  if (!validation.valid) {
    const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    throw new Error(`Updated manifest failed schema validation:\n${details}`);
  }

  await writeJson(manifestPath, manifest);
  return {
    manifestPath,
    rawRelPath,
    rawAbsPath,
    url,
    region: resolved.region,
    downloaded,
    sha256,
    size,
  };
}
