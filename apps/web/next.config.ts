import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Serve AVIF first (then WebP), so next/image's responsive variants stay tiny.
    formats: ["image/avif", "image/webp"],
  },
  transpilePackages: [
    "@untch/design-tokens",
    "@untch/canon",
    "@untch/shared",
    "@untch/policy-engine",
    "@untch/proof-engine",
    "@untch/policy-store",
    "@untch/receipt-writer",
    "@untch/trust-bureau",
    "@untch/reports",
  ],
  // These are only pulled in transitively (repo-pg / queue / anchorers) and are never
  // constructed in the dashboard, which uses the pure and in-memory paths only. Externalizing
  // them keeps them out of the bundle and loading them has no connection side effect.
  serverExternalPackages: ["pg", "bullmq", "ioredis"],
};

export default nextConfig;
