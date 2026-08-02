/**
 * Untch-owned artifact storage: what a service produced, addressed by what it contains.
 *
 * WHY UNTCH STORES ITS OWN OUTPUT
 *
 * A paid service that hands a customer a link to somebody else's uploader has outsourced the one
 * thing the receipt commits to. The manifest hash covers content; if the content lives somewhere this
 * deployment cannot re-read, the hash proves a file existed once and nothing about the file the
 * customer will actually open.
 *
 * WHAT IMMUTABILITY MEANS HERE
 *
 * An `ArtifactVersion` is written once and never updated. Correcting an artifact means writing a NEW
 * version and moving the artifact's pointer — the same discipline the receipts use, for the same
 * reason: a corrected document and an edited one are different claims, and only one of them can be
 * audited afterwards.
 *
 * The content hash is computed from the BYTES BEING STORED, by this module, at write time. It is
 * never taken from the caller. A caller-supplied hash is a claim about a file, and the whole point of
 * the field is to be a fact about it.
 */

import { createHash } from "node:crypto";
import type { Hex } from "viem";

export type ArtifactVisibility = "PRIVATE" | "PUBLIC";
export type ArtifactStatus = "ACTIVE" | "EXPIRED" | "DELETED";

export interface Artifact {
  readonly artifactId: string;
  readonly accountId: string;
  readonly orderId: string | null;
  readonly type: string;
  readonly visibility: ArtifactVisibility;
  readonly currentVersionId: string | null;
  readonly createdAt: string;
  /** After this the bytes may be reclaimed. Null means retained until an operator says otherwise. */
  readonly retentionUntil: string | null;
  readonly status: ArtifactStatus;
}

export interface ArtifactVersion {
  readonly versionId: string;
  readonly artifactId: string;
  readonly contentHash: Hex;
  readonly sizeBytes: number;
  readonly mimeType: string;
  readonly storageKey: string;
  /** The work node that produced it, when one did. Null for an upload. */
  readonly sourceNodeId: string | null;
  readonly createdAt: string;
}

/**
 * The media types this platform will store and serve.
 *
 * An allow-list, not a deny-list. The failure mode of a deny-list on a route that serves user content
 * is that a type nobody thought about is served with whatever the sniffer decides, and the sniffer's
 * decision on ambiguous bytes is how a stored file becomes an executed one.
 *
 * PDF is absent, and its absence is the point: this deployment has no PDF renderer, so a service that
 * promised one would be promising a file nothing here can create.
 */
export const SUPPORTED_MIME_TYPES: Readonly<Record<string, string>> = Object.freeze({
  "text/html": "html",
  "text/csv": "csv",
  "application/json": "json",
  "text/markdown": "md",
  "image/svg+xml": "svg",
  "image/png": "png",
  "application/zip": "zip",
});

export function isSupportedMime(mimeType: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_MIME_TYPES, mimeType.split(";")[0]?.trim() ?? "");
}

/** Content hash, computed from the bytes, always. `0x`-prefixed so it reads like every other hash here. */
export function contentHashOf(bytes: Uint8Array): Hex {
  return `0x${createHash("sha256").update(bytes).digest("hex")}` as Hex;
}

export class ArtifactError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}

/**
 * Where bytes live.
 *
 * Two implementations are expected — an in-process one for tests and a real object store for
 * production — and the interface is deliberately small enough that the second cannot acquire
 * behaviour the first does not have. `put` is content-addressed and idempotent: writing identical
 * bytes twice is one object, which is what makes a retried node cheap rather than duplicative.
 */
export interface ArtifactStorage {
  put(key: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** A short-lived URL for a caller to fetch directly, when the backend offers one. Null otherwise. */
  signedUrl?(key: string, ttlSeconds: number): Promise<string | null>;
}

/** The test and local-development adapter. Holds bytes in a Map; loses them on restart, as it should. */
export class InMemoryArtifactStorage implements ArtifactStorage {
  private readonly objects = new Map<string, { bytes: Uint8Array; mimeType: string }>();

  async put(key: string, bytes: Uint8Array, mimeType: string): Promise<void> {
    this.objects.set(key, { bytes, mimeType });
  }

