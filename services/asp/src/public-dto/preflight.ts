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
  commitDecisionEffects,
  createReservation,
  lockPartition,
  newReservationId,
  persistDecisionEvidenceV3,
  presentRequester,
  projectionReportV3,
  quoteDigestOfV3,
  rawLegacyAgentProjection,
  snapshotDecisionState,
  type AssembledEvidenceV3,
  type CanonicalQuoteTermsV3,
  type DecisionStateTx,
  type EvidenceTx,
  type PolicySnapshot,
} from "@untch/consumer-core";
import {
  ENGINE_VERSION,
  RULE_MANIFEST_HASH,
  ledgerPartitionKey,
  proposeDecision,
  utcDayKey,
  type DecisionOutcome,
} from "@untch/policy-engine";
import { toEnginePolicy } from "@untch/policy-store";
import { canonTimestamp } from "@untch/canon";
import type { PgServiceCallStore, ServiceCallTx } from "@untch/consumer-core";
import type { HandlerResult } from "../handlers";
import { assemblePreflightInjects } from "../preflight-state";
import {
  APPROVAL_PATH_READY,
  escalationRefusedForUnreadyPath,
  routeReachability,
  type DecisionOnlyDeps,
} from "../route-profiles";
import { openAccountSession } from "../consumer/account-auth";
import {
  EscalatedApprovalRefused,
  persistEscalatedApproval,
  type EscalatedApprovalRecord,
} from "../consumer/escalated-approval";
import { validateRequoteClaim, type ValidatedRequote } from "@untch/consumer-core";
import type { VerifiedPaymentAuthorizationContext } from "../consumer/payment-authorization";
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
import type { PublicPreflightRequest, PublicRequoteClaim } from "./types";

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
  /**
   * Where the escalated branch records the service call and the payment attempt.
   *
   * A STORE, not a settlement capability. Its whole surface is four SQL statements against two tables,
   * every one of them executed on the transaction handed in, and none of them can reach a facilitator,
   * a signer or a chain. It sits here rather than on `DecisionOnlyDeps` for the same reason `evidenceTx`
   * does: writing a row inside the caller's transaction is something a rollback undoes, and that is the
   * boundary those types are drawn on.
   *
   * Null on an instance with no database. The escalated branch then refuses rather than raising an
   * approval nothing could later activate.
   */
  readonly serviceCalls?: PgServiceCallStore | null;
  /**
   * Whether the approval path is ready, defaulting to what this build was compiled with.
   *
   * Injectable so the CLOSED behaviour stays exercisable after the constant was flipped to true. That
   * refusal is the fallback an operator has if the path ever has to be shut again, and a fallback
   * nothing tests is one that has quietly stopped working. Production passes nothing and gets the
   * constant, so this cannot become a way to arm or disarm the path at runtime.
   */
  readonly approvalPathReady?: boolean;
  /**
   * How long a human is given to answer, in milliseconds.
   *
   * Separate from the caller's `deadline`, which is when the QUOTE ages out. The two are different
   * facts and the approval digest binds both, so collapsing them would make an approval window inherit
   * whatever expiry a caller happened to ask for.
   */
  readonly approvalWindowMs?: number;
}

/** The default human window. Long enough for a person to read a message, answer and be wrong once. */
export const DEFAULT_APPROVAL_WINDOW_MS = 60 * 60_000;

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

function readRequest(
  body: unknown,
): PublicPreflightRequest | { readonly missing: readonly string[] } | { readonly malformed: "requote" } {
  const b = (body ?? {}) as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((f) => typeof b[f] !== "string" || (b[f] as string).trim() === "");
  if (missing.length > 0) return { missing };

  const requote = readRequote(b);
  if (requote === REQUOTE_MALFORMED) return { malformed: "requote" };

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
    ...(requote !== null ? { requote } : {}),
  };
}

/**
 * The requote claim, read strictly.
 *
 * A malformed `requote` is NOT silently dropped. Dropping it would turn "replace my 6.00 with a 6.50"
 * into "buy a second 6.50 alongside the 6.00", which is the accumulation the whole lineage concept
 * exists to prevent — arriving through a typo rather than through an attack. So a present-but-invalid
 * object returns the sentinel below and the handler refuses.
 */
const REQUOTE_MALFORMED = Symbol("requote-malformed");

