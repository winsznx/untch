import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appDir = path.dirname(fileURLToPath(import.meta.url));
/** Repo-root docs/ (MDX source of truth). */
const docsRoot = path.resolve(appDir, "../../docs");

const nextConfig: NextConfig = {
  // Allow reading markdown outside the app directory at build time.
  outputFileTracingRoot: path.resolve(appDir, "../.."),
  experimental: {
    // Ensure content is available to the server for FS reads in monorepo deploys.
    externalDir: true,
  },
  // Expose for runtime modules that resolve the docs root once.
  env: {
    UNTCH_DOCS_ROOT: docsRoot,
  },
};

export default nextConfig;
