/**
 * Decision evidence V2 — what a decision has to record to still be checkable in a year.
 *
 * WHAT V1 RECORDED, AND WHY IT WAS NOT ENOUGH
 *
 * A decision receipt named `policyId`, `policyVersion`, `intentHash` and a timestamp. Every one of
 * those is a POINTER. `policyId` points at a row that can be updated; `policyVersion` is a number on
 * that row; and neither says what the rules were when the decision was taken or what code read them.
 *
 * Three failures follow, and all three have already happened here:
 *
 *   • Two decisions under one anchored `policyHash` produced opposite verdicts, because the evaluator
 *     changed between them. Nothing in either record distinguished them.
 *   • A policy row updated after a decision silently rewrites what that decision appears to have been
 *     judged against, because the decision only points at the row.
 *   • A quote could not be tied to the decision that authorised it, so an approval and the thing it
 *     approved were connected only by timing.
 *
 * V2 replaces every pointer with a CONTENT HASH, and stores the content beside it.
 *
 * WHY THE ON-CHAIN SHAPE DOES NOT CHANGE
 *
 * `UntchReceipts` has a fixed struct and receipts are already anchored under it. V2 lives entirely in
 * the off-chain evidence row and in the `metadataHash` the existing struct already carries — so old
 * receipts stay verifiable, the contract is untouched, and the commitment gets stronger.
 */

import { hashCanonicalJson } from "@untch/canon";
import { keccak256, toHex, type Hex } from "viem";
import type { Pool } from "./db";

/** The evidence schema a decision was written under. Bumped when the canonical object changes. */
export const METADATA_SCHEMA_VERSION_V2 = 2 as const;
export type MetadataSchemaVersion = 1 | 2;

/**
 * The public reference to an account.
 *
 * A receipt is public and an `accountId` is a durable identifier that appears across every one of an
 * account's receipts. Publishing it would let anyone group a stranger's entire spending history from
 * public data alone, which is a disclosure nobody asked for and the receipt does not need to make.
 *
 * Domain-separated so this hash cannot collide with, or be replayed as, any other hash in the system:
 * a bare `keccak256(accountId)` would be computable by anyone holding an id from any other context.
 */
export const ACCOUNT_REFERENCE_DOMAIN = "untch-account-reference-v1" as const;

