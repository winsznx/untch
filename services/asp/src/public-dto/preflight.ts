/**
 * The public, account-derived preflight — the route a stranger's agent can actually complete.
 *
 * WHAT CHANGED, AND WHY IT IS THE WHOLE POINT
 *
 * The registered contract has said for two passes that a caller sends six fields and the protocol
 * object is derived server-side. It was true of the SCHEMA and false of the ROUTE: `mapping.ts` was
 * written, tested, and wired to nothing, so the live endpoint still demanded a policy hash, an owner,
 * a token address, four content hashes, a nonce and two agent ids. A published contract nothing
 * enforces is worse than a bad contract, because it is the one a caller will build against.
 *
 * This module is the enforcement. It takes the public request, resolves who is asking from a
 * wallet-backed session, resolves what governs them from their account's policy, resolves who is paid
 * from the registered service definition, maps the result onto the protocol struct, and hands it to
 * the same engine the internal route uses. Every value it produces is reported back with what produced
 * it, so a caller can check the derivation rather than trusting it.
 *
 * WHAT IT REFUSES TO DO
 *
 * Substitute. There is no branch here that reaches for the host's payTo, a zero agent id, or a policy
 * nobody chose. Each of those has a named refusal with the route that resolves it, and a refusal that
 * costs one round trip is cheaper than a receipt that is wrong in a way nobody can see.
 */



import type { Address, Hex } from "viem";
import { keccak256, toHex } from "viem";
import {
  assembleDecisionEvidenceV3,
  persistDecisionEvidenceV3,
  presentRequester,
  projectionReportV3,
  rawLegacyAgentProjection,
  type AssembledEvidenceV3,
  type CanonicalQuoteTermsV3,
  type EvidenceTx,
  type PolicySnapshot,
} from "@untch/consumer-core";
import { ENGINE_VERSION, RULE_MANIFEST_HASH } from "@untch/policy-engine";
import type { HandlerResult, PreflightDeps } from "../handlers";
import { evaluatePreflight } from "../handlers";
import { openAccountSession } from "../consumer/account-auth";
import { mapPreflightRequest, type NetworkFacts } from "./mapping";
import {
  DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID,
  OUTCOME_STATUS,
  publicOutcomeFor,
  resolveAuthority,
  type AuthorityDeps,
  type AccountFactsReader,
  type CallerIdentity,
  type OwnedServiceDefinition,
  type StoredPolicyReader,
} from "./authority";
import type { PublicPreflightRequest } from "./types";

/** What the public preflight needs from the account store: the resolver's reads, plus one write. */
export interface AccountUse extends AccountFactsReader {
  recordPolicyUse(args: { readonly accountId: string; readonly policyId: string; readonly by: string }): Promise<void>;
}

export interface PublicPreflightDeps {
  readonly accounts: AccountUse;
  readonly policies: StoredPolicyReader;
  readonly ownedService: (provider: string, capability: string) => OwnedServiceDefinition | null;
  readonly network: NetworkFacts;
  /** The HMAC secret account sessions are sealed with. */
  readonly sessionSecret: string;
  /**
   * Whether a provider could actually run right now.
   *
   * It changes no decision. It changes what an APPROVED decision is CALLED, and that is the field a
   * demo would otherwise turn into a claim that money moved.
   */
  readonly executionEnabled: boolean;
  /**
   * Where V3 evidence is written. Null on an instance with no database, and a paid decision then
   * refuses rather than returning success with nothing recorded.
   */
  readonly evidenceTx?: (<T>(fn: (tx: EvidenceTx) => Promise<T>) => Promise<T>) | null;
  /** The chain and registry the policy lives on, for the snapshot. */
  readonly chainId: number;
  readonly registry: string;
  readonly now?: () => number;
}

/**
 * Does this body speak the public contract?
 *
 * Detected by the four fields that have no counterpart in the protocol struct. A protocol intent has
 * `owner` and `taskHash`; a public request has `provider`, `capability`, `task` and `maxSpend`. The
 * two shapes cannot be confused, which is what lets one route serve both without a version flag —
 * and the internal shape stays available for `create_spend_intent` callers who already hold one.
 */
export function looksPublic(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  return (
    typeof b.provider === "string" &&
    typeof b.capability === "string" &&
    typeof b.task === "string" &&
    typeof b.maxSpend === "string"
  );
}

const REQUIRED_FIELDS = ["provider", "capability", "task", "maxSpend", "currency", "deadline"] as const;

