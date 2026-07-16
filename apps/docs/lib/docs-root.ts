import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the monorepo `docs/` content tree.
 * Prefer env (set by next.config) so Railway/cwd variants still resolve.
 */
export function getDocsRoot(): string {
  if (process.env.UNTCH_DOCS_ROOT?.trim()) {
    return process.env.UNTCH_DOCS_ROOT.trim();
  }
  // apps/docs/lib → apps/docs → apps → repo root → docs
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../docs");
}
