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
};

export default nextConfig;
