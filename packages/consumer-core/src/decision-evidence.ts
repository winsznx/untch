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
import type { Hex } from "viem";
import type { Pool } from "./db";
import {
  ACCOUNT_REFERENCE_DOMAIN,
  LEGACY_AGENT_ID_SEMANTICS_V3,
  LEGACY_ZERO_AGENT_ID_BYTES32,
  METADATA_SCHEMA_VERSION_V3,
  POLICY_SELECTION_SEMANTICS,
  RequesterEvidenceError,
  UNTCH_ACCOUNT_NAMESPACE,
  accountRefHash,
  assertRequesterEvidenceV3,
  commitmentInputOf,
  requesterCommitment,
  type PolicySelectionSemantics,
  type RequesterEvidenceV3,
} from "./requester-principal";

/** The evidence schema a decision was written under. Bumped when the canonical object changes. */
export const METADATA_SCHEMA_VERSION_V2 = 2 as const;
/**
 * V3 adds the requester principal — see `./requester-principal` and
 * docs/adr/ADR-replace-legacy-buyerAgentId-with-requester-principal.md.
 *
 * It is a NEW version rather than a widening of V2 because a V2 row genuinely does not say who asked,
 * and a reader that treated a V2 row as a V3 row with absent requester fields would be inventing the
 * one fact V3 exists to record. V1 and V2 are not reinterpreted here or anywhere else.
 */
export type MetadataSchemaVersion = 1 | 2 | 3;

/**
 * The public reference to an account, defined in `./requester-principal` and re-exported here.
 *
 * It was declared in this file until V3. The V3 requester commitment is built FROM it and evidence is
 * built from the requester commitment, so leaving the declaration here would have made the two modules
 * import each other. The export path is unchanged for every existing caller.
 */
export { ACCOUNT_REFERENCE_DOMAIN, accountRefHash };

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

/**
 * The V3 quote terms — the same obligation, plus WHO it obliges.
 *
 * WHY THE REQUESTER BELONGS IN THE QUOTE DIGEST AND NOT BESIDE IT
 *
 * The digest is what an approval commits to. Without the requester inside it, two accounts asking for
 * the same work, at the same price, from the same provider, on the same policy ruleset, produce the
 * same digest — so an approval one of them obtained would match the other's request exactly. The
 * digest would be doing its job perfectly and still authorise the wrong payer.
 *
 * `policyId` is here for the reason `policySelectionSemantics` exists: the on-chain hash commits the
 * RULESET and cannot distinguish two policies that share an owner and a ruleset. If the digest
 * committed only `policyHash`, an approval raised under one of them would satisfy a request under the
 * other, and the only place that difference is recorded would not be binding anything.
 *
 * A separate interface rather than optional members on `CanonicalQuoteTerms`, because a V2 digest must
 * keep hashing exactly what it hashed. Optional members that are sometimes present are how one record
 * acquires two digests.
 */
export interface CanonicalQuoteTermsV3 {
  /** Fixed at 3. In the hash, so a V2 and a V3 quote can never collide even with identical terms. */
  readonly quoteSchemaVersion: 3;
  readonly lineage: string;
  readonly version: number;

  // ── who is asking ────────────────────────────────────────────────────────
  readonly requesterPrincipalKind: string;
  readonly requesterPrincipalNamespace: string;
  readonly requesterPrincipalRef: string;
  readonly accountRefHash: Hex;
  readonly walletAuthorityRef: Hex;
  /** Present only for a verified marketplace request. `null` states there was none. */
  readonly marketplace: { readonly marketplace: string; readonly buyerAgentId: string; readonly marketplaceBindingId: string } | null;

  // ── who is being transacted with, and who does the work ──────────────────
  readonly sellerAspId: string;
  readonly workerAgentId: string;
  readonly serviceId: string;

  // ── what governs it ──────────────────────────────────────────────────────
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly policyOwner: string;
  readonly governedAgent: string;

  // ── the money ────────────────────────────────────────────────────────────
  readonly amount: string;
  readonly asset: string;
  readonly chain: string;
  readonly recipient: string | null;
  readonly provider: string;
  readonly capability: string;
  readonly paramsHash: Hex;
  readonly acceptanceHash: Hex | null;
  readonly expiry: string;
  readonly nonce: string;
}

export function quoteDigestOfV3(terms: CanonicalQuoteTermsV3): Hex {
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
}

