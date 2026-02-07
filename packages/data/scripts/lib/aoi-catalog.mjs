const AOI_CATALOG = {
  // WGS84 lon/lat bounds in [minLon, minLat, maxLon, maxLat].
  tashkent: {
    id: 'tashkent',
    crs: 'EPSG:4326',
    bbox: [69.103, 41.168, 69.397, 41.434],
  },
};

export function listAoiIds() {
  return Object.keys(AOI_CATALOG);
}

export function resolveAoi(aoiId) {
  const aoi = AOI_CATALOG[aoiId];
  if (!aoi) {
    const known = listAoiIds().join(', ');
    throw new Error(`Unknown --aoi: ${aoiId}. Known: ${known}`);
  }
  return aoi;
}

