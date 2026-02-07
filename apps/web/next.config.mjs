/** @type {import('next').NextConfig} */
function normalizeBasePath(raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '/') return '';
  const withLeading = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/g, '');
}

const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@tashkent-voxel-vision/shared'],
  basePath: normalizeBasePath(process.env.NEXT_PUBLIC_BASE_PATH),
};

export default nextConfig;
