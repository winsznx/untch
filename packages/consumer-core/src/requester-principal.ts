/**
 * Who asked, committed off chain because the deployed struct has nowhere to put it.
 *
 * WHAT THIS MODULE IS FOR
 *
 * `SpendIntent` is a deployed EIP-712 struct with eleven fields and not one of them names an account
 * (docs/adr/ADR-replace-legacy-buyerAgentId-with-requester-principal.md). A direct Untch-account
 * request therefore carries `buyerAgentId = 0` — the reserved protocol null meaning NO MARKETPLACE
 * BUYER EXISTS — and everything that actually identifies the requester lives here, in commitments the
 * quote digest, the approval digest, the decision evidence and the metadata commitment all bind.
 *
 * THE THREE COMMITMENTS, AND WHY THEY ARE THREE
 *
 *   walletAuthorityRef      — the exact wallet authority state: which address, which binding row, how
 *                             it was proven, and WHEN. A revocation followed by a reactivation is a
 *                             new proof at a new time, so it is a different authority, so it must be a
 *                             different value. That is what stops an approval created under the old
 *                             authority being honoured after the wallet was disowned.
 *
 *   requesterPrincipalRef   — the durable, publishable reference to the requester. For a direct
 *                             account it IS the accountRefHash, because that is exactly what "this
 *                             account asked" means and a second hash of the same fact would be a
 *                             second answer to one question.
 *
 *   requesterCommitment     — kind + namespace + ref + walletAuthorityRef, hashed together. The kind
 *                             and namespace are in the hash rather than beside it because
 *                             `untch-account/0xabc…` and `okx-ai/0xabc…` must never collide, and a
 *                             namespace carried alongside a hash is a namespace an attacker can drop.
 *
 * WHAT NEVER APPEARS IN ANY OF THEM
 *
 * The raw `accountId`, the raw `walletBindingId` on the public side, the SIWE signature, the proof
 * reference. A commitment is published; an identifier that appears across every one of an account's
 * receipts is not something a receipt needs to disclose to be checkable.
 */

import { hashCanonicalJson } from "@untch/canon";
import { keccak256, toHex, type Hex } from "viem";

// ─────────────────────────────────────────────────────────────────────────────
// The vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** The evidence schema version that carries a requester principal. */
export const METADATA_SCHEMA_VERSION_V3 = 3 as const;

/**
 * WHO is asking, as a closed set.
 *
 * Two kinds, because they have different required facts and different proofs. A third would be a
 * third proof obligation, and adding one silently is how a path with no proof gets a name.
 */
export type RequesterPrincipalKind = "untch_account" | "marketplace_agent";

/**
 * The authority a requester reference is scoped to.
 *
 * This is the field whose ABSENCE makes the legacy bare `uint256` insufficient: `6047` means nothing
 * without saying which registry issued it. `untch-account` scopes an accountRefHash to this service;
 * `okx-ai` scopes an agent id to the OKX marketplace registry.
 */
export const UNTCH_ACCOUNT_NAMESPACE = "untch-account" as const;
export const OKX_MARKETPLACE_NAMESPACE = "okx-ai" as const;

/**
 * What a `buyerAgentId` of 0 means in THIS decision. Recorded, never inferred by a later reader.
 *
 * The whole reason it is a stored word rather than a derived one: a V1 or V2 receipt can also carry a
 * zero, and there it means a decision receipted against an agent that does not exist. The same bytes,
 * the opposite meaning. Only the record can say which.
 */
export type BuyerAgentIdSemantics = "no_marketplace_buyer" | "verified_marketplace_agent";

/**
 * How much of the policy identity is on chain, said out loud.
 *
 * The legacy `SpendIntent` commits `policyHash` — the RULESET bytes — and not `policyId`. Two policies
 * with the same owner and identical rules confer identical authority and produce identical intent
 * hashes, so the contract cannot say which one was evaluated. V3 commits the exact `policyId` off
 * chain, and this constant is the disclosure travelling with every V3 record that says the on-chain
 * side is weaker than the off-chain one.
 */
export const POLICY_SELECTION_SEMANTICS = "exact_offchain_policy_id_legacy_onchain_policy_hash" as const;
export type PolicySelectionSemantics = typeof POLICY_SELECTION_SEMANTICS;

/** The reserved on-chain null for `SpendIntent.buyerAgentId` on a direct account request. */
export const DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID = "0" as const;

