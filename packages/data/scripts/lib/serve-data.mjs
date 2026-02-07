import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pmtiles') return 'application/octet-stream';
  if (ext === '.pbf' || ext === '.mvt') return 'application/x-protobuf';
  if (ext === '.json' || ext === '.geojson') return 'application/geo+json; charset=utf-8';
  if (ext === '.parquet') return 'application/octet-stream';
  if (ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
  if (ext === '.html') return 'text/html; charset=utf-8';
  return 'application/octet-stream';
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range,Content-Type,Accept');
  res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges,Content-Range,Content-Length');
}

function parseRangeHeader(rangeHeader, size) {
  if (typeof rangeHeader !== 'string') return null;
  const trimmed = rangeHeader.trim();
  if (!trimmed.startsWith('bytes=')) return null;

  // We only support a single range.
  const spec = trimmed.slice('bytes='.length).split(',')[0]?.trim() ?? '';
  if (!spec) return null;

  const [startRaw, endRaw] = spec.split('-', 2);
  if (startRaw == null || endRaw == null) return null;

  // Suffix range: "-500" means last 500 bytes.
  if (startRaw === '') {
    const suffix = Number(endRaw);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    const len = Math.min(size, Math.floor(suffix));
    return { start: size - len, end: size - 1 };
  }

  const start = Number(startRaw);
  if (!Number.isFinite(start) || start < 0) return null;

  // Open ended range: "500-"
  if (endRaw === '') {
    if (start >= size) return null;
    return { start: Math.floor(start), end: size - 1 };
  }

  const end = Number(endRaw);
  if (!Number.isFinite(end) || end < 0) return null;
  if (start > end) return null;
  if (start >= size) return null;

  return { start: Math.floor(start), end: Math.min(size - 1, Math.floor(end)) };
}

function isSubPath(parentAbs, childAbs) {
  const rel = path.relative(parentAbs, childAbs);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Serves files from a local `data/` directory with CORS + byte-range support.
 * This is required for PMTiles which uses HTTP Range requests in the browser.
 *
 * @param {{
 *   dataRootAbs: string,
 *   mountPath?: string,
 *   quiet?: boolean,
 * }} opts
 */
export function createDataServer(opts) {
  const { dataRootAbs, mountPath = '/data', quiet = false } = opts;
  if (typeof dataRootAbs !== 'string' || dataRootAbs.length === 0) throw new Error('Missing dataRootAbs');

  const normMount = mountPath.startsWith('/') ? mountPath.replace(/\/+$/g, '') : `/${mountPath}`.replace(/\/+$/g, '');

  return http.createServer(async (req, res) => {
    try {
      setCors(res);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.statusCode = 405;
        res.setHeader('Allow', 'GET, HEAD, OPTIONS');
        res.end('Method Not Allowed');
        return;
      }

      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname ?? '/';

      if (!pathname.startsWith(`${normMount}/`)) {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end(
          [
            'tvv data server',
            '',
            `Serving ${dataRootAbs} at ${normMount}/...`,
            '',
            'Example:',
            `  BASE_DATA_URL=http://127.0.0.1:<port>${normMount}/releases`,
          ].join('\n'),
        );
        return;
      }

      const rel = decodeURIComponent(pathname.slice(normMount.length + 1));
      if (rel.includes('\0')) {
        res.statusCode = 400;
        res.end('Bad Request');
        return;
      }

      const abs = path.resolve(dataRootAbs, rel);
      if (!isSubPath(dataRootAbs, abs)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      const st = await fs.stat(abs).catch(() => null);
      if (!st || !st.isFile()) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('Not Found');
        return;
      }

      const size = st.size;
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Content-Type', contentType(abs));

      const range = parseRangeHeader(req.headers.range, size);
      if (req.headers.range && !range) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${size}`);
        res.end();
        return;
      }

      if (range) {
        const { start, end } = range;
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        res.setHeader('Content-Length', String(end - start + 1));
        if (req.method === 'HEAD') {
          res.end();
          return;
        }

        const stream = createReadStream(abs, { start, end });
        stream.on('error', () => res.destroy());
        stream.pipe(res);
        return;
      }

      res.statusCode = 200;
      res.setHeader('Content-Length', String(size));
      if (req.method === 'HEAD') {
        res.end();
        return;
      }

      const stream = createReadStream(abs);
      stream.on('error', () => res.destroy());
      stream.pipe(res);
    } catch (err) {
      if (!quiet) {
        const msg = err instanceof Error ? err.stack ?? err.message : String(err);
        // eslint-disable-next-line no-console
        console.error(msg);
      }
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
      res.end('Internal Server Error');
    }
  });
}

/**
 * @param {{
 *   repoRoot: string,
 *   host?: string,
 *   port?: number,
 *   quiet?: boolean,
 * }} opts
 */
export async function startDataServer(opts) {
  const { repoRoot, host = '127.0.0.1', port = 8787, quiet = false } = opts;
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) throw new Error('Missing repoRoot');

  const dataRootAbs = path.join(repoRoot, 'data');
  await fs.mkdir(dataRootAbs, { recursive: true });

  const server = createDataServer({ dataRootAbs, mountPath: '/data', quiet });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    server,
    origin: `http://${host}:${actualPort}`,
    base_data_url: `http://${host}:${actualPort}/data/releases`,
  };
}