  async get(key: string): Promise<Uint8Array | null> {
    return this.objects.get(key)?.bytes ?? null;
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }

  get size(): number {
    return this.objects.size;
  }
}

/**
 * The storage key.
 *
 * Content-addressed under the account, so the same bytes written twice occupy one object and two
 * accounts holding identical files do not share one. The account prefix is what makes deleting an
 * account's data a prefix operation rather than a query.
 */
export function storageKeyFor(accountId: string, contentHash: Hex, mimeType: string): string {
  const ext = SUPPORTED_MIME_TYPES[mimeType.split(";")[0]?.trim() ?? ""] ?? "bin";
  return `${accountId}/${contentHash.slice(2, 6)}/${contentHash.slice(2)}.${ext}`;
}

export interface WriteArtifactVersionInput {
  readonly artifactId: string;
  readonly accountId: string;
  readonly versionId: string;
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly sourceNodeId: string | null;
  readonly createdAt: string;
}

/**
 * Write one immutable version and return the row that describes it.
 *
 * Refuses an unsupported media type rather than storing it with a fallback, and refuses empty
 * content: a zero-byte artifact satisfies "a file was produced" while satisfying nothing a customer
 * wanted, and it is exactly what an over-eager renderer emits when it fails quietly.
 */
export async function writeArtifactVersion(
  storage: ArtifactStorage,
  input: WriteArtifactVersionInput,
): Promise<ArtifactVersion> {
  const mimeType = input.mimeType.split(";")[0]?.trim() ?? "";
  if (!isSupportedMime(mimeType)) {
    throw new ArtifactError(
      "ARTIFACT_MIME_UNSUPPORTED",
      `${mimeType} is not a media type this platform stores. Supported: ${Object.keys(SUPPORTED_MIME_TYPES).join(", ")}`,
    );
  }
  if (input.bytes.byteLength === 0) {
    throw new ArtifactError(
      "ARTIFACT_EMPTY",
      "an artifact with no bytes is not a deliverable; a renderer that produced nothing must fail rather than store nothing",
    );
  }

  const contentHash = contentHashOf(input.bytes);
  const storageKey = storageKeyFor(input.accountId, contentHash, mimeType);
  await storage.put(storageKey, input.bytes, mimeType);

  return {
    versionId: input.versionId,
    artifactId: input.artifactId,
    contentHash,
    sizeBytes: input.bytes.byteLength,
    mimeType,
    storageKey,
    sourceNodeId: input.sourceNodeId,
    createdAt: input.createdAt,
  };
}

/**
 * Read bytes back and prove they are the ones the version committed to.
 *
 * The re-hash is not paranoia about the storage backend; it is what makes the content hash load
 * bearing at READ time as well as at write time. Without it the hash is a value in a row that nothing
 * ever checks, and a silently truncated object serves as a valid artifact.
 */
export async function readArtifactVersion(
  storage: ArtifactStorage,
  version: ArtifactVersion,
): Promise<Uint8Array> {
  const bytes = await storage.get(version.storageKey);
  if (bytes === null) {
    throw new ArtifactError("ARTIFACT_BYTES_MISSING", `no object at ${version.storageKey} for version ${version.versionId}`);
  }
  const actual = contentHashOf(bytes);
  if (actual !== version.contentHash) {
    throw new ArtifactError(
      "ARTIFACT_HASH_MISMATCH",
      `object at ${version.storageKey} hashes to ${actual}, but version ${version.versionId} committed to ${version.contentHash}`,
    );
  }
  return bytes;
}

/**
 * May this caller read this artifact?
 *
 * Public artifacts are readable by anyone; private ones only by their account. Deleted and expired
 * artifacts are readable by nobody, including their owner — the retention promise is what makes the
 * deletion policy mean something, and an owner-only exception would quietly make it optional.
 */
export function mayRead(artifact: Artifact, accountId: string | null): boolean {
  if (artifact.status !== "ACTIVE") return false;
  if (artifact.visibility === "PUBLIC") return true;
  return accountId !== null && accountId === artifact.accountId;
}
