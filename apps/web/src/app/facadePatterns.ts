import type { Map } from 'maplibre-gl';

type Rgba = readonly [number, number, number, number];

const COLOR_WALL_LIGHT: Rgba = [209, 213, 219, 255]; // #d1d5db
const COLOR_WALL_MID: Rgba = [156, 163, 175, 255]; // #9ca3af
const COLOR_WALL_DARK: Rgba = [107, 114, 128, 255]; // #6b7280
const COLOR_WINDOW_DARK: Rgba = [31, 41, 55, 255]; // #1f2937
const COLOR_WINDOW_LIGHT: Rgba = [96, 165, 250, 255]; // #60a5fa
const COLOR_DOOR: Rgba = [87, 83, 78, 255]; // #57534e

export const FACADE_IMAGE_NAMES = ['tvv-facade-a', 'tvv-facade-b', 'tvv-facade-c'] as const;

function setPixel(data: Uint8ClampedArray, width: number, x: number, y: number, c: Rgba) {
  const i = (y * width + x) * 4;
  data[i + 0] = c[0];
  data[i + 1] = c[1];
  data[i + 2] = c[2];
  data[i + 3] = c[3];
}

function fill(data: Uint8ClampedArray, c: Rgba) {
  for (let i = 0; i < data.length; i += 4) {
    data[i + 0] = c[0];
    data[i + 1] = c[1];
    data[i + 2] = c[2];
    data[i + 3] = c[3];
  }
}

function rect(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  c: Rgba,
) {
  const x1 = Math.min(width, x0 + w);
  const y1 = Math.min(height, y0 + h);
  for (let y = Math.max(0, y0); y < y1; y++) {
    for (let x = Math.max(0, x0); x < x1; x++) {
      setPixel(data, width, x, y, c);
    }
  }
}

function hLine(data: Uint8ClampedArray, width: number, height: number, y: number, c: Rgba) {
  if (y < 0 || y >= height) return;
  for (let x = 0; x < width; x++) setPixel(data, width, x, y, c);
}

function vLine(data: Uint8ClampedArray, width: number, height: number, x: number, c: Rgba) {
  if (x < 0 || x >= width) return;
  for (let y = 0; y < height; y++) setPixel(data, width, x, y, c);
}

function frame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
  c: Rgba,
) {
  for (let x = x0; x < x0 + w; x++) {
    if (x < 0 || x >= width) continue;
    if (y0 >= 0 && y0 < height) setPixel(data, width, x, y0, c);
    const yb = y0 + h - 1;
    if (yb >= 0 && yb < height) setPixel(data, width, x, yb, c);
  }
  for (let y = y0; y < y0 + h; y++) {
    if (y < 0 || y >= height) continue;
    if (x0 >= 0 && x0 < width) setPixel(data, width, x0, y, c);
    const xr = x0 + w - 1;
    if (xr >= 0 && xr < width) setPixel(data, width, xr, y, c);
  }
}

function buildFacadeA(): ImageData {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  fill(data, COLOR_WALL_LIGHT);

  // Subtle dithering.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + y) % 7 === 0) setPixel(data, width, x, y, COLOR_WALL_MID);
    }
  }

  // "Floor" lines.
  for (let y = 0; y < height; y += 8) hLine(data, width, height, y, COLOR_WALL_DARK);
  // "Column" lines.
  for (let x = 0; x < width; x += 8) vLine(data, width, height, x, COLOR_WALL_DARK);

  // Windows per 8x8 cell.
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const cellX = cx * 8;
      const cellY = cy * 8;

      // Door in the bottom row, second column.
      if (cy === 3 && cx === 1) {
        rect(data, width, height, cellX + 2, cellY + 2, 4, 6, COLOR_DOOR);
        frame(data, width, height, cellX + 1, cellY + 1, 6, 7, COLOR_WALL_DARK);
        setPixel(data, width, cellX + 4, cellY + 5, COLOR_WINDOW_LIGHT);
        continue;
      }

      rect(data, width, height, cellX + 2, cellY + 2, 4, 4, COLOR_WINDOW_DARK);
      frame(data, width, height, cellX + 1, cellY + 1, 6, 6, COLOR_WALL_MID);
      setPixel(data, width, cellX + 3, cellY + 3, COLOR_WINDOW_LIGHT);
    }
  }

  return new ImageData(data, width, height);
}

