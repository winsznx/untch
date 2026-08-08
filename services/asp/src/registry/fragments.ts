import type { JsonSchema, Predecessor } from "./types";

/**
 * The field shapes that recur across contracts, written once.
 *
 * These are not conveniences. Six of the seventeen fields `preflight_payment` demands are one of
 * these four shapes, and the rule that catches callers out — that uint256 values arrive as decimal
 * STRINGS while `amount` arrives as a JSON number — is invisible when each field is described in
 * isolation. Naming the shapes makes the inversion legible in one place and impossible to describe
 * two different ways in two definitions.
 */

export const BYTES32_PATTERN = "^0x[0-9a-fA-F]{64}$";
export const ADDRESS_PATTERN = "^0x[0-9a-fA-F]{40}$";
export const UINT256_PATTERN = "^[0-9]+$";

export const bytes32 = (description: string): JsonSchema => ({
  type: "string",
  pattern: BYTES32_PATTERN,
  description,
  examples: ["0x" + "ab".repeat(32)],
});

export const address = (description: string): JsonSchema => ({
  type: "string",
  pattern: ADDRESS_PATTERN,
  description,
  examples: ["0xd9ed4d474b0d01031d10d637546450f39ed6a5ba"],
});

/**
 * A uint256 as a decimal string.
 *
 * JSON has no integer type wide enough for uint256, and a JS number silently loses precision above
 * 2^53. The validators reject a JSON number here outright rather than accepting a value they would
 * have to round — so the description says so, because a caller who sends `5000000` and is refused
 * needs to know the fix is quotes, not a different number.
 */
export const uint256String = (description: string): JsonSchema => ({
  type: "string",
  pattern: UINT256_PATTERN,
  description: `${description} Sent as a DECIMAL STRING, not a JSON number — JSON numbers cannot carry uint256 without losing precision, so a number here is refused rather than rounded.`,
  examples: ["1000000"],
});

export const policyIdField: JsonSchema = {
  type: "string",
  pattern: UINT256_PATTERN,
  description:
    "The id of a policy registered on the PolicyRegistry contract, as a decimal string. It names the spending rules this request is judged against.",
  examples: ["7"],
};

export const isoTimestamp = (description: string): JsonSchema => ({
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
  description,
  examples: ["2026-08-01T12:00:00.000Z"],
});

/** The `{code, message, retryable, docsUrl}` envelope every refusal uses. */
export const ERROR_ENVELOPE: JsonSchema = {
  type: "object",
  title: "Refusal",
  description: "The shape of every refusal this service returns, at every status code.",
  properties: {
    code: { type: "string", description: "A stable machine-readable reason. Safe to branch on." },
    message: { type: "string", description: "One sentence a caller can act on." },
    retryable: {
      type: "boolean",
      description: "Whether repeating the identical request could succeed without changing it.",
    },
    docsUrl: { type: ["string", "null"], description: "Where the rule is written down, when it is." },
    correlationId: {
      type: "string",
      description:
        "Present only on an unclassified internal failure. Quote it when reporting; it names the log line holding the cause.",
    },
  },
  required: ["code", "message", "retryable"],
};

/**
 * The predecessor that makes two listed services unreachable.
 *
 * `obtainableBy: null` is a factual claim checked by a test: no registered service produces a policy
 * id. It is recorded here once so both dependent contracts state the same thing, and so the listing
 * generator can refuse to publish a service whose predecessor nobody can satisfy.
 */
/**
 * An account, which is where wallet authority comes from.
 *
 * FIRST in every predecessor list that mentions a policy, because it is genuinely first: a policy is
 * owned by a wallet, and until a wallet has proven itself there is no "your policy" for a route to
 * resolve. The audit's central finding was that two listed services were UNREACHABLE — they needed a
 * policy no public route could create. This is the front half of that chain finally having a route.
 */