function readRequest(body: unknown): PublicPreflightRequest | { readonly missing: readonly string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((f) => typeof b[f] !== "string" || (b[f] as string).trim() === "");
  if (missing.length > 0) return { missing };

  const optionalString = (k: string): string | undefined =>
    typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string) : undefined;
  const optionalObject = (k: string): Record<string, unknown> | undefined =>
    typeof b[k] === "object" && b[k] !== null && !Array.isArray(b[k]) ? (b[k] as Record<string, unknown>) : undefined;

  // Built by explicit assignment rather than a spread of `b`, so an unknown key in the request can
  // never reach the canonicaliser and change a hash the caller did not intend to commit to.
  return {
    provider: (b.provider as string).trim(),
    capability: (b.capability as string).trim(),
    task: (b.task as string).trim(),
    maxSpend: (b.maxSpend as string).trim(),
    currency: (b.currency as string).trim(),
    deadline: (b.deadline as string).trim(),
    ...(optionalString("policyId") !== undefined ? { policyId: optionalString("policyId") as string } : {}),
    ...(typeof b.useDefaultPolicy === "boolean" ? { useDefaultPolicy: b.useDefaultPolicy } : {}),
    ...(optionalString("recipient") !== undefined ? { recipient: optionalString("recipient") as string } : {}),
    ...(optionalObject("parameters") !== undefined ? { parameters: optionalObject("parameters") as Record<string, unknown> } : {}),
    ...(optionalObject("acceptance") !== undefined ? { acceptance: optionalObject("acceptance") as Record<string, unknown> } : {}),
    ...(optionalString("idempotencyKey") !== undefined ? { idempotencyKey: optionalString("idempotencyKey") as string } : {}),
    ...(optionalString("buyerAgentId") !== undefined ? { buyerAgentId: optionalString("buyerAgentId") as string } : {}),
    ...(optionalString("workerAgentId") !== undefined ? { workerAgentId: optionalString("workerAgentId") as string } : {}),
  };
}

const refusal = (
  code: keyof typeof OUTCOME_STATUS,
  message: string,
  extra: Record<string, unknown> = {},
): HandlerResult => ({
  status: OUTCOME_STATUS[code],
  body: { outcome: code, code, message, retryable: false, docsUrl: null, ...extra },
});

/**
 * Run a public preflight.
 *
 * `bearer` is the raw Authorization header. It is opened here rather than in the route so that the
 * one place that decides what an unauthenticated request means is the same place that knows what an
 * account would have supplied — otherwise `ACCOUNT_LINK_REQUIRED` gets raised by a middleware that
 * cannot say which of the derived fields it was needed for.
 */