/** What a raw contract projection may call the reserved zero. Never shown as an agent id. */
export const LEGACY_AGENT_ID_SEMANTICS_V3 = "NO_MARKETPLACE_BUYER_V3" as const;

/** `bytes32(uint256(0))` — the legacy `agentId` a V3 direct-account receipt is anchored under. */
export const LEGACY_ZERO_AGENT_ID_BYTES32 = `0x${"0".repeat(64)}` as Hex;

// ─────────────────────────────────────────────────────────────────────────────
// Domain separation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every commitment here names its own domain INSIDE the hashed object.
 *
 * Not as a prefix string, and not as a parameter beside the hash. `hashCanonicalJson` is the
 * repository's RFC 8785 hasher and it is used for the policy hash, the intent hash, the quote digest
 * and the snapshot hash — so a bare hash of `{address, bindingId}` here could, in principle, equal a
 * hash of some other record with those field names. A `domain` member inside the object makes that
 * impossible without a second serialiser and without a second answer to "what did this commit to".
 */
export const WALLET_AUTHORITY_DOMAIN = "untch-wallet-authority-v1" as const;
export const REQUESTER_PRINCIPAL_DOMAIN = "untch-requester-principal-v1" as const;

/**
 * The public reference to an account.
 *
 * DEFINED HERE, RE-EXPORTED BY `./decision-evidence`, WHICH IS WHERE IT USED TO LIVE.
 *
 * It moved because V3 made the dependency run the other way: the requester commitment is built from
 * this, and evidence is built from the requester commitment. Leaving it in `decision-evidence` would
 * have made the two modules import each other, and a cycle between the module that DEFINES a
 * commitment and the module that USES it is the kind of thing that works until an unrelated import
 * order changes and a top-level constant is briefly undefined.
 *
 * A receipt is public and an `accountId` is a durable identifier appearing across every one of an
 * account's receipts. Publishing it would let anyone group a stranger's whole spending history from
 * public data alone. Domain-separated so this hash cannot collide with, or be replayed as, any other
 * hash of the same id in another context.
 */
export const ACCOUNT_REFERENCE_DOMAIN = "untch-account-reference-v1" as const;

export function accountRefHash(accountId: string): Hex {
  return keccak256(toHex(`${ACCOUNT_REFERENCE_DOMAIN}||${accountId}`));
}

// ─────────────────────────────────────────────────────────────────────────────
// walletAuthorityRef
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exact wallet authority a request was made under.
 *
 * WHY `verifiedAt` IS IN HERE, WHICH IS THE WHOLE DESIGN
 *
 * A binding can be revoked and later reactivated on the SAME account — the address is never freed
 * (migration 024), so reactivation is the only way back. Reactivation writes a FRESH proof and a fresh
 * `verifiedAt`, which means this value changes, which means:
 *
 *   • an approval digest created under the old authority matches nothing after revocation;
 *   • reactivating cannot revive it, because the new authority hashes differently;
 *   • and a decision already taken keeps its ORIGINAL walletAuthorityRef, so history still reads
 *     correctly rather than being retroactively re-attributed to the new proof.
 *
 * That last point is why the value is stored on the decision rather than recomputed from the current
 * binding when somebody asks. A recomputation would quietly rewrite the past every time a user
 * re-proved a wallet.
 */
export interface WalletAuthorityFacts {
  /** `evm` | `solana`. In the hash because one address string can exist on both. */
  readonly chainKind: string;
  readonly address: string;
  /** The immutable binding row id. Private on its own; here it is one input among five. */
  readonly walletBindingId: string;
  /** `siwe` | `declared`. Only `siwe` is authority, and the difference must change the value. */
  readonly proofKind: string;
  /** ISO-8601. Null only for a binding that was never proven, which authorises nothing. */
  readonly verifiedAt: string | null;
}

