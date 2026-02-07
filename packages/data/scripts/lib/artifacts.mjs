import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { validateManifest } from './manifest-schema.mjs';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

export function getRunPaths(repoRoot, runId) {
  const runRoot = path.join(repoRoot, 'data', 'releases', runId);
  const manifestPath = path.join(runRoot, 'manifest.json');
  return { runRoot, manifestPath };
}

export async function sha256File(filePath) {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export async function buildArtifact(runRoot, absFilePath) {
  const stats = await fs.stat(absFilePath);
  const sha256 = await sha256File(absFilePath);
  const relPath = path.relative(runRoot, absFilePath).replaceAll('\\', '/');
  return {
    path: relPath,
    sha256,
    size: stats.size,
  };
}

export function upsertArtifacts(manifest, artifacts) {
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest object');
  if (!Array.isArray(manifest.artifacts)) manifest.artifacts = [];

  const indexByPath = new Map();
  for (let i = 0; i < manifest.artifacts.length; i++) {
    const a = manifest.artifacts[i];
    if (a?.path) indexByPath.set(a.path, i);
  }

  for (const a of artifacts) {
    if (!a?.path) continue;
    const idx = indexByPath.get(a.path);
    if (idx == null) {
      manifest.artifacts.push(a);
      indexByPath.set(a.path, manifest.artifacts.length - 1);
    } else {
      manifest.artifacts[idx] = a;
    }
  }
}

export async function addFilesToManifest({ manifestPath, runRoot, absPaths }) {
  if (!(await fileExists(manifestPath))) {
    throw new Error(`Missing manifest: ${manifestPath} (run data:release:init first)`);
  }

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const artifacts = [];
  for (const absPath of absPaths) artifacts.push(await buildArtifact(runRoot, absPath));

  upsertArtifacts(manifest, artifacts);

  const validation = await validateManifest(manifest);
  if (!validation.valid) {
    const details = validation.errors.map((e) => `${e.path}: ${e.message}`).join('\n');
    throw new Error(`Internal error: updated manifest failed schema validation:\n${details}`);
  }

  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { manifest, artifacts };
}

