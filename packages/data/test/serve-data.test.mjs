import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startDataServer } from '../scripts/lib/serve-data.mjs';
import { findRepoRoot } from '../scripts/lib/repo-root.mjs';

async function fileExists(filePath) {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

test('data server supports CORS + Range requests', async () => {
  const repoRoot = (await findRepoRoot(process.cwd())) ?? process.cwd();
  const runId = `test_serve_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
  const fileAbs = path.join(repoRoot, 'data', 'releases', runId, 'tiles', 'buildings.pmtiles');
  const dirAbs = path.dirname(fileAbs);

  await fs.mkdir(dirAbs, { recursive: true });
  await fs.writeFile(fileAbs, Buffer.from('abcdefghijklmnopqrstuvwxyz', 'utf8'));

  const { server, origin, base_data_url } = await startDataServer({ repoRoot, host: '127.0.0.1', port: 0, quiet: true });
  try {
    assert.ok(origin.startsWith('http://127.0.0.1:'));
    assert.ok(base_data_url.includes('/data/releases'));

    const url = `${origin}/data/releases/${runId}/tiles/buildings.pmtiles`;

    {
      const res = await fetch(url, { headers: { Range: 'bytes=0-3' } });
      assert.equal(res.status, 206);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      assert.equal(res.headers.get('content-range')?.startsWith('bytes 0-3/'), true);
      const body = await res.text();
      assert.equal(body, 'abcd');
    }

    {
      const res = await fetch(url, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      // HEAD has no body.
      const body = await res.text();
      assert.equal(body, '');
    }

    {
      const res = await fetch(`${origin}/data/releases/${runId}/tiles/missing.pmtiles`);
      assert.equal(res.status, 404);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    // Best-effort cleanup (repo ignores data/releases/ anyway).
    const runRoot = path.join(repoRoot, 'data', 'releases', runId);
    if (await fileExists(runRoot)) {
      await fs.rm(runRoot, { recursive: true, force: true });
    }
  }
});

