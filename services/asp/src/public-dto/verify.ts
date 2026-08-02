/**
 * The public delivery verify — one identifier in, the whole record loaded here.
 *
 * WHAT THE OLD CONTRACT ASKED FOR AND WHY IT COULD NOT BE ANSWERED
 *
 * Seventeen protocol fields plus the acceptance criteria that were committed when the work started.
 * That last one is the tell: nothing had ever returned those criteria to the caller, so the only way
 * to satisfy the contract was to reconstruct a value this service is the sole custodian of. A verify
 * that asks the buyer to supply the standard is not a verify.
 *
 * So this route takes the intent id, and every other input is loaded: the policy that judged it, the
 * quote that priced it, the execution that ran, the settlement that moved money, what the provider
 * returned, the delivery evidence, the receipt, and every verification already written against it.
 *
 * THE THREE THINGS IT WILL NOT DO
 *
 * Judge on a partial record and call the result a verification — a missing settlement produces a
 * truthful PENDING, not a fail. Report a delivery on a deployment where nothing could have been
 * delivered — execution being disabled is stated, not papered over. And write a second row for
 * evidence that has not changed — a repeat returns the first verification, because a verification is a
 * dated claim about a state of the record and re-stating it over identical inputs adds nothing but a
 * second charge.
 */

import type {
  AccountStore,
  ConsumerStore,
  DeliveryVerificationRecord,
} from "@untch/consumer-core";
import { hashCanonicalJson } from "@untch/canon";
import type { HandlerResult } from "../handlers";
import { openAccountSession } from "../consumer/account-auth";

export interface PublicVerifyDeps {
  readonly store: ConsumerStore;
  readonly accounts: AccountStore;
  readonly sessionSecret: string;
  readonly executionEnabled: boolean;
  readonly now?: () => number;
}

/**
 * Does this body speak the public verify contract?
 *
 * `intentId` alone, and none of the protocol material. The presence of `policyId`, an inline `intent`
 * or a `delivery` means the caller is driving the internal shape and knows what it holds — routing
 * that here would silently ignore evidence they deliberately sent.
 */
export function looksPublicVerify(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.intentId !== "string" || b.intentId.trim() === "") return false;
  return (
    b.policyId === undefined &&
    b.intent === undefined &&
    b.intentHash === undefined &&
    b.delivery === undefined &&
    b.payload === undefined &&
    b.payloadHash === undefined &&
    b.acceptanceCriteria === undefined
  );
}

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): HandlerResult => ({
  status,
  body: { code, message, retryable: false, docsUrl: null, ...extra },
});

const HASH = /^0x[0-9a-fA-F]{64}$/;

/** What was loaded and what was not. A named gap, never a verification that judged on less. */
interface Evidence {
  readonly policyFound: boolean;
  readonly quoteFound: boolean;
  readonly executionFound: boolean;
  readonly settlementFound: boolean;
  readonly resultFound: boolean;
  readonly deliveryEvidenceFound: boolean;
  readonly receiptFound: boolean;
}

function gaps(e: Evidence): readonly string[] {
  const out: string[] = [];
  if (!e.policyFound) out.push("the policy this intent was judged against");
  if (!e.quoteFound) out.push("the quote that priced it");
  if (!e.executionFound) out.push("the provider execution");
  if (!e.settlementFound) out.push("the settlement");
  if (!e.resultFound) out.push("the delivered result");
  if (!e.deliveryEvidenceFound) out.push("the delivery evidence");
  if (!e.receiptFound) out.push("the receipt");
  return out;
}

/**
 * The public projection of a verification.
 *
 * Deliberately built by NAMING publishable fields rather than by deleting private ones. A redaction
 * list has to be maintained against a growing record and fails silently when somebody adds a field;
 * an allow-list fails by omitting something, which is visible.
 */
function publicView(v: DeliveryVerificationRecord): Record<string, unknown> {
  return {
    verificationId: v.verificationId,
    intentId: v.intentId,
    verified: v.verified,
    method: v.method,
    verifierVersion: v.verifierVersion,
    verifiedAt: v.verifiedAt,
    settlementChain: v.settlementChain,
    settlementTx: v.settlementTx,
    originalReceiptId: v.originalReceiptId,
    supersedingReceiptId: v.supersedingReceiptId,
    refusals: v.refusals,
  };
}

