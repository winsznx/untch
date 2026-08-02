/**
 * Static-site releases: an archive becomes a set of files, or it is refused with a reason.
 *
 * WHY VALIDATION IS A PURE FUNCTION OVER ENTRIES
 *
 * Every dangerous thing an archive can do to a host happens during EXTRACTION. So nothing here
 * extracts: the caller lists the archive's entries, this module judges the listing, and only a
 * listing that passed is written anywhere. A validator that ran during extraction would be deciding
 * whether a path was safe after the write that used it.
 *
 * WHAT IS BEING DEFENDED AGAINST, AND WHY EACH ONE IS SEPARATE
 *
 * Traversal and absolute paths escape the destination. Symlinks and hard links escape it a second
 * way, after the path check passed, which is why they are refused by TYPE rather than by where they
 * point — a link whose target is inside the tree today is a link whose target can move. Decompression
 * bombs exhaust the host without any path being wrong at all. Each has its own refusal code because
 * each has a different fix, and "invalid archive" tells a customer nothing they can act on.
 *
 * ACTIVATION IS A POINTER MOVE
 *
 * A release is uploaded, validated, stored and previewed while the site still serves the previous
 * one. Going live sets `activeReleaseId`. That makes activation atomic and rollback free — the old
 * release's files were never deleted, so returning to it is another pointer move rather than another
 * upload.
 */

import type { Hex } from "viem";
import { contentHashOf, isSupportedMime, SUPPORTED_MIME_TYPES } from "./artifacts";

export type SiteStatus = "ACTIVE" | "SUSPENDED" | "DELETED";
export type ReleaseStatus = "VALIDATING" | "REJECTED" | "READY" | "ACTIVE" | "SUPERSEDED";
export type DomainVerificationState = "PENDING" | "VERIFIED" | "FAILED" | "DETACHED";
export type TlsState = "NONE" | "REQUESTED" | "ISSUED" | "FAILED";

export interface Site {
  readonly siteId: string;
  readonly accountId: string;
  readonly orderId: string | null;
  readonly slug: string;
  readonly activeReleaseId: string | null;
  readonly status: SiteStatus;
  readonly retentionUntil: string | null;
}

export interface SiteRelease {
  readonly releaseId: string;
  readonly siteId: string;
  readonly sourceArtifactId: string;
  readonly sourceZipHash: Hex;
  readonly extractedManifestHash: Hex;
  readonly fileCount: number;
  readonly totalSize: number;
  readonly entrypoint: string;
  readonly createdAt: string;
  readonly activatedAt: string | null;
  readonly status: ReleaseStatus;
}

/**
 * A custom domain, modelled through its states and no further.
 *
 * There is no DNS client and no ACME client behind this. The states exist so a UI can show the truth
 * — `PENDING` means nobody has verified anything — and so that when automation is built it has a
 * record to move through rather than a column to invent. Nothing in this repository may report a
 * custom domain as live, because nothing in this repository issues a certificate.
 */
export interface DomainBinding {
  readonly domainBindingId: string;
  readonly siteId: string;
  readonly hostname: string;
  readonly verificationMethod: "DNS_TXT" | "CNAME";
  readonly dnsRecords: readonly { readonly type: string; readonly name: string; readonly value: string }[];
  readonly verificationState: DomainVerificationState;
  readonly tlsState: TlsState;
  readonly activatedAt: string | null;
  readonly detachedAt: string | null;
}

/** One entry as the archive declares it, before anything is written. */
export interface ArchiveEntry {
  readonly path: string;
  readonly type: "file" | "directory" | "symlink" | "hardlink" | "other";
  /** Bytes after decompression, as the archive header claims. */
  readonly declaredSize: number;
  readonly compressedSize: number;
}

export interface ArchiveLimits {
  readonly maxFileCount: number;
  readonly maxTotalBytes: number;
  readonly maxSingleFileBytes: number;
  /** Refuse above this decompressed:compressed ratio. A zip bomb's whole trick is this number. */
  readonly maxCompressionRatio: number;
}

export const DEFAULT_ARCHIVE_LIMITS: ArchiveLimits = Object.freeze({
  maxFileCount: 2_000,
  maxTotalBytes: 50 * 1024 * 1024,
  maxSingleFileBytes: 10 * 1024 * 1024,
  maxCompressionRatio: 100,
});

export interface ArchiveRefusal {
  readonly code: string;
  readonly path: string | null;
  readonly detail: string;
}

export type ArchiveVerdict =
  | { readonly ok: true; readonly files: readonly ArchiveEntry[]; readonly totalBytes: number; readonly entrypoint: string }
  | { readonly ok: false; readonly refusals: readonly ArchiveRefusal[] };

