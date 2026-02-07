'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import maplibregl, { type LayerSpecification, type Map, type StyleSpecification } from 'maplibre-gl';
import * as pmtiles from 'pmtiles';

const TASHKENT_CENTER: [number, number] = [69.2401, 41.2995];

type PmtilesLayerKey = 'buildings' | 'green' | 'roads' | 'water';

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

const BASEMAP_STYLE: StyleSpecification = {
  version: 8,
  sources: {
    osm: {
      type: 'raster',
      tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap contributors',
    },
  },
  layers: [
    {
      id: 'osm',
      type: 'raster',
      source: 'osm',
    },
  ],
};

function stripPmtilesProtocol(url: string) {
  return url.replace(/^pmtiles:\/\//, '');
}

export function MapClient() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  const pmtilesUrls = useMemo(() => {
    const baseDataUrl = process.env.NEXT_PUBLIC_BASE_DATA_URL;
    const runId = process.env.NEXT_PUBLIC_RUN_ID;

    if (!baseDataUrl || !runId) return null;
    return buildPmtilesUrls(baseDataUrl, runId);
  }, []);

  useEffect(() => {
    if (!containerRef.current) return;

    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLE,
      center: TASHKENT_CENTER,
      zoom: 13,
      pitch: 60,
      bearing: -25,
      hash: true,
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

    map.once('load', () => {
      if (!pmtilesUrls) {
        setHint(
          'PMTiles overlays disabled. Set NEXT_PUBLIC_BASE_DATA_URL and NEXT_PUBLIC_RUN_ID to enable buildings/roads/water/green.',
        );
        return;
      }

      // Non-blocking existence check for quick feedback when tiles are missing.
      // If it fails due to CORS or unsupported methods, we just skip the hint.
      void (async () => {
        try {
          const urls = Object.values(pmtilesUrls).map(stripPmtilesProtocol);
          const checks = await Promise.allSettled(urls.map((u) => fetch(u, { method: 'HEAD' })));
          const missing = checks.some((r) => r.status === 'fulfilled' && r.value.status === 404);
          if (missing) {
            setHint((prev) => prev ?? 'PMTiles not found (404). Check NEXT_PUBLIC_BASE_DATA_URL and NEXT_PUBLIC_RUN_ID.');
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

      addLayerSafe({
        id: 'buildings-extrusion',
        type: 'fill-extrusion',
        source: 'buildings',
        'source-layer': 'buildings',
        minzoom: 12,
        paint: {
          'fill-extrusion-color': '#d1d5db',
          'fill-extrusion-height': ['get', 'height_m'],
          'fill-extrusion-base': 0,
          'fill-extrusion-opacity': 0.92,
        },
      });
    });

    return () => {
      mapRef.current = null;
      map.remove();
      try {
        maplibregl.removeProtocol('pmtiles');
      } catch {
        // ignore
      }
    };
  }, [pmtilesUrls]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100dvh' }}>
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
      {hint ? (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            maxWidth: 420,
            background: 'rgba(0, 0, 0, 0.7)',
            color: '#fff',
            padding: '10px 12px',
            borderRadius: 10,
            fontSize: 13,
            lineHeight: 1.35,
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: '1 1 auto' }}>{hint}</div>
          <button
            type="button"
            onClick={() => setHint(null)}
            style={{
              flex: '0 0 auto',
              border: 'none',
              background: 'rgba(255, 255, 255, 0.12)',
              color: '#fff',
              padding: '2px 8px',
              borderRadius: 999,
              cursor: 'pointer',
              fontSize: 12,
            }}
            aria-label="Dismiss hint"
            title="Dismiss"
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}