export const ACCOUNT_PREDECESSOR: Predecessor = {
  what: "An Untch account, established by proving a wallet.",
  why: "Authority here is a verified wallet and nothing else. Without one there is no owner for a policy, no subject for an approval, and no account a marketplace identity can be bound to.",
  obtainableBy: "POST /consumer/account/link/start, sign the message, then POST /consumer/account/link/complete",
};

/**
 * `obtainableBy` was `null`, and that was the honest answer: no public route created a policy.
 *
 * It is no longer null, and the change is not cosmetic. The listing generator refuses to emit a
 * submission entry for a service whose predecessors carry `obtainableBy: null`, so this field is the
 * mechanical difference between "described accurately and uncallable" and "callable by a stranger".
 * It flips only because `/consumer/policies/draft` and `/consumer/policies/sync` now exist, and the
 * route it names is the one a caller actually walks.
 */
export const POLICY_PREDECESSOR: Predecessor = {
  what: "A registered spend policy, and its numeric policyId.",
  why: "Every decision this service makes is a comparison against a policy. Without one there is nothing to compare to, and the request is refused rather than judged.",
  obtainableBy:
    "POST /consumer/policies/draft to build the unsigned registration, send that transaction from your own wallet, then POST /consumer/policies/sync. The policy's owner is whoever sent it — Untch does not relay the call and cannot.",
};

export const POLICY_HASH_PREDECESSOR: Predecessor = {
  what: "The policyHash of that policy — the exact hash the registry stored when it was registered.",
  why: "It binds the request to one VERSION of the rules, so a policy edited after the request was built cannot silently change the answer.",
  obtainableBy:
    "returned by POST /consumer/policies/draft before registration and by GET /consumer/policies/:policyId afterwards; the on-chain value is authoritative",
};

/**
 * The default policy, which is what lets a caller omit `policyId` entirely.
 *
 * Recorded as a predecessor of its own rather than folded into POLICY_PREDECESSOR, because it is a
 * different fact: having a policy and having chosen which one answers for you are separate steps, and
 * a caller who did the first and not the second gets POLICY_REQUIRED rather than a policy nobody
 * picked.
 */
export const DEFAULT_POLICY_PREDECESSOR: Predecessor = {
  what: "A default policy on the account, if the request omits policyId.",
  why: "A request that names no policy resolves to the account's default. An account with policies but no default is refused rather than given one it did not choose.",
  obtainableBy:
    "set automatically by the FIRST policy an account registers, or explicitly with PUT /consumer/account/default-policy",
};

/**
 * A channel binding, which is what makes an approval answerable anywhere other than the dashboard.
 *
 * Present so the generated listing knows, mechanically, that Telegram and Discord cannot approve
 * anything until a binding exists — the property §17 asks the registry to encode rather than to
 * describe in prose somewhere a validator never reads.
 */
export const CHANNEL_BINDING_PREDECESSOR: Predecessor = {
  what: "A verified channel binding, for any decision arriving from Telegram or Discord.",
  why: "A callback carries a platform identity, which authorises nothing until that identity has been bound to an account. Email never gains a decision path at all: a sender address is forged trivially, so email carries a link to an authenticated session.",
  obtainableBy:
    "start the binding from an authenticated dashboard session; production sending stays disabled until the channel credential is rotated (see /internal/credential-state)",
};


/**
 * The public request shape for a policy decision.
 *
 * Written here rather than inside the service definition because delivery verification's contract
 * refers to the same ideas, and because the point of the redesign is that this shape is a THING —
 * the marketplace interface — rather than a paragraph inside one entry.
 *
 * Ten fields are absent on purpose: policyHash, owner, token, taskHash, acceptanceHash, schemaHash,
 * paramsHash, nonce, endpoint and the two agent identifiers are derived from production state. A
 * caller that could send them could send a wrong one, and a policy binding the caller chooses is not
 * a binding.
 */