function buildFacadeB(): ImageData {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  fill(data, COLOR_WALL_LIGHT);

  // Stronger vertical shading.
  for (let x = 0; x < width; x++) {
    if (x % 4 === 0) vLine(data, width, height, x, COLOR_WALL_MID);
    if (x % 8 === 0) vLine(data, width, height, x, COLOR_WALL_DARK);
  }
  for (let y = 0; y < height; y += 6) hLine(data, width, height, y, COLOR_WALL_MID);

  // Bigger windows in a 4x4 grid.
  for (let cy = 0; cy < 4; cy++) {
    for (let cx = 0; cx < 4; cx++) {
      const x0 = cx * 8 + 1;
      const y0 = cy * 8 + 2;
      rect(data, width, height, x0 + 1, y0, 5, 4, COLOR_WINDOW_DARK);
      frame(data, width, height, x0, y0 - 1, 7, 6, COLOR_WALL_DARK);
      setPixel(data, width, x0 + 3, y0 + 1, COLOR_WINDOW_LIGHT);
    }
  }

  return new ImageData(data, width, height);
}

function buildFacadeC(): ImageData {
  const width = 32;
  const height = 32;
  const data = new Uint8ClampedArray(width * height * 4);
  fill(data, COLOR_WALL_LIGHT);

  // Brick-ish pattern.
  for (let y = 0; y < height; y++) {
    const rowShift = (Math.floor(y / 4) % 2) * 4;
    for (let x = 0; x < width; x++) {
      if (y % 4 === 0) setPixel(data, width, x, y, COLOR_WALL_DARK);
      if ((x + rowShift) % 8 === 0) setPixel(data, width, x, y, COLOR_WALL_DARK);
      if ((x + y) % 11 === 0) setPixel(data, width, x, y, COLOR_WALL_MID);
    }
  }

  // Sparse windows so it doesn't look too busy on the roof.
  for (let y = 3; y < height; y += 10) {
    for (let x = 4; x < width; x += 10) {
      rect(data, width, height, x, y, 4, 3, COLOR_WINDOW_DARK);
      frame(data, width, height, x - 1, y - 1, 6, 5, COLOR_WALL_MID);
      setPixel(data, width, x + 1, y + 1, COLOR_WINDOW_LIGHT);
    }
  }

  return new ImageData(data, width, height);
}

export function ensureFacadeImages(map: Map) {
  const patterns: Record<(typeof FACADE_IMAGE_NAMES)[number], ImageData> = {
    'tvv-facade-a': buildFacadeA(),
    'tvv-facade-b': buildFacadeB(),
    'tvv-facade-c': buildFacadeC(),
  };

  for (const name of FACADE_IMAGE_NAMES) {
    if (map.hasImage(name)) continue;
    map.addImage(name, patterns[name], { pixelRatio: 1 });
  }
}

export function buildFacadePatternExpression() {
  // Avoid runtime errors: expressions like `["at", ...]` throw when out-of-bounds.
  // Some datasets store `id` as a plain number/string without a `type/id` prefix.
  const idStr = ['to-string', ['get', 'id']] as const;
  const numericStr = ['slice', idStr, ['+', ['index-of', '/', idStr], 1]] as const;
  const idNum = ['to-number', numericStr, 0] as const;

  const variant = ['%', idNum, 3] as const;

  // Use resolved images so MapLibre treats the values as sprite/added images.
  return [
    'match',
    variant,
    0,
    ['image', 'tvv-facade-a'],
    1,
    ['image', 'tvv-facade-b'],
    ['image', 'tvv-facade-c'],
  ] as const;
}
