function isObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function extractGeometry(geojson) {
  if (!isObject(geojson)) throw new Error('Invalid GeoJSON: expected an object');

  if (geojson.type === 'FeatureCollection') {
    const features = Array.isArray(geojson.features) ? geojson.features : [];
    const feature = features[0];
    if (!isObject(feature) || feature.type !== 'Feature') {
      throw new Error('Invalid GeoJSON FeatureCollection: missing first Feature');
    }
    if (!isObject(feature.geometry)) {
      throw new Error('Invalid GeoJSON FeatureCollection: missing Feature.geometry');
    }
    return feature.geometry;
  }

  if (geojson.type === 'Feature') {
    if (!isObject(geojson.geometry)) throw new Error('Invalid GeoJSON Feature: missing geometry');
    return geojson.geometry;
  }

  if (typeof geojson.type === 'string' && Array.isArray(geojson.coordinates)) {
    return geojson;
  }

  throw new Error('Invalid GeoJSON: expected Geometry | Feature | FeatureCollection');
}

export function assertPolygonOrMultiPolygon(geometry) {
  const type = geometry?.type;
  if (type !== 'Polygon' && type !== 'MultiPolygon') {
    throw new Error(`Expected Polygon or MultiPolygon geometry; got: ${String(type)}`);
  }
}

function* iteratePositions(coords) {
  if (!Array.isArray(coords)) return;
  if (coords.length === 0) return;

  // Position: [x, y, (z...)]
  if (typeof coords[0] === 'number') {
    yield coords;
    return;
  }

  for (const child of coords) yield* iteratePositions(child);
}

export function computeGeometryBbox(geometry) {
  if (!isObject(geometry) || !Array.isArray(geometry.coordinates)) {
    throw new Error('Invalid geometry: missing coordinates');
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const pos of iteratePositions(geometry.coordinates)) {
    const x = pos[0];
    const y = pos[1];
    if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) continue;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    throw new Error('Failed to compute geometry bbox (no finite coordinates found)');
  }

  return [minX, minY, maxX, maxY];
}

export function assertBboxCoversGeometry(bbox, geometryBbox, epsilon = 1e-9) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('Invalid bbox: expected [minX, minY, maxX, maxY]');
  if (!Array.isArray(geometryBbox) || geometryBbox.length !== 4) {
    throw new Error('Invalid geometry bbox: expected [minX, minY, maxX, maxY]');
  }

  const [minX, minY, maxX, maxY] = bbox;
  const [gMinX, gMinY, gMaxX, gMaxY] = geometryBbox;

  if (gMinX < minX - epsilon || gMinY < minY - epsilon || gMaxX > maxX + epsilon || gMaxY > maxY + epsilon) {
    throw new Error(`AOI bbox does not cover geometry bbox.\n- bbox: ${JSON.stringify(bbox)}\n- geom: ${JSON.stringify(geometryBbox)}`);
  }
}