export const PUBLIC_PREFLIGHT_INPUT: JsonSchema = {
  type: "object",
  title: "PreflightRequest",
  description:
    "A payment you are considering, in your own terms. Every protocol value — the policy hash, the token contract, the hashes of the things you describe below, the nonce, the endpoint — is derived server-side from production state and returned to you, so there is nothing here you have to look up first.",
  properties: {
    policyId: policyIdField,
    provider: {
      type: "string",
      minLength: 1,
      description: "The provider you want to pay, by its registered id.",
      examples: ["stabledomains"],
    },
    capability: {
      type: "string",
      minLength: 1,
      description: "What you want that provider to do, by its registered capability id.",
      examples: ["domains.register"],
    },
    task: {
      type: "string",
      minLength: 1,
      maxLength: 500,
      description: "What this payment is for, in a sentence a person would recognise.",
      examples: ["Register kyrve.xyz for one year"],
    },
    maxSpend: {
      type: "string",
      pattern: "^\\d+(\\.\\d+)?$",
      description: "The most you will spend, in DISPLAY units — \"20.00\", not base units.",
      examples: ["20.00"],
    },
    currency: {
      type: "string",
      minLength: 1,
      description: "The settlement currency's symbol. It must be one this network actually settles.",
      examples: ["USDT0"],
    },
    deadline: isoTimestamp("After this the request is stale and must be rebuilt rather than replayed."),
    recipient: address("Optional. Constrains who may be paid. Without it, the recipient must come from a resolved quote."),
    parameters: {
      type: "object",
      description: "Optional. The structured parameters that will be sent to the provider. Hashed and committed.",
    },
    acceptance: {
      type: "object",
      description:
        "Optional. What \"delivered\" will mean, committed NOW so that verification later has something to compare against. Without it the task text is used.",
    },
    idempotencyKey: {
      type: "string",
      maxLength: 128,
      description:
        "Optional. Makes a retry of an identical request resolve to the same intent rather than creating a second one.",
    },
    buyerAgentId: {
      type: "string",
      pattern: UINT256_PATTERN,
      description:
        "Optional and temporary. Which agent is spending is a property of an account; send it explicitly until your wallet is bound to one.",
    },
    workerAgentId: {
      type: "string",
      pattern: UINT256_PATTERN,
      description:
        "Optional and temporary. Which agent is being paid is a property of the provider's registration; send it explicitly until that binding exists.",
    },
  },
  /**
   * `policyId` is required, and `useDefaultPolicy` is not offered here.
   *
   * It used to be, as an `anyOf` alternative, and this is the MARKETPLACE contract — the tool a
   * stranger buys over x402 with no session and no account. A default policy is a property of an
   * account, so there was nothing for the handler to resolve it against: `handlers.ts` reads a literal
   * `policyId` and refuses without one. A buyer following the published schema sent
   * `useDefaultPolicy`, paid, and was answered POLICY_ID_REQUIRED for doing what the contract told
   * them to do. (They were not charged — a failing handler settles nothing — but they were still
   * refused for our mistake.)
   *
   * The account-scoped path in `authority.ts` does support it, correctly, because there it has an
   * account to ask. That is a different surface with a different contract.
   */
  required: ["policyId", "provider", "capability", "task", "maxSpend", "currency", "deadline"],
};

/**
 * The public request shape for delivery verification: one identifier.
 *
 * Everything else — the policy, the quote, the execution, the settlement, the result and the receipt
 * — is evidence this service already holds against that intent. The old contract asked the caller to
 * resend the acceptance criteria, a value that was never returned to them in the first place.
 */
export const PUBLIC_VERIFY_INPUT: JsonSchema = {
  type: "object",
  title: "VerifyRequest",
  description:
    "Ask for a delivery to be checked against what was agreed. Only the intent id is needed; the policy, quote, execution, settlement, result and receipt are loaded here.",
  properties: {
    intentId: bytes32("The intent to verify, as returned when it was created."),
    expectedResultHash: bytes32(
      "Optional. A hash you believe the result should have. It is compared and the comparison is reported, but it never overrides the acceptance criteria that were committed — asserting what an answer should be is not the same as it being what was agreed.",
    ),
  },
  required: ["intentId"],
};
