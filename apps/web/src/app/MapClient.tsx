'use client';

import { useEffect, useRef, useState } from 'react';
import maplibregl, { type LayerSpecification, type Map, type MapGeoJSONFeature, type StyleSpecification } from 'maplibre-gl';
import * as pmtiles from 'pmtiles';
import { buildFacadePatternExpression, ensureFacadeImages } from './facadePatterns';

const TASHKENT_CENTER: [number, number] = [69.2401, 41.2995];
// WGS84 lon/lat bounds for clamping interaction to Tashkent by default.
// Keep in sync with `packages/data/scripts/lib/aoi-catalog.mjs` (MVP duplication is intentional).
const TASHKENT_BBOX: [number, number, number, number] = [69.103, 41.168, 69.397, 41.434];

type OverlayKey = 'buildings' | 'green' | 'roads' | 'water' | 'grid';
type PmtilesLayerKey = Exclude<OverlayKey, 'grid'>;

const PMTILES_LAYER_KEYS: readonly PmtilesLayerKey[] = ['buildings', 'green', 'roads', 'water'];

const OVERLAY_KEYS: readonly OverlayKey[] = [...PMTILES_LAYER_KEYS, 'grid'];

type LayerVisibility = Record<OverlayKey, boolean>;

const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  buildings: true,
  green: true,
  roads: true,
  water: true,
  grid: false,
};

const LAYER_META: Record<OverlayKey, { label: string }> = {
  buildings: { label: 'Buildings' },
  green: { label: 'Green' },
  roads: { label: 'Roads' },
  water: { label: 'Water' },
  grid: { label: 'Grid metrics' },
};

const BUILDINGS_LAYER_ID = 'buildings-extrusion';
const BUILDINGS_ROOF_LAYER_ID = 'buildings-roof-extrusion';
const BUILDINGS_SELECTED_LAYER_ID = 'buildings-selected-extrusion';
const BUILDINGS_HOVER_LAYER_ID = 'buildings-hover-extrusion';
const GRID_SOURCE_ID = 'grid-metrics';
const GRID_FILL_LAYER_ID = 'grid-metrics-fill';
const GRID_OUTLINE_LAYER_ID = 'grid-metrics-outline';

function joinUrlParts(a: string, b: string) {
  return `${a.replace(/\/+$/g, '')}/${b.replace(/^\/+/, '')}`;
}

function buildPmtilesUrls(baseDataUrl: string, runId: string): Record<PmtilesLayerKey, string> {
  const tilesDir = joinUrlParts(joinUrlParts(baseDataUrl, runId), 'tiles');
  return {
    buildings: `pmtiles://${joinUrlParts(tilesDir, 'buildings.pmtiles')}`,
    green: `pmtiles://${joinUrlParts(tilesDir, 'green.pmtiles')}`,
    roads: `pmtiles://${joinUrlParts(tilesDir, 'roads.pmtiles')}`,
    water: `pmtiles://${joinUrlParts(tilesDir, 'water.pmtiles')}`,
  };
}

function buildGridMetricsUrl(baseDataUrl: string, runId: string, cell = 500) {
  const metricsDir = joinUrlParts(joinUrlParts(baseDataUrl, runId), 'metrics');
  return joinUrlParts(metricsDir, `grid_${cell}m_metrics.geojson`);
}

const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [
    {
      id: 'background',
      type: 'background',
      paint: {
        // Warm paper-like base to keep focus on the city layers.
        'background-color': '#f6f2e8',
      },
    },
  ],
};

