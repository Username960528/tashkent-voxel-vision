import fs from 'node:fs/promises';
import path from 'node:path';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function isRepoRoot(dir) {
  const ws = path.join(dir, 'pnpm-workspace.yaml');
  const pkg = path.join(dir, 'package.json');
  if (!(await fileExists(ws)) || !(await fileExists(pkg))) return false;

  try {
    const raw = await fs.readFile(pkg, 'utf8');
    const json = JSON.parse(raw);
    return json?.name === 'tashkent-voxel-vision';
  } catch {
    return false;
  }
}

export async function findRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 25; i++) {
    if (await isRepoRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

