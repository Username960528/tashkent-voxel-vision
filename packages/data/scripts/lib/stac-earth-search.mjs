/**
 * Minimal STAC client for https://earth-search.aws.element84.com/v1
 *
 * Earth Search uses a POST `/search` endpoint with pagination via a `links[]`
 * entry with `rel: "next"` that includes a fully-formed `body` (with a `next`
 * token). We follow that protocol to avoid guessing token semantics.
 */

export const EARTH_SEARCH_V1 = 'https://earth-search.aws.element84.com/v1';

/**
 * @param {unknown} feature
 * @returns {feature is { id: string, assets?: Record<string, {href?: unknown}>, properties?: Record<string, unknown> }}
 */
function isStacItemLike(feature) {
  return Boolean(feature && typeof feature === 'object' && typeof feature.id === 'string' && feature.id.length > 0);
}

function assertRfc3339Range(datetime) {
  if (typeof datetime !== 'string' || datetime.length === 0) throw new Error('Invalid datetime range');
  // Earth Search rejects non-RFC3339; we enforce the presence of time + Z.
  const [start, end] = datetime.split('/', 2);
  if (!start || !end) throw new Error(`Invalid datetime range (expected "start/end"): ${datetime}`);
  const re = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
  if (!re.test(start) || !re.test(end)) {
    throw new Error(`Invalid datetime range (RFC3339 required): ${datetime}`);
  }
}

/**
 * @param {string} bandId
 * @returns {string}
 */
function bandIdToEarthSearchAssetKey(bandId) {
  const b = String(bandId).trim();
  if (!b) return '';
  // Sentinel-2 L2A in Earth Search exposes both semantic keys and per-band keys.
  // Prefer semantic keys used by the collection.
  if (b.toUpperCase() === 'B04') return 'red';
  if (b.toUpperCase() === 'B08') return 'nir';
  if (b.toUpperCase() === 'SCL') return 'scl';
  return b;
}

/**
 * @param {Record<string, unknown>} props
 * @returns {string|null}
 */
function computeMgrsTileId(props) {
  const direct = props['s2:tile_id'];
  if (typeof direct === 'string' && direct.length > 0) return direct;

  const utm = props['mgrs:utm_zone'];
  const band = props['mgrs:latitude_band'];
  const sq = props['mgrs:grid_square'];
  const utmStr = typeof utm === 'number' || typeof utm === 'string' ? String(utm) : '';
  if (utmStr && typeof band === 'string' && typeof sq === 'string') return `${utmStr}${band}${sq}`;
  return null;
}

/**
 * @param {{ baseUrl?: string, body: any, maxPages?: number }} opts
 * @returns {Promise<{features: any[], pages: number}>}
 */
export async function stacSearchAll(opts) {
  const { baseUrl = EARTH_SEARCH_V1, body, maxPages = 5000 } = opts ?? {};
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new Error('Invalid baseUrl');
  if (!body || typeof body !== 'object') throw new Error('Invalid STAC search body');
  if (!Number.isFinite(maxPages) || maxPages <= 0) throw new Error('Invalid maxPages');

  if (typeof fetch !== 'function') {
    throw new Error('Global fetch() is not available; require Node.js >= 18');
  }

  if (body.datetime) assertRfc3339Range(body.datetime);

  const url = `${baseUrl.replace(/\/+$/, '')}/search`;
  /** @type {any[]} */
  const out = [];

  /** @type {any} */
  let nextBody = body;
  let pages = 0;

  while (true) {
    pages++;
    if (pages > maxPages) throw new Error(`STAC pagination exceeded maxPages=${maxPages}`);

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(nextBody),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`STAC search failed (${res.status}): ${text}`.slice(0, 2000));
    }

    const json = await res.json();
    const features = Array.isArray(json?.features) ? json.features : [];
    out.push(...features);

    const links = Array.isArray(json?.links) ? json.links : [];
    const next = links.find((l) => l && typeof l === 'object' && l.rel === 'next' && l.method === 'POST');
    if (!next || !next.body || typeof next.body !== 'object') break;
    nextBody = next.body;
  }

  return { features: out, pages };
}

/**
 * @param {any} feature
 * @param {{ red: string, nir: string, scl: string }} bands
 * @returns {{
 *   id: string,
 *   datetime: string|null,
 *   cloud_cover: number|null,
 *   tile_id: string|null,
 *   proj_epsg: number|null,
 *   assets: { red: string, nir: string, scl: string },
 * }}
 */
export function normalizeEarthSearchS2L2AItem(feature, bands) {
  if (!isStacItemLike(feature)) throw new Error('Invalid STAC item');
  const props = feature.properties && typeof feature.properties === 'object' ? feature.properties : {};
  const assets = feature.assets && typeof feature.assets === 'object' ? feature.assets : {};

  const redKey = bandIdToEarthSearchAssetKey(bands.red);
  const nirKey = bandIdToEarthSearchAssetKey(bands.nir);
  const sclKey = bandIdToEarthSearchAssetKey(bands.scl);

  const red = assets?.[redKey]?.href;
  const nir = assets?.[nirKey]?.href;
  const scl = assets?.[sclKey]?.href;
  if (typeof red !== 'string' || typeof nir !== 'string' || typeof scl !== 'string') {
    throw new Error(`Missing required band assets in STAC item ${feature.id} (need: ${redKey},${nirKey},${sclKey})`);
  }

  const datetime = typeof props.datetime === 'string' ? props.datetime : null;
  const cc = props['eo:cloud_cover'];
  const cloud_cover = typeof cc === 'number' ? cc : null;
  const proj = props['proj:epsg'];
  const proj_epsg = typeof proj === 'number' ? proj : null;

  return {
    id: feature.id,
    datetime,
    cloud_cover,
    tile_id: computeMgrsTileId(props),
    proj_epsg,
    assets: { red, nir, scl },
  };
}
