import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // PGlite resolves its WASM/data files with native Node URLs, not bundled browser URLs.
  serverExternalPackages: ['@electric-sql/pglite'],
};

export default nextConfig;