function stripPmtilesProtocol(url: string) {
  return url.replace(/^pmtiles:\/\//, '');
}

function parseRunIdParam(raw: string | null): string | null {
  const trimmed = (raw ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseLayersParam(raw: string | null): LayerVisibility | null {
  if (raw === null) return null;

  const next: LayerVisibility = {
    buildings: false,
    green: false,
    roads: false,
    water: false,
    grid: false,
  };

  for (const part of raw.split(',')) {
    const key = part.trim();
    if (key === 'buildings' || key === 'green' || key === 'roads' || key === 'water' || key === 'grid') {
      next[key] = true;
    }
  }

  return next;
}

function serializeLayersParam(layers: LayerVisibility) {
  return OVERLAY_KEYS.filter((k) => layers[k]).join(',');
}

type BuildingInfo = {
  id: string;
  height_m: number | null;
  height_source: string | null;
};

type HoverState = {
  x: number;
  y: number;
  info: BuildingInfo;
};

type GridInfo = {
  cell_id: string;
  cell_area_m2: number | null;
  green_area_m2: number | null;
  green_share: number | null;
};

type GridHoverState = {
  x: number;
  y: number;
  info: GridInfo;
};

function asStringOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return null;
}

function asNumberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function getBuildingInfo(feature: MapGeoJSONFeature): BuildingInfo | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const id = asStringOrNull(props.id);
  if (!id) return null;
  return {
    id,
    height_m: asNumberOrNull(props.height_m),
    height_source: asStringOrNull(props.height_source),
  };
}

function getGridInfo(feature: MapGeoJSONFeature): GridInfo | null {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const cellId = asStringOrNull(props.cell_id);
  if (!cellId) return null;
  return {
    cell_id: cellId,
    cell_area_m2: asNumberOrNull(props.cell_area_m2),
    green_area_m2: asNumberOrNull(props.green_area_m2),
    green_share: asNumberOrNull(props.green_share),
  };
}

export function MapClient() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const protocolRef = useRef<pmtiles.Protocol | null>(null);
  const registeredPmtilesRef = useRef<Set<string>>(new Set());
  const currentRunIdRef = useRef<string | null>(null);

  const hoverRafRef = useRef<number | null>(null);
  const lastHoverPointRef = useRef<{ x: number; y: number } | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);

  const baseDataUrl = process.env.NEXT_PUBLIC_BASE_DATA_URL ?? null;
  const envRunId = process.env.NEXT_PUBLIC_RUN_ID ?? null;

  const [mapLoaded, setMapLoaded] = useState(false);
  const [isUrlInitialized, setIsUrlInitialized] = useState(false);

  const [pixelMode, setPixelMode] = useState(true);
  // Fraction of the devicePixelRatio to render at when pixel mode is enabled.
  // 1.0 means normal DPR rendering, 0.25 means heavy pixelation.
  const [pixelScale, setPixelScale] = useState(0.35);

  const [hint, setHint] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(envRunId);
  const [draftRunId, setDraftRunId] = useState(envRunId ?? '');
  const [layers, setLayers] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);

  const [hover, setHover] = useState<HoverState | null>(null);
  const [gridHover, setGridHover] = useState<GridHoverState | null>(null);
  const [selected, setSelected] = useState<BuildingInfo | null>(null);

  const layersRef = useRef(layers);
  useEffect(() => {
    layersRef.current = layers;
  }, [layers]);

  const hoveredRef = useRef(hover);
  useEffect(() => {
    hoveredRef.current = hover;
  }, [hover]);

  const gridHoveredRef = useRef(gridHover);
  useEffect(() => {
    gridHoveredRef.current = gridHover;
  }, [gridHover]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const applyFromUrl = () => {
      const url = new URL(window.location.href);
      const params = url.searchParams;

      const nextRunId = parseRunIdParam(params.get('run_id'));
      const nextLayers = parseLayersParam(params.get('layers'));

      if (nextRunId !== null) {
        setRunId(nextRunId);
        setDraftRunId(nextRunId);
      }

      if (nextLayers !== null) {
        setLayers(nextLayers);
      }
    };

    applyFromUrl();
    setIsUrlInitialized(true);

    const onPopState = () => applyFromUrl();
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    if (!isUrlInitialized) return;
    if (typeof window === 'undefined') return;

    const url = new URL(window.location.href);
    const params = url.searchParams;

    if (runId) params.set('run_id', runId);
    else params.delete('run_id');

    params.set('layers', serializeLayersParam(layers));

    const next = `${url.pathname}?${params.toString()}${url.hash}`;
    window.history.replaceState({}, '', next);
  }, [isUrlInitialized, layers, runId]);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new pmtiles.Protocol();
    protocolRef.current = protocol;
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: TASHKENT_CENTER,
      zoom: 13,
      minZoom: 10.5,
      maxZoom: 19,
      pitch: 60,
      bearing: -25,
      hash: true,
      renderWorldCopies: false,
      maxBounds: [
        [TASHKENT_BBOX[0], TASHKENT_BBOX[1]],
        [TASHKENT_BBOX[2], TASHKENT_BBOX[3]],
      ],
    });

    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');

    const maybeShowPmtilesHintFromError = (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      if (!lower.includes('pmtiles') && !lower.includes('.pmtiles')) return;
      if (!/\b404\b/.test(lower) && !lower.includes('not found')) return;
      setHint((prev) => prev ?? 'PMTiles not found (404). Check NEXT_PUBLIC_BASE_DATA_URL and NEXT_PUBLIC_RUN_ID.');
    };

    map.on('error', (evt) => {
      // Keep basemap usable; just surface a small hint if PMTiles are missing.
      const err = (evt as { error?: unknown }).error;
      if (err) maybeShowPmtilesHintFromError(err);
    });

    map.once('load', () => setMapLoaded(true));

    return () => {
      mapRef.current = null;
      protocolRef.current = null;
      map.remove();
      try {
        maplibregl.removeProtocol('pmtiles');
      } catch {
        // ignore
      }
    };
  }, []);

  useEffect(() => {
    if (!mapLoaded) return;
    const map = mapRef.current;
    if (!map) return;
    if (typeof window === 'undefined') return;

    const dpr = window.devicePixelRatio || 1;
    const clampedScale = Math.min(1, Math.max(0.15, pixelScale));
    const nextRatio = dpr * (pixelMode ? clampedScale : 1);

    map.setPixelRatio(nextRatio);
    map.resize();
  }, [mapLoaded, pixelMode, pixelScale]);

  useEffect(() => {
    if (!mapLoaded) return;

    const map = mapRef.current;
    if (!map) return;

    const setLayerVisibility = (layerId: string, visible: boolean) => {
      if (!map.getLayer(layerId)) return;
      map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
    };

    const setBuildingsHighlight = (layerId: string, featureId: string | null) => {
      if (!map.getLayer(layerId)) return;
      if (!layersRef.current.buildings || !featureId) {
        map.setLayoutProperty(layerId, 'visibility', 'none');
        return;
      }
      map.setFilter(layerId, ['==', ['to-string', ['get', 'id']], featureId] as never);
      map.setLayoutProperty(layerId, 'visibility', 'visible');
    };

    const clearHover = () => {
      hoveredIdRef.current = null;
      setHover(null);
      setBuildingsHighlight(BUILDINGS_HOVER_LAYER_ID, null);
    };

    const clearSelection = () => {
      selectedIdRef.current = null;
      setSelected(null);
      setBuildingsHighlight(BUILDINGS_SELECTED_LAYER_ID, null);
    };

    const removeLayerSafe = (id: string) => {
      if (!map.getLayer(id)) return;
      map.removeLayer(id);
    };

    const removeSourceSafe = (id: string) => {
      if (!map.getSource(id)) return;
      map.removeSource(id);
    };

    const teardownOverlays = () => {
      removeLayerSafe(GRID_OUTLINE_LAYER_ID);
      removeLayerSafe(GRID_FILL_LAYER_ID);
      removeLayerSafe(BUILDINGS_HOVER_LAYER_ID);
      removeLayerSafe(BUILDINGS_SELECTED_LAYER_ID);
      removeLayerSafe(BUILDINGS_ROOF_LAYER_ID);
      removeLayerSafe(BUILDINGS_LAYER_ID);
      removeLayerSafe('roads-line');
      removeLayerSafe('green-fill');
      removeLayerSafe('water-fill');

      removeSourceSafe(GRID_SOURCE_ID);
      removeSourceSafe('buildings');
      removeSourceSafe('roads');
      removeSourceSafe('green');
      removeSourceSafe('water');

      currentRunIdRef.current = null;
    };

    const ensureOverlaysForRun = (nextRunId: string) => {
      if (!baseDataUrl) return;
      const protocol = protocolRef.current;
      if (!protocol) return;

      const pmtilesUrls = buildPmtilesUrls(baseDataUrl, nextRunId);
      const gridUrl = buildGridMetricsUrl(baseDataUrl, nextRunId, 500);

      // Facade textures are registered as runtime images; do this before any layers reference them.
      ensureFacadeImages(map);

      // Register PMTiles archives so MapLibre can request TileJSON + tiles via the `pmtiles://` protocol.
      for (const url of Object.values(pmtilesUrls)) {
        const bare = stripPmtilesProtocol(url);
        if (registeredPmtilesRef.current.has(bare)) continue;
        try {
          protocol.add(new pmtiles.PMTiles(bare));
          registeredPmtilesRef.current.add(bare);
        } catch {
          // ignore; MapLibre will surface load errors via `map.on('error', ...)`.
        }
      }

      // Non-blocking existence check for quick feedback when tiles are missing.
      // If it fails due to CORS or unsupported methods, we just skip the hint.
      void (async () => {
        try {
          const urls = Object.values(pmtilesUrls).map(stripPmtilesProtocol);
          const checks = await Promise.allSettled(urls.map((u) => fetch(u, { method: 'HEAD' })));
          const missing = checks.some((r) => r.status === 'fulfilled' && r.value.status === 404);
          if (missing) {
            setHint((prev) => prev ?? 'PMTiles not found (404). Check NEXT_PUBLIC_BASE_DATA_URL and run_id / NEXT_PUBLIC_RUN_ID.');
          }
        } catch {
          // ignore
        }
      })();

      // If the PMTiles are missing, MapLibre will log errors and keep the basemap running.
      // We show a small hint but do not block interaction.
      const addSourceSafe = (id: PmtilesLayerKey) => {
        if (map.getSource(id)) return;
        map.addSource(id, { type: 'vector', url: pmtilesUrls[id] });
      };

      addSourceSafe('water');
      addSourceSafe('green');
      addSourceSafe('roads');
      addSourceSafe('buildings');

      if (!map.getSource(GRID_SOURCE_ID)) {
        map.addSource(GRID_SOURCE_ID, { type: 'geojson', data: gridUrl });
      }

      const addLayerSafe = (layer: LayerSpecification) => {
        if (map.getLayer(layer.id)) return;
        map.addLayer(layer);
      };

      addLayerSafe({
        id: 'water-fill',
        type: 'fill',
        source: 'water',
        'source-layer': 'water',
        paint: {
          'fill-color': '#93c5fd',
          'fill-opacity': 0.6,
        },
      });

      addLayerSafe({
        id: 'green-fill',
        type: 'fill',
        source: 'green',
        'source-layer': 'green',
        paint: {
          'fill-color': '#86efac',
          'fill-opacity': 0.45,
        },
      });

      const gridShareExpr = ['coalesce', ['to-number', ['get', 'green_share']], 0] as never;

      addLayerSafe({
        id: GRID_FILL_LAYER_ID,
        type: 'fill',
        source: GRID_SOURCE_ID,
        minzoom: 11,
        paint: {
          'fill-color': [
            'interpolate',
            ['linear'],
            gridShareExpr,
            0,
            '#f3f4f6',
            0.1,
            '#dcfce7',
            0.3,
            '#86efac',
            0.5,
            '#4ade80',
            0.7,
            '#22c55e',
            1,
            '#15803d',
          ] as never,
          'fill-opacity': 0.35,
        },
      });

      addLayerSafe({
        id: GRID_OUTLINE_LAYER_ID,
        type: 'line',
        source: GRID_SOURCE_ID,
        minzoom: 11,
        paint: {
          'line-color': '#111827',
          'line-opacity': 0.22,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.2, 14, 0.8, 16, 1.4] as never,
        },
      });

      addLayerSafe({
        id: 'roads-line',
        type: 'line',
        source: 'roads',
        'source-layer': 'roads',
        paint: {
          'line-color': '#6b7280',
          'line-opacity': 0.9,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.5, 14, 1.5, 16, 3],
        },
      });

      const heightExpr = ['coalesce', ['to-number', ['get', 'height_m']], 0] as never;

      addLayerSafe({
        id: BUILDINGS_LAYER_ID,
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12,
        paint: {
          'fill-extrusion-pattern': buildFacadePatternExpression() as never,
          // Keep facades off the roof: render walls up to (height - roofThickness),
          // and draw a plain roof cap layer above.
          'fill-extrusion-height': ['max', 0, ['-', heightExpr, 0.8]] as never,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.92,
          'fill-extrusion-vertical-gradient': false,
        },
      });

      addLayerSafe({
        id: BUILDINGS_ROOF_LAYER_ID,
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12,
        paint: {
          'fill-extrusion-color': '#e5e7eb',
          'fill-extrusion-height': heightExpr,
          'fill-extrusion-base': ['max', 0, ['-', heightExpr, 0.8]] as never,
          'fill-extrusion-opacity': 0.95,
          'fill-extrusion-vertical-gradient': false,
        },
      });

      // Selection + hover highlights (hidden until set via filters).
      addLayerSafe({
        id: BUILDINGS_SELECTED_LAYER_ID,
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12,
        filter: ['==', ['to-string', ['get', 'id']], ''] as never,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': '#f59e0b',
          'fill-extrusion-height': heightExpr,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.98,
        },
      });

      addLayerSafe({
        id: BUILDINGS_HOVER_LAYER_ID,
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12,
        filter: ['==', ['to-string', ['get', 'id']], ''] as never,
        layout: { visibility: 'none' },
        paint: {
          'fill-extrusion-color': '#60a5fa',
          'fill-extrusion-height': heightExpr,
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.98,
        },
      });
    };

    const syncOverlays = () => {
      if (!baseDataUrl || !runId) {
        teardownOverlays();
        clearSelection();
        clearHover();
        setGridHover(null);
        setHint(
          'PMTiles overlays disabled. Set NEXT_PUBLIC_BASE_DATA_URL and NEXT_PUBLIC_RUN_ID (or use ?run_id=...) to enable buildings/roads/water/green.',
        );
        return;
      }

      if (currentRunIdRef.current !== runId) {
        // Run hot-swap: rebuild PMTiles sources + layers in-place (no page reload).
        setHint(null);
        clearSelection();
        clearHover();
        setGridHover(null);
        teardownOverlays();
        ensureOverlaysForRun(runId);
        currentRunIdRef.current = runId;
      }

      // Apply per-layer visibility toggles.
      setLayerVisibility('water-fill', layers.water);
      setLayerVisibility('green-fill', layers.green);
      setLayerVisibility(GRID_FILL_LAYER_ID, layers.grid);
      setLayerVisibility(GRID_OUTLINE_LAYER_ID, layers.grid);
      setLayerVisibility('roads-line', layers.roads);
      setLayerVisibility(BUILDINGS_LAYER_ID, layers.buildings);
      setLayerVisibility(BUILDINGS_ROOF_LAYER_ID, layers.buildings);

      if (!layers.grid) {
        setGridHover(null);
      }

      if (!layers.buildings) {
        clearSelection();
        clearHover();
      } else {
        setBuildingsHighlight(BUILDINGS_SELECTED_LAYER_ID, selectedIdRef.current);
        setBuildingsHighlight(BUILDINGS_HOVER_LAYER_ID, hoveredIdRef.current);
      }
    };

    syncOverlays();
  }, [baseDataUrl, layers, mapLoaded, runId]);

  useEffect(() => {
    if (!mapLoaded) return;
    const map = mapRef.current;
    if (!map) return;

    const setHoverHighlight = (featureId: string | null) => {
      if (hoveredIdRef.current === featureId) return;
      hoveredIdRef.current = featureId;
      if (!map.getLayer(BUILDINGS_HOVER_LAYER_ID)) return;
      if (!layersRef.current.buildings || !featureId) {
        map.setLayoutProperty(BUILDINGS_HOVER_LAYER_ID, 'visibility', 'none');
        return;
      }
      map.setFilter(BUILDINGS_HOVER_LAYER_ID, ['==', ['to-string', ['get', 'id']], featureId] as never);
      map.setLayoutProperty(BUILDINGS_HOVER_LAYER_ID, 'visibility', 'visible');
    };

    const setSelectedHighlight = (featureId: string | null) => {
      if (selectedIdRef.current === featureId) return;
      selectedIdRef.current = featureId;
      if (!map.getLayer(BUILDINGS_SELECTED_LAYER_ID)) return;
      if (!layersRef.current.buildings || !featureId) {
        map.setLayoutProperty(BUILDINGS_SELECTED_LAYER_ID, 'visibility', 'none');
        return;
      }
      map.setFilter(BUILDINGS_SELECTED_LAYER_ID, ['==', ['to-string', ['get', 'id']], featureId] as never);
      map.setLayoutProperty(BUILDINGS_SELECTED_LAYER_ID, 'visibility', 'visible');
    };

    const clearHover = () => {
      setHover(null);
      setHoverHighlight(null);
    };

    const clearSelection = () => {
      setSelected(null);
      setSelectedHighlight(null);
    };

    const onKeyDown = (evt: KeyboardEvent) => {
      if (evt.key !== 'Escape') return;
      clearSelection();
    };

    window.addEventListener('keydown', onKeyDown);

    const onMouseMove = (evt: { point: { x: number; y: number } }) => {
      lastHoverPointRef.current = { x: evt.point.x, y: evt.point.y };
      if (hoverRafRef.current !== null) return;

      hoverRafRef.current = window.requestAnimationFrame(() => {
        hoverRafRef.current = null;

        const pt = lastHoverPointRef.current;
        if (!pt) return;

        // Priority: buildings hover first, then grid metrics.
        const canHoverBuildings =
          layersRef.current.buildings && (Boolean(map.getLayer(BUILDINGS_LAYER_ID)) || Boolean(map.getLayer(BUILDINGS_ROOF_LAYER_ID)));

        if (canHoverBuildings) {
          const hoverLayers: string[] = [];
          if (map.getLayer(BUILDINGS_ROOF_LAYER_ID)) hoverLayers.push(BUILDINGS_ROOF_LAYER_ID);
          if (map.getLayer(BUILDINGS_LAYER_ID)) hoverLayers.push(BUILDINGS_LAYER_ID);
          const features = map.queryRenderedFeatures([pt.x, pt.y], { layers: hoverLayers });
          const feature = features[0];
          if (feature) {
            const info = getBuildingInfo(feature);
            if (info) {
              if (gridHoveredRef.current) setGridHover(null);
              setHoverHighlight(info.id);
              setHover({ x: pt.x, y: pt.y, info });
              return;
            }
          }
        }

        if (hoveredRef.current) clearHover();

        const canHoverGrid = layersRef.current.grid && Boolean(map.getLayer(GRID_FILL_LAYER_ID));
        if (!canHoverGrid) {
          if (gridHoveredRef.current) setGridHover(null);
          return;
        }

        const gridFeatures = map.queryRenderedFeatures([pt.x, pt.y], { layers: [GRID_FILL_LAYER_ID] });
        const gridFeature = gridFeatures[0];
        if (!gridFeature) {
          if (gridHoveredRef.current) setGridHover(null);
          return;
        }

        const gridInfo = getGridInfo(gridFeature);
        if (!gridInfo) {
          if (gridHoveredRef.current) setGridHover(null);
          return;
        }

        setGridHover({ x: pt.x, y: pt.y, info: gridInfo });
      });
    };

    const onClick = (evt: { point: { x: number; y: number } }) => {
      if (
        !layersRef.current.buildings ||
        (!map.getLayer(BUILDINGS_LAYER_ID) && !map.getLayer(BUILDINGS_ROOF_LAYER_ID))
      ) {
        clearSelection();
        return;
      }

      const clickLayers: string[] = [];
      if (map.getLayer(BUILDINGS_ROOF_LAYER_ID)) clickLayers.push(BUILDINGS_ROOF_LAYER_ID);
      if (map.getLayer(BUILDINGS_LAYER_ID)) clickLayers.push(BUILDINGS_LAYER_ID);
      const features = map.queryRenderedFeatures([evt.point.x, evt.point.y], { layers: clickLayers });
      const feature = features[0];

      if (!feature) {
        clearSelection();
        return;
      }

      const info = getBuildingInfo(feature);
      if (!info) {
        clearSelection();
        return;
      }

      setSelected(info);
      setSelectedHighlight(info.id);
    };

    map.on('mousemove', onMouseMove as never);
    map.on('click', onClick as never);

    const canvas = map.getCanvas();
    const onCanvasMouseLeave = () => {
      clearHover();
      setGridHover(null);
    };
    canvas.addEventListener('mouseleave', onCanvasMouseLeave);

    return () => {
      window.removeEventListener('keydown', onKeyDown);

      if (hoverRafRef.current !== null) {
        window.cancelAnimationFrame(hoverRafRef.current);
        hoverRafRef.current = null;
      }

      map.off('mousemove', onMouseMove as never);
      map.off('click', onClick as never);
      canvas.removeEventListener('mouseleave', onCanvasMouseLeave);
    };
  }, [mapLoaded]);

  return (
    <div className={`tvv-map-root${pixelMode ? ' tvv-map-root--pixel' : ''}`}>
      <div ref={containerRef} className="tvv-map-canvas" />

      <div className="tvv-panel tvv-panel--left">
        <div className="tvv-panel__title">Overlays</div>

        <form
          className="tvv-form-row"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = draftRunId.trim();
            setRunId(trimmed.length > 0 ? trimmed : envRunId);
          }}
        >
          <label className="tvv-label" htmlFor="tvv-run-id">
            Run ID
          </label>
          <div className="tvv-form-inline">
            <input
              id="tvv-run-id"
              className="tvv-input"
              value={draftRunId}
              onChange={(e) => setDraftRunId(e.target.value)}
              placeholder={envRunId ?? 'unset'}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              inputMode="text"
            />
            <button className="tvv-btn" type="submit">
              Apply
            </button>
          </div>
        </form>

        <div className="tvv-section">
          <div className="tvv-section__label">Layers</div>
          <div className="tvv-checkboxes">
            {OVERLAY_KEYS.map((k) => (
              <label key={k} className="tvv-checkbox">
                <input
                  type="checkbox"
                  checked={layers[k]}
                  onChange={() => setLayers((prev) => ({ ...prev, [k]: !prev[k] }))}
                />
                <span>{LAYER_META[k].label}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="tvv-section">
          <div className="tvv-section__label">Render</div>
          <label className="tvv-checkbox">
            <input type="checkbox" checked={pixelMode} onChange={() => setPixelMode((prev) => !prev)} />
            <span>Pixel mode</span>
          </label>
          {pixelMode ? (
            <div className="tvv-form-row">
              <label className="tvv-label" htmlFor="tvv-pixel-scale">
                Pixel scale
              </label>
              <input
                id="tvv-pixel-scale"
                className="tvv-range"
                type="range"
                min="0.15"
                max="1"
                step="0.05"
                value={pixelScale}
                onChange={(e) => setPixelScale(e.currentTarget.valueAsNumber)}
              />
              <div className="tvv-range__meta">{Math.round(pixelScale * 100)}%</div>
            </div>
          ) : null}
        </div>

        <div className="tvv-section">
          <div className="tvv-section__label">Legend</div>
          <div className="tvv-legend">
            <div className="tvv-legend__item">
              <span className="tvv-swatch tvv-swatch--buildings" /> Buildings
            </div>
            <div className="tvv-legend__item">
              <span className="tvv-swatch tvv-swatch--green" /> Green
            </div>
            <div className="tvv-legend__item">
              <span className="tvv-swatch tvv-swatch--water" /> Water
            </div>
            <div className="tvv-legend__item">
              <span className="tvv-swatch tvv-swatch--roads" /> Roads
            </div>
            <div className="tvv-legend__item">
              <span className="tvv-swatch tvv-swatch--grid" /> Grid metrics
            </div>
          </div>
        </div>

        {hint ? (
          <div className="tvv-hint">
            <div className="tvv-hint__text">{hint}</div>
            <button type="button" className="tvv-hint__btn" onClick={() => setHint(null)} aria-label="Dismiss hint">
              Dismiss
            </button>
          </div>
        ) : null}
      </div>

      {hover ? (
        <div className="tvv-tooltip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="tvv-kv">
            <div className="tvv-kv__k">id</div>
            <div className="tvv-kv__v">{hover.info.id}</div>
          </div>
          <div className="tvv-kv">
            <div className="tvv-kv__k">height_m</div>
            <div className="tvv-kv__v">{hover.info.height_m ?? 'null'}</div>
          </div>
          <div className="tvv-kv">
            <div className="tvv-kv__k">height_source</div>
            <div className="tvv-kv__v">{hover.info.height_source ?? 'null'}</div>
          </div>
        </div>
      ) : gridHover ? (
        <div className="tvv-tooltip" style={{ left: gridHover.x + 12, top: gridHover.y + 12 }}>
          <div className="tvv-kv">
            <div className="tvv-kv__k">cell_id</div>
            <div className="tvv-kv__v">{gridHover.info.cell_id}</div>
          </div>
          <div className="tvv-kv">
            <div className="tvv-kv__k">green_share</div>
            <div className="tvv-kv__v">{gridHover.info.green_share ?? 'null'}</div>
          </div>
          <div className="tvv-kv">
            <div className="tvv-kv__k">green_area_m2</div>
            <div className="tvv-kv__v">{gridHover.info.green_area_m2 ?? 'null'}</div>
          </div>
          <div className="tvv-kv">
            <div className="tvv-kv__k">cell_area_m2</div>
            <div className="tvv-kv__v">{gridHover.info.cell_area_m2 ?? 'null'}</div>
          </div>
        </div>
      ) : null}

      {selected ? (
        <aside className="tvv-panel tvv-panel--right" aria-label="Building inspector">
          <div className="tvv-panel__title-row">
            <div className="tvv-panel__title">Building</div>
            <button
              type="button"
              className="tvv-icon-btn"
              onClick={() => {
                selectedIdRef.current = null;
                setSelected(null);
                const map = mapRef.current;
                if (map?.getLayer(BUILDINGS_SELECTED_LAYER_ID)) {
                  map.setLayoutProperty(BUILDINGS_SELECTED_LAYER_ID, 'visibility', 'none');
                }
              }}
              aria-label="Close inspector"
              title="Close (Esc)"
            >
              ✕
            </button>
          </div>

          <div className="tvv-kv tvv-kv--panel">
            <div className="tvv-kv__k">id</div>
            <div className="tvv-kv__v">{selected.id}</div>
          </div>
          <div className="tvv-kv tvv-kv--panel">
            <div className="tvv-kv__k">height_m</div>
            <div className="tvv-kv__v">{selected.height_m ?? 'null'}</div>
          </div>
          <div className="tvv-kv tvv-kv--panel">
            <div className="tvv-kv__k">height_source</div>
            <div className="tvv-kv__v">{selected.height_source ?? 'null'}</div>
          </div>

          <div className="tvv-panel__footer">Esc clears selection.</div>
        </aside>
      ) : null}
    </div>
  );
}