/**
 * Files whose presence in a published site is almost always an accident.
 *
 * Matched by name, at any depth. The list is short on purpose: it names the things that leak a
 * credential or a history, not everything that is merely untidy. A validator that refused every
 * unfamiliar dotfile would be one people learn to work around.
 */
const SECRET_NAMES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".git",
  ".npmrc",
  ".netrc",
  "id_rsa",
  "id_ed25519",
  ".aws",
  "credentials",
  ".ssh",
]);

/** Extensions that mean "something wants to execute on the server". A static host runs nothing. */
const EXECUTABLE_EXTENSIONS = new Set([
  ".php", ".jsp", ".asp", ".aspx", ".cgi", ".pl", ".py", ".rb", ".sh", ".exe", ".dll", ".so", ".wasm",
]);

const EXTENSION_MIME: Readonly<Record<string, string>> = Object.freeze({
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".xml": "application/xml",
  ".webmanifest": "application/manifest+json",
});

function extensionOf(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  return dot > slash ? path.slice(dot).toLowerCase() : "";
}

function basename(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

/**
 * Judge an archive listing.
 *
 * Collects EVERY refusal rather than returning the first. A caller fixing a rejected upload one
 * message at a time will do it four times; a caller shown all four fixes it once.
 */
export function validateArchive(
  entries: readonly ArchiveEntry[],
  limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS,
): ArchiveVerdict {
  const refusals: ArchiveRefusal[] = [];
  const files: ArchiveEntry[] = [];
  let totalBytes = 0;

  if (entries.length === 0) {
    return { ok: false, refusals: [{ code: "ARCHIVE_EMPTY", path: null, detail: "the archive contains no entries" }] };
  }
  if (entries.length > limits.maxFileCount) {
    refusals.push({
      code: "ARCHIVE_TOO_MANY_FILES",
      path: null,
      detail: `${entries.length} entries exceeds the limit of ${limits.maxFileCount}`,
    });
  }

  for (const entry of entries) {
    const path = entry.path;

    // Links are refused by TYPE, never by target. A link pointing inside the tree today is a link
    // whose target can be changed after the check.
    if (entry.type === "symlink" || entry.type === "hardlink") {
      refusals.push({
        code: entry.type === "symlink" ? "ARCHIVE_SYMLINK" : "ARCHIVE_HARDLINK",
        path,
        detail: "links are refused by type, not by where they point: a target inside the tree today can move tomorrow",
      });
      continue;
    }
    if (entry.type === "other") {
      refusals.push({ code: "ARCHIVE_ENTRY_TYPE", path, detail: "only regular files and directories may be published" });
      continue;
    }

    if (path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) {
      refusals.push({ code: "ARCHIVE_ABSOLUTE_PATH", path, detail: "an absolute path writes outside the release" });
      continue;
    }
    if (path.split(/[\\/]/).some((seg) => seg === "..")) {
      refusals.push({ code: "ARCHIVE_PATH_TRAVERSAL", path, detail: "`..` escapes the release directory" });
      continue;
    }
    if (path.includes("\0")) {
      refusals.push({ code: "ARCHIVE_PATH_NUL", path, detail: "a NUL byte truncates a path in some consumers and not others" });
      continue;
    }

    if (entry.type === "directory") continue;

    const name = basename(path);
    if (SECRET_NAMES.has(name) || path.split("/").some((seg) => SECRET_NAMES.has(seg))) {
      refusals.push({ code: "ARCHIVE_SECRET_FILE", path, detail: `${name} is a credential or history file and is never published` });
      continue;
    }

    const ext = extensionOf(path);
    if (EXECUTABLE_EXTENSIONS.has(ext)) {
      refusals.push({ code: "ARCHIVE_EXECUTABLE", path, detail: `${ext} implies server-side execution; this host executes nothing` });
      continue;
    }
    if (ext !== "" && !Object.prototype.hasOwnProperty.call(EXTENSION_MIME, ext)) {
      refusals.push({
        code: "ARCHIVE_MIME_UNSUPPORTED",
        path,
        detail: `${ext} has no media type this host will serve; an unknown type would be served by a sniffer's guess`,
      });
      continue;
    }

    if (entry.declaredSize > limits.maxSingleFileBytes) {
      refusals.push({
        code: "ARCHIVE_FILE_TOO_LARGE",
        path,
        detail: `${entry.declaredSize} bytes exceeds the per-file limit of ${limits.maxSingleFileBytes}`,
      });
      continue;
    }
    // The bomb check is per-entry, because one entry is all it takes. A 10 GB file that compresses to
    // 40 KB has a ratio in the hundreds of thousands and passes every size check on the way in.
    if (entry.compressedSize > 0 && entry.declaredSize / entry.compressedSize > limits.maxCompressionRatio) {
      refusals.push({
        code: "ARCHIVE_DECOMPRESSION_BOMB",
        path,
        detail:
          `expands ${Math.round(entry.declaredSize / entry.compressedSize)}:1, above the limit of ` +
          `${limits.maxCompressionRatio}:1`,
      });
      continue;
    }

    totalBytes += entry.declaredSize;
    files.push(entry);
  }

  if (totalBytes > limits.maxTotalBytes) {
    refusals.push({
      code: "ARCHIVE_TOO_LARGE",
      path: null,
      detail: `${totalBytes} bytes decompressed exceeds the limit of ${limits.maxTotalBytes}`,
    });
  }

  const entrypoint = files.find((f) => f.path === "index.html")?.path ?? files.find((f) => basename(f.path) === "index.html")?.path;
  if (!entrypoint) {
    refusals.push({
      code: "ARCHIVE_NO_ENTRYPOINT",
      path: null,
      detail: "no index.html: a site with no entry point has no page to serve at its root",
    });
  }

  if (refusals.length > 0) return { ok: false, refusals };
  return { ok: true, files, totalBytes, entrypoint: entrypoint as string };
}

/** The media type this host will serve a published path as. Never sniffed. */
export function serveMimeFor(path: string): string | null {
  return EXTENSION_MIME[extensionOf(path)] ?? null;
}

/**
 * The headers a published file is served with.
 *
 * `nosniff` is the load-bearing one: it is what makes the extension-to-type table above the decision
 * rather than an opinion the browser may overrule. The CSP forbids scripts and framing outright,
 * because the artifacts this platform publishes are documents — a battle card, a report, a table —
 * and a document that needs to execute is a document that has been tampered with.
 */
export function publishedHeadersFor(path: string, contentHash: Hex): Readonly<Record<string, string>> {
  const mime = serveMimeFor(path) ?? "application/octet-stream";
  return Object.freeze({
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "content-disposition": mime === "text/html" ? "inline" : `inline; filename="${basename(path).replace(/"/g, "")}"`,
    // Hashed content is immutable by construction, so it may be cached forever. The pointer that
    // decides WHICH hash is current is not cached, which is what makes activation take effect.
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${contentHash.slice(2, 34)}"`,
    "referrer-policy": "no-referrer",
  });
}

/** The manifest hash a release commits to: every path with the hash of its bytes, in sorted order. */
export function manifestHashOf(files: readonly { readonly path: string; readonly contentHash: Hex }[]): Hex {
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const body = sorted.map((f) => `${f.path} ${f.contentHash}`).join("\n");
  return contentHashOf(new TextEncoder().encode(body));
}

/**
 * Activate a release.
 *
 * Returns the new site row rather than mutating one, so the caller writes a single UPDATE and the
 * change is atomic at the database rather than at the application. Refuses a release that is not
 * READY: activating one that failed validation would publish files nothing checked.
 */
export function activate(site: Site, release: SiteRelease, nowIso: string): { site: Site; release: SiteRelease } {
  if (release.siteId !== site.siteId) {
    throw new Error(`release ${release.releaseId} belongs to site ${release.siteId}, not ${site.siteId}`);
  }
  if (release.status !== "READY" && release.status !== "SUPERSEDED") {
    throw new Error(`release ${release.releaseId} is ${release.status}; only a validated release may be activated`);
  }
  return {
    site: { ...site, activeReleaseId: release.releaseId },
    release: { ...release, status: "ACTIVE", activatedAt: release.activatedAt ?? nowIso },
  };
}

/**
 * Roll back to a previous release.
 *
 * Identical to activation, and that is the design: the previous release's files were never deleted,
 * so returning to it moves a pointer. A rollback that required re-uploading would be a rollback
 * nobody could perform during the incident that needed it.
 */
export function rollback(site: Site, previous: SiteRelease, nowIso: string): { site: Site; release: SiteRelease } {
  return activate(site, { ...previous, status: "READY" }, nowIso);
}

/** Media types an artifact may be, restated here so a site upload and an artifact write agree. */
export function isPublishableArtifactMime(mimeType: string): boolean {
  return isSupportedMime(mimeType) && Object.prototype.hasOwnProperty.call(SUPPORTED_MIME_TYPES, mimeType);
}