function readRequote(b: Record<string, unknown>): PublicRequoteClaim | null | typeof REQUOTE_MALFORMED {
  const raw = b.requote;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) return REQUOTE_MALFORMED;

  const o = raw as Record<string, unknown>;
  const req = (k: string): string | null =>
    typeof o[k] === "string" && (o[k] as string).trim() !== "" ? (o[k] as string).trim() : null;

  const quoteLineageId = req("quoteLineageId");
  const previousQuoteDigest = req("previousQuoteDigest");
  const supersedesApprovalRequestId = req("supersedesApprovalRequestId");
  if (!quoteLineageId || !previousQuoteDigest || !supersedesApprovalRequestId) return REQUOTE_MALFORMED;

  /**
   * The reservation is the one field that may legitimately be absent, because a PROVISIONAL or PENDING
   * predecessor holds none. Absent and explicit-null are treated as the same claim — "it holds no
   * reservation" — and the validator refuses if that turns out to be false.
   */
  const reservation = o.supersedesReservationId;
  if (reservation !== undefined && reservation !== null && typeof reservation !== "string") return REQUOTE_MALFORMED;
  const supersedesReservationId =
    typeof reservation === "string" && reservation.trim() !== "" ? reservation.trim() : null;

  return { quoteLineageId, previousQuoteDigest, supersedesApprovalRequestId, supersedesReservationId };
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
  /**
   * DECISION-ONLY, enforced by the type and by a compile-time assertion in `route-profiles.ts`.
   *
   * It previously took `PreflightDeps`, which carries the escalation gateway, the receipt enqueuer,
   * the intent registry and the oracle signer. Whether this route could reach an executor was then a
   * question about wiring, answerable only by reading the call site — and the answer changed with a
   * global environment flag that exists for a completely different route.
   *
   * `DecisionOnlyDeps` cannot NAME an executor. The guarantee is checked by `tsc`, holds regardless of
   * `CONSUMER_EXECUTION_ENABLED`, and does not weaken because some other route may legitimately
   * execute a provider.
   */
  decisionDeps: DecisionOnlyDeps,
  /**
   * THE PAYMENT AS EVIDENCE, NEVER AS A CAPABILITY.
   *
   * `VerifiedPaymentAuthorizationContext` is strings and nulls — proven callable-free by a `tsc`
   * assertion in `payment-authorization.ts`. It carries no settlement function, no facilitator client,
   * no treasury signer, no provider executor, no raw bearer, no signature and no key.
   *
   * It is a FIFTH parameter rather than a field on `decisionDeps` deliberately. `DecisionOnlyDeps` is
   * the type whose guarantee is that this route cannot name an executor, and widening it — even with
   * something inert — would make that guarantee a judgement about each field rather than a property of
   * the type. So the dependency bundle stays exactly as it was, and the request's own evidence arrives
   * as what it is: part of the request.
   */
  paymentAuthorization: VerifiedPaymentAuthorizationContext | null = null,
): Promise<HandlerResult> {
  const now = publicDeps.now ?? Date.now;
  /** What this build was compiled with, unless a caller is deliberately exercising the closed gate. */
  const approvalPathReady = publicDeps.approvalPathReady ?? APPROVAL_PATH_READY;
  const parsed = readRequest(body);
  if ("malformed" in parsed) {
    /**
     * Refused rather than ignored, and the message says what ignoring it would have cost.
     *
     * A caller who meant to replace a quote and mistyped one field would otherwise get a second live
     * request at the new price beside the old one at the old price — two authorities, two answerable
     * messages, and double the exposure for one piece of work.
     */
    return {
      status: 400,
      body: {
        outcome: "REQUEST_SCHEMA_VIOLATION",
        code: "REQUOTE_CLAIM_MALFORMED",
        message:
          "requote must name quoteLineageId, previousQuoteDigest and supersedesApprovalRequestId as " +
          "non-empty strings, and supersedesReservationId as a string or null. This request was " +
          "refused rather than treated as a new quote, which would have left two live requests for " +
          "one piece of work.",
        retryable: false,
        docsUrl: null,
      },
    };
  }
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
  void decisionDeps.intentStore;

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

  if (!publicDeps.evidenceTx) {
    return {
      status: 503,
      body: {
        outcome: "DECISION_EVIDENCE_INCOMPLETE",
        code: "DECISION_EVIDENCE_INCOMPLETE",
        message: "this instance has no evidence store, so a decision cannot be reached or recorded",
        retryable: true,
        docsUrl: null,
      },
    };
  }

  /**
   * ── THE DECISION, ITS EVIDENCE AND ITS EFFECTS ARE ONE TRANSACTION ────────
   *
   * WHAT THIS REPLACES, AND WHY IT HAD TO CHANGE
   *
   * The engine used to read its window from a process singleton and write an APPROVED intent's
   * duplicate marker, spend, rate tick and cooldown straight back into it — outside any transaction.
   * The always-rollback validation route could therefore roll back every database write perfectly and
   * still change the next real decision. On 2026-08-03 it did: a non-billable 4.00 validation made a
   * genuine 4.00 return BLOCKED_DUPLICATE minutes later.
   *
   * Now the window is read from Postgres inside the caller's transaction, the evaluation is pure and
   * returns a PROPOSAL, and the proposal is applied — if at all — through the same transaction that
   * writes the evidence. A rollback removes the decision, its evidence and every state change that
   * could alter a later decision, because they are the same rollback.
   *
   * The advisory lock is taken on the policy partition and released by COMMIT or ROLLBACK. It
   * serialises two replicas, which the in-process mutex never could.
   */
  const nowMs = now();
  const dayKey = utcDayKey(nowMs);
  const partitionKey = ledgerPartitionKey(a.policy.id);
  const enginePolicy = toEnginePolicy(a.policy);

  const evaluatedAt = new Date(Math.floor(nowMs / 1000) * 1000).toISOString();
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
  const quoteTermsFor = (intentHash: string, quoteVersion: number): CanonicalQuoteTermsV3 => ({
    quoteSchemaVersion: 3,
    /**
     * On a first quote: the caller's idempotency key when they gave one, because that is the value they
     * chose to identify this logical request. Without one it is the intent hash, which is unique per
     * request and therefore correctly makes every call its own lineage.
     *
     * On a REQUOTE: the lineage the predecessor already carries. That is what `lineage` and `version`
     * were declared for — "a re-quote of the same logical work shares the lineage and increments the
     * version" — and it is what puts the lineage inside the quote digest, so a requote's digest cannot
     * be produced by a request that did not claim the lineage.
     *
     * A first quote's lineage is deliberately UNCHANGED by this commit. Deriving it from the minted
     * `qln_` id instead would have altered the digest of every decision this route has ever taken,
     * requote or not, which is the rewriting-the-past failure this repository keeps refusing.
     */
    lineage: request.requote?.quoteLineageId ?? request.idempotencyKey ?? intentHash,
    version: quoteVersion,
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
    /**
     * The deadline at SECOND resolution, the same normalisation the intent hash uses.
     *
     * Found by a test: two requests carrying the same idempotency key produced the same intentHash
     * and DIFFERENT quote digests. The intent floors the deadline to unix seconds; the quote was
     * committing the caller's raw ISO string, milliseconds and all. So a retry after a timeout — the
     * exact case an idempotency key exists for — produced a second digest, and an approval raised
     * against the first would have matched nothing.
     *
     * `canonTimestamp` is the repository's §9 normaliser and is what the intent path already agrees
     * with, so this makes one logical request have one digest rather than inventing a second rule.
     */
    expiry: canonTimestamp(request.deadline),
    nonce: mapped.intent.nonce.toString(),
  });

  /**
   * One transaction: read the window, judge, record the evidence, apply the effects.
   *
   * `evidenceTx` is supplied by the ROUTE. The paid route commits it; the validation route rolls it
   * back. Because everything that could change a later decision happens inside it, those two routes
   * differ in exactly one thing — whether the transaction commits — and in nothing else.
   */
  /**
   * Thrown inside the decision transaction when an escalation cannot reach a human.
   *
   * A sentinel rather than a returned value, because the refusal has to take the TRANSACTION with
   * it. Returning early would leave the evidence row and the durable decision state committed for a
   * request that was never served — poisoning the duplicate, replay, rate and cooldown windows for a
   * decision the caller could not act on and will legitimately retry.
   */
  class ApprovalPathUnavailable extends Error {
    constructor(public readonly engineDecision: string) {
      super("approval path not ready");
      this.name = "ApprovalPathUnavailable";
    }
  }

  interface Committed {
    readonly assembled: AssembledEvidenceV3;
    readonly engineDecision: DecisionOutcome;
    readonly ruleTrace: readonly Record<string, unknown>[];
    readonly reasons: readonly string[];
    readonly intentHash: Hex;
    readonly effectsApplied: boolean;
    readonly reservationId: string | null;
    readonly budgetUsage: { readonly settledToday: number; readonly reservedActiveToday: number; readonly effectiveToday: number };
    readonly stateBefore: { readonly recentIntents: number; readonly callsInLastHour: number };
    /** Present only when this decision escalated AND the approval path is wired. */
    readonly escalated: EscalatedApprovalRecord | null;
    /** Present only on a requote that passed validation. The predecessor is still untouched. */
    readonly requote: ValidatedRequote | null;
  }

  /**
   * Thrown inside the decision transaction when a requote claim does not hold.
   *
   * A sentinel for the same reason `ApprovalPathUnavailable` is one: the refusal has to take the
   * transaction with it. A returned value would leave the evidence row, the replay marker and the
   * decision-state window committed for a request that raised nothing — poisoning the duplicate,
   * cooldown and rate windows for a caller whose only mistake was naming a predecessor that had moved.
   *
   * x402 settles only on a 2xx, so the non-2xx this produces is also what stops the fee being taken for
   * a refusal.
   */
  class RequoteRefused extends Error {
    constructor(
      public readonly refusal: string,
      public readonly detail: string,
    ) {
      super(detail);
      this.name = "RequoteRefused";
    }
  }

  let committed: Committed;
  try {
    committed = await publicDeps.evidenceTx(async (tx) => {
      // Serialises this policy's read→judge→commit against every other instance. Released by COMMIT
      // or ROLLBACK, by Postgres — not by a `finally` this process has to reach.
      await lockPartition(tx as DecisionStateTx, partitionKey);

      const windowState = await snapshotDecisionState(tx as DecisionStateTx, partitionKey, nowMs, dayKey);
      const injects = await assemblePreflightInjects(mapped.intent, body, decisionDeps.scoreDataSource ?? null);
      const stateWithInjects = { ...windowState, ...injects };

      // PURE. Returns a decision and a PROPOSAL; mutates nothing anywhere.
      const { decision: engineResult, effects } = proposeDecision(
        mapped.intent,
        enginePolicy,
        stateWithInjects,
        { nowMs, ...(decisionDeps.now ? { now: decisionDeps.now } : {}) },
      );

      const intentHash = engineResult.intentHash;

      /**
       * ── THE REQUOTE GATE ──────────────────────────────────────────────
       *
       * Run BEFORE the evidence is assembled, because the verdict carries the lineage position and the
       * position is hashed into the quote digest. Assembling first and validating afterwards would mean
       * the digest committed to a version the validator had not agreed to.
       *
       * It runs on THIS transaction and takes the predecessor's row lock, which is what makes "the
       * prior authority has not changed" true of the row this request was validated against rather than
       * true at the instant it was read. A concurrent Approve on the predecessor queues behind it.
       *
       * It changes nothing. The predecessor is read, compared and left exactly as it was.
       */
      let validatedRequote: ValidatedRequote | null = null;
      if (request.requote) {
        const provisionalTerms = quoteTermsFor(intentHash, 1);
        const verdict = await validateRequoteClaim(
          tx as ServiceCallTx,
          {
            quoteLineageId: request.requote.quoteLineageId,
            previousQuoteDigest: request.requote.previousQuoteDigest,
            supersedesApprovalRequestId: request.requote.supersedesApprovalRequestId,
            supersedesReservationId: request.requote.supersedesReservationId ?? null,
          },
          {
            accountId: a.account.accountId,
            requesterPrincipalRef: r.requesterPrincipalRef,
            provider: request.provider,
            capability: request.capability,
            asset: request.currency,
            chain: `eip155:${publicDeps.chainId}`,
            recipient: a.recipient,
            taskHash: mapped.intent.paramsHash,
            acceptanceHash: mapped.intent.acceptanceHash,
            policyId: a.policy.id,
            /**
             * The digest the new terms WOULD produce at version 1, used only to answer "is this quote
             * actually different". Comparing at the real version would make every requote trivially
             * different from its predecessor, because the version is inside the hash — so the unchanged-
             * quote refusal would never fire and a caller could mint a fresh request on identical terms
             * whenever the duplicate window was inconvenient.
             */
            newQuoteDigest: quoteDigestOfV3(provisionalTerms),
          },
        );
        if (!verdict.ok) throw new RequoteRefused(verdict.refusal, verdict.detail);
        validatedRequote = verdict;
      }

      const quoteTerms = quoteTermsFor(intentHash, validatedRequote?.quoteVersion ?? 1);
      const assembledEvidence = assembleDecisionEvidenceV3({
        decisionId: `dec_${keccak256(toHex(`${intentHash}:${evaluatedAt}`)).slice(2, 34)}`,
        intentId: intentHash,
        intentHash,
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
        decision: engineResult.decision,
        ruleTrace: engineResult.rules as unknown as Record<string, unknown>[],
        evaluatedAt,
      });

      /**
       * ── THE SAFETY GATE ───────────────────────────────────────────────
       *
       * An escalated decision promises that a human will be asked. On the account path nothing
       * currently asks one: PR #65 removed the only escalation call site, and the writer that
       * replaces it is not built yet. Returning 200 here would take 0.05 USDT0 for a promise the
       * service cannot keep, and would leave the caller waiting for a message nobody will send.
       *
       * So it refuses BEFORE the evidence is written, from inside the transaction. Everything this
       * decision touched rolls back — evidence, replay marker, recent intent, rate tick, cooldown —
       * because the same request must remain eligible the moment the approval path is available.
       * Poisoning a duplicate window on behalf of a service that could not complete would punish the
       * caller twice for one outage.
       *
       * x402 settles only on a 2xx, so the non-2xx below is also what stops the fee being taken.
       */
      if (escalationRefusedForUnreadyPath(approvalPathReady, engineResult.decision)) {
        throw new ApprovalPathUnavailable(engineResult.decision);
      }

      await persistDecisionEvidenceV3(tx, assembledEvidence);

      /**
       * ── THE ESCALATED BRANCH ──────────────────────────────────────────
       *
       * Reached only when the path is wired. Everything it writes is PROVISIONAL: a service call, the
       * payment attempt that bought it, and an approval request that is explicitly NOT actionable.
       *
       * No outbox event, no delivery, no reservation and no channel call happen here. Those belong to
       * the finalizer and the worker, which run after this transaction has committed AND after an
       * authority has confirmed the fee actually settled. Writing any of them now would be promising a
       * human something the process cannot yet know was paid for.
       *
       * It is inside the transaction on purpose. A rollback removes the approval request along with the
       * decision that raised it, so a caller whose request failed stays eligible to make it again.
       */
      let escalated: EscalatedApprovalRecord | null = null;
      if (engineResult.decision.startsWith("ESCALATED")) {
        if (!publicDeps.serviceCalls) {
          throw new EscalatedApprovalRefused(
            "this instance has no service-call store, so an escalated decision cannot record the payment " +
              "that bought it and could never be activated",
            "PAYMENT_AUTHORIZATION_ABSENT",
          );
        }
        escalated = await persistEscalatedApproval(tx as ServiceCallTx, publicDeps.serviceCalls, paymentAuthorization, {
          route: "/preflight_payment",
          accountId: a.account.accountId,
          /**
           * The caller's key when they gave one, and the intent hash when they did not — the same rule
           * the quote lineage uses, and for the same reason: a retry after a lost response has to
           * resolve to the SAME service call rather than buying a second one.
           */
          idempotencyKey: request.idempotencyKey ?? intentHash,
          provider: request.provider,
          capability: request.capability,
          amount: request.maxSpend,
          asset: request.currency,
          deadline: canonTimestamp(request.deadline),
          chain: `eip155:${publicDeps.chainId}`,
          recipient: a.recipient,
          decisionId: assembledEvidence.evidence.decisionId,
          intentHash,
          quoteDigest: assembledEvidence.evidence.quoteDigest,
          policySnapshotHash: assembledEvidence.evidence.policySnapshotHash,
          policyId: a.policy.id,
          policyHash: a.policy.policyHash,
          policyVersion: a.policy.version,
          intentNonce: mapped.intent.nonce.toString(),
          taskHash: mapped.intent.paramsHash,
          acceptanceHash: mapped.intent.acceptanceHash,
          requesterPrincipalKind: r.requesterPrincipalKind,
          requesterPrincipalNamespace: r.requesterPrincipalNamespace,
          requesterPrincipalRef: r.requesterPrincipalRef,
          accountRefHash: r.accountRefHash,
          walletAuthorityRef: r.walletAuthorityRef,
          reason: engineResult.decision,
          approvalExpiresAt: new Date(nowMs + (publicDeps.approvalWindowMs ?? DEFAULT_APPROVAL_WINDOW_MS)).toISOString(),
          /**
           * The VALIDATED verdict, not the caller's claim.
           *
           * `persistEscalatedApproval` has no rules of its own about supersession and must not acquire
           * any — one gate, holding one lock, is what makes the answer reproducible.
           */
          ...(validatedRequote
            ? {
                requote: {
                  quoteLineageId: validatedRequote.quoteLineageId,
                  quoteVersion: validatedRequote.quoteVersion,
                  previousQuoteDigest: validatedRequote.priorQuoteDigest,
                  supersedesApprovalRequestId: validatedRequote.priorApprovalRequestId,
                  supersedesReservationId: validatedRequote.priorReservationId,
                },
              }
            : {}),
        });
      }

      /**
       * The proposal is applied HERE and only here.
       *
       * A non-APPROVED decision proposes nothing: it consumed no budget and is not a duplicate that
       * later requests should be measured against. So `effects` is null and nothing is written —
       * which is why three blocked validations in a row leave the window exactly as they found it.
       */
      let reservationId: string | null = null;
      if (effects) {
        await commitDecisionEffects(tx as DecisionStateTx, effects);

        /**
         * THE APPROVAL RESERVES BUDGET. IT DOES NOT SPEND IT.
         *
         * `/preflight_payment` is decision-only: no provider runs, no payment settles, no delivery
         * occurs. The governed amount is authority granted, and recording it as spend is what made an
         * authorisation look like a completed payment in the ledger, the reports and the dashboard.
         *
         * It still has to be VISIBLE to the next decision, or two agents could each be approved
         * against the same remaining capacity. So it becomes an ACTIVE reservation, written in this
         * same transaction — which means a rolled-back validation leaves no hold either.
         *
         * The hold expires with the caller's own deadline. Authority that outlived the request that
         * asked for it would shrink a user's budget with permission nobody can still use.
         */
        reservationId = await createReservation(tx as DecisionStateTx, {
          reservationId: newReservationId(),
          accountId: a.account.accountId,
          policyId: a.policy.id,
          partitionKey,
          decisionId: assembledEvidence.evidence.decisionId,
          intentId: intentHash,
          intentHash,
          quoteDigest: assembledEvidence.evidence.quoteDigest,
          requesterPrincipalRef: r.requesterPrincipalRef,
          walletAuthorityRef: r.walletAuthorityRef,
          amount: request.maxSpend,
          asset: request.currency,
          chain: `eip155:${publicDeps.chainId}`,
          recipient: a.recipient,
          provider: request.provider,
          capability: request.capability,
          dayKey,
          expiresAt: canonTimestamp(request.deadline),
        });
      }

      return {
        assembled: assembledEvidence,
        engineDecision: engineResult.decision,
        ruleTrace: engineResult.rules as unknown as Record<string, unknown>[],
        reasons: engineResult.reasons,
        intentHash,
        effectsApplied: effects !== null,
        reservationId,
        budgetUsage: windowState.budgetUsage,
        stateBefore: {
          recentIntents: windowState.recentIntents.length,
          callsInLastHour: windowState.callsInLastHour,
        },
        escalated,
        requote: validatedRequote,
      };
    });
  } catch (err) {
    if (err instanceof ApprovalPathUnavailable) {
      /**
       * Non-2xx, so the x402 middleware does not settle. Nothing was charged and nothing was kept.
       *
       * The body says what the engine decided, because a caller is entitled to know their request
       * WOULD need human approval — that is useful and true. It does not say a human was notified,
       * which would be the lie this gate exists to prevent.
       *
       * On the signed payment authorization the caller sent: this gate commits no replay marker, no
       * decision state and no settlement, so nothing here makes that authorization unusable at the
       * protocol level. The rule is a client-side one and is stated as such: the client discards the
       * authorization after a failed attempt, and a later retry mints and signs a fresh one. No
       * durable payment-auth replay record is added for this hotfix, because x402 does not require
       * one for an unsettled attempt and inventing one would be new state on a refusal path whose
       * entire promise is that it writes nothing.
       */
      return {
        status: 503,
        /**
         * `Retry-After` is a backoff hint, not a promise that approval will be reachable in five
         * minutes. `no-store` because a cached 503 would keep refusing after the path is wired.
         */
        headers: { "Retry-After": "300", "Cache-Control": "no-store" },
        body: {
          outcome: "APPROVAL_PATH_NOT_READY",
          code: "APPROVAL_PATH_NOT_READY",
          message: "Human approval is temporarily unavailable. No payment was taken.",
          decisionOutcome: err.engineDecision,
          approvalPathAvailable: false,
          servicePaymentSettled: false,
          paymentConsumed: false,
          retryable: true,
          retryAfterApprovalPathActivation: true,
          // Stated so nobody has to infer it from the absence of a field.
          humanNotified: false,
          decisionPersisted: false,
          docsUrl: null,
        },
      };
    }
    if (err instanceof RequoteRefused) {
      /**
       * 409, not 503 and not 400.
       *
       * The request is well-formed and the service is healthy. What is wrong is a claim about state:
       * the predecessor has moved, or was never what the caller believed. A conflict is what a client
       * can act on — re-read the lineage and try again with what is actually there — and it is what
       * stops a retry loop treating this as a transient outage.
       *
       * Nothing was written. The transaction that would have carried the evidence, the replay marker
       * and the decision-state window rolled back with this, so the same request stays eligible the
       * moment the caller's view of the lineage is correct.
       */
      return {
        status: 409,
        headers: { "Cache-Control": "no-store" },
        body: {
          outcome: "REQUOTE_REFUSED",
          code: err.refusal,
          message: err.detail,
          /**
           * The three facts a caller most needs to be told explicitly, because the alarming reading of
           * a refused requote is "did it take my old approval with it".
           */
          priorAuthorityUnchanged: true,
          servicePaymentSettled: false,
          paymentConsumed: false,
          humanNotified: false,
          decisionPersisted: false,
          retryable: false,
          docsUrl: null,
        },
      };
    }
    if (err instanceof EscalatedApprovalRefused) {
      /**
       * The escalated branch could not record what it needed to, so the whole decision rolls back.
       *
       * Non-2xx, so `paymentMiddleware` never settles: the caller is not charged for a request that
       * raised nothing. `SERVICE_CALL_NOT_CLAIMABLE` is the one case that means the OPPOSITE of a
       * failure — the work was already bought — and it is reported as a conflict rather than an
       * outage so a client retries through the replay resolver rather than paying again.
       */
      const alreadyPaid = err.code === "SERVICE_CALL_NOT_CLAIMABLE";
      return {
        status: alreadyPaid ? 409 : 503,
        headers: alreadyPaid ? { "Cache-Control": "no-store" } : { "Retry-After": "60", "Cache-Control": "no-store" },
        body: {
          outcome: "APPROVAL_REQUEST_NOT_RECORDABLE",
          code: err.code,
          message: err.message,
          approvalPathAvailable: approvalPathReady,
          servicePaymentSettled: false,
          paymentConsumed: false,
          humanNotified: false,
          decisionPersisted: false,
          retryable: !alreadyPaid,
          docsUrl: null,
        },
      };
    }
    return {
      status: 500,
      body: {
        outcome: "DECISION_EVIDENCE_INCOMPLETE",
        code: "DECISION_EVIDENCE_INCOMPLETE",
        message:
          "the decision could not be reached and recorded as one atomic unit, so nothing was recorded " +
          `and nothing was changed. Retry with the same idempotencyKey rather than paying again. ${(err as Error).message}`,
        retryable: true,
        docsUrl: null,
      },
    };
  }

  const assembled = committed.assembled;
  const engineDecision = committed.engineDecision;
  const outcome = publicOutcomeFor(engineDecision);
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
      decision: engineDecision,
      intentHash: committed.intentHash,
      policyId: a.policy.id,
      reasons: committed.reasons,
      ruleTrace: committed.ruleTrace,
      evaluatedAt,
      outcome,
      /**
       * What this ROUTE can reach, stated in its own response.
       *
       * Not a claim about the deployment — a claim about this route, derived from the dependency type
       * it is wired with. `globalProviderExecutionEnabled` may be true beside it, and the three
       * reachability booleans are still false, because they are answers to a different question.
       */
      routeExecution: routeReachability("/preflight_payment"),
      /**
       * What the decision changed, and what it read before deciding.
       *
       * `effectsApplied` is false for every non-APPROVED outcome, which is how a caller can see that
       * three blocked evaluations in a row leave the duplicate window exactly as they found it.
       */
      decisionState: {
        partitionKey,
        effectsApplied: committed.effectsApplied,
        observedBeforeDecision: committed.stateBefore,
      },
      /**
       * WHAT WAS RESERVED, AND WHAT WAS SPENT. NEVER ONE NUMBER.
       *
       * `0.05 USDT0` is the x402 fee for this preflight — real money, Untch revenue, and not part of
       * the governed budget at all. The amount below is the governed authority: no provider ran, no
       * payment settled, no delivery happened, and there is no provider liability. A surface that
       * merged the two would be describing a payment that did not occur.
       */
      budget: {
        settledGovernedSpend: committed.budgetUsage.settledToday,
        activeReservedExposureBefore: committed.budgetUsage.reservedActiveToday,
        effectiveUsageBefore: committed.budgetUsage.effectiveToday,
        proposedReservation: committed.effectsApplied ? request.maxSpend : null,
        reservationId: committed.reservationId,
        /**
         * The hold's effective state, not merely its stored one.
         *
         * A reservation past `expires_at` stops counting toward exposure immediately, but the row
         * still reads ACTIVE until a sweeper runs. Publishing only the stored status would tell an
         * API, the Explorer or a person that authority is live when none is.
         */
        reservation: committed.reservationId
          ? {
              storedStatus: "ACTIVE",
              effectiveStatus: "ACTIVE",
              countsTowardExposure: true,
              expiresAt: canonTimestamp(request.deadline),
              terminalReason: null,
            }
          : null,
        economicClassification: committed.effectsApplied
          ? "RESERVED_AUTHORITY_NOT_SPEND"
          : "NO_AUTHORITY_GRANTED",
        note:
          "The governed amount is authority reserved, not money spent. This route is decision_only: " +
          "no provider execution, no settlement and no delivery occurred. The only money moving in " +
          "this call is the x402 service fee, which is Untch revenue and is not governed spend.",
      },
      /**
       * WHAT WAS RAISED, AND WHAT IT IS NOT YET.
       *
       * `state: "PROVISIONAL"` is the honest answer at this moment and the field a caller must branch
       * on. The handler's transaction commits BEFORE the fee settles, and a pending facilitator status
       * is reported as success, so nothing here can claim the request is actionable. It becomes PENDING
       * only when an authority confirms the settlement, and `humanNotified` stays false until the
       * delivery worker has actually sent something.
       */
      approval:
        committed.escalated === null
          ? null
          : {
              approvalRequestId: committed.escalated.approvalRequestId,
              approvalDigest: committed.escalated.approvalDigest,
              serviceCallId: committed.escalated.serviceCallId,
              quoteLineageId: committed.escalated.quoteLineageId,
              quoteVersion: committed.escalated.quoteVersion,
              /**
               * WHAT THIS WILL RETIRE, AND THAT IT HAS NOT.
               *
               * The tense is the whole content of this field. A caller reading `supersedes: "aprq_…"`
               * with no further qualification would reasonably conclude the 6.00 is gone, and act on
               * it — stop showing it, stop counting its exposure, tell the user it was replaced. It is
               * not gone. It is untouched, still answerable if it was PENDING, still holding its
               * reservation if it was APPROVED, and it stays that way unless an authority confirms this
               * request's fee actually settled.
               */
              requote:
                committed.requote === null
                  ? null
                  : {
                      supersedesApprovalRequestId: committed.requote.priorApprovalRequestId,
                      supersedesReservationId: committed.requote.priorReservationId,
                      previousQuoteDigest: committed.requote.priorQuoteDigest,
                      previousAmount: committed.requote.priorAmount,
                      previousState: committed.requote.priorState,
                      priorAuthorityRetired: false,
                      priorAuthorityStillLive: committed.requote.priorState !== "PROVISIONAL",
                      retiresOn: "confirmed settlement of this request's service fee",
                      note:
                        "The earlier request has NOT been replaced. It keeps its state, its reservation " +
                        "and its buttons until an authority confirms this request's fee settled. If that " +
                        "payment fails, the earlier authority survives untouched — a failed payment does " +
                        "not revoke authority that was already granted.",
                    },
              state: committed.escalated.state,
              actionable: false,
              humanNotified: false,
              activatesOn: "confirmed settlement of the service fee, verified against the facilitator",
              note:
                "This request is PROVISIONAL. The service fee for it has been authorised and not yet " +
                "confirmed settled, so no message has been sent and no authority exists. Poll the " +
                "approval case rather than treating this response as a request a human can see.",
            },
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
