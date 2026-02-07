import './globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { ReactNode } from 'react';

export const metadata = {
  title: 'Tashkent Voxel Vision',
  description: '3D map of Tashkent (MapLibre + PMTiles)',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