/**
 * The hash covers the policy STATE, and deliberately not the moment it was read.
 *
 * The first version put `observedAt` inside the hashed content. That made every read of an unchanged
 * policy a distinct "state": three validation calls against one policy produced three different
 * snapshot hashes and would have written three rows, which defeats the content-addressing entirely
 * and contradicts the claim that one policy evaluated a hundred times writes one snapshot.
 *
 * When a state was observed belongs to the OBSERVATION, not to the state. The decision already
 * records `evaluatedAt`, and the snapshot row records `first_seen_at` — so nothing is lost, and a
 * policy that has not changed now hashes the same way every time it is read.
 */
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
export type EvidenceCompleteness = "V2_COMPLETE" | "V3_COMPLETE" | "LEGACY_PARTIAL";

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
  readonly v3?: MetadataV3;
  /** The exact object V1 hashed, supplied by the caller that still holds it. */
  readonly v1Object?: unknown;
  readonly v1Hash?: (value: unknown) => Hex;
}): { readonly ok: boolean; readonly reason: string | null } {
  if (args.version === 3) {
    if (!args.v3) return { ok: false, reason: "a V3 commitment needs the V3 evidence object" };
    const recomputed = metadataHashV3(args.v3);
    return recomputed.toLowerCase() === args.committed.toLowerCase()
      ? { ok: true, reason: null }
      : { ok: false, reason: `recomputed ${recomputed} does not equal committed ${args.committed}` };
  }
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
  /**
   * A read returns whatever schema the row was WRITTEN under.
   *
   * The union, not a widened V3 with nullable requester fields. A caller that has to branch on
   * `metadataSchemaVersion` cannot accidentally read `walletAuthorityRef` off a V2 row and get
   * `undefined` where it expected a commitment.
   */
  getDecision(decisionId: string): Promise<StoredDecisionEvidence | null>;
  decisionsForQuote(quoteDigest: Hex): Promise<readonly StoredDecisionEvidence[]>;
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

  // ── V3, all null on a V1 or V2 row ───────────────────────────────────────
  requester_principal_kind?: string | null;
  requester_principal_namespace?: string | null;
  requester_principal_ref?: string | null;
  wallet_authority_ref?: string | null;
  wallet_binding_id?: string | null;
  onchain_buyer_agent_id?: string | null;
  buyer_agent_id_semantics?: string | null;
  buyer_agent_id?: string | null;
  marketplace?: string | null;
  marketplace_binding_id?: string | null;
  seller_asp_id?: string | null;
  worker_agent_id?: string | null;
  service_id?: string | null;
  policy_owner?: string | null;
  governed_agent?: string | null;
  policy_selection_semantics?: string | null;
}