export async function handlePublicPreflight(
  body: unknown,
  bearer: string | undefined,
  publicDeps: PublicPreflightDeps,
  engineDeps: PreflightDeps,
): Promise<HandlerResult> {
  const now = publicDeps.now ?? Date.now;
  const parsed = readRequest(body);
  if ("missing" in parsed) {
    return {
      status: 400,
      body: {
        outcome: "REQUEST_SCHEMA_VIOLATION",
        code: "REQUEST_SCHEMA_VIOLATION",
        message: `these fields are required and were missing or blank: ${parsed.missing.join(", ")}`,
        missing: parsed.missing,
        retryable: false,
        docsUrl: null,
      },
    };
  }
  const request = parsed;

  const token = /^Bearer\s+(.+)$/i.exec(bearer ?? "")?.[1];
  const session = openAccountSession(publicDeps.sessionSecret, token, now());
  const identity: CallerIdentity | null = session
    ? {
        accountId: session.accountId,
        address: session.address,
        bindingId: session.bindingId,
        scopes: session.scopes,
      }
    : null;

  const authorityDeps: AuthorityDeps = {
    accounts: publicDeps.accounts,
    policies: publicDeps.policies,
    ownedService: publicDeps.ownedService,
    now,
  };

  const authority = await resolveAuthority(
    {
      provider: request.provider,
      capability: request.capability,
      ...(request.policyId !== undefined ? { policyId: request.policyId } : {}),
      ...(request.useDefaultPolicy !== undefined ? { useDefaultPolicy: request.useDefaultPolicy } : {}),
      ...(request.recipient !== undefined ? { recipient: request.recipient } : {}),
      ...(request.buyerAgentId !== undefined ? { buyerAgentId: request.buyerAgentId } : {}),
      ...(request.workerAgentId !== undefined ? { workerAgentId: request.workerAgentId } : {}),
    },
    identity,
    authorityDeps,
  );

  if (!authority.ok) {
    return refusal(authority.code, authority.message, {
      missing: authority.missing,
      resolveBy: authority.resolveBy,
    });
  }

  const a = authority.authority;

  /**
   * The mapping is given the recipient and the agent ids as FACTS.
   *
   * `mapPreflightRequest` still refuses when it cannot derive them, and that refusal is still
   * reachable — through the internal path, and through any future caller that reaches the mapping
   * without an account. Passing the resolved values in rather than teaching the mapping to read an
   * account keeps the mapping pure and testable with no store at all.
   */
  const mapped = mapPreflightRequest(
    {
      ...request,
      ...(a.recipient !== null ? { recipient: a.recipient } : {}),
      /**
       * The reserved on-chain null for a direct account request.
       *
       * `SpendIntent.buyerAgentId` is a `uint256` in a deployed EIP-712 struct, so the field cannot be
       * omitted — only given a value. `0` is that value and it means exactly one thing:
       * NO MARKETPLACE BUYER EXISTS FOR THIS REQUEST.
       *
       * It is NOT ERC-8004 agent 0, and it is not a placeholder for an agent nobody looked up. ERC-8004
       * identifies an agent by a registry coordinate AND a token id, so a bare uint256 could never carry
       * a globally unambiguous agent identity anyway — which is why registering an agent purely to fill
       * this field would be ceremony rather than a fix. The real requester is committed off chain, in the
       * V3 evidence and in every digest derived from it; `buyerAgentIdSemantics` is what makes the 0
       * readable rather than ambiguous.
       *
       * Replacing this field with a genuine requester commitment is a planned protocol version —
       * docs/adr/0002-requester-principal-commitment.md — not something to patch in tonight.
       */
      buyerAgentId: a.buyerAgentId ?? DIRECT_ACCOUNT_ONCHAIN_BUYER_AGENT_ID,
      workerAgentId: a.workerAgentId,
    },
    {
      policy: { policyId: a.policy.id, policyHash: a.policy.policyHash, owner: a.policy.owner as Address },
      network: publicDeps.network,
      provider: {
        providerId: request.provider,
        capability: request.capability,
        endpoint: a.ownedService?.endpoint ?? `https://asp.untch.xyz/${request.provider}/${request.capability}`,
        resolvedRecipient: a.recipient,
      },
      now: now(),
    },
  );

  if (!mapped.ok) {
    const code = (mapped.code in OUTCOME_STATUS ? mapped.code : "AUTHORITY_NOT_DERIVABLE") as keyof typeof OUTCOME_STATUS;
    return {
      status: code in OUTCOME_STATUS ? OUTCOME_STATUS[code] : 400,
      body: {
        outcome: code,
        code: mapped.code,
        message: mapped.message,
        missing: mapped.missing,
        retryable: false,
        docsUrl: null,
      },
    };
  }

  const decision = await evaluatePreflight(mapped.intent, a.policy.id, a.policy, body, engineDeps);
  if (decision.status !== 200) return decision;

  const engineDecision = String(decision.body.decision ?? "");
  const outcome = publicOutcomeFor(engineDecision);

  /**
   * V3 evidence, assembled and persisted BEFORE a paid response is returned.
   *
   * The order is the point. A caller who paid $0.05 and received a decision has bought a record; if
   * the record cannot be written, they have bought nothing and must be told so rather than handed a
   * success whose evidence does not exist. So an assembly or write failure refuses with
   * DECISION_EVIDENCE_INCOMPLETE and never silently downgrades to a V1 row.
   */
  const evaluatedAt = String(decision.body.evaluatedAt ?? new Date(now()).toISOString());
  const snapshot: PolicySnapshot = {
    policyId: a.policy.id,
    policyHash: a.policy.policyHash,
    owner: a.policy.owner.toLowerCase(),
    governedAgent: a.policy.agentId.toLowerCase(),
    chainId: publicDeps.chainId,
    registry: publicDeps.registry.toLowerCase(),
    currency: publicDeps.network.symbol,
    rules: a.policy.rules as unknown as Record<string, unknown>,
    version: a.policy.version,
    expiryAtEval: new Date(a.policy.expiry * 1000).toISOString(),
    statusAtEval: a.policy.status,
    // Observed, not re-derived. A policy that expires later must not make a decision taken while it
    // was live look like it was taken against a dead one.
    activeAtEval: a.policy.status === "ACTIVE" && a.policy.expiry * 1000 > now(),
    defaultForAccount: a.account.defaultPolicyId === a.policy.id,
  };

  /**
   * The V3 quote terms — the obligation AND the obligor.
   *
   * The requester fields are what stop an approval obtained by one account matching another account's
   * identical request. `policyId` is here for the same reason `policySelectionSemantics` exists: the
   * on-chain hash commits the ruleset and cannot tell two same-ruleset policies apart, so the digest
   * is the only place the exact policy is bound to the exact quote.
   */
  const r = a.requesterEvidence;
  const quoteTerms: CanonicalQuoteTermsV3 = {
    quoteSchemaVersion: 3,
    // The lineage is the caller's idempotency key when they gave one, because that is the value they
    // chose to identify this logical request. Without one it is the intent hash, which is unique per
    // request and therefore correctly makes every call its own lineage.
    lineage: request.idempotencyKey ?? String(decision.body.intentHash ?? ""),
    version: 1,
    requesterPrincipalKind: r.requesterPrincipalKind,
    requesterPrincipalNamespace: r.requesterPrincipalNamespace,
    requesterPrincipalRef: r.requesterPrincipalRef,
    accountRefHash: r.accountRefHash,
    walletAuthorityRef: r.walletAuthorityRef,
    marketplace:
      r.marketplace !== null && r.buyerAgentId !== null && r.marketplaceBindingId !== null
        ? { marketplace: r.marketplace, buyerAgentId: r.buyerAgentId, marketplaceBindingId: r.marketplaceBindingId }
        : null,
    sellerAspId: r.sellerAspId,
    workerAgentId: r.workerAgentId,
    serviceId: r.serviceId,
    policyId: a.policy.id,
    policyHash: a.policy.policyHash,
    policyOwner: a.policy.owner.toLowerCase(),
    governedAgent: a.policy.agentId.toLowerCase(),
    amount: request.maxSpend,
    asset: request.currency,
    chain: `eip155:${publicDeps.chainId}`,
    provider: request.provider,
    capability: request.capability,
    recipient: a.recipient,
    paramsHash: mapped.intent.paramsHash,
    acceptanceHash: mapped.intent.acceptanceHash,
    expiry: request.deadline,
    nonce: mapped.intent.nonce.toString(),
  };

  let assembled: AssembledEvidenceV3;
  try {
    assembled = assembleDecisionEvidenceV3({
      decisionId: `dec_${keccak256(toHex(`${String(decision.body.intentHash)}:${evaluatedAt}`)).slice(2, 34)}`,
      intentId: String(decision.body.intentHash ?? ""),
      intentHash: decision.body.intentHash as Hex,
      accountId: a.account.accountId,
      walletBindingId: a.wallet.bindingId,
      requester: r,
      policyId: a.policy.id,
      policyHash: a.policy.policyHash,
      policyOwner: a.policy.owner,
      governedAgent: a.policy.agentId,
      snapshot,
      quoteTerms,
      engineVersion: ENGINE_VERSION,
      ruleManifestHash: RULE_MANIFEST_HASH as Hex,
      decision: engineDecision,
      ruleTrace: (decision.body.ruleTrace as Record<string, unknown>[]) ?? [],
      evaluatedAt,
    });
  } catch (err) {
    return {
      status: 500,
      body: {
        outcome: "DECISION_EVIDENCE_INCOMPLETE",
        code: "DECISION_EVIDENCE_INCOMPLETE",
        message:
          "the decision was reached but its evidence could not be assembled, so no result is returned. " +
          `A paid call must produce a record. ${(err as Error).message}`,
        retryable: false,
        docsUrl: null,
        // Enough to reconcile a payment that already settled without charging again.
        reconciliation: { intentHash: decision.body.intentHash ?? null, evaluatedAt },
      },
    };
  }

  if (!publicDeps.evidenceTx) {
    return {
      status: 503,
      body: {
        outcome: "DECISION_EVIDENCE_INCOMPLETE",
        code: "DECISION_EVIDENCE_INCOMPLETE",
        message: "this instance has no evidence store, so a paid decision cannot be recorded",
        retryable: true,
        docsUrl: null,
      },
    };
  }

  try {
    await publicDeps.evidenceTx((tx) => persistDecisionEvidenceV3(tx, assembled));
  } catch (err) {
    return {
      status: 500,
      body: {
        outcome: "DECISION_EVIDENCE_INCOMPLETE",
        code: "DECISION_EVIDENCE_INCOMPLETE",
        message:
          "the decision was reached but could not be persisted. The payment is reconcilable from the " +
          `intent hash below; retry with the same idempotencyKey rather than paying again. ${(err as Error).message}`,
        retryable: true,
        docsUrl: null,
        reconciliation: {
          intentHash: assembled.evidence.intentHash,
          decisionId: assembled.evidence.decisionId,
          quoteDigest: assembled.evidence.quoteDigest,
        },
      },
    };
  }

  const projection = projectionReportV3(assembled.evidence);

  /**
   * The account's use of the policy is recorded AFTER the decision, and a failure to record it does
   * not fail the request. It is provenance, not authority: losing it costs a "last used" timestamp,
   * and letting it fail a decision the engine already made would be trading a real answer for a
   * bookkeeping row.
   */
  try {
    await publicDeps.accounts.recordPolicyUse({
      accountId: a.account.accountId,
      policyId: a.policy.id,
      by: `account:${a.account.accountId}`,
    });
  } catch (err) {
    console.error("[asp] recordPolicyUse failed — the decision stands", err);
  }

  return {
    status: 200,
    body: {
      ...decision.body,
      outcome,
      // The engine's own word stays beside the public one. `ESCALATED_OVER_THRESHOLD` says which rule
      // fired; `ESCALATED` is what a caller branches on. Collapsing them would lose the reason.
      engineDecision,
      account: { accountId: a.account.accountId, wallet: a.wallet.address },
      policy: {
        policyId: a.policy.id,
        policyHash: a.policy.policyHash,
        version: a.policy.version,
        selectedBy: request.policyId ? "explicit" : "account-default",
        expiry: new Date(a.policy.expiry * 1000).toISOString(),
      },
      marketplace:
        a.marketplace === null
          ? null
          : {
              marketplace: a.marketplace.marketplace,
              agentId: a.marketplace.agentId,
              // Reported, never quietly upgraded. `unproven` is the schema saying an id arrived in a
              // header, and a reader deciding how much to trust this decision needs to see that word.
              provenBy: a.marketplace.provenBy,
            },
      /**
       * WHO ASKED, IN WORDS, AND THE RAW VALUE SEPARATELY.
       *
       * `presentRequester` never emits the zero. A direct request reads `Marketplace buyer: None`,
       * because that is the true statement — `Buyer agent 0` would name an agent that does not exist
       * and `Unknown agent` would claim ignorance this record does not have.
       *
       * The raw projection is here too, and only here, for whoever is reconciling against the chain.
       * Offering the words without the bytes would send that person back to reading the zero unaided,
       * which is where every misreading of it starts.
       */
      requester: {
        ...presentRequester(a.requesterEvidence),
        principalKind: a.requesterEvidence.requesterPrincipalKind,
        principalNamespace: a.requesterEvidence.requesterPrincipalNamespace,
        principalRef: a.requesterEvidence.requesterPrincipalRef,
        accountRefHash: a.requesterEvidence.accountRefHash,
        walletAuthorityRef: a.requesterEvidence.walletAuthorityRef,
        raw: rawLegacyAgentProjection(a.requesterEvidence),
      },
      recipient: { address: a.recipient, derivedFrom: a.recipientDerivedFrom },
      derived: [...a.derived, ...mapped.derived],
      /**
       * The evidence this decision was recorded with.
       *
       * The PUBLIC projection is returned, and the booleans state what it contains rather than
       * describing it in prose that cannot be asserted on. `walletBindingIdPresent` is new in V3 and
       * is checked for the same reason `rawAccountIdPresent` is: it names a specific row on a specific
       * account, and the public surface is not the place for it.
       */
      evidence: {
        ...projection.publicProjection,
        metadataCommitment: assembled.metadataHash,
        requesterCommitment: assembled.requesterCommitment,
        rawAccountIdPresent: projection.rawAccountIdPresentInPublic,
        walletBindingIdPresent: projection.walletBindingIdPresentInPublic,
        accountRefHashPresent: projection.accountRefHashPresentInPublic,
        walletAuthorityRefPresent: projection.walletAuthorityRefPresentInPublic,
      },
      executionPosture: {
        enabled: publicDeps.executionEnabled,
        note: publicDeps.executionEnabled
          ? "Provider execution is enabled on this deployment."
          : "Provider execution is DISABLED on this deployment. A decision was recorded and nothing was paid.",
      },
      paid: false,
    },
  };
}
