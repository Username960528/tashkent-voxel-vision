import { webMercatorBboxToWgs84Bbox, wgs84BboxToWebMercatorBbox } from './mercator.mjs';

export function scaleBboxWgs84(bbox, scale) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('Invalid bbox (expected [w,s,e,n])');
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1) throw new Error(`Invalid scale: ${String(scale)}`);

  const [west, south, east, north] = bbox;
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const halfW = ((east - west) * scale) / 2;
  const halfH = ((north - south) * scale) / 2;
  return [cx - halfW, cy - halfH, cx + halfW, cy + halfH];
}

export function splitBboxGridWgs84({ bbox, grid, overlap = 0 }) {
  if (!Array.isArray(bbox) || bbox.length !== 4) throw new Error('Invalid bbox (expected [w,s,e,n])');
  if (!Number.isInteger(grid) || grid <= 0 || grid > 64) {
    throw new Error(`Invalid grid: ${String(grid)} (expected integer 1..64)`);
  }
  if (!Number.isFinite(overlap) || overlap < 0 || overlap >= 0.49) {
    throw new Error(`Invalid overlap: ${String(overlap)} (expected 0..0.49 as a fraction of tile size)`);
  }

  // Split in WebMercator meters to keep tile sizes consistent across the bbox.
  const [x0, y0, x1, y1] = wgs84BboxToWebMercatorBbox(bbox);
  const w = x1 - x0;
  const h = y1 - y0;
  if (!(Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0)) {
    throw new Error(`Degenerate bbox in WebMercator: w=${String(w)} h=${String(h)}`);
  }

  const dx = w / grid;
  const dy = h / grid;
  const ox = dx * overlap;
  const oy = dy * overlap;

  const tiles = [];
  // y index: 0 is "north row" for easier visual scanning. We still store bbox as [w,s,e,n].
  for (let y = 0; y < grid; y++) {
    for (let x = 0; x < grid; x++) {
      const xMin = x0 + dx * x;
      const xMax = x0 + dx * (x + 1);
      // Note: y increases north, so top row uses the largest y's.
      const yMax = y1 - dy * y;
      const yMin = y1 - dy * (y + 1);

      const bbox3857 = [xMin, yMin, xMax, yMax];
      const bbox3857Overlap = [xMin - ox, yMin - oy, xMax + ox, yMax + oy];

      tiles.push({
        z: 0,
        x,
        y,
        bbox: webMercatorBboxToWgs84Bbox(bbox3857),
        bbox_3857: bbox3857,
        bbox_overlap: webMercatorBboxToWgs84Bbox(bbox3857Overlap),
        bbox_overlap_3857: bbox3857Overlap,
      });
    }
  }

  return tiles;
}

