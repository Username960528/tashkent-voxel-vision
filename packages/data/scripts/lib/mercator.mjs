const R = 6378137; // WGS84 sphere radius used by WebMercator
const MAX_LAT = 85.05112878;

function clampLatDeg(lat) {
  if (!Number.isFinite(lat)) throw new Error(`Invalid latitude: ${String(lat)}`);
  return Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
}

export function lonLatToWebMercator(lonDeg, latDeg) {
  if (!Number.isFinite(lonDeg)) throw new Error(`Invalid longitude: ${String(lonDeg)}`);
  const lat = clampLatDeg(latDeg);

  const lonRad = (lonDeg * Math.PI) / 180;
  const latRad = (lat * Math.PI) / 180;

  const x = R * lonRad;
  const y = R * Math.log(Math.tan(Math.PI / 4 + latRad / 2));
  return { x, y };
}

export function webMercatorToLonLat(x, y) {
  if (!Number.isFinite(x)) throw new Error(`Invalid x: ${String(x)}`);
  if (!Number.isFinite(y)) throw new Error(`Invalid y: ${String(y)}`);

  const lonRad = x / R;
  const latRad = 2 * Math.atan(Math.exp(y / R)) - Math.PI / 2;

  return {
    lon: (lonRad * 180) / Math.PI,
    lat: (latRad * 180) / Math.PI,
  };
}

export function wgs84BboxToWebMercatorBbox(bbox) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('Invalid bbox (expected [w,s,e,n])');
  const [w, s, e, n] = bbox;
  const pW = lonLatToWebMercator(w, 0);
  const pE = lonLatToWebMercator(e, 0);
  const pS = lonLatToWebMercator(0, s);
  const pN = lonLatToWebMercator(0, n);
  return [pW.x, pS.y, pE.x, pN.y];
}

export function webMercatorBboxToWgs84Bbox(bbox3857) {
  if (!Array.isArray(bbox3857) || bbox3857.length !== 4) throw new Error('Invalid bbox3857 (expected [x0,y0,x1,y1])');
  const [x0, y0, x1, y1] = bbox3857;
  const llSW = webMercatorToLonLat(x0, y0);
  const llNE = webMercatorToLonLat(x1, y1);
  return [llSW.lon, llSW.lat, llNE.lon, llNE.lat];
}