/** The account's own view: everything above, plus what only the owner may read. */
function privateView(v: DeliveryVerificationRecord): Record<string, unknown> {
  return {
    ...publicView(v),
    providerId: v.providerId,
    capability: v.capability,
    executionShape: v.executionShape,
    detail: v.detail,
    requestHash: v.requestHash,
    resultHash: v.resultHash,
    quoteHash: v.quoteHash,
    settledAmount: v.settledAmount,
    evidenceDigest: v.evidenceDigest,
  };
}

export async function handlePublicVerify(
  body: unknown,
  bearer: string | undefined,
  deps: PublicVerifyDeps,
): Promise<HandlerResult> {
  const now = deps.now ?? Date.now;
  const b = (body ?? {}) as Record<string, unknown>;
  const intentId = typeof b.intentId === "string" ? b.intentId.trim() : "";
  if (intentId === "") {
    return refuse(400, "REQUEST_SCHEMA_VIOLATION", "intentId is required");
  }

  const expectedRaw = typeof b.expectedResultHash === "string" ? b.expectedResultHash.trim() : null;
  if (expectedRaw !== null && !HASH.test(expectedRaw)) {
    return refuse(400, "REQUEST_SCHEMA_VIOLATION", "expectedResultHash must be a 0x-prefixed 32-byte hex string");
  }
  const expected = expectedRaw?.toLowerCase() ?? null;

  const token = /^Bearer\s+(.+)$/i.exec(bearer ?? "")?.[1];
  const session = openAccountSession(deps.sessionSecret, token, now());
  if (!session) {
    return refuse(
      401,
      "ACCOUNT_LINK_REQUIRED",
      "a verification is scoped to the account that commissioned the work: sign in with your wallet at " +
        "/consumer/account/link/start and send the session as `Authorization: Bearer <token>`",
      { resolveBy: "/consumer/account/link/start" },
    );
  }

  const intent = await deps.store.getIntent(intentId);
  if (!intent) {
    return refuse(404, "INTENT_NOT_FOUND", `no intent ${intentId} is known here`);
  }

  /**
   * Ownership, checked two ways, and answering 404 for either failure.
   *
   * The policy's account is the strong link. The marketplace binding covers a job that arrived through
   * a marketplace this account has proven. A cross-account read gets the same answer as a nonexistent
   * intent, because distinguishing them would confirm which opaque ids are real.
   */
  const owner = await deps.accounts.accountForPolicy(intent.policyId);
  let authorised = owner?.accountId === session.accountId;
  if (!authorised) {
    const bindings = await deps.accounts.marketplaceBindingsFor(session.accountId);
    authorised = bindings.some(
      (m) => m.status === "ACTIVE" && m.provenBy === "wallet-signature" && m.agentId === intent.requestingAgentId,
    );
  }
  if (!authorised) {
    return refuse(404, "INTENT_NOT_FOUND", `no intent ${intentId} is known here`);
  }

  const [executions, evidence, verifications] = await Promise.all([
    deps.store.listExecutions(intentId),
    deps.store.getDeliveryEvidence(intentId),
    deps.store.listDeliveryVerifications(intentId),
  ]);
  const quote = intent.quoteId ? await deps.store.getQuote(intent.quoteId) : null;
  const settled = executions.find((e) => e.settlementTxHash !== null) ?? null;
  const latest = verifications.length > 0 ? (verifications[0] as DeliveryVerificationRecord) : null;

  /**
   * The result hash lives on the VERIFICATION, not on the delivery evidence.
   *
   * `DeliveryEvidence` records what the provider attested and how Untch checked it; the hash of the
   * answer that was bought is written when a verification is taken, because that is the moment the
   * answer is read and committed to. Reading it from the verification is therefore reading it from
   * the record that is the custodian of it — and when no verification exists yet, there is honestly
   * no recorded result hash to compare an assertion against.
   */
  const recordedResultHash = latest?.resultHash ?? null;

  const loaded: Evidence = {
    policyFound: intent.policyHash !== null,
    quoteFound: quote !== null,
    executionFound: executions.length > 0,
    settlementFound: settled !== null,
    resultFound: recordedResultHash !== null,
    deliveryEvidenceFound: evidence !== null,
    receiptFound: verifications.some((v) => v.originalReceiptId !== null),
  };

  /**
   * The expected-result check runs BEFORE the pending checks.
   *
   * A caller asserting the answer should be X, against a record whose result is Y, has a disagreement
   * worth reporting even when the rest of the record is incomplete — and reporting PENDING first would
   * bury it under a state they cannot act on.
   */
  if (expected !== null && recordedResultHash !== null) {
    const actual = recordedResultHash.toLowerCase();
    if (actual !== expected) {
      return refuse(
        409,
        "EXPECTED_RESULT_MISMATCH",
        "the result recorded for this intent does not have the hash you asserted. This is reported rather " +
          "than judged: what a delivery had to satisfy is the acceptance criteria committed before the work " +
          "started, and an assertion about the answer never overrides them",
        {
          expectedResultHash: expected,
          recordedResultHash: actual,
          verification: latest ? publicView(latest) : null,
        },
      );
    }
  }

  if (!loaded.settlementFound) {
    /**
     * PENDING, with the reason separated from the fact.
     *
     * "Execution is disabled here" and "execution is enabled and this one has not settled yet" are the
     * same absence and completely different situations. A caller polling the second will eventually get
     * an answer; a caller polling the first never will, and deserves to be told so.
     */
    return {
      status: 200,
      body: {
        outcome: "PENDING",
        intentId,
        verified: null,
        state: intent.state,
        message: deps.executionEnabled
          ? "no settlement is recorded for this intent yet, so there is nothing to verify a delivery against"
          : "provider execution is DISABLED on this deployment, so this intent cannot have been delivered and " +
            "must not be reported as verified",
        executionPosture: { enabled: deps.executionEnabled },
        missingEvidence: gaps(loaded),
        // A prior verification is still shown. It is a dated claim about an earlier state of the
        // record, and hiding it because the record is now incomplete would lose history.
        verification: latest ? privateView(latest) : null,
        paid: false,
      },
    };
  }

  if (!latest) {
    return {
      status: 200,
      body: {
        outcome: "PENDING",
        intentId,
        verified: null,
        state: intent.state,
        message:
          "this intent has settled but no delivery verification has been written against it yet. " +
          "Verification runs from the record inside production; it is not computed from this request",
        missingEvidence: gaps(loaded),
        executionPosture: { enabled: deps.executionEnabled },
        verification: null,
        paid: false,
      },
    };
  }

  /**
   * The idempotency key of a verification, and why it is a digest rather than a request id.
   *
   * Two calls a week apart, over a record that did not change, are asking the same question and must
   * get the same answer. Keying on the request would make them two questions; keying on the EVIDENCE
   * makes "has anything changed" the thing that decides, which is what a caller actually means when
   * they retry after a timeout.
   */
  const evidenceDigest = hashCanonicalJson({
    intentId,
    state: intent.state,
    quoteHash: intent.quoteHash,
    executions: executions.map((e) => ({ id: e.executionId, state: e.state, tx: e.settlementTxHash })),
    evidenceHash: evidence?.evidenceHash ?? null,
  });

  return {
    status: 200,
    body: {
      outcome: latest.verified ? "VERIFIED" : "NOT_VERIFIED",
      intentId,
      verified: latest.verified,
      state: intent.state,
      // True when the stored verification was written over the same evidence this call just read.
      // False means the record moved after it was written and a fresh verification is warranted.
      current: latest.evidenceDigest === evidenceDigest,
      evidenceDigest,
      missingEvidence: gaps(loaded),
      executionPosture: { enabled: deps.executionEnabled },
      // Both projections, named. A caller holding an account session may read the private one; the
      // public one is what a receipt page may show to anybody.
      verification: privateView(latest),
      publicVerification: publicView(latest),
      history: verifications.map((v) => ({
        verificationId: v.verificationId,
        verifierVersion: v.verifierVersion,
        verified: v.verified,
        verifiedAt: v.verifiedAt,
      })),
      expectedResultHash: expected,
      expectedResultMatched:
        expected === null || recordedResultHash === null ? null : recordedResultHash.toLowerCase() === expected,
      paid: false,
    },
  };
}
