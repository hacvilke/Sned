import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Sandbox/preview hostnames used during development.
  allowedDevOrigins: ['*.e2b.app', 'localhost'],
  // The Blob SDK is only loaded by the blob signalling adapter.
  serverExternalPackages: ['@vercel/blob'],
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'x-content-type-options', value: 'nosniff' },
          { key: 'referrer-policy', value: 'strict-origin-when-cross-origin' },
          { key: 'permissions-policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