export function walletAuthorityRef(facts: WalletAuthorityFacts): Hex {
  return hashCanonicalJson({
    domain: WALLET_AUTHORITY_DOMAIN,
    chainKind: facts.chainKind.toLowerCase(),
    // Lowercased for the same reason `canonAddress` lowercases: checksum case is display, and a hash
    // that changed with it would make one authority hash two ways.
    address: facts.address.toLowerCase(),
    walletBindingId: facts.walletBindingId,
    proofKind: facts.proofKind,
    verifiedAt: facts.verifiedAt,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// The requester principal
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A direct Untch-account requester. The account is the payer and its own proven wallet is the
 * authority; there is no marketplace anywhere in the request.
 */
export interface DirectAccountRequester {
  readonly kind: "untch_account";
  readonly namespace: typeof UNTCH_ACCOUNT_NAMESPACE;
  readonly accountRefHash: Hex;
  readonly walletAuthorityRef: Hex;
}

/**
 * A marketplace requester. The buyer agent id is the requester reference, and it counts only when a
 * VERIFIED binding produced it — a declared id is audit context and satisfies nothing here.
 */
export interface MarketplaceRequester {
  readonly kind: "marketplace_agent";
  readonly namespace: string;
  readonly accountRefHash: Hex;
  readonly walletAuthorityRef: Hex;
  readonly buyerAgentId: string;
  readonly marketplaceBindingId: string;
}

export type RequesterPrincipalCommitmentInput = DirectAccountRequester | MarketplaceRequester;

/**
 * The requester commitment.
 *
 * Marketplace identity is present as `null` for a direct request rather than omitted. An omitted
 * member and a null member canonicalise differently, and "this request had no marketplace" is a fact
 * the commitment should state, not a gap a reader has to notice.
 */
export function requesterCommitment(input: RequesterPrincipalCommitmentInput): Hex {
  const marketplace =
    input.kind === "marketplace_agent"
      ? { buyerAgentId: input.buyerAgentId, marketplaceBindingId: input.marketplaceBindingId }
      : null;
  return hashCanonicalJson({
    domain: REQUESTER_PRINCIPAL_DOMAIN,
    kind: input.kind,
    namespace: input.namespace,
    requesterPrincipalRef: requesterPrincipalRefOf(input),
    accountRefHash: input.accountRefHash,
    walletAuthorityRef: input.walletAuthorityRef,
    marketplace,
  });
}

/**
 * The publishable reference to the requester.
 *
 * For a direct account it is the accountRefHash itself. Minting a separate hash would create two
 * public references to one requester, and a verifier would then have to be told which of them the
 * quote digest bound — a question with no good answer.
 *
 * For a marketplace agent it is the namespaced agent id, because the id alone is meaningless: `6047`
 * is only an identity once you say which registry issued it.
 */
export function requesterPrincipalRefOf(input: RequesterPrincipalCommitmentInput): string {
  return input.kind === "untch_account" ? input.accountRefHash : `${input.namespace}:${input.buyerAgentId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The V3 requester record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every requester-shaped field a V3 decision carries, in one object.
 *
 * `sellerAspId` and `workerAgentId` are separate members even though both are currently `6086`. They
 * are different roles — who is transacted WITH, and who performs the work — and a deployment where
 * Untch brokers somebody else's service makes them different values. Collapsing them now because
 * they happen to match is exactly how a role gets silently borrowed later.
 */
export interface RequesterEvidenceV3 {
  readonly requesterPrincipalKind: RequesterPrincipalKind;
  readonly requesterPrincipalNamespace: string;
  readonly requesterPrincipalRef: string;
  readonly accountRefHash: Hex;
  readonly walletAuthorityRef: Hex;
  /** The value written into `SpendIntent.buyerAgentId`. `"0"` for every direct account request. */
  readonly onchainBuyerAgentId: string;
  readonly buyerAgentIdSemantics: BuyerAgentIdSemantics;
  /** The marketplace buyer, when there IS one. Absent — not zero — for a direct account. */
  readonly buyerAgentId: string | null;
  readonly marketplace: string | null;
  readonly marketplaceBindingId: string | null;
  readonly sellerAspId: string;
  readonly workerAgentId: string;
  readonly serviceId: string;
}

export class RequesterEvidenceError extends Error {
  constructor(
    public readonly violations: readonly string[],
    message: string,
  ) {
    super(message);
    this.name = "RequesterEvidenceError";
  }
}

const UINT = /^[0-9]+$/;

/**
 * The shape rules, checked in code as well as in the database.
 *
 * Both, deliberately, and for the reason `assertCompleteV2` gives: the application check produces a
 * message naming the violation at the call site, and the CHECK constraint holds for anything that
 * reaches the table by another path — a repair script, a console session, a later migration.
 *
 * Every rule below is a way a record could otherwise claim an authority it does not have.
 */
export function assertRequesterEvidenceV3(e: RequesterEvidenceV3): void {
  const bad: string[] = [];

  if (!UINT.test(e.onchainBuyerAgentId)) bad.push("onchainBuyerAgentId must be a uint256 decimal string");
  if (e.sellerAspId.trim() === "") bad.push("sellerAspId is required");
  if (e.workerAgentId.trim() === "") bad.push("workerAgentId is required");
  if (e.serviceId.trim() === "") bad.push("serviceId is required");
  if (e.accountRefHash.trim() === "") bad.push("accountRefHash is required");
  if (e.walletAuthorityRef.trim() === "") bad.push("walletAuthorityRef is required");
  if (e.requesterPrincipalRef.trim() === "") bad.push("requesterPrincipalRef is required");

  if (e.requesterPrincipalKind === "untch_account") {
    if (e.requesterPrincipalNamespace !== UNTCH_ACCOUNT_NAMESPACE) {
      bad.push(`a direct account requester is namespaced ${UNTCH_ACCOUNT_NAMESPACE}, not ${e.requesterPrincipalNamespace}`);
    }
    if (e.requesterPrincipalRef !== e.accountRefHash) {
      bad.push("a direct account's requesterPrincipalRef IS its accountRefHash");
    }
    if (e.onchainBuyerAgentId !== DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID) {
      bad.push(
        `a direct account request reserves buyerAgentId 0; ${e.onchainBuyerAgentId} would receipt this ` +
          "decision against a marketplace agent that had nothing to do with it",
      );
    }
    if (e.buyerAgentIdSemantics !== "no_marketplace_buyer") {
      bad.push("a direct account request means no_marketplace_buyer");
    }
    if (e.buyerAgentId !== null) bad.push("a direct account request has no marketplace buyer agent id");
    if (e.marketplace !== null) bad.push("a direct account request names no marketplace");
    if (e.marketplaceBindingId !== null) bad.push("a direct account request has no marketplace binding");
  } else {
    if (e.requesterPrincipalNamespace.trim() === "" || e.requesterPrincipalNamespace === UNTCH_ACCOUNT_NAMESPACE) {
      bad.push("a marketplace requester needs the namespace of the registry that issued its agent id");
    }
    if (e.buyerAgentId === null || !UINT.test(e.buyerAgentId) || e.buyerAgentId === "0") {
      bad.push("a marketplace requester needs a verified buyer agent id greater than zero");
    }
    if (e.onchainBuyerAgentId === "0" || e.onchainBuyerAgentId !== e.buyerAgentId) {
      bad.push("the on-chain buyerAgentId must equal the verified marketplace buyer agent id");
    }
    if (e.buyerAgentIdSemantics !== "verified_marketplace_agent") {
      bad.push("a marketplace request means verified_marketplace_agent");
    }
    if (!e.marketplaceBindingId || e.marketplaceBindingId.trim() === "") {
      bad.push("a marketplace requester needs the VERIFIED binding that produced its id");
    }
    if (!e.marketplace || e.marketplace.trim() === "") bad.push("a marketplace requester names its marketplace");
    if (e.requesterPrincipalRef !== `${e.requesterPrincipalNamespace}:${e.buyerAgentId ?? ""}`) {
      bad.push("a marketplace requesterPrincipalRef is `namespace:agentId`");
    }
  }

  if (bad.length > 0) {
    throw new RequesterEvidenceError(
      bad,
      `this requester record does not hold together and is refused rather than stored: ${bad.join("; ")}`,
    );
  }
}

/** The commitment input for a requester record, so callers never rebuild the discrimination by hand. */
export function commitmentInputOf(e: RequesterEvidenceV3): RequesterPrincipalCommitmentInput {
  return e.requesterPrincipalKind === "untch_account"
    ? {
        kind: "untch_account",
        namespace: UNTCH_ACCOUNT_NAMESPACE,
        accountRefHash: e.accountRefHash,
        walletAuthorityRef: e.walletAuthorityRef,
      }
    : {
        kind: "marketplace_agent",
        namespace: e.requesterPrincipalNamespace,
        accountRefHash: e.accountRefHash,
        walletAuthorityRef: e.walletAuthorityRef,
        buyerAgentId: e.buyerAgentId as string,
        marketplaceBindingId: e.marketplaceBindingId as string,
      };
}
