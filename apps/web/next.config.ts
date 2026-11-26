import path from "node:path";

import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  serverExternalPackages: ["better-sqlite3"],
  experimental: {
    serverActions: {
      // 5 MiB raster image + base64 overhead и служебные поля command envelope.
      bodySizeLimit: "8mb",
    },
  },
};

export default nextConfig;
