import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import { normalizeEarthSearchS2L2AItem, stacSearchAll } from '../scripts/lib/stac-earth-search.mjs';

test('stacSearchAll follows Earth Search next-link pagination and normalizes S2 items', async () => {
  /** @type {http.Server|null} */
  let server = null;
  try {
    server = http.createServer(async (req, res) => {
      if (!req.url || req.method !== 'POST') {
        res.statusCode = 404;
        res.end();
        return;
      }

      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));

      if (!req.url.startsWith('/v1/search')) {
        res.statusCode = 404;
        res.end();
        return;
      }

      const makeItem = (id, tile = { utm: 42, band: 'T', sq: 'VL' }) => ({
        type: 'Feature',
        id,
        properties: {
          datetime: '2024-06-09T06:17:57Z',
          'eo:cloud_cover': 12.34,
          'mgrs:utm_zone': tile.utm,
          'mgrs:latitude_band': tile.band,
          'mgrs:grid_square': tile.sq,
          'proj:epsg': 32642,
        },
        assets: {
          red: { href: `https://example.test/${id}/B04.tif` },
          nir: { href: `https://example.test/${id}/B08.tif` },
          scl: { href: `https://example.test/${id}/SCL.tif` },
        },
      });

      if (typeof body.next === 'string' && body.next === 'token-2') {
        const payload = {
          type: 'FeatureCollection',
          features: [makeItem('S2_TEST_3', { utm: 42, band: 'T', sq: 'WL' })],
          links: [],
        };
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(payload));
        return;
      }

      const payload = {
        type: 'FeatureCollection',
        features: [makeItem('S2_TEST_1'), makeItem('S2_TEST_2')],
        links: [
          {
            rel: 'next',
            method: 'POST',
            href: `http://127.0.0.1:${server.address().port}/v1/search`,
            body: { ...body, next: 'token-2' },
          },
        ],
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/v1`;

    const { features, pages } = await stacSearchAll({
      baseUrl,
      body: {
        collections: ['sentinel-2-l2a'],
        bbox: [0, 0, 1, 1],
        datetime: '2024-06-01T00:00:00Z/2024-06-30T23:59:59Z',
        limit: 2,
      },
    });

    assert.equal(pages, 2);
    assert.equal(features.length, 3);

    const items = features.map((f) => normalizeEarthSearchS2L2AItem(f, { red: 'B04', nir: 'B08', scl: 'SCL' }));
    assert.equal(items[0].assets.red, 'https://example.test/S2_TEST_1/B04.tif');
    assert.equal(items[0].assets.nir, 'https://example.test/S2_TEST_1/B08.tif');
    assert.equal(items[0].assets.scl, 'https://example.test/S2_TEST_1/SCL.tif');
    assert.equal(items[0].tile_id, '42TVL');
    assert.equal(items[2].tile_id, '42TWL');
    assert.equal(items[2].proj_epsg, 32642);
  } finally {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

