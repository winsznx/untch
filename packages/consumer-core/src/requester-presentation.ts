/**
 * What a person is shown, and what a stranger is allowed to see.
 *
 * THE ONE SENTENCE THIS MODULE EXISTS FOR
 *
 * `buyerAgentId = 0` is a protocol null, and every naive rendering of it — `Buyer agent 0`,
 * `Agent ID 0`, `ERC-8004 agent 0`, `Marketplace identity 0`, `Unknown agent` — is a lie in a
 * different register. The first three name an agent that does not exist. The fourth invents a
 * marketplace. The fifth says the system does not know, when it knows precisely: there is no
 * marketplace buyer, because the account asked directly.
 *
 * So the number never reaches a label. `presentRequester` maps the RECORD to words, and the raw zero
 * is available only through `rawLegacyAgentProjection`, where it arrives beside the semantics that
 * make it readable and is clearly a contract-level view rather than a description of a party.
 *
 * THE PRIVACY RULE, AS A MECHANISM RATHER THAN A HABIT
 *
 * Public projections are ALLOW-LISTS built by naming fields. A deny-list has to be maintained against
 * a growing record and fails silently the day somebody adds a column; an allow-list fails by omitting
 * something, which somebody notices. `publicFromRow` additionally drops unknown keys outright, so a
 * database row handed straight to a public surface cannot leak a column nobody thought about.
 */

import type { DecisionEvidenceV3 } from "./decision-evidence";
import { LEGACY_AGENT_ID_SEMANTICS_V3, LEGACY_ZERO_AGENT_ID_BYTES32 } from "./requester-principal";

/** The human-readable answer to "who asked, and who is on the other side". */
export interface RequesterPresentation {
  readonly requester: string;
  readonly marketplaceBuyer: string;
  readonly sellerAsp: string;
  readonly workerAgent: string;
  readonly service: string;
}

export function presentRequester(e: {
  readonly requesterPrincipalKind: string;
  readonly marketplace: string | null;
  readonly buyerAgentId: string | null;
  readonly sellerAspId: string;
  readonly workerAgentId: string;
  readonly serviceId: string;
}): RequesterPresentation {
  const direct = e.requesterPrincipalKind === "untch_account";
  return {
    requester: direct ? "Untch account" : `Marketplace agent (${e.marketplace ?? "unknown marketplace"})`,
    /**
     * "None" — the true statement — rather than the number.
     *
     * `Buyer agent 0` would be a claim about an agent. `Unknown agent` would be a claim about this
     * system's knowledge. Neither is what happened: nobody bought through a marketplace.
     */
    marketplaceBuyer: direct ? "None" : (e.buyerAgentId ?? "None"),
    sellerAsp: e.sellerAspId,
    workerAgent: e.workerAgentId,
    service: e.serviceId,
  };
}

/**
 * The contract-level view: the bytes as anchored, and what they mean here.
 *
 * Two fields, never one. `legacyAgentId` alone is the value that has been misread in every direction;
 * the semantics beside it is what makes it a fact rather than an invitation to guess.
 */
export interface RawLegacyAgentProjection {
  readonly legacyAgentId: string;
  readonly legacyAgentIdSemantics: string;
}

export function rawLegacyAgentProjection(e: {
  readonly requesterPrincipalKind: string;
  readonly onchainBuyerAgentId: string;
}): RawLegacyAgentProjection {
  const asBytes32 =
    e.onchainBuyerAgentId === "0"
      ? LEGACY_ZERO_AGENT_ID_BYTES32
      : (`0x${BigInt(e.onchainBuyerAgentId).toString(16).padStart(64, "0")}` as const);
  return {
    legacyAgentId: asBytes32,
    legacyAgentIdSemantics:
      e.requesterPrincipalKind === "untch_account" ? LEGACY_AGENT_ID_SEMANTICS_V3 : "MARKETPLACE_BUYER_AGENT",
  };
}

/**
 * Everything a public surface must never carry, named so a test can assert on the list.
 *
 * Not used to filter — the allow-list does that. Used to CHECK the allow-list, which is the direction
 * that catches a mistake: a deny-list that filters is a deny-list somebody has to remember to extend.
 */
export const NEVER_PUBLIC_FIELDS = Object.freeze([
  "accountId",
  "account_id",
  "walletBindingId",
  "wallet_binding_id",
  "marketplaceBindingId",
  "marketplace_binding_id",
  "proofRef",
  "proof_ref",
  "signature",
  "siwe",
  "siweMessage",
  "authMethod",
  "auth_method",
  "email",
  "walletAddress",
  "wallet_address",
  "address",
  "addressHistory",
  "challengeRef",
  "challenge_ref",
]);

/** The public V3 fields, by name. The single source both the projection and its test read. */
export const PUBLIC_V3_FIELDS = Object.freeze([
  "decisionId",
  "intentHash",
  "accountRefHash",
  "requesterPrincipalKind",
  "requesterPrincipalNamespace",
  "requesterPrincipalRef",
  "walletAuthorityRef",
  "onchainBuyerAgentId",
  "buyerAgentIdSemantics",
  "buyerAgentId",
  "marketplace",
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
  "metadataSchemaVersion",
  "completeness",
]);

/**
 * Project an arbitrary record down to the public field set.
 *
 * For the case the allow-list alone does not cover: a row read with `SELECT *`, or a DTO assembled
 * upstream, arriving at a public surface with columns this module has never heard of. Unknown keys
 * are DROPPED rather than passed through, so adding a column to the table cannot publish it.
 */
export function publicFromRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_V3_FIELDS) {
    if (key in row) out[key] = row[key];
  }
  return out;
}

/**
 * The complete public view of a V3 decision: the commitments, the words, and the raw contract value.
 *
 * All three together on purpose. The commitments are what a verifier checks, the words are what a
 * person reads, and the raw projection is what somebody reconciling against the chain needs — and a
 * surface that offered only the first two would send that last person back to reading the zero
 * unaided, which is where every misreading of it starts.
 */
export function publicRequesterView(e: DecisionEvidenceV3): Record<string, unknown> {
  return {
    presentation: presentRequester(e),
    raw: rawLegacyAgentProjection(e),
  };
}
