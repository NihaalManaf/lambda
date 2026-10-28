import type { NextConfig } from "next";

// set by `npm run app:build`: the server runs from inside the signed .app bundle, so it must never write
// to its own dist dir (image cache, ISR files) — that breaks the code seal. images are tiny + local anyway.
const APP_BUILD = process.env.LAMBDA_APP_BUILD === "1";

const nextConfig: NextConfig = {
  // standalone: the mac app (electron/) runs .next/standalone/server.js.
  // electron/scripts/prepare.mjs strips data/ + electron out of it (tracing excludes match too broadly)
  output: "standalone",
  // local art is pre-sized webp; the optimizer's internal fetch is also blocked by proxy.ts host checks
  images: { unoptimized: true },
  ...(APP_BUILD && { experimental: { isrFlushToDisk: false } }),
  // pgsql-parser/libpg-query load a .wasm from disk: bundling breaks the path, external keeps it traced
  serverExternalPackages: ["playwright", "sharp", "pgsql-parser", "libpg-query"],
  // tailwind v4 via its turbopack loader (no postcss config)
  turbopack: {
    rules: {
      "*.css": { loaders: ["@tailwindcss/turbopack"], as: "*.css" },
    },
  },
};

export default nextConfig;
