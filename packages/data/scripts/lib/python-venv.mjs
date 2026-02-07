import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${cmd} ${args.join(' ')}`);
}

async function acquireExclusiveLock(lockPath, { timeoutMs = 10 * 60_000 } = {}) {
  const startedAt = Date.now();
  while (true) {
    try {
      const fh = await fs.open(lockPath, 'wx');
      await fh.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
      return fh;
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'EEXIST') {
        if (Date.now() - startedAt > timeoutMs) {
          throw new Error(`Timed out waiting for lock: ${lockPath}`);
        }
        await sleep(100);
        continue;
      }
      throw err;
    }
  }
}

async function releaseExclusiveLock(lockHandle, lockPath) {
  await lockHandle.close().catch(() => undefined);
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
}

async function sha256TextFile(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return crypto.createHash('sha256').update(raw).digest('hex');
}

export function getVenvPaths(repoRoot) {
  const venvDir = path.join(repoRoot, 'packages', 'data', '.venv');
  const pythonBin =
    process.platform === 'win32'
      ? path.join(venvDir, 'Scripts', 'python.exe')
      : path.join(venvDir, 'bin', 'python');
  return { venvDir, pythonBin };
}

export async function ensurePythonVenv(repoRoot) {
  const { venvDir, pythonBin } = getVenvPaths(repoRoot);
  await fs.mkdir(path.dirname(venvDir), { recursive: true });

  // Cross-test/process guard: Node's test runner may execute multiple files in parallel.
  // Creating/updating a venv concurrently is racy; serialize with a filesystem lock.
  const lockPath = `${venvDir}.lock`;
  const lock = await acquireExclusiveLock(lockPath);
  try {
    if (!(await fileExists(pythonBin))) {
      const dirExists = await fileExists(venvDir);
      run('python3', ['-m', 'venv', ...(dirExists ? ['--upgrade'] : []), venvDir]);
    }

    const requirementsPath = path.join(repoRoot, 'packages', 'data', 'scripts', 'py', 'requirements.txt');
    const markerPath = path.join(venvDir, '.tvv_requirements_sha256');

    const reqHash = await sha256TextFile(requirementsPath);
    const existing = (await fileExists(markerPath)) ? (await fs.readFile(markerPath, 'utf8')).trim() : '';
    if (existing !== reqHash) {
      run(pythonBin, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      run(pythonBin, ['-m', 'pip', 'install', '-r', requirementsPath]);
      await fs.writeFile(markerPath, `${reqHash}\n`, 'utf8');
    }
  } finally {
    await releaseExclusiveLock(lock, lockPath);
  }

  return { pythonBin };
}

export async function runPython({ repoRoot, scriptPath, args }) {
  const { pythonBin } = await ensurePythonVenv(repoRoot);
  run(pythonBin, [scriptPath, ...args]);
}