function toEvidence(row: DecisionRow): StoredDecisionEvidence {
  const base = {
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
  };

  if (row.metadata_schema_version !== 3) {
    return {
      ...base,
      metadataSchemaVersion: row.metadata_schema_version as MetadataSchemaVersion,
      completeness: row.completeness,
    };
  }

  return {
    ...base,
    requesterPrincipalKind: row.requester_principal_kind as RequesterEvidenceV3["requesterPrincipalKind"],
    requesterPrincipalNamespace: row.requester_principal_namespace ?? "",
    requesterPrincipalRef: row.requester_principal_ref ?? "",
    walletAuthorityRef: (row.wallet_authority_ref ?? "") as Hex,
    walletBindingId: row.wallet_binding_id ?? "",
    onchainBuyerAgentId: row.onchain_buyer_agent_id ?? "",
    buyerAgentIdSemantics: row.buyer_agent_id_semantics as RequesterEvidenceV3["buyerAgentIdSemantics"],
    buyerAgentId: row.buyer_agent_id ?? null,
    marketplace: row.marketplace ?? null,
    marketplaceBindingId: row.marketplace_binding_id ?? null,
    sellerAspId: row.seller_asp_id ?? "",
    workerAgentId: row.worker_agent_id ?? "",
    serviceId: row.service_id ?? "",
    policyOwner: row.policy_owner ?? "",
    governedAgent: row.governed_agent ?? "",
    policySelectionSemantics: (row.policy_selection_semantics ?? "") as PolicySelectionSemantics,
    metadataSchemaVersion: 3,
    completeness: "V3_COMPLETE",
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

  async getDecision(decisionId: string): Promise<StoredDecisionEvidence | null> {
    const { rows } = await this.pool.query<DecisionRow>(
      "SELECT * FROM untch_decision_evidence WHERE decision_id = $1",
      [decisionId],
    );
    return rows[0] ? toEvidence(rows[0]) : null;
  }

  async decisionsForQuote(quoteDigest: Hex): Promise<readonly StoredDecisionEvidence[]> {
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

// ─────────────────────────────────────────────────────────────────────────────
// The assembler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The one function that turns a served decision into V2 evidence.
 *
 * WHY IT COMPUTES THE HASHES RATHER THAN ACCEPTING THEM
 *
 * Every hash here is derived from content this function is handed. Accepting `quoteDigest` or
 * `policySnapshotHash` as parameters would let a caller pass a value computed from something else —
 * which is precisely the failure V2 exists to close, and it would be invisible because a hash is a
 * hash. The caller supplies the CONTENT; the commitment is this module's answer about it.
 *
 * WHY THERE IS EXACTLY ONE OF THESE
 *
 * A second assembler written for a demo would be a second definition of what a decision means, and
 * the demo would prove that definition rather than the product's. The paid route, the automatic path,
 * the escalation path, the blocked path and the operator validation all call this.
 */
export interface AssembleEvidenceInput {
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  readonly accountId: string;
  readonly policyId: string;
  readonly policyHash: Hex;
  /** The content, not its hash. */
  readonly snapshot: PolicySnapshot;
  /** The content, not its digest. */
  readonly quoteTerms: CanonicalQuoteTerms;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly decision: string;
  readonly ruleTrace: readonly Record<string, unknown>[];
  readonly evaluatedAt: string;
}

export interface AssembledEvidence {
  readonly evidence: DecisionEvidenceV2;
  readonly snapshot: PolicySnapshot;
  readonly metadata: MetadataV2;
  readonly metadataHash: Hex;
}

export function assembleDecisionEvidenceV2(input: AssembleEvidenceInput): AssembledEvidence {
  const policySnapshotHash = policySnapshotHashOf(input.snapshot);
  const quoteDigest = quoteDigestOf(input.quoteTerms);

  /**
   * The snapshot must be about the policy the decision names.
   *
   * A snapshot of a different policy would hash cleanly and commit to the wrong thing. Checked here
   * because this is the only place that sees both, and a mismatch is a programming error rather than
   * a user error — it fails loudly rather than being stored.
   */
  if (input.snapshot.policyId !== input.policyId) {
    throw new IncompleteEvidenceError(
      ["policySnapshot"],
      `the snapshot is of policy ${input.snapshot.policyId} but the decision names ${input.policyId}. ` +
        "A snapshot of a different policy would hash cleanly and commit to the wrong ruleset.",
    );
  }
  if (input.snapshot.policyHash.toLowerCase() !== input.policyHash.toLowerCase()) {
    throw new IncompleteEvidenceError(
      ["policySnapshot"],
      `the snapshot's policyHash ${input.snapshot.policyHash} does not equal the decision's ${input.policyHash}`,
    );
  }

  const evidence: DecisionEvidenceV2 = {
    decisionId: input.decisionId,
    intentId: input.intentId,
    intentHash: input.intentHash,
    accountId: input.accountId,
    accountRefHash: accountRefHash(input.accountId),
    policyId: input.policyId,
    policyHash: input.policyHash,
    policySnapshotHash,
    quoteDigest,
    engineVersion: input.engineVersion,
    ruleManifestHash: input.ruleManifestHash,
    decision: input.decision,
    ruleTrace: input.ruleTrace,
    evaluatedAt: input.evaluatedAt,
    metadataSchemaVersion: METADATA_SCHEMA_VERSION_V2,
    completeness: "V2_COMPLETE",
  };

  // Throws before anything is returned, so a caller cannot persist a half-assembled object.
  assertCompleteV2(evidence);

  const metadata = metadataV2Of(evidence);
  return { evidence, snapshot: input.snapshot, metadata, metadataHash: metadataHashV2(metadata) };
}

/**
 * Write the snapshot and the decision in ONE transaction, on a caller-supplied client.
 *
 * The client is a parameter rather than a pool so the same function serves two callers with opposite
 * intentions: the paid route commits, and the operator validation rolls back. A validation path with
 * its own writer would be validating a writer nobody uses.
 */
export interface EvidenceTx {
  query(sql: string, params?: readonly unknown[]): Promise<{ readonly rows: unknown[] }>;
}

export async function persistDecisionEvidenceV2(tx: EvidenceTx, assembled: AssembledEvidence): Promise<void> {
  const s = assembled.snapshot;
  await tx.query(
    `INSERT INTO untch_policy_snapshots (snapshot_hash, policy_id, policy_hash, owner, chain_id, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (snapshot_hash) DO NOTHING`,
    [assembled.evidence.policySnapshotHash, s.policyId, s.policyHash, s.owner, s.chainId, JSON.stringify(s)],
  );

  const e = assembled.evidence;
  await tx.query(
    `INSERT INTO untch_decision_evidence
       (decision_id, intent_id, intent_hash, account_id, account_ref_hash, policy_id, policy_hash,
        policy_snapshot_hash, quote_digest, engine_version, rule_manifest_hash, decision, rule_trace,
        evaluated_at, metadata_schema_version, completeness)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,2,'V2_COMPLETE')
     ON CONFLICT (decision_id) DO NOTHING`,
    [
      e.decisionId, e.intentId, e.intentHash, e.accountId, e.accountRefHash, e.policyId, e.policyHash,
      e.policySnapshotHash, e.quoteDigest, e.engineVersion, e.ruleManifestHash, e.decision,
      JSON.stringify(e.ruleTrace), e.evaluatedAt,
    ],
  );
}

/**
 * The projection report the deployment gate asks for.
 *
 * Two booleans rather than prose, because "no raw accountId" was previously reported as a sentence
 * and a sentence cannot be asserted on.
 */
export function projectionReport(e: DecisionEvidenceV2): {
  readonly publicProjection: Record<string, unknown>;
  readonly privateProjection: Record<string, unknown>;
  readonly rawAccountIdPresentInPublic: boolean;
  readonly accountRefHashPresentInPublic: boolean;
  readonly rawAccountIdPresentInPrivate: boolean;
} {
  const pub = publicDecisionProjection(e);
  const priv = privateDecisionProjection(e);
  // Checked against the SERIALISED form, not against key presence. A nested field carrying the id
  // would satisfy a key check and still publish it.
  const publicJson = JSON.stringify(pub);
  return {
    publicProjection: pub,
    privateProjection: priv,
    rawAccountIdPresentInPublic: publicJson.includes(e.accountId),
    accountRefHashPresentInPublic: publicJson.includes(e.accountRefHash),
    rawAccountIdPresentInPrivate: JSON.stringify(priv).includes(e.accountId),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// V3 — the same row, plus who asked
// ═════════════════════════════════════════════════════════════════════════════

/**
 * WHY THIS EXTENDS THE V2 ROW RATHER THAN OPENING A SECOND TABLE
 *
 * A decision is a decision. Two tables would mean two answers to "what decisions has this account
 * taken", two indexes to keep in step, and a join that a reporting query eventually forgets — and the
 * first V3-only report that quietly omits every V2 decision would look complete. So V3 is additive
 * columns on `untch_decision_evidence`, guarded by CHECK constraints that make an incomplete V3 row
 * impossible, and V1 and V2 rows stay exactly as they were written.
 *
 * Nothing is backfilled. A V2 row has no requester principal because it genuinely did not record one,
 * and inventing `untch_account` for it would be asserting a fact nobody established.
 */
export interface DecisionEvidenceV3 extends RequesterEvidenceV3 {
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  /** Private. Never rendered in a public projection. */
  readonly accountId: string;
  /** Private. The binding row, resolvable only in an authenticated view. */
  readonly walletBindingId: string;
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly policyOwner: string;
  readonly governedAgent: string;
  readonly policySnapshotHash: Hex;
  readonly policySelectionSemantics: PolicySelectionSemantics;
  readonly quoteDigest: Hex;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly decision: string;
  readonly ruleTrace: readonly Record<string, unknown>[];
  readonly evaluatedAt: string;
  readonly metadataSchemaVersion: 3;
  readonly completeness: "V3_COMPLETE";
}

/** Either shape, as it comes back from the one table. */
export type StoredDecisionEvidence = DecisionEvidenceV2 | DecisionEvidenceV3;

export function isV3Evidence(e: StoredDecisionEvidence): e is DecisionEvidenceV3 {
  return e.metadataSchemaVersion === 3;
}

/**
 * The V3 commitment object.
 *
 * Every field the spec requires a receipt to be un-tamperable in, and nothing that is merely nice to
 * have. `ruleTrace` is deliberately absent: it can be long, it is not needed to check that a decision
 * says what it said, and putting it in the commitment would make the commitment depend on a
 * formatting choice inside the engine.
 */
export interface MetadataV3 {
  readonly metadataSchemaVersion: 3;
  readonly requesterPrincipalKind: string;
  readonly requesterPrincipalNamespace: string;
  readonly requesterPrincipalRef: string;
  readonly accountRefHash: Hex;
  readonly walletAuthorityRef: Hex;
  readonly onchainBuyerAgentId: string;
  readonly buyerAgentIdSemantics: string;
  readonly sellerAspId: string;
  readonly workerAgentId: string;
  readonly serviceId: string;
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly policyOwner: string;
  readonly governedAgent: string;
  readonly policySnapshotHash: Hex;
  readonly policySelectionSemantics: string;
  readonly quoteDigest: Hex;
  readonly intentHash: Hex;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly decision: string;
  readonly evaluatedAt: string;
}

export function metadataV3Of(e: DecisionEvidenceV3): MetadataV3 {
  return {
    metadataSchemaVersion: METADATA_SCHEMA_VERSION_V3,
    requesterPrincipalKind: e.requesterPrincipalKind,
    requesterPrincipalNamespace: e.requesterPrincipalNamespace,
    requesterPrincipalRef: e.requesterPrincipalRef,
    accountRefHash: e.accountRefHash,
    walletAuthorityRef: e.walletAuthorityRef,
    onchainBuyerAgentId: e.onchainBuyerAgentId,
    buyerAgentIdSemantics: e.buyerAgentIdSemantics,
    sellerAspId: e.sellerAspId,
    workerAgentId: e.workerAgentId,
    serviceId: e.serviceId,
    policyId: e.policyId,
    policyHash: e.policyHash,
    policyOwner: e.policyOwner,
    governedAgent: e.governedAgent,
    policySnapshotHash: e.policySnapshotHash,
    policySelectionSemantics: e.policySelectionSemantics,
    quoteDigest: e.quoteDigest,
    intentHash: e.intentHash,
    engineVersion: e.engineVersion,
    ruleManifestHash: e.ruleManifestHash,
    decision: e.decision,
    evaluatedAt: e.evaluatedAt,
  };
}

export function metadataHashV3(metadata: MetadataV3): Hex {
  return hashCanonicalJson(metadata as unknown as Record<string, unknown>);
}

/**
 * Refuse to persist a V3 decision that is not V3.
 *
 * Two layers: the field-presence check that V2 also has, then `assertRequesterEvidenceV3`, which is
 * the one that matters — presence is cheap, and a row with every field populated and a nonzero
 * `buyerAgentId` beside `requesterPrincipalKind: untch_account` would pass a presence check while
 * describing a requester that cannot exist.
 */
export function assertCompleteV3(e: Partial<DecisionEvidenceV3>): asserts e is DecisionEvidenceV3 {
  const required: (keyof DecisionEvidenceV3)[] = [
    "decisionId",
    "intentId",
    "intentHash",
    "accountId",
    "accountRefHash",
    "walletBindingId",
    "walletAuthorityRef",
    "requesterPrincipalKind",
    "requesterPrincipalNamespace",
    "requesterPrincipalRef",
    "onchainBuyerAgentId",
    "buyerAgentIdSemantics",
    "sellerAspId",
    "workerAgentId",
    "serviceId",
    "policyId",
    "policyHash",
    "policyOwner",
    "governedAgent",
    "policySnapshotHash",
    "policySelectionSemantics",
    "quoteDigest",
    "engineVersion",
    "ruleManifestHash",
    "decision",
    "evaluatedAt",
  ];
  const missing = required.filter((k) => e[k] === undefined || e[k] === null || e[k] === "");
  if (e.metadataSchemaVersion !== METADATA_SCHEMA_VERSION_V3) missing.push("metadataSchemaVersion");
  if (e.completeness !== "V3_COMPLETE") missing.push("completeness");
  if (missing.length > 0) {
    throw new IncompleteEvidenceError(
      missing,
      `a V3 decision cannot be persisted without ${missing.join(", ")}. An incomplete V3 row would be ` +
        "indistinguishable from a complete one to every later reader, so it is refused rather than stored.",
    );
  }
  assertRequesterEvidenceV3(e as DecisionEvidenceV3);
}

export interface AssembleEvidenceV3Input {
  readonly decisionId: string;
  readonly intentId: string;
  readonly intentHash: Hex;
  readonly accountId: string;
  readonly walletBindingId: string;
  readonly requester: RequesterEvidenceV3;
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly policyOwner: string;
  readonly governedAgent: string;
  /** The content, not its hash. */
  readonly snapshot: PolicySnapshot;
  /** The content, not its digest. */
  readonly quoteTerms: CanonicalQuoteTermsV3;
  readonly engineVersion: string;
  readonly ruleManifestHash: Hex;
  readonly decision: string;
  readonly ruleTrace: readonly Record<string, unknown>[];
  readonly evaluatedAt: string;
}

export interface AssembledEvidenceV3 {
  readonly evidence: DecisionEvidenceV3;
  readonly snapshot: PolicySnapshot;
  readonly quoteTerms: CanonicalQuoteTermsV3;
  readonly metadata: MetadataV3;
  readonly metadataHash: Hex;
  /** The requester commitment, so a caller never has to reconstruct the discrimination by hand. */
  readonly requesterCommitment: Hex;
}

/**
 * The one function that turns a served V3 decision into evidence.
 *
 * Like the V2 assembler it COMPUTES every hash from content it is handed rather than accepting one,
 * for the same reason: a `quoteDigest` passed in could have been computed from something else, and a
 * hash that is wrong looks exactly like a hash that is right.
 *
 * The two cross-checks below exist because this is the only place that sees both sides. A quote whose
 * requester disagrees with the decision's requester would hash cleanly and bind the wrong payer —
 * which is the entire failure V3 exists to close, so it is a throw and not a warning.
 */
export function assembleDecisionEvidenceV3(input: AssembleEvidenceV3Input): AssembledEvidenceV3 {
  assertRequesterEvidenceV3(input.requester);

  if (input.snapshot.policyId !== input.policyId) {
    throw new IncompleteEvidenceError(
      ["policySnapshot"],
      `the snapshot is of policy ${input.snapshot.policyId} but the decision names ${input.policyId}. ` +
        "A snapshot of a different policy would hash cleanly and commit to the wrong ruleset.",
    );
  }
  if (input.snapshot.policyHash.toLowerCase() !== input.policyHash.toLowerCase()) {
    throw new IncompleteEvidenceError(
      ["policySnapshot"],
      `the snapshot's policyHash ${input.snapshot.policyHash} does not equal the decision's ${input.policyHash}`,
    );
  }
  if (input.quoteTerms.requesterPrincipalRef !== input.requester.requesterPrincipalRef) {
    throw new IncompleteEvidenceError(
      ["quoteTerms.requesterPrincipalRef"],
      `the quote was priced for requester ${input.quoteTerms.requesterPrincipalRef} but the decision names ` +
        `${input.requester.requesterPrincipalRef}. A digest that bound one requester to another's decision ` +
        "would authorise the wrong payer while verifying perfectly.",
    );
  }
  if (input.quoteTerms.policyId !== input.policyId) {
    throw new IncompleteEvidenceError(
      ["quoteTerms.policyId"],
      `the quote names policy ${input.quoteTerms.policyId} and the decision names ${input.policyId}. ` +
        "The on-chain hash cannot tell two same-ruleset policies apart, so this is the only place it can be caught.",
    );
  }

  const policySnapshotHash = policySnapshotHashOf(input.snapshot);
  const quoteDigest = quoteDigestOfV3(input.quoteTerms);

  const evidence: DecisionEvidenceV3 = {
    ...input.requester,
    decisionId: input.decisionId,
    intentId: input.intentId,
    intentHash: input.intentHash,
    accountId: input.accountId,
    walletBindingId: input.walletBindingId,
    policyId: input.policyId,
    policyHash: input.policyHash,
    policyOwner: input.policyOwner.toLowerCase(),
    governedAgent: input.governedAgent.toLowerCase(),
    policySnapshotHash,
    policySelectionSemantics: POLICY_SELECTION_SEMANTICS,
    quoteDigest,
    engineVersion: input.engineVersion,
    ruleManifestHash: input.ruleManifestHash,
    decision: input.decision,
    ruleTrace: input.ruleTrace,
    evaluatedAt: input.evaluatedAt,
    metadataSchemaVersion: METADATA_SCHEMA_VERSION_V3,
    completeness: "V3_COMPLETE",
  };

  // Throws before anything is returned, so a caller cannot persist a half-assembled object.
  assertCompleteV3(evidence);

  const metadata = metadataV3Of(evidence);
  return {
    evidence,
    snapshot: input.snapshot,
    quoteTerms: input.quoteTerms,
    metadata,
    metadataHash: metadataHashV3(metadata),
    requesterCommitment: requesterCommitment(commitmentInputOf(input.requester)),
  };
}

/** Write the snapshot and the V3 decision in ONE transaction, on a caller-supplied client. */
export async function persistDecisionEvidenceV3(tx: EvidenceTx, assembled: AssembledEvidenceV3): Promise<void> {
  const s = assembled.snapshot;
  await tx.query(
    `INSERT INTO untch_policy_snapshots (snapshot_hash, policy_id, policy_hash, owner, chain_id, snapshot)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (snapshot_hash) DO NOTHING`,
    [assembled.evidence.policySnapshotHash, s.policyId, s.policyHash, s.owner, s.chainId, JSON.stringify(s)],
  );

  const e = assembled.evidence;
  await tx.query(
    `INSERT INTO untch_decision_evidence
       (decision_id, intent_id, intent_hash, account_id, account_ref_hash, policy_id, policy_hash,
        policy_snapshot_hash, quote_digest, engine_version, rule_manifest_hash, decision, rule_trace,
        evaluated_at, metadata_schema_version, completeness,
        requester_principal_kind, requester_principal_namespace, requester_principal_ref,
        wallet_authority_ref, wallet_binding_id, onchain_buyer_agent_id, buyer_agent_id_semantics,
        buyer_agent_id, marketplace, marketplace_binding_id, seller_asp_id, worker_agent_id, service_id,
        policy_owner, governed_agent, policy_selection_semantics)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,3,'V3_COMPLETE',
             $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)
     ON CONFLICT (decision_id) DO NOTHING`,
    [
      e.decisionId, e.intentId, e.intentHash, e.accountId, e.accountRefHash, e.policyId, e.policyHash,
      e.policySnapshotHash, e.quoteDigest, e.engineVersion, e.ruleManifestHash, e.decision,
      JSON.stringify(e.ruleTrace), e.evaluatedAt,
      e.requesterPrincipalKind, e.requesterPrincipalNamespace, e.requesterPrincipalRef,
      e.walletAuthorityRef, e.walletBindingId, e.onchainBuyerAgentId, e.buyerAgentIdSemantics,
      e.buyerAgentId, e.marketplace, e.marketplaceBindingId, e.sellerAspId, e.workerAgentId, e.serviceId,
      e.policyOwner, e.governedAgent, e.policySelectionSemantics,
    ],
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 projections
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What anybody may see of a V3 decision.
 *
 * An ALLOW-LIST, for the reason the V2 one is: a deny-list fails silently when somebody adds a
 * column. Everything below is either a commitment or a public identifier. Absent by construction:
 * `accountId`, `walletBindingId`, the SIWE proof, the signature, the proof reference, the
 * authentication method, the email identity, and any history of which addresses an account has held.
 *
 * `walletAuthorityRef` IS public. It is a domain-separated hash of an authority state and it is what a
 * verifier needs to check that an approval and a decision were made under the same one; it discloses
 * neither the address nor the binding id to anyone who does not already hold them.
 */
export function publicDecisionProjectionV3(e: DecisionEvidenceV3): Record<string, unknown> {
  return {
    decisionId: e.decisionId,
    intentHash: e.intentHash,
    accountRefHash: e.accountRefHash,
    requesterPrincipalKind: e.requesterPrincipalKind,
    requesterPrincipalNamespace: e.requesterPrincipalNamespace,
    requesterPrincipalRef: e.requesterPrincipalRef,
    walletAuthorityRef: e.walletAuthorityRef,
    onchainBuyerAgentId: e.onchainBuyerAgentId,
    buyerAgentIdSemantics: e.buyerAgentIdSemantics,
    buyerAgentId: e.buyerAgentId,
    marketplace: e.marketplace,
    sellerAspId: e.sellerAspId,
    workerAgentId: e.workerAgentId,
    serviceId: e.serviceId,
    policyId: e.policyId,
    policyHash: e.policyHash,
    policyOwner: e.policyOwner,
    governedAgent: e.governedAgent,
    policySnapshotHash: e.policySnapshotHash,
    policySelectionSemantics: e.policySelectionSemantics,
    quoteDigest: e.quoteDigest,
    engineVersion: e.engineVersion,
    ruleManifestHash: e.ruleManifestHash,
    decision: e.decision,
    evaluatedAt: e.evaluatedAt,
    metadataSchemaVersion: e.metadataSchemaVersion,
    completeness: e.completeness,
  };
}

/**
 * The owner's view.
 *
 * `marketplaceBindingId` is here rather than in the public projection: it names a specific binding row
 * on a specific account, which is the account's business.
 */
export function privateDecisionProjectionV3(e: DecisionEvidenceV3): Record<string, unknown> {
  return {
    ...publicDecisionProjectionV3(e),
    accountId: e.accountId,
    walletBindingId: e.walletBindingId,
    marketplaceBindingId: e.marketplaceBindingId,
    intentId: e.intentId,
    ruleTrace: e.ruleTrace,
  };
}

export function projectionReportV3(e: DecisionEvidenceV3): {
  readonly publicProjection: Record<string, unknown>;
  readonly privateProjection: Record<string, unknown>;
  readonly rawAccountIdPresentInPublic: boolean;
  readonly walletBindingIdPresentInPublic: boolean;
  readonly accountRefHashPresentInPublic: boolean;
  readonly walletAuthorityRefPresentInPublic: boolean;
  readonly rawAccountIdPresentInPrivate: boolean;
} {
  const pub = publicDecisionProjectionV3(e);
  const priv = privateDecisionProjectionV3(e);
  const publicJson = JSON.stringify(pub);
  return {
    publicProjection: pub,
    privateProjection: priv,
    rawAccountIdPresentInPublic: publicJson.includes(e.accountId),
    walletBindingIdPresentInPublic: publicJson.includes(e.walletBindingId),
    accountRefHashPresentInPublic: publicJson.includes(e.accountRefHash),
    walletAuthorityRefPresentInPublic: publicJson.includes(e.walletAuthorityRef),
    rawAccountIdPresentInPrivate: JSON.stringify(priv).includes(e.accountId),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The receipt verifier
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptVerification {
  readonly ok: boolean;
  readonly refusals: readonly string[];
  /** What the verifier decided the zero means here. Null when the receipt carries a real agent id. */
  readonly legacyAgentIdSemantics: string | null;
}

/**
 * Check a receipt's requester claim against the metadata it committed to.
 *
 * WHAT THIS IS FOR, IN ONE SENTENCE
 *
 * The on-chain receipt carries `agentId` as `bytes32`, and a zero there means two opposite things
 * depending on which schema wrote it — so a verifier that reads the bytes alone is guaranteed to be
 * wrong about half of them.
 *
 *   • Under V1 and V2, a zero `agentId` is a decision receipted against an agent that does not exist.
 *     That was invalid then and it is invalid now, and this function REFUSES it rather than granting
 *     it the V3 reading retroactively. Nothing about a receipt improves because a later schema was
 *     written.
 *
 *   • Under V3 with `requesterPrincipalKind: untch_account`, a zero is the reserved null meaning NO
 *     MARKETPLACE BUYER, and the real requester is in the metadata. It is accepted only when that
 *     metadata is actually present and actually commits — a V3 receipt with a zero and no requester
 *     data is the exact forgery this check exists to catch, and it fails.
 */
export function verifyReceiptRequester(args: {
  /** The `agentId` field as anchored: `bytes32`. */
  readonly legacyAgentIdBytes32: Hex;
  readonly version: MetadataSchemaVersion;
  readonly committedMetadataHash: Hex;
  /** The V3 evidence, when the receipt claims V3. */
  readonly v3?: DecisionEvidenceV3 | undefined;
  readonly v2?: MetadataV2 | undefined;
  readonly v1Object?: unknown;
  readonly v1Hash?: ((value: unknown) => Hex) | undefined;
  /**
   * Whether a VERIFIED marketplace binding exists for the id the metadata claims.
   *
   * A parameter rather than a lookup, because the binding store is not this module's to reach and a
   * verifier that could not be run offline against an exported record would not be much of a verifier.
   * Undefined means "not checked"; for a marketplace receipt that is itself a refusal, because an
   * unchecked binding and a verified one must never produce the same answer.
   */
  readonly marketplaceBindingVerified?: boolean | undefined;
  /** The proven wallet the direct policy owner must equal, when the caller can supply it. */
  readonly provenPolicyOwner?: string | undefined;
}): ReceiptVerification {
  const refusals: string[] = [];
  const zero = args.legacyAgentIdBytes32.toLowerCase() === LEGACY_ZERO_AGENT_ID_BYTES32;

  if (args.version !== 3) {
    if (zero) {
      refusals.push(
        `this receipt was written under metadata schema V${args.version}, where a zero agentId is a decision ` +
          "receipted against an agent that does not exist. The V3 reserved-null reading is not applied " +
          "retroactively: a receipt does not become valid because a later schema was written.",
      );
    }
    const commitment = verifyMetadataCommitment({
      committed: args.committedMetadataHash,
      version: args.version,
      ...(args.v2 !== undefined ? { v2: args.v2 } : {}),
      ...(args.v1Object !== undefined ? { v1Object: args.v1Object } : {}),
      ...(args.v1Hash !== undefined ? { v1Hash: args.v1Hash } : {}),
    });
    if (!commitment.ok) refusals.push(commitment.reason ?? "the metadata commitment does not match");
    return { ok: refusals.length === 0, refusals, legacyAgentIdSemantics: null };
  }

  const e = args.v3;
  if (!e) {
    return {
      ok: false,
      refusals: [
        "this receipt claims metadata schema V3 and carries no V3 evidence. A zero agentId with no " +
          "requester metadata is unattributable, and unattributable is refused rather than assumed benign.",
      ],
      legacyAgentIdSemantics: null,
    };
  }

  try {
    assertRequesterEvidenceV3(e);
  } catch (err) {
    refusals.push(...((err as RequesterEvidenceError).violations ?? [(err as Error).message]));
  }

  if (e.requesterPrincipalKind === "untch_account") {
    if (!zero) {
      refusals.push(
        `a direct account receipt reserves agentId 0; this one is anchored under ${args.legacyAgentIdBytes32}, ` +
          "which names a marketplace agent that had no part in the decision",
      );
    }
    if (e.requesterPrincipalNamespace !== UNTCH_ACCOUNT_NAMESPACE) {
      refusals.push(`a direct account requester is namespaced ${UNTCH_ACCOUNT_NAMESPACE}`);
    }
    if (e.buyerAgentIdSemantics !== "no_marketplace_buyer") {
      refusals.push("a direct account receipt means no_marketplace_buyer");
    }
    if (e.marketplace !== null || e.marketplaceBindingId !== null || e.buyerAgentId !== null) {
      refusals.push("a direct account receipt carries no marketplace identity at all");
    }
    if (e.accountRefHash.trim() === "") refusals.push("accountRefHash is absent");
    if (e.walletAuthorityRef.trim() === "") refusals.push("walletAuthorityRef is absent");
    if (
      args.provenPolicyOwner !== undefined &&
      args.provenPolicyOwner.toLowerCase() !== e.policyOwner.toLowerCase()
    ) {
      refusals.push(
        `the policy is owned by ${e.policyOwner} and the proven direct wallet is ${args.provenPolicyOwner}. ` +
          "A direct request is identified on chain only by the owner address, so these must be the same wallet.",
      );
    }
  } else {
    if (zero) {
      refusals.push(
        "a marketplace receipt is anchored under the agent that made the decision; zero names no agent",
      );
    }
    if (BigInt(e.onchainBuyerAgentId || "0") <= 0n) {
      refusals.push("a marketplace receipt needs an on-chain buyerAgentId greater than zero");
    }
    const anchored = BigInt(args.legacyAgentIdBytes32).toString();
    if (anchored !== e.onchainBuyerAgentId) {
      refusals.push(
        `the metadata names buyer agent ${e.onchainBuyerAgentId} and the receipt is anchored under ${anchored}`,
      );
    }
    if (e.buyerAgentId !== e.onchainBuyerAgentId) {
      refusals.push("the metadata buyerAgentId must equal the committed on-chain value");
    }
    if (args.marketplaceBindingVerified !== true) {
      refusals.push(
        "no VERIFIED marketplace binding was shown for this buyer agent id. A declared or unchecked " +
          "claim is audit context and can never satisfy a verified-authority requirement.",
      );
    }
  }

  const commitment = verifyMetadataCommitment({
    committed: args.committedMetadataHash,
    version: 3,
    v3: metadataV3Of(e),
  });
  if (!commitment.ok) refusals.push(commitment.reason ?? "the metadata commitment does not match");

  return {
    ok: refusals.length === 0,
    refusals,
    legacyAgentIdSemantics:
      e.requesterPrincipalKind === "untch_account" && zero ? LEGACY_AGENT_ID_SEMANTICS_V3 : null,
  };
}
