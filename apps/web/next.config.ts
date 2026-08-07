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
    "@untch/escalation",
    "@untch/x402-guard",
  ],
  // `pg` IS now constructed server-side: the dashboard reads its policy/intent/ledger/escalation/score
  // data from the shared production Postgres via the real pg repos (see lib/dashboard/db.ts), scoped to the
  // signed-in wallet. It stays externalized because `pg` is a Node-only package that must not be bundled for
  // the client — externalizing keeps it a server-side `require` (the read modules are server-only). `bullmq`
  // / `ioredis` remain transitive-only: the dashboard reads but never enqueues, so no Redis queue is
  // constructed here; externalizing keeps them out of the bundle with no connection side effect.
  serverExternalPackages: ["pg", "bullmq", "ioredis"],

  /**
   * Cache headers for the metadata images.
   *
   * Next serves `/opengraph-image.png`, `/twitter-image.png` and `/icon.png` through a route rather
   * than as static assets, and its default for those is `public, max-age=0, must-revalidate`. On
   * Cloudflare that is worse than it looks: a Worker Custom Domain owns the response, so zone Cache
   * Rules do not apply to it and there is no edge cache to absorb the repeats — every crawler fetch
   * and every re-share re-invokes the Worker for a file that never changes.
   *
   * These are content-hashed by Next, so a long TTL cannot serve a stale image: a new build produces
   * a new URL. `stale-while-revalidate` keeps a preview rendering while any revalidation happens.
   */
  async headers() {
    return [
      {
        source: "/:image(opengraph-image|twitter-image|icon).png",
        headers: [
          { key: "cache-control", value: "public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800" },
        ],
      },
      {
        source: "/favicon.ico",
        headers: [{ key: "cache-control", value: "public, max-age=3600, s-maxage=86400" }],
      },
    ];
  },
};

export default nextConfig;