export function accountRefHash(accountId: string): Hex {
  return keccak256(toHex(`${ACCOUNT_REFERENCE_DOMAIN}||${accountId}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// The quote digest
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exact terms a decision is about.
 *
 * Every field here changes what is being agreed to, so every field is in the digest. `version` and
 * `lineage` are what make supersession expressible: a re-quote of the same logical work shares the
 * lineage and increments the version, so "this approval was for an earlier version of this order" is
 * a fact the data can state rather than an inference from two timestamps.
 *
 * `nonce` is included even though it makes two otherwise-identical quotes distinct. That is the
 * point: it is what stops an approval for one request being replayed against a second request that
 * happens to have the same terms.
 */
export interface CanonicalQuoteTerms {
  /** The order or logical work request this quote belongs to. Stable across re-quotes. */
  readonly lineage: string;
  /** Increments on each re-quote of the same lineage. */
  readonly version: number;
  /** Display units, as a decimal string. Never a float. */
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly provider: string;
  readonly capability: string;
  readonly recipient: string | null;
  readonly paramsHash: Hex;
  readonly acceptanceHash: Hex | null;
  readonly expiry: string;
  readonly nonce: string;
}

/**
 * The digest, computed from the terms and from nothing else.
 *
 * `hashCanonicalJson` is the repository's RFC 8785 canonicaliser — the same one the policy hash and
 * the intent hash use. A second serialiser here would mean two answers for "what did this commit
 * to", and the V1 metadata hash already showed what that costs: it used `JSON.stringify`, whose
 * output depends on key insertion order, so the same logical object could hash two ways.
 */
export function quoteDigestOf(terms: CanonicalQuoteTerms): Hex {
  return hashCanonicalJson(terms as unknown as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// The policy snapshot
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The complete policy state at the moment of evaluation.
 *
 * Enough to REPRODUCE the decision, which is a higher bar than enough to describe it. `activeAtEval`
 * and `expiryAtEval` are recorded as observed rather than re-derived, because a policy that has since
 * expired must not make a decision taken while it was live look like it was taken against a dead one.
 *
 * `defaultForAccount` is here because "this was the account's default at the time" is load-bearing
 * for an automatic approval: it is the answer to "who chose these limits", and the account's default
 * pointer is mutable.
 */
export interface PolicySnapshot {
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly owner: string;
  readonly governedAgent: string;
  readonly chainId: number;
  readonly registry: string;
  readonly currency: string;
  readonly rules: Record<string, unknown>;
  readonly version: number;
  readonly expiryAtEval: string;
  readonly statusAtEval: string;
  readonly activeAtEval: boolean;
  readonly defaultForAccount: boolean;
  /** When this state was read from the store. Distinct from the decision timestamp. */
  readonly observedAt: string;
}

export function policySnapshotHashOf(snapshot: PolicySnapshot): Hex {
  return hashCanonicalJson(snapshot as unknown as Record<string, unknown>);
}

// ─────────────────────────────────────────────────────────────────────────────
// The evidence row
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How complete a stored decision's evidence is.
 *
 * `LEGACY_PARTIAL` exists so a backfill never has to invent a value to make an old row look whole. A
 * decision taken before quote digests existed has no quote digest, and writing a plausible one would
 * turn an honest gap into a false record — which is worse than the gap, because the gap is visible.
 */
export type EvidenceCompleteness = "V2_COMPLETE" | "LEGACY_PARTIAL";

export interface DecisionEvidenceV2 {
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  /** Private. Never rendered in a public projection. */
  readonly accountId: string;
  /** Public. The domain-separated reference a verifier may show. */
  readonly accountRefHash: Hex;
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly policySnapshotHash: Hex;
  readonly quoteDigest: Hex;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly decision: string;
  readonly ruleTrace: readonly Record<string, unknown>[];
  readonly evaluatedAt: string;
  readonly metadataSchemaVersion: MetadataSchemaVersion;
  readonly completeness: EvidenceCompleteness;
}

/** The V2 commitment object, in the exact field set the schema promises. */
export interface MetadataV2 {
  readonly metadataSchemaVersion: 2;
  readonly accountRefHash: Hex;
  readonly quoteDigest: Hex;
  readonly policySnapshotHash: Hex;
  readonly policyHash: Hex;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly intentHash: Hex;
  readonly decision: string;
  readonly evaluatedAt: string;
}

export function metadataV2Of(e: {
  readonly accountRefHash: Hex;
  readonly quoteDigest: Hex;
  readonly policySnapshotHash: Hex;
  readonly policyHash: Hex;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly intentHash: Hex;
  readonly decision: string;
  readonly evaluatedAt: string;
}): MetadataV2 {
  return {
    metadataSchemaVersion: METADATA_SCHEMA_VERSION_V2,
    accountRefHash: e.accountRefHash,
    quoteDigest: e.quoteDigest,
    policySnapshotHash: e.policySnapshotHash,
    policyHash: e.policyHash,
    engineVersion: e.engineVersion,
    ruleManifestHash: e.ruleManifestHash,
    intentHash: e.intentHash,
    decision: e.decision,
    evaluatedAt: e.evaluatedAt,
  };
}

/**
 * The V2 metadata commitment.
 *
 * Uses `hashCanonicalJson`, not the V1 `keccak256(JSON.stringify(...))`. That is not a second
 * serialiser: it is the repository's canonical one, which the policy hash and intent hash already
 * use. V1's dependence on key insertion order is the defect being left behind, and V1 keeps its own
 * algorithm because changing it would un-verify every receipt already anchored.
 */
export function metadataHashV2(metadata: MetadataV2): Hex {
  return hashCanonicalJson(metadata as unknown as Record<string, unknown>);
}

/**
 * Verify a receipt's metadata commitment under whichever schema wrote it.
 *
 * Both versions are supported permanently. A V1 receipt is not upgraded, re-committed or migrated:
 * it was anchored under V1 and the only honest thing to do with it is check it under V1.
 */
export function verifyMetadataCommitment(args: {
  readonly committed: Hex;
  readonly version: MetadataSchemaVersion;
  readonly v2?: MetadataV2;
  /** The exact object V1 hashed, supplied by the caller that still holds it. */
  readonly v1Object?: unknown;
  readonly v1Hash?: (value: unknown) => Hex;
}): { readonly ok: boolean; readonly reason: string | null } {
  if (args.version === 2) {
    if (!args.v2) return { ok: false, reason: "a V2 commitment needs the V2 evidence object" };
    const recomputed = metadataHashV2(args.v2);
    return recomputed.toLowerCase() === args.committed.toLowerCase()
      ? { ok: true, reason: null }
      : { ok: false, reason: `recomputed ${recomputed} does not equal committed ${args.committed}` };
  }
  if (!args.v1Object || !args.v1Hash) {
    return { ok: false, reason: "a V1 commitment needs the V1 object and the V1 hash function" };
  }
  const recomputed = args.v1Hash(args.v1Object);
  return recomputed.toLowerCase() === args.committed.toLowerCase()
    ? { ok: true, reason: null }
    : { ok: false, reason: `recomputed ${recomputed} does not equal committed ${args.committed}` };
}

// ─────────────────────────────────────────────────────────────────────────────
// The invariant
// ─────────────────────────────────────────────────────────────────────────────

export class IncompleteEvidenceError extends Error {
  constructor(
    public readonly missing: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "IncompleteEvidenceError";
  }
}

/**
 * Refuse to persist a V2 decision that is not V2.
 *
 * Enforced here AND by a database CHECK. The duplicate is deliberate: the store guard produces a
 * usable error at the call site, and the constraint holds for anything that reaches the table by
 * another path. A rule that lives only in application code is a rule a migration script can bypass.
 */
export function assertCompleteV2(e: Partial<DecisionEvidenceV2>): asserts e is DecisionEvidenceV2 {
  const required: (keyof DecisionEvidenceV2)[] = [
    "decisionId",
    "intentId",
    "intentHash",
    "accountId",
    "accountRefHash",
    "policyId",
    "policyHash",
    "policySnapshotHash",
    "quoteDigest",
    "engineVersion",
    "ruleManifestHash",
    "decision",
    "evaluatedAt",
  ];
  const missing = required.filter((k) => e[k] === undefined || e[k] === null || e[k] === "");
  if (e.metadataSchemaVersion !== METADATA_SCHEMA_VERSION_V2) missing.push("metadataSchemaVersion");
  if (missing.length > 0) {
    throw new IncompleteEvidenceError(
      missing,
      `a V2 decision cannot be persisted without ${missing.join(", ")}. An incomplete V2 row would be ` +
        "indistinguishable from a complete one to every later reader, so it is refused rather than stored.",
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

export interface DecisionEvidenceStore {
  /** Write the snapshot if this exact content has not been seen. Returns its hash either way. */
  putPolicySnapshot(snapshot: PolicySnapshot): Promise<Hex>;
  getPolicySnapshot(hash: Hex): Promise<PolicySnapshot | null>;
  putDecision(evidence: DecisionEvidenceV2): Promise<void>;
  getDecision(decisionId: string): Promise<DecisionEvidenceV2 | null>;
  decisionsForQuote(quoteDigest: Hex): Promise<readonly DecisionEvidenceV2[]>;
}

interface SnapshotRow {
  snapshot_hash: string;
  snapshot: PolicySnapshot;
}

interface DecisionRow {
  decision_id: string;
  intent_id: string;
  intent_hash: string;
  account_id: string | null;
  account_ref_hash: string | null;
  policy_id: string;
  policy_hash: string | null;
  policy_snapshot_hash: string | null;
  quote_digest: string | null;
  engine_version: string | null;
  rule_manifest_hash: string | null;
  decision: string;
  rule_trace: Record<string, unknown>[];
  evaluated_at: Date;
  metadata_schema_version: number;
  completeness: EvidenceCompleteness;
}

function toEvidence(row: DecisionRow): DecisionEvidenceV2 {
  return {
    decisionId: row.decision_id,
    intentId: row.intent_id,
    intentHash: row.intent_hash as Hex,
    accountId: row.account_id ?? "",
    accountRefHash: (row.account_ref_hash ?? "") as Hex,
    policyId: row.policy_id,
    policyHash: (row.policy_hash ?? "") as Hex,
    policySnapshotHash: (row.policy_snapshot_hash ?? "") as Hex,
    quoteDigest: (row.quote_digest ?? "") as Hex,
    engineVersion: row.engine_version ?? "",
    ruleManifestHash: (row.rule_manifest_hash ?? "") as Hex,
    decision: row.decision,
    ruleTrace: row.rule_trace ?? [],
    evaluatedAt: row.evaluated_at.toISOString(),
    metadataSchemaVersion: row.metadata_schema_version as MetadataSchemaVersion,
    completeness: row.completeness,
  };
}

export class PgDecisionEvidenceStore implements DecisionEvidenceStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Content-addressed insert.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert, because the table is append-only and an upsert on
   * a content-addressed key is a contradiction: if the key matches, the content matches, so there is
   * nothing to update. The trigger would refuse anyway; this makes the common case not attempt it.
   */
  async putPolicySnapshot(snapshot: PolicySnapshot): Promise<Hex> {
    const hash = policySnapshotHashOf(snapshot);
    await this.pool.query(
      `INSERT INTO untch_policy_snapshots (snapshot_hash, policy_id, policy_hash, owner, chain_id, snapshot)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (snapshot_hash) DO NOTHING`,
      [hash, snapshot.policyId, snapshot.policyHash, snapshot.owner, snapshot.chainId, JSON.stringify(snapshot)],
    );
    return hash;
  }

  async getPolicySnapshot(hash: Hex): Promise<PolicySnapshot | null> {
    const { rows } = await this.pool.query<SnapshotRow>(
      "SELECT snapshot_hash, snapshot FROM untch_policy_snapshots WHERE snapshot_hash = $1",
      [hash],
    );
    return rows[0]?.snapshot ?? null;
  }

  /**
   * Write a decision, refusing an incomplete V2 before the database has to.
   *
   * `assertCompleteV2` runs first so the caller gets a message naming the missing fields. The CHECK
   * constraint is still there and still fires for anything that reaches the table another way.
   */
  async putDecision(evidence: DecisionEvidenceV2): Promise<void> {
    if (evidence.metadataSchemaVersion === METADATA_SCHEMA_VERSION_V2) assertCompleteV2(evidence);
    await this.pool.query(
      `INSERT INTO untch_decision_evidence
         (decision_id, intent_id, intent_hash, account_id, account_ref_hash, policy_id, policy_hash,
          policy_snapshot_hash, quote_digest, engine_version, rule_manifest_hash, decision, rule_trace,
          evaluated_at, metadata_schema_version, completeness)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (decision_id) DO NOTHING`,
      [
        evidence.decisionId,
        evidence.intentId,
        evidence.intentHash,
        evidence.accountId || null,
        evidence.accountRefHash || null,
        evidence.policyId,
        evidence.policyHash || null,
        evidence.policySnapshotHash || null,
        evidence.quoteDigest || null,
        evidence.engineVersion || null,
        evidence.ruleManifestHash || null,
        evidence.decision,
        JSON.stringify(evidence.ruleTrace),
        evidence.evaluatedAt,
        evidence.metadataSchemaVersion,
        evidence.completeness,
      ],
    );
  }

  async getDecision(decisionId: string): Promise<DecisionEvidenceV2 | null> {
    const { rows } = await this.pool.query<DecisionRow>(
      "SELECT * FROM untch_decision_evidence WHERE decision_id = $1",
      [decisionId],
    );
    return rows[0] ? toEvidence(rows[0]) : null;
  }

  async decisionsForQuote(quoteDigest: Hex): Promise<readonly DecisionEvidenceV2[]> {
    const { rows } = await this.pool.query<DecisionRow>(
      "SELECT * FROM untch_decision_evidence WHERE quote_digest = $1 ORDER BY evaluated_at DESC",
      [quoteDigest],
    );
    return rows.map(toEvidence);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Projections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What anybody may see.
 *
 * Built by NAMING publishable fields. `accountId` is absent by construction rather than deleted, so
 * adding a field to the evidence row cannot leak it here by default — the failure mode of a deny-list
 * is silence.
 */
export function publicDecisionProjection(e: DecisionEvidenceV2): Record<string, unknown> {
  return {
    decisionId: e.decisionId,
    intentHash: e.intentHash,
    accountRefHash: e.accountRefHash,
    policyId: e.policyId,
    policyHash: e.policyHash,
    policySnapshotHash: e.policySnapshotHash,
    quoteDigest: e.quoteDigest,
    engineVersion: e.engineVersion,
    ruleManifestHash: e.ruleManifestHash,
    decision: e.decision,
    evaluatedAt: e.evaluatedAt,
    metadataSchemaVersion: e.metadataSchemaVersion,
    completeness: e.completeness,
  };
}

/** The owner's view: everything above, plus the account this belongs to and the trace. */
export function privateDecisionProjection(e: DecisionEvidenceV2): Record<string, unknown> {
  return { ...publicDecisionProjection(e), accountId: e.accountId, intentId: e.intentId, ruleTrace: e.ruleTrace };
}
