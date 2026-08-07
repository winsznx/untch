import {
  ACCOUNT_PREDECESSOR,
  ADDRESS_PATTERN,
  BYTES32_PATTERN,
  ERROR_ENVELOPE,
  POLICY_HASH_PREDECESSOR,
  CHANNEL_BINDING_PREDECESSOR,
  POLICY_PREDECESSOR,
  PUBLIC_PREFLIGHT_INPUT,
  PUBLIC_VERIFY_INPUT,
  UINT256_PATTERN,
  address,
  bytes32,
  isoTimestamp,
  policyIdField,
  uint256String,
} from "./fragments";
import type { JsonSchema, ServiceDefinition } from "./types";

/**
 * Every service this host offers a stranger's agent, described once.
 *
 * SCOPE OF THIS PASS
 *
 * The 22 definitions below are the MARKETPLACE surface: everything listed in `/catalog` and in the
 * ERC-8004 registration card, plus the two free status polls a caller needs to finish a job. The
 * Consumer Pack's 36 `/consumer/*` routes are deliberately NOT here. They are session-authenticated
 * rather than marketplace-callable, they are not listed on OKX, and bringing them in would mean
 * describing a paid consumer execution path this pass is explicitly not building. That is a gap with
 * a name, not an oversight — `registeredToolIds` is what the drift test compares against, so adding
 * them later is a visible change.
 *
 * WHY THE TWO REJECTED SERVICES ARE STILL HERE
 *
 * `preflight_payment` and `verify_delivery` are registered with the contract they ACTUALLY enforce
 * today — seventeen fields for one, sixteen-or-a-hash plus four gates for the other — and marked
 * `blocked`. Describing them accurately is not an endorsement of the shape; it is the prerequisite
 * for replacing it. A registry that omitted them, or that described the shape someone wished they
 * had, would leave the 402 body exactly as empty as the audit found it.
 *
 * `blocked` is not cosmetic. The listing generator refuses to emit a submission entry for a service
 * whose predecessors carry `obtainableBy: null`, so the honest description cannot become a listing
 * that promises a callable tool.
 */

const OK_ENVELOPE = (title: string, properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  title,
  properties,
  required,
});

const NO_INPUT: JsonSchema = {
  type: "object",
  description: "This service takes no parameters.",
  properties: {},
  additionalProperties: false,
};

/**
 * The eleven hashed struct fields plus the five operational columns `preflight_payment` demands.
 *
 * Written out in full rather than summarised. The audit's finding was that the published contract
 * said three requirements and the validator enforced seventeen; the only fix that survives contact
 * with a caller is the seventeen, spelled out, including the one field that must NOT be a string.
 */
const SPEND_INTENT_INPUT: JsonSchema = {
  type: "object",
  title: "SpendIntent",
  description:
    "The bounded object a spend decision is made about. Eleven of these fields are hashed together into the intentHash that the receipt commits to; the remaining five are the operational values the rules read.",
  properties: {
    owner: address("The address that owns the policy this intent is judged against."),
    buyerAgentId: uint256String("The ERC-8004 agent id of the agent doing the spending."),
    workerAgentId: uint256String("The ERC-8004 agent id of the agent being paid."),
    token: address("The ERC-20 the payment settles in."),
    maxAmount: uint256String("The ceiling for this payment, in the token's BASE UNITS."),
    taskHash: bytes32("A hash of the task description this payment is for."),
    acceptanceHash: bytes32("A hash of the acceptance criteria delivery will later be judged against."),
    schemaHash: bytes32("A hash of the schema the delivered result must conform to."),
    policyHash: bytes32("The stored hash of the policy named by policyId. Must match exactly."),
    deadline: uint256String("Unix seconds after which this intent is no longer valid."),
    nonce: uint256String("A value that makes this intent distinct from an otherwise identical one."),
    endpoint: {
      type: "string",
      description: "The absolute URL the payment is for. Must be absolute, including the scheme.",
      pattern: "^https?://",
      examples: ["https://asp.untch.xyz/ping_untch"],
    },
    paramsHash: bytes32("A hash of the parameters that will be sent to that endpoint."),
    recipientAddress: address("The address that will receive the funds."),
    category: {
      type: "string",
      minLength: 1,
      description: "The spend category, as your policy names it. Used by category rules.",
      examples: ["api"],
    },
    amount: {
      type: "number",
      minimum: 0,
      description:
        "The amount in DISPLAY units, as a JSON NUMBER. This is the one field that must not be a string — every other numeric field above is a decimal string. The inversion is load-bearing: maxAmount is a uint256 ceiling in base units, and this is the human-scale figure the budget rules read.",
      examples: [1.5],
    },
  },
  required: [
    "owner",
    "buyerAgentId",
    "workerAgentId",
    "token",
    "maxAmount",
    "taskHash",
    "acceptanceHash",
    "schemaHash",
    "policyHash",
    "deadline",
    "nonce",
    "endpoint",
    "paramsHash",
    "recipientAddress",
    "category",
    "amount",
  ],
};

const EXAMPLE_INTENT = {
  owner: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  buyerAgentId: "6047",
  workerAgentId: "6086",
  token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  maxAmount: "2000000",
  taskHash: `0x${"11".repeat(32)}`,
  acceptanceHash: `0x${"22".repeat(32)}`,
  schemaHash: `0x${"33".repeat(32)}`,
  policyHash: `0x${"44".repeat(32)}`,
  deadline: "1790000000",
  nonce: "1",
  endpoint: "https://asp.untch.xyz/ping_untch",
  paramsHash: `0x${"55".repeat(32)}`,
  recipientAddress: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  category: "api",
  amount: 1.5,
};

/**
 * The worked request the redesigned contract accepts.
 *
 * Six fields, all of them things the caller knows. The seventeen-field version is still what the
 * policy engine evaluates — `services/asp/src/public-dto/mapping.ts` derives it — but a marketplace
 * caller never sees it, which was the whole point of the redesign.
 */
const EXAMPLE_PREFLIGHT_REQUEST = {
  policyId: "7",
  provider: "stabledomains",
  capability: "domains.register",
  task: "Register kyrve.xyz for one year",
  maxSpend: "20.00",
  currency: "USDT0",
  deadline: "2026-08-02T12:00:00.000Z",
  recipient: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
  parameters: { domain: "kyrve.xyz", years: 1 },
  buyerAgentId: "6047",
  workerAgentId: "6086",
};

export const SERVICES: readonly ServiceDefinition[] = [
  // ── discovery ────────────────────────────────────────────────────────────
  {
    toolId: "catalog",
    publicName: "Service catalog",
    protocol: "A2MCP",
    method: "GET",
    path: "/catalog",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "PUBLIC_SUPPORT",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "The free index of what this service serves. Discovery, not a product — nobody buys a list of " +
      "things they could buy.",
    },
    summary: "Lists every tool this host serves, with its route, price and purpose.",
    intendedCaller: "any agent deciding whether this host has a tool worth calling",
    delivers: "a JSON catalog of every route, its price, and what it is for",
    input: NO_INPUT,
    output: OK_ENVELOPE(
      "Catalog",
      {
        asp: { type: "string" },
        baseUrl: { type: "string" },
        type: { type: "string" },
        surfaces: { type: "object" },
      },
      ["asp", "baseUrl", "surfaces"],
    ),
    validExample: { title: "Read the catalog", request: null },
    invalidExample: {
      title: "Send a body to a GET route",
      request: { anything: true },
      refusalCode: "METHOD_NOT_ALLOWED",
    },
    predecessors: [],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [
      { code: "METHOD_NOT_ALLOWED", status: 405, when: "the path is right and the verb is not" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "ping_untch",
    publicName: "Rail ping",
    protocol: "A2MCP",
    method: "GET",
    path: "/ping_untch",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "PUBLIC_SUPPORT",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "A health check. It used to cost $0.01, which billed a buyer to prove that x402 works rather than " +
      "to receive anything. Free, useful, and not a deliverable.",
    },
    summary: "Reports that this host is up and answering.",
    intendedCaller: "any agent checking whether this service is reachable before it decides to spend",
    delivers: "a timestamped acknowledgement. It is a health check, not a purchase",
    input: NO_INPUT,
    output: OK_ENVELOPE(
      "Ping",
      {
        ok: { type: "boolean", const: true },
        tool: { type: "string", const: "ping_untch" },
        ts: isoTimestamp("When this host answered."),
      },
      ["ok", "tool", "ts"],
    ),
    validExample: { title: "Prove the rail", request: null },
    invalidExample: {
      title: "Call without paying",
      request: null,
      refusalCode: "PAYMENT_REQUIRED",
    },
    predecessors: [
      {
        what: "An x402 client holding USDT0 on X Layer mainnet.",
        why: "The call settles a real payment before the handler runs.",
        obtainableBy: "any x402-capable wallet funded with USDT0 on eip155:196",
      },
    ],
    sideEffects: [{ what: "Settles $0.01 of USDT0 to this host's payTo address.", durable: true }],
    idempotency: "not-idempotent",
    refusals: [{ code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" }],
    schemaVersion: "1.0.0",
  },

  // ── the two OKX-rejected services, described as they actually behave ─────
  {
    toolId: "preflight_payment",
    publicName: "Policy preflight",
    protocol: "A2MCP",
    method: "POST",
    path: "/preflight_payment",
    pricing: { kind: "paid", price: "$0.05", amountBaseUnits: "50000" },
    /**
     * `blocked` until PASS 2, and the word had a precise meaning: the contract is correct and a fresh
     * caller cannot complete it, because something it requires has no public way to be created. That
     * was true — a policy id came from nowhere a stranger could reach.
     *
     * It is no longer true. `/consumer/policies/draft` and `/consumer/policies/sync` let any caller
     * register a policy from their own wallet, so the predecessor chain is complete and the honest
     * value is `demo`: the path exists end to end and has not been walked against mainnet on this
     * deployment, because doing so means broadcasting a real registration transaction — a separately
     * approved action, not something a build does on its own.
     */
    maturity: "demo",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "Untch's core control capability, and the one a stranger has the clearest reason to buy: it " +
      "judges a proposed payment against a registered spend policy and returns allow, block or escalate " +
      "with the rule that decided it. It needs a policyId, and that policy is obtainable through a " +
      "documented public route the listing names, so the prerequisite is disclosed rather than private.",
    },
    summary:
      "Judges a proposed payment against a registered spend policy and returns allow, block or escalate, with the rule that decided it.",
    intendedCaller: "an operator funding an autonomous agent who wants every payment checked before it moves",
    delivers:
      "a decision, the ordered list of rules that were evaluated and what each one found, and a receipt reference for the decision",
    input: PUBLIC_PREFLIGHT_INPUT,
    output: OK_ENVELOPE(
      "PreflightDecision",
      {
        decision: {
          type: "string",
          enum: ["ALLOW", "BLOCK", "ESCALATE"],
          description: "What the policy concluded.",
        },
        reasons: { type: "array", items: { type: "string" }, description: "Why, in the policy's own terms." },
        ruleTrace: {
          type: "array",
          items: { type: "object" },
          description: "Every rule evaluated, in order, with its verdict. The audit trail of the decision.",
        },
        intentHash: bytes32("The hash of the intent that was judged."),
        receiptRef: {
          type: ["string", "null"],
          description: "The receipt this decision was written to, when a receipt writer is wired.",
        },
      },
      ["decision", "reasons", "ruleTrace"],
    ),
    validExample: {
      title: "Check a domain registration against policy 7 before paying for it",
      request: EXAMPLE_PREFLIGHT_REQUEST,
    },
    invalidExample: {
      title: "Name neither a policy nor a default one the account has chosen",
      request: { ...EXAMPLE_PREFLIGHT_REQUEST, policyId: undefined },
      refusalCode: "POLICY_REQUIRED",
    },
    /**
     * One predecessor now, not two.
     *
     * `policyHash` was a predecessor because the caller had to supply it and no route returned it.
     * It is now derived from the stored policy, which is where it always came from. The policy itself
     * remains genuinely required and genuinely unobtainable through any public route — that is the
     * gap the policy-registration work closes, and until it does this service stays withheld.
     */
    predecessors: [POLICY_PREDECESSOR],
    sideEffects: [
      { what: "Records the decision in this instance's rolling ledger window.", durable: false },
      { what: "Writes a DECISION receipt and queues it for anchoring, when a receipt writer is wired.", durable: true },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "REQUEST_SCHEMA_VIOLATION", status: 400, when: "a field is missing or has the wrong shape; the message names each one" },
      { code: "CURRENCY_NOT_SETTLEABLE", status: 400, when: "this network has no confirmed contract for that currency" },
      { code: "MAX_SPEND_INVALID", status: 400, when: "maxSpend is not a decimal amount the settlement token can express" },
      { code: "DEADLINE_IN_THE_PAST", status: 400, when: "the deadline has already passed" },
      {
        code: "ACCOUNT_LINK_REQUIRED",
        status: 401,
        when: "no wallet-backed session accompanied the request; the policy, the spending agent and the owning wallet are all properties of an account",
      },
      {
        code: "POLICY_REQUIRED",
        status: 409,
        when: "no policyId was sent and the account has chosen no default, or the named policy is neither owned by nor delegated to this account",
      },
      { code: "POLICY_INACTIVE", status: 409, when: "the policy is paused, revoked, or past its on-chain expiry" },
      {
        code: "RECIPIENT_REQUIRED",
        status: 409,
        when: "no recipient was constrained and no registered service definition names a deterministic payment address for this capability",
      },
      {
        code: "AUTHORITY_NOT_DERIVABLE",
        status: 409,
        when: "a protocol value cannot be derived without inventing it; the response names each one and what would supply it",
      },
      { code: "QUOTE_REQUIRED", status: 409, when: "the capability is priced by live quote and none has been resolved" },
      { code: "QUOTE_EXPIRED", status: 410, when: "the quote this request was built against has aged out and must be re-taken" },
      { code: "POLICY_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no policy store" },
    ],
    schemaVersion: "2.0.0",
  },
  {
    toolId: "verify_delivery",
    publicName: "Delivery verify",
    protocol: "A2MCP",
    method: "POST",
    path: "/verify_delivery",
    pricing: { kind: "paid", price: "$0.10", amountBaseUnits: "100000" },
    // Same reasoning as preflight_payment: the policy predecessor now has a public route, so the
    // service is reachable. `demo` rather than `live` because it has not been proven end to end here.
    maturity: "demo",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "It evaluates submitted delivery evidence against committed acceptance criteria and returns PASS " +
      "or FAIL with the differences. That is the whole claim: Untch performed no provider work and " +
      "settled no provider principal, and the description says exactly that so a buyer cannot read the " +
      "result as proof that something was delivered on their behalf.",
    },
    summary:
      "Checks a delivered result against the acceptance criteria that were committed to before the work started, and records the verdict.",
    intendedCaller: "a buyer deciding whether work they commissioned has actually been delivered",
    delivers: "a pass or fail verdict against the committed criteria, and a durable receipt of that verdict",
    input: PUBLIC_VERIFY_INPUT,
    output: OK_ENVELOPE(
      "VerifyResult",
      {
        verified: { type: "boolean", description: "Whether the delivery met the committed criteria." },
        proofTier: { type: "string", description: "How strong the check was." },
        intentHash: bytes32("The intent this verification is about."),
        receiptRef: { type: ["string", "null"], description: "The durable receipt of this verdict." },
      },
      ["verified", "proofTier"],
    ),
    validExample: {
      title: "Verify one intent",
      request: { intentId: `0x${"11".repeat(32)}` },
    },
    invalidExample: {
      title: "Omit the intent id",
      request: { expectedResultHash: `0x${"66".repeat(32)}` },
      refusalCode: "REQUEST_SCHEMA_VIOLATION",
    },
    /**
     * The acceptance criteria are no longer a predecessor.
     *
     * They were, and it was the least defensible of the seventeen fields: the caller was asked to
     * resend a value that nothing had ever returned to them. This service is the custodian of what was
     * committed, so it loads it. What remains is the policy — an intent cannot exist without one.
     */
    predecessors: [
      CHANNEL_BINDING_PREDECESSOR,
  POLICY_PREDECESSOR,
      {
        what: "An intent created on this host.",
        why: "Verification is about a specific commitment. Without one there is nothing to compare a delivery against.",
        obtainableBy: "the intentId returned by POST /preflight_payment or POST /create_spend_intent",
      },
    ],
    sideEffects: [
      {
        what: "Writes a VERIFY receipt and queues it for on-chain anchoring. Calling twice writes twice.",
        durable: true,
      },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "REQUEST_SCHEMA_VIOLATION", status: 400, when: "intentId is missing, or expectedResultHash is not a 32-byte hex string" },
      {
        code: "ACCOUNT_LINK_REQUIRED",
        status: 401,
        when: "no wallet-backed session accompanied the request; a verification is scoped to the account that commissioned the work",
      },
      {
        code: "INTENT_NOT_FOUND",
        status: 404,
        when: "no intent with that id is known here, or it belongs to another account — the two answer alike, so an opaque id cannot be probed for existence",
      },
      {
        code: "EXPECTED_RESULT_MISMATCH",
        status: 409,
        when: "expectedResultHash was sent and does not equal the recorded result hash; reported rather than judged, because an assertion about the answer never overrides the committed acceptance criteria",
      },
      {
        code: "EVIDENCE_INCOMPLETE",
        status: 409,
        when: "the record needed to judge this delivery is not all present; the response names which parts are missing rather than judging on less",
      },
    ],
    schemaVersion: "2.0.0",
  },
  {
    toolId: "create_spend_intent",
    publicName: "Create spend intent",
    protocol: "A2MCP",
    method: "POST",
    path: "/create_spend_intent",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    // Reachable for the same reason: the policy it binds to can now be created by its own owner.
    maturity: "demo",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It writes an intent into this host's store against a policy the caller must own. Free, correct, " +
      "and part of operating an Untch account rather than something a stranger buys.",
    },
    summary: "Canonicalises and hashes a proposed payment, binding it to a registered policy.",
    intendedCaller: "an agent that wants one stable hash to refer to a payment through preflight, verification and receipt",
    delivers: "the canonical form of the intent and its intentHash",
    input: {
      type: "object",
      title: "CreateIntentRequest",
      properties: { policyId: policyIdField, intent: SPEND_INTENT_INPUT },
      required: ["policyId", "intent"],
    },
    output: OK_ENVELOPE(
      "CreatedIntent",
      {
        intentHash: bytes32("The hash every later step refers to."),
        canonicalIntent: { type: "object", description: "Exactly the values that were hashed." },
        policyId: { type: "string" },
        onchain: { type: ["object", "null"], description: "The registration transaction, when a writer key is wired." },
      },
      ["intentHash", "canonicalIntent", "policyId"],
    ),
    validExample: { title: "Hash an intent under policy 7", request: { policyId: "7", intent: EXAMPLE_INTENT } },
    invalidExample: {
      title: "Omit the intent",
      request: { policyId: "7" },
      refusalCode: "INTENT_REQUIRED",
    },
    predecessors: [POLICY_PREDECESSOR, POLICY_HASH_PREDECESSOR],
    sideEffects: [
      {
        what: "Caches the intent IN MEMORY on this instance only. It does not survive a restart and is invisible to any other instance.",
        durable: false,
      },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "POLICY_ID_REQUIRED", status: 400, when: "policyId is absent or is not a decimal string" },
      { code: "INTENT_REQUIRED", status: 400, when: "no intent was given" },
      { code: "INTENT_MALFORMED", status: 400, when: "a field of the intent has the wrong type or format" },
      { code: "POLICY_NOT_FOUND", status: 404, when: "no policy with that id is stored" },
      { code: "POLICY_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no policy store" },
    ],
    schemaVersion: "1.0.0",
  },

  // ── ledger and hygiene ───────────────────────────────────────────────────
  {
    toolId: "get_ledger",
    publicName: "Spend window",
    protocol: "A2MCP",
    method: "POST",
    path: "/get_ledger",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "demo",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It reads this host's ledger window for a policy the caller must own. Exposing an account's own " +
      "spend history as an open marketplace service would be publishing private state.",
    },
    summary: "Returns the recent spend window this instance is holding for one policy.",
    intendedCaller: "an operator checking what a policy has spent recently",
    delivers: "the spend-so-far, the call count in the last hour, and the most recent intents",
    input: {
      type: "object",
      title: "LedgerRequest",
      properties: { policyId: policyIdField },
      required: ["policyId"],
    },
    output: OK_ENVELOPE(
      "LedgerWindow",
      {
        policyId: { type: "string" },
        spentToday: { type: "object" },
        callsInLastHour: { type: "number" },
        recentIntents: { type: "array", items: { type: "object" } },
        note: { type: "string" },
      },
      ["policyId", "spentToday", "callsInLastHour", "recentIntents"],
    ),
    validExample: { title: "Read policy 7's window", request: { policyId: "7" } },
    invalidExample: { title: "Omit policyId", request: {}, refusalCode: "POLICY_ID_REQUIRED" },
    predecessors: [POLICY_PREDECESSOR],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [{ code: "POLICY_ID_REQUIRED", status: 400, when: "policyId is absent or empty" }],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "detect_duplicate",
    publicName: "Duplicate check",
    protocol: "A2MCP",
    method: "POST",
    path: "/detect_duplicate",
    pricing: { kind: "paid", price: "$0.02", amountBaseUnits: "20000" },
    maturity: "demo",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "It answers whether an identical call was already seen in this host's recent window, which is the " +
      "replay question an agent has to ask before it pays twice. The window is this instance's own and " +
      "the contract says so; a caller who has made no prior call here gets a truthful negative rather " +
      "than a refusal.",
    },
    summary: "Says whether this exact task, endpoint and parameter set was already paid for recently.",
    intendedCaller: "an agent about to retry, that does not want to pay twice for one job",
    delivers: "whether a matching prior intent exists, which one, and how long the match remains in the window",
    input: {
      type: "object",
      title: "DuplicateRequest",
      properties: {
        policyId: policyIdField,
        taskHash: bytes32("The task hash to look for."),
        endpoint: { type: "string", description: "The endpoint the prior call would have used." },
        paramsHash: bytes32("The parameter hash to look for."),
      },
      required: ["policyId", "taskHash", "endpoint", "paramsHash"],
    },
    output: OK_ENVELOPE(
      "DuplicateVerdict",
      {
        duplicate: { type: "boolean" },
        priorIntentId: { type: ["string", "null"] },
        ttlRemainingSec: { type: ["number", "null"] },
      },
      ["duplicate", "priorIntentId", "ttlRemainingSec"],
    ),
    validExample: {
      title: "Check before retrying",
      request: {
        policyId: "7",
        taskHash: `0x${"11".repeat(32)}`,
        endpoint: "https://asp.untch.xyz/ping_untch",
        paramsHash: `0x${"55".repeat(32)}`,
      },
    },
    invalidExample: {
      title: "Omit paramsHash",
      request: { policyId: "7", taskHash: `0x${"11".repeat(32)}`, endpoint: "https://asp.untch.xyz/ping_untch" },
      refusalCode: "FIELDS_REQUIRED",
    },
    predecessors: [
      {
        what: "A prior call recorded in THIS instance's rolling window.",
        why: "The window is process-local and one hour long, so a match can only be found for something this instance itself saw.",
        obtainableBy: "POST /preflight_payment on this same instance, within the last hour",
      },
    ],
    sideEffects: [{ what: "Settles $0.02 of USDT0.", durable: true }],
    idempotency: "read-only",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "FIELDS_REQUIRED", status: 400, when: "any of policyId, taskHash, endpoint or paramsHash is missing" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "redact_payment_metadata",
    publicName: "Metadata redaction",
    protocol: "A2MCP",
    method: "POST",
    path: "/redact_payment_metadata",
    pricing: { kind: "paid", price: "$0.02", amountBaseUnits: "20000" },
    maturity: "live",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "It takes arbitrary metadata and returns it with the identifying fields removed. No account, no " +
      "prior state, no host history — the input is the whole input, and the output is the whole " +
      "product.",
    },
    summary: "Strips emails, phone numbers, API keys and bearer tokens out of payment metadata and hashes what is left.",
    intendedCaller: "an agent that must attach metadata to a payment without publishing what is inside it",
    delivers: "the redacted metadata and a hash of it, with nothing stored",
    input: {
      type: "object",
      title: "RedactRequest",
      properties: { metadata: { type: "object", description: "The metadata to strip." } },
      required: ["metadata"],
    },
    output: OK_ENVELOPE(
      "Redacted",
      {
        redacted: { type: "object" },
        metadataHash: bytes32("A hash of the redacted form."),
        note: { type: "string" },
      },
      ["redacted", "metadataHash"],
    ),
    validExample: {
      title: "Strip a contact address out of an order note",
      request: { metadata: { note: "ship to ada@example.com", orderId: "A-1" } },
    },
    invalidExample: { title: "Send a string instead of an object", request: { metadata: "ada@example.com" }, refusalCode: "METADATA_REQUIRED" },
    predecessors: [],
    sideEffects: [
      { what: "Settles $0.02 of USDT0.", durable: true },
      { what: "The raw metadata is not stored anywhere.", durable: false },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "METADATA_REQUIRED", status: 400, when: "metadata is absent or is not an object" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "log_receipt",
    publicName: "Receipt lookup",
    protocol: "A2MCP",
    method: "POST",
    path: "/log_receipt",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It appends to this host's receipt store for a policy the caller must own. Writing into " +
      "somebody's account is account control, whatever it costs.",
    },
    summary: "Reports the anchoring state of a receipt this host wrote.",
    intendedCaller: "a caller holding a receiptRef who wants to know whether it has reached the chain",
    delivers: "the receipt's current state, and its anchoring transaction once it has one",
    input: {
      type: "object",
      title: "ReceiptLookup",
      properties: { receiptId: bytes32("The receiptRef returned by an earlier call.") },
      required: ["receiptId"],
    },
    output: OK_ENVELOPE("ReceiptState", { status: { type: "string" } }, ["status"]),
    validExample: { title: "Poll a receipt", request: { receiptId: `0x${"77".repeat(32)}` } },
    invalidExample: { title: "Send a short id", request: { receiptId: "0x77" }, refusalCode: "BAD_RECEIPT_ID" },
    predecessors: [
      {
        what: "A receiptRef from an earlier paid call.",
        why: "There is nothing to look up until something has written a receipt.",
        obtainableBy: "the receiptRef field of a preflight_payment or verify_delivery response",
      },
    ],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [
      { code: "BAD_RECEIPT_ID", status: 400, when: "receiptId is not a 32-byte hex string" },
      { code: "RECEIPT_NOT_FOUND", status: 404, when: "no receipt with that id was written by this host" },
      { code: "RECEIPTS_NOT_CONFIGURED", status: 503, when: "this instance has no receipt writer" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "receipt_status",
    publicName: "Receipt status",
    protocol: "A2MCP",
    method: "GET",
    path: "/receipt_status/{receiptId}",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It resolves a receiptId that only a prior account-bound write produces. A stranger has no " +
      "receiptId to ask about, so being free does not make it a service anyone could use.",
    },
    summary: "The same receipt state, as a plain GET a browser or a poller can use.",
    intendedCaller: "anything polling for an anchor without wanting to POST",
    delivers: "the receipt's state and its anchoring transaction once it has one",
    input: NO_INPUT,
    output: OK_ENVELOPE("ReceiptState", { status: { type: "string" } }, ["status"]),
    validExample: { title: "Poll by URL", request: null },
    invalidExample: { title: "Poll an id that is not 32 bytes", request: null, refusalCode: "BAD_RECEIPT_ID" },
    predecessors: [
      {
        what: "A receiptRef from an earlier paid call.",
        why: "There is nothing to poll until something has written a receipt.",
        obtainableBy: "the receiptRef field of a preflight_payment or verify_delivery response",
      },
    ],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [
      { code: "BAD_RECEIPT_ID", status: 400, when: "the id in the path is not a 32-byte hex string" },
      { code: "RECEIPT_NOT_FOUND", status: 404, when: "no receipt with that id was written by this host" },
      { code: "RECEIPTS_NOT_CONFIGURED", status: 503, when: "this instance has no receipt writer" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "escalation_status",
    publicName: "Approval status",
    protocol: "A2MCP",
    method: "GET",
    path: "/escalation_status/{pollRef}",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It resolves an opaque pollRef issued by a prior escalation on this host. Same shape as receipt " +
      "status: without the reference there is nothing to poll, and the reference is account-bound.",
    },
    summary: "Reports whether a payment that was escalated to a human has been approved or denied yet.",
    intendedCaller: "an agent waiting on a human decision it triggered",
    delivers: "the pending, approved or denied state of one escalation",
    input: NO_INPUT,
    output: OK_ENVELOPE("EscalationState", { state: { type: "string", enum: ["PENDING", "APPROVED", "DENIED"] } }, [
      "state",
    ]),
    validExample: { title: "Poll an escalation", request: null },
    invalidExample: { title: "Poll an unknown reference", request: null, refusalCode: "ESCALATION_NOT_CONFIGURED" },
    predecessors: [
      {
        what: "A pollRef from an ESCALATE decision.",
        why: "There is nothing to wait on until a decision escalated.",
        obtainableBy: "the escalation reference on a preflight_payment response whose decision was ESCALATE",
      },
    ],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [
      { code: "ESCALATION_NOT_CONFIGURED", status: 503, when: "this instance has no escalation service wired" },
    ],
    schemaVersion: "1.0.0",
  },

  // ── reputation ───────────────────────────────────────────────────────────
  {
    toolId: "score_vendor",
    publicName: "Vendor score",
    protocol: "A2MCP",
    method: "POST",
    path: "/score_vendor",
    pricing: { kind: "paid", price: "$0.20", amountBaseUnits: "200000" },
    maturity: "blocked",
    classification: {
      serviceClass: "INTERNAL_OR_WITHHELD",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It scores a vendor from receipt history held by this host. A stranger's vendor has no history " +
      "here, so the answer cannot exist. The route now refuses before any payment challenge is emitted " +
      "rather than charging for a question it cannot answer.",
    },
    summary: "Scores how reliably a vendor has delivered, from receipts this host holds.",
    intendedCaller: "a buyer choosing between vendors before committing money to one",
    delivers:
      "a score with its uncertainty, a lower-confidence bound, and the per-feature breakdown showing which parts were observed and which are cold-start priors",
    input: {
      type: "object",
      title: "VendorScoreRequest",
      description: "Identify the vendor by its id, or by the endpoint or host it serves from.",
      properties: {
        vendorId: bytes32("The vendor's 32-byte id."),
        endpoint: { type: "string", description: "A URL the vendor serves from; its host is resolved to a vendor id." },
        host: { type: "string", description: "The vendor's host, resolved to a vendor id." },
        payoutAddress: address("Optional. Includes the wallet's operational profile as a feature."),
      },
      required: [],
    },
    output: OK_ENVELOPE(
      "Score",
      {
        subjectKind: { type: "string" },
        subjectId: { type: "string" },
        score: { type: "number" },
        sigma: { type: "number" },
        lcb: { type: "number" },
        band: { type: "string" },
        features: { type: "array", items: { type: "object" } },
        coldStartFeatures: { type: "array", items: { type: "string" } },
        disclaimer: { type: "string" },
      },
      ["subjectKind", "subjectId", "score", "sigma", "lcb", "band", "features", "disclaimer"],
    ),
    validExample: { title: "Score a vendor by host", request: { host: "asp.untch.xyz" } },
    invalidExample: {
      title: "Identify the vendor by a marketplace listing id",
      request: { listingId: "okx-12345" },
      refusalCode: "LISTING_ID_UNRESOLVABLE",
    },
    predecessors: [
      {
        what: "Receipt history for that vendor, held by this host.",
        why: "The score is computed from receipts. With none, every feature is a cold-start prior and the answer carries almost no information.",
        obtainableBy: null,
      },
    ],
    sideEffects: [{ what: "Settles $0.20 of USDT0.", durable: true }],
    idempotency: "read-only",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "VENDOR_ID_REQUIRED", status: 400, when: "none of vendorId, endpoint or host was given" },
      { code: "LISTING_ID_UNRESOLVABLE", status: 400, when: "only a marketplace listingId was given; this host cannot resolve one" },
      { code: "PAYOUT_ADDRESS_MALFORMED", status: 400, when: "payoutAddress is not a 20-byte address" },
      { code: "SCORE_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no score store" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "score_buyer",
    publicName: "Buyer score",
    protocol: "A2MCP",
    method: "POST",
    path: "/score_buyer",
    pricing: { kind: "paid", price: "$0.20", amountBaseUnits: "200000" },
    maturity: "blocked",
    classification: {
      serviceClass: "INTERNAL_OR_WITHHELD",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It scores a buyer from receipt history held by this host, and refuses before any payment " +
      "challenge for the same reason vendor scoring does.",
    },
    summary: "Scores how well a buyer has behaved — paying, not disputing spuriously, not retrying blindly.",
    intendedCaller: "a vendor deciding whether to take a job from a buyer they do not know",
    delivers: "a score with its uncertainty and the per-feature breakdown behind it",
    input: {
      type: "object",
      title: "BuyerScoreRequest",
      properties: {
        buyerId: bytes32("The buyer's 32-byte id."),
        agentId: { type: "string", pattern: UINT256_PATTERN, description: "The buyer's ERC-8004 agent id." },
      },
      required: [],
    },
    output: OK_ENVELOPE(
      "Score",
      {
        subjectKind: { type: "string" },
        subjectId: { type: "string" },
        score: { type: "number" },
        sigma: { type: "number" },
        lcb: { type: "number" },
        band: { type: "string" },
        features: { type: "array", items: { type: "object" } },
        disclaimer: { type: "string" },
      },
      ["subjectKind", "subjectId", "score", "sigma", "lcb", "band", "features", "disclaimer"],
    ),
    validExample: { title: "Score a buyer by agent id", request: { agentId: "6047" } },
    invalidExample: { title: "Identify nobody", request: {}, refusalCode: "BUYER_ID_REQUIRED" },
    predecessors: [
      {
        what: "Receipt history for that buyer, held by this host.",
        why: "Every observed feature comes from receipts. With none, the answer is priors.",
        obtainableBy: null,
      },
    ],
    sideEffects: [{ what: "Settles $0.20 of USDT0.", durable: true }],
    idempotency: "read-only",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "BUYER_ID_REQUIRED", status: 400, when: "neither buyerId nor agentId was given" },
      { code: "SCORE_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no score store" },
    ],
    schemaVersion: "1.0.0",
  },

  // ── reports ──────────────────────────────────────────────────────────────
  {
    toolId: "generate_dispute_packet",
    publicName: "Dispute packet",
    protocol: "A2MCP",
    method: "POST",
    path: "/generate_dispute_packet",
    pricing: { kind: "paid", price: "$0.50", amountBaseUnits: "500000" },
    maturity: "blocked",
    classification: {
      serviceClass: "INTERNAL_OR_WITHHELD",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It assembles a dispute packet from an intentHash this host has history for. Without that history " +
      "there is nothing to assemble, so it refuses before a challenge rather than after settlement.",
    },
    summary: "Assembles everything this host recorded about one payment into a single hashed evidence bundle.",
    intendedCaller: "either side of a dispute who needs one artefact both parties can check",
    delivers: "the assembled packet, its hash, and — where a writer key is wired — the transaction that anchored the hash",
    input: {
      type: "object",
      title: "DisputeRequest",
      properties: {
        intentRef: bytes32("The intentHash the dispute is about."),
        agentId: { type: "string", pattern: UINT256_PATTERN, description: "Optional. Used when the packet cannot infer one." },
      },
      required: ["intentRef"],
    },
    output: OK_ENVELOPE(
      "DisputePacket",
      {
        tool: { type: "string", const: "generate_dispute_packet" },
        intentHash: bytes32("The intent this packet is about."),
        reportHash: bytes32("The hash that is anchored. Recompute it from the packet to verify."),
        packet: { type: "object" },
        anchor: { type: "object" },
      },
      ["tool", "intentHash", "reportHash", "packet", "anchor"],
    ),
    validExample: { title: "Assemble evidence for an intent", request: { intentRef: `0x${"11".repeat(32)}` } },
    invalidExample: { title: "Omit the intent reference", request: {}, refusalCode: "INTENT_REF_REQUIRED" },
    predecessors: [
      {
        what: "An intentHash this host has history for.",
        why: "The packet is assembled from receipts, ledger entries and escalations. An unknown intent yields an honestly empty packet.",
        obtainableBy: null,
      },
    ],
    sideEffects: [
      { what: "Settles $0.50 of USDT0.", durable: true },
      { what: "Anchors the packet hash on-chain, only where this instance holds a writer key.", durable: true },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "INTENT_REF_REQUIRED", status: 400, when: "intentRef is absent or is not a 32-byte hex string" },
      { code: "REPORT_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no report store" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "reconcile_agent_spend",
    publicName: "Spend reconciliation",
    protocol: "A2MCP",
    method: "POST",
    path: "/reconcile_agent_spend",
    pricing: { kind: "paid", price: "$0.25", amountBaseUnits: "250000" },
    maturity: "blocked",
    classification: {
      serviceClass: "INTERNAL_OR_WITHHELD",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It reconciles receipt and ledger history for an agent over a period, all of which is held here. " +
      "A caller with no history gets a refusal before any payment challenge.",
    },
    summary: "Totals what one agent spent over a period, and what was blocked before it spent.",
    intendedCaller: "an operator reconciling an agent's spend against what they authorised",
    delivers: "the period report, its hash, and — where a writer key is wired — the transaction that anchored the hash",
    input: {
      type: "object",
      title: "ReconcileRequest",
      properties: {
        agentId: {
          type: "string",
          description: "The agent to report on, as a decimal ERC-8004 id or a 32-byte hex id.",
          examples: ["6047"],
        },
        period: {
          type: ["string", "object"],
          description: "The window to report over — a named period such as `day` or `week`, or an explicit from/to.",
          examples: ["day"],
        },
      },
      required: ["agentId", "period"],
    },
    output: OK_ENVELOPE(
      "ReconcileReport",
      {
        tool: { type: "string", const: "reconcile_agent_spend" },
        reportHash: bytes32("The hash that is anchored."),
        report: { type: "object" },
        anchor: { type: "object" },
      },
      ["tool", "reportHash", "report", "anchor"],
    ),
    validExample: { title: "Reconcile one day", request: { agentId: "6047", period: "day" } },
    invalidExample: { title: "Omit the agent", request: { period: "day" }, refusalCode: "AGENT_ID_REQUIRED" },
    predecessors: [
      {
        what: "Receipt and ledger history for that agent in that period.",
        why: "The report is an aggregation. With no history it is honestly empty rather than wrong.",
        obtainableBy: null,
      },
    ],
    sideEffects: [
      {
        what: "Settles $0.25 of USDT0. Both the day and the week report currently charge this same rate.",
        durable: true,
      },
      { what: "Anchors the report hash on-chain, only where this instance holds a writer key.", durable: true },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "AGENT_ID_REQUIRED", status: 400, when: "agentId is absent or is neither a decimal nor a 32-byte hex id" },
      { code: "PERIOD_INVALID", status: 400, when: "the period could not be parsed" },
      { code: "REPORT_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no report store" },
    ],
    schemaVersion: "1.0.0",
  },

  // ── lifestyle demo ───────────────────────────────────────────────────────
  {
    toolId: "cafe_menu",
    publicName: "Café menu",
    protocol: "A2MCP",
    method: "GET",
    path: "/cafe/menu",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "demo",
    classification: {
      serviceClass: "PUBLIC_SUPPORT",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "The menu for the cafe demonstration. Free, public, and part of a simulation rather than a " +
      "service.",
    },
    summary: "A machine-readable café menu, used to demonstrate governed spending on something ordinary.",
    intendedCaller: "an agent being shown what a governed purchase looks like end to end",
    delivers: "the items, their prices, and how long a quote holds",
    input: NO_INPUT,
    output: OK_ENVELOPE(
      "Menu",
      {
        vendorId: { type: "string" },
        currency: { type: "string" },
        network: { type: "string" },
        items: { type: "array", items: { type: "object" } },
        quoteExpiresInSec: { type: "number" },
      },
      ["vendorId", "currency", "network", "items"],
    ),
    validExample: { title: "Read the menu", request: null },
    invalidExample: { title: "POST to a GET route", request: {}, refusalCode: "METHOD_NOT_ALLOWED" },
    predecessors: [],
    sideEffects: [],
    idempotency: "read-only",
    refusals: [{ code: "METHOD_NOT_ALLOWED", status: 405, when: "the path is right and the verb is not" }],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "cafe_order_latte",
    publicName: "Café order",
    protocol: "A2MCP",
    method: "POST",
    path: "/cafe/order/latte",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "demo",
    classification: {
      serviceClass: "PRODUCTION_DISABLED",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "It simulates a coffee order. No merchant is contacted, no order is placed and no coffee exists. " +
      "It used to cost $0.04, which made a demonstration look like a purchase. Kept as a free, clearly " +
      "labelled simulation and excluded from the marketplace, because a listing that sells a simulated " +
      "latte is a listing that misrepresents what a payment buys.",
    },
    summary: "Simulates a coffee order so a caller can see the shape of a governed purchase. Nothing is bought and nothing is delivered.",
    intendedCaller: "anyone evaluating what a governed agent purchase looks like before wiring a real provider",
    delivers: "a simulated order id and pickup code. No merchant is contacted, no order is placed and no coffee exists",
    input: {
      type: "object",
      title: "LatteOrder",
      properties: {
        buyerRef: { type: "string", maxLength: 128, description: "Optional. Your own reference for this order." },
      },
      required: [],
    },
    output: OK_ENVELOPE(
      "Voucher",
      {
        orderId: { type: "string" },
        sku: { type: "string", const: "latte" },
        amountPaid: { type: "string" },
        currency: { type: "string" },
        status: { type: "string" },
        pickupCode: { type: "string" },
        fulfillment: { type: "string", const: "DEMO_VOUCHER" },
        paidAt: isoTimestamp("When the order was created."),
      },
      ["orderId", "sku", "amountPaid", "currency", "status", "pickupCode", "fulfillment", "paidAt"],
    ),
    validExample: { title: "Order a latte", request: { buyerRef: "demo-run-1" } },
    invalidExample: { title: "Order without paying", request: {}, refusalCode: "PAYMENT_REQUIRED" },
    predecessors: [],
    sideEffects: [
      { what: "Settles $0.04 of USDT0.", durable: true },
      { what: "Issues a demonstration voucher. No coffee is dispatched.", durable: false },
    ],
    idempotency: "not-idempotent",
    refusals: [{ code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" }],
    schemaVersion: "1.0.0",
  },

  // ── builder pack ─────────────────────────────────────────────────────────
  {
    toolId: "suggest_names",
    publicName: "Product name suggestions",
    protocol: "A2MCP",
    method: "POST",
    path: "/builder/suggest_names",
    pricing: { kind: "paid", price: "$0.01", amountBaseUnits: "10000" },
    maturity: "demo",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "It returns generated name candidates for an idea, in the response, in one call. No account, no " +
      "prior state, and the buyer receives the complete result rather than a handle to fetch later.",
    },
    summary: "Proposes short product names for an idea, filtered against a list of over-used startup stems.",
    intendedCaller: "a founder or an agent naming something new",
    delivers: "a handful of candidate names, each with the reasoning behind it",
    input: {
      type: "object",
      title: "NameRequest",
      properties: {
        idea: { type: "string", minLength: 1, maxLength: 280, description: "What the product does, in a sentence." },
        count: { type: "number", minimum: 3, maximum: 8, description: "How many names to return. Defaults to 6." },
      },
      required: ["idea"],
    },
    output: OK_ENVELOPE(
      "Names",
      { suggestions: { type: "array", items: { type: "object" } }, note: { type: "string" } },
      ["suggestions"],
    ),
    validExample: { title: "Name a spend-control product", request: { idea: "spend control for autonomous agents", count: 6 } },
    invalidExample: { title: "Omit the idea", request: { count: 6 }, refusalCode: "IDEA_REQUIRED" },
    predecessors: [],
    sideEffects: [{ what: "Settles $0.01 of USDT0.", durable: true }],
    idempotency: "not-idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "IDEA_REQUIRED", status: 400, when: "idea is absent, empty, or longer than 280 characters" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "rank_options",
    publicName: "Name ranking",
    protocol: "A2MCP",
    method: "POST",
    path: "/builder/rank_options",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "blocked",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "Free, and it delivers: a heuristic ranking of supplied names with the reasons for each score. It " +
      "says plainly that it is a heuristic and not trademark clearance, so it makes no claim it cannot " +
      "check.",
    },
    summary: "Orders a list of candidate names by length, character set and how easily they are said.",
    intendedCaller: "someone choosing between names they already have",
    delivers: "the names in ranked order with their scores",
    input: {
      type: "object",
      title: "RankRequest",
      properties: {
        names: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 24,
          description: "The candidates to order.",
        },
      },
      required: ["names"],
    },
    output: OK_ENVELOPE(
      "Ranking",
      { ranked: { type: "array", items: { type: "object" } }, top: { type: "object" }, note: { type: "string" } },
      ["ranked", "note"],
    ),
    validExample: { title: "Rank four candidates", request: { names: ["Untch", "Kyrve", "FlowLabs", "NexaVerse"] } },
    invalidExample: { title: "Send an empty list", request: { names: [] }, refusalCode: "NAMES_REQUIRED" },
    predecessors: [],
    sideEffects: [],
    idempotency: "idempotent",
    refusals: [{ code: "NAMES_REQUIRED", status: 400, when: "names is absent or empty" }],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "check_domains",
    publicName: "Domain availability",
    protocol: "A2MCP",
    method: "POST",
    path: "/builder/check_domains",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "blocked",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "Free, and it performs a live RDAP lookup per name. It reports UNKNOWN wherever the registry does " +
      "not answer, including for TLDs with no trusted RDAP source, so an AVAILABLE from it is a claim " +
      "it actually verified.",
    },
    summary: "Asks the registries whether the domains for a list of names are taken.",
    intendedCaller: "someone checking whether a name is usable before committing to it",
    delivers: "one availability verdict per domain, with the registry response behind it",
    input: {
      type: "object",
      title: "DomainRequest",
      properties: {
        names: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 10, description: "Base names, without a suffix." },
        tlds: { type: "array", items: { type: "string" }, maxItems: 6, description: "Suffixes to check. Defaults to a standard set." },
      },
      required: ["names"],
    },
    output: OK_ENVELOPE("DomainVerdicts", { results: { type: "array", items: { type: "object" } } }, ["results"]),
    validExample: { title: "Check two names", request: { names: ["untch", "kyrve"], tlds: [".com", ".xyz"] } },
    invalidExample: { title: "Send no names", request: {}, refusalCode: "NAMES_REQUIRED" },
    predecessors: [],
    sideEffects: [{ what: "Queries public domain registries. Nothing is registered or reserved.", durable: false }],
    idempotency: "read-only",
    refusals: [{ code: "NAMES_REQUIRED", status: 400, when: "names is absent or empty" }],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "seo_tips",
    publicName: "Launch checklist",
    protocol: "A2MCP",
    method: "POST",
    path: "/builder/seo_tips",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "demo",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "Free, and it returns concrete suggestions plus handle and domain candidates in the response. It " +
      "disclaims legal and trademark advice rather than implying it.",
    },
    summary: "Returns a short launch checklist for a chosen brand name.",
    intendedCaller: "someone who has picked a name and is about to launch",
    delivers: "a list of concrete steps, using the name given",
    input: {
      type: "object",
      title: "TipsRequest",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 64, description: "The brand name." },
        idea: { type: "string", maxLength: 200, description: "Optional. What the product does." },
      },
      required: ["name"],
    },
    output: OK_ENVELOPE(
      "Tips",
      { name: { type: "string" }, idea: { type: ["string", "null"] }, tips: { type: "array", items: { type: "string" } } },
      ["name", "tips"],
    ),
    validExample: { title: "Checklist for a chosen name", request: { name: "Untch", idea: "spend control for agents" } },
    invalidExample: { title: "Omit the name", request: { idea: "spend control" }, refusalCode: "NAME_REQUIRED" },
    predecessors: [],
    sideEffects: [],
    idempotency: "idempotent",
    refusals: [{ code: "NAME_REQUIRED", status: 400, when: "name is absent or empty" }],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "brand_pack",
    publicName: "Launch brand pack",
    protocol: "A2MCP",
    method: "POST",
    path: "/builder/brand_pack",
    pricing: { kind: "paid", price: "$0.05", amountBaseUnits: "50000" },
    maturity: "blocked",
    classification: {
      serviceClass: "MARKETPLACE_LISTABLE",
      strangerCallable: true,
      catalogVisible: true,
      reason:
      "The paid tier of the builder set: it returns the assembled pack in the response after " +
      "settlement, with no account and no prior state required. It is priced above the free tools " +
      "because it produces the whole artifact rather than one heuristic.",
    },
    summary: "Runs naming, domain checking, ranking and the launch checklist as one call.",
    intendedCaller: "a founder or an agent wanting a first pass at a brand in a single request",
    delivers: "candidate names, their domain verdicts, a ranking, and a launch checklist",
    input: {
      type: "object",
      title: "BrandPackRequest",
      properties: {
        idea: { type: "string", minLength: 1, maxLength: 280, description: "What the product does, in a sentence." },
      },
      required: ["idea"],
    },
    output: OK_ENVELOPE(
      "BrandPack",
      {
        idea: { type: "string" },
        suggestions: { type: "array", items: { type: "object" } },
        domains: { type: "array", items: { type: "object" } },
        ranked: { type: "array", items: { type: "object" } },
        tips: { type: "array", items: { type: "string" } },
      },
      ["idea", "suggestions", "domains", "ranked", "tips"],
    ),
    validExample: { title: "One-call brand pass", request: { idea: "spend control for autonomous agents" } },
    invalidExample: { title: "Omit the idea", request: {}, refusalCode: "IDEA_REQUIRED" },
    predecessors: [],
    sideEffects: [
      { what: "Settles $0.05 of USDT0.", durable: true },
      { what: "Queries public domain registries. Nothing is registered or reserved.", durable: false },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "IDEA_REQUIRED", status: 400, when: "idea is absent, empty, or longer than 280 characters" },
    ],
    schemaVersion: "1.0.0",
  },

  // ── the account, policy and approval journey ─────────────────────────────
  //
  // These are the routes PASS 1 recorded as missing, and their presence here is what makes the
  // ordering MECHANICAL rather than described in prose a validator never reads. `preflight_payment`
  // names POLICY_PREDECESSOR; POLICY_PREDECESSOR names `/consumer/policies/draft`; that route names
  // ACCOUNT_PREDECESSOR; and ACCOUNT_PREDECESSOR names the link flow. A generator walking that graph
  // can state the whole sequence without anyone having written it down twice.
  {
    toolId: "account_link_start",
    publicName: "Account link — start",
    protocol: "A2MCP",
    method: "POST",
    path: "/consumer/account/link/start",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: false,
      reason:
      "It begins binding a wallet to an Untch account. This is this project's own sign-in, and listing " +
      "it would be advertising account setup as a purchasable service.",
    },
    summary: "Opens a one-time request to bind a wallet — and optionally a marketplace identity — to an Untch account.",
    intendedCaller:
      "a marketplace caller whose agent id Untch has never seen, or a person signing in for the first time",
    delivers:
      "a link request id, a one-time code shown exactly once, the message the wallet must sign, and the URL to sign it at",
    input: {
      type: "object",
      title: "AccountLinkStart",
      properties: {
        requestedScopes: {
          type: "array",
          description: "identity proves who you are. policy-authority additionally permits owning a policy.",
          items: { type: "string", enum: ["identity", "policy-authority"] },
        },
        marketplace: { type: "string", description: "The marketplace this call arrived through, e.g. okx." },
        marketplaceAgentId: {
          type: "string",
          description:
            "UNPROVEN on arrival. Recorded as context and authorises nothing until a wallet signs for it.",
        },
        marketplaceBuyerId: { type: "string" },
        taskRef: { type: "string", description: "The marketplace task or job this call belongs to." },
        serviceOrderRef: { type: "string" },
        returnUrl: {
          type: "string",
          description: "Where to return afterwards. Matched against an allowlist by exact ORIGIN, and must be https.",
        },
      },
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "AccountLinkStarted",
      {
        linkRequestId: { type: "string", pattern: "^ulnk_[a-z0-9]{26}$" },
        oneTimeCode: { type: "string", description: "Returned once. Stored hashed; no later read can produce it." },
        expiresAt: isoTimestamp("When this link request stops being redeemable."),
        proofMethod: { type: "string", const: "siwe-personal-sign" },
        walletActionUrl: { type: "string" },
        requestedScopes: { type: "array", items: { type: "string" } },
      },
      ["linkRequestId", "oneTimeCode", "expiresAt", "proofMethod"],
    ),
    validExample: {
      title: "Link a marketplace caller",
      request: { marketplace: "okx", marketplaceAgentId: "6047", taskRef: "task-42", requestedScopes: ["identity"] },
    },
    invalidExample: {
      title: "Ask for a scope that does not exist",
      request: { requestedScopes: ["spend-anything"] },
      refusalCode: "UNKNOWN_SCOPE",
    },
    predecessors: [],
    sideEffects: [
      { what: "Creates a pending link request holding a hashed one-time code.", durable: true },
      { what: "Approves no payment. No route reachable from this code takes an amount.", durable: false },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "UNKNOWN_SCOPE", status: 400, when: "requestedScopes contains a scope this host does not grant" },
      { code: "RETURN_URL_NOT_ALLOWED", status: 400, when: "returnUrl is not an exact-origin match for an allowed origin, or is not https" },
      { code: "ACCOUNT_LINK_UNAVAILABLE", status: 503, when: "this instance cannot mint sessions" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "account_link_complete",
    publicName: "Account link — complete",
    protocol: "A2MCP",
    method: "POST",
    path: "/consumer/account/link/complete",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: false,
      reason:
      "It completes a wallet binding against a signature. The other half of sign-in, and not a product.",
    },
    summary: "Verifies a wallet signature and binds the wallet, and any marketplace identity, to an account.",
    intendedCaller: "the same person who started the link, now holding a signature from their wallet",
    delivers: "the account id, the wallet binding, any marketplace binding, and a session token",
    input: {
      type: "object",
      title: "AccountLinkComplete",
      properties: {
        linkRequestId: { type: "string", pattern: "^ulnk_[a-z0-9]{26}$" },
        code: { type: "string", description: "The one-time code. Case and hyphens are ignored." },
        message: { type: "string", description: "The SIWE message, naming this domain and the nonce this request issued." },
        signature: { type: "string", pattern: "^0x[0-9a-fA-F]+$" },
        walletProvider: { type: "string", description: "e.g. okx-agentic-wallet. Recorded, never trusted." },
      },
      required: ["linkRequestId", "code", "message", "signature"],
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "AccountLinked",
      {
        accountId: { type: "string", pattern: "^acct_[a-z0-9]{26}$" },
        accountCreated: { type: "boolean", description: "False when the wallet restored an existing account." },
        session: { type: "object" },
        nextAction: { type: "object", description: "READY, or POLICY_REQUIRED when the account holds no policy yet." },
      },
      ["accountId", "accountCreated", "session"],
    ),
    validExample: {
      title: "Complete a link",
      request: {
        linkRequestId: "ulnk_abcdefghijklmnopqrstuvwxyz",
        code: "ABCD-EFGH-IJKL-MNOP-QRST",
        message: "asp.untch.xyz wants you to sign in with your Ethereum account:\n0x…",
        signature: "0xdeadbeef",
      },
    },
    invalidExample: {
      title: "Present a signature naming another request's nonce",
      request: {
        linkRequestId: "ulnk_abcdefghijklmnopqrstuvwxyz",
        code: "ABCD-EFGH-IJKL-MNOP-QRST",
        message: "asp.untch.xyz wants you to sign in…",
        signature: "0xdeadbeef",
      },
      refusalCode: "SIWE_NONCE_MISMATCH",
    },
    predecessors: [
      {
        what: "A pending link request and its one-time code.",
        why: "The request holds the nonce the signature must name, so a signature obtained for another purpose cannot complete this binding.",
        obtainableBy: "POST /consumer/account/link/start",
      },
      {
        what: "A wallet able to sign an EIP-191 personal_sign message on X Layer.",
        why: "Authority here is a verified wallet and nothing else.",
        obtainableBy: "the OKX Agentic Wallet (`wallet sign-message --type personal`), or any EVM wallet",
      },
    ],
    sideEffects: [
      { what: "Creates or restores an account and binds the wallet to it.", durable: true },
      { what: "Binds a marketplace identity, when the request carried one.", durable: true },
      { what: "Consumes the one-time code. It cannot be redeemed twice.", durable: true },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "SIWE_NONCE_MISMATCH", status: 401, when: "the message names a nonce this link request did not issue" },
      { code: "SIWE_WRONG_DOMAIN", status: 401, when: "the message was signed for another site" },
      { code: "SIWE_WRONG_CHAIN", status: 401, when: "the message names a chain that is not X Layer 196 or 1952" },
      { code: "SIWE_BAD_SIGNATURE", status: 401, when: "the signature does not verify" },
      { code: "LINK_CODE_MISMATCH", status: 401, when: "the one-time code does not match this request" },
      { code: "LINK_REQUEST_NOT_PENDING", status: 409, when: "the request was already completed, cancelled or expired" },
      { code: "WALLET_BOUND_ELSEWHERE", status: 409, when: "that address is already the authority of another account" },
      { code: "MARKETPLACE_IDENTITY_BOUND_ELSEWHERE", status: 409, when: "that agent id is already bound to another account" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "policy_draft",
    publicName: "Policy draft",
    protocol: "A2MCP",
    method: "POST",
    path: "/consumer/policies/draft",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It builds an unsigned policy registration for the caller to send from their own wallet. A setup " +
      "step for an account, correctly free, and not something a stranger buys.",
    },
    summary: "Turns human spending limits into the exact unsigned transaction that registers them on chain.",
    intendedCaller: "an account owner setting the rules their agent will spend under",
    delivers:
      "the canonical ruleset, its policy hash, the unsigned registerPolicy transaction, and the addresses permitted to send it",
    input: {
      type: "object",
      title: "PolicyDraft",
      properties: {
        name: { type: "string" },
        currency: { type: "string", description: "Settlement token symbol these limits are denominated in." },
        perActionLimit: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,6})?$", description: "DECIMAL STRING." },
        dailyLimit: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,6})?$", description: "DECIMAL STRING." },
        autoApproveAtOrBelow: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,6})?$", description: "At or below this, the decision is automatic. Above it, the owner is asked." },
        hardCap: { type: "string", pattern: "^\\d{1,12}(\\.\\d{1,6})?$", description: "The line nothing crosses, approval or not." },
        allowedCapabilities: { type: "array", items: { type: "string" }, minItems: 1 },
        deniedCapabilities: { type: "array", items: { type: "string" } },
        allowedRecipients: { type: "array", items: address("A permitted recipient.") },
        deniedRecipients: { type: "array", items: address("A refused recipient.") },
        expiry: { type: "string", description: "ISO-8601. After this the policy authorises nothing, with no transaction needed to stop it." },
        duplicateWindowMinutes: { type: "integer", minimum: 0 },
        cooldownMinutes: { type: "integer", minimum: 0 },
        callsPerHour: { type: "integer", minimum: 0 },
        agentId: address("The agent address this policy governs. Immutable on chain once registered."),
      },
      required: [
        "name",
        "currency",
        "perActionLimit",
        "dailyLimit",
        "autoApproveAtOrBelow",
        "hardCap",
        "allowedCapabilities",
        "expiry",
      ],
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "PolicyDrafted",
      {
        policyDraftId: { type: "string" },
        policyHash: bytes32("The hash the registry will store."),
        canonicalRules: { type: "object", description: "The full ruleset the hash covers. Shown, never hidden." },
        derivedDefaults: { type: "array", items: { type: "object" }, description: "What the server decided that you did not state, with the reasoning." },
        transaction: { type: "object", description: "The unsigned registerPolicy call, for YOUR wallet to send." },
        mustBeSentBy: { type: "object", description: "Which addresses may send it, and why Untch cannot." },
      },
      ["policyDraftId", "policyHash", "canonicalRules", "transaction", "mustBeSentBy"],
    ),
    validExample: {
      title: "Gifts and small errands",
      request: {
        name: "Gifts and small errands",
        currency: "USDC",
        perActionLimit: "8.00",
        dailyLimit: "40.00",
        autoApproveAtOrBelow: "5.00",
        hardCap: "8.00",
        allowedCapabilities: ["gifts.order"],
        expiry: "2027-01-01T00:00:00.000Z",
      },
    },
    invalidExample: {
      title: "A threshold above the hard cap",
      request: {
        name: "Broken",
        currency: "USDC",
        perActionLimit: "8.00",
        dailyLimit: "40.00",
        autoApproveAtOrBelow: "20.00",
        hardCap: "8.00",
        allowedCapabilities: ["gifts.order"],
        expiry: "2027-01-01T00:00:00.000Z",
      },
      refusalCode: "POLICY_THRESHOLD_ABOVE_CAP",
    },
    predecessors: [
      ACCOUNT_PREDECESSOR,
      {
        what: "A wallet on the account carrying the policy-authority scope.",
        why: "A wallet that proved identity has not thereby consented to hold spending rules.",
        obtainableBy: "request `policy-authority` in requestedScopes at POST /consumer/account/link/start",
      },
    ],
    sideEffects: [
      { what: "Stores a draft. Nothing is registered and no transaction is sent.", durable: true },
      { what: "Untch does NOT relay the registration: registerPolicy makes msg.sender the owner.", durable: false },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "ACCOUNT_SESSION_REQUIRED", status: 401, when: "no account session accompanied the request" },
      { code: "POLICY_AUTHORITY_REQUIRED", status: 409, when: "no wallet on this account may own a policy" },
      { code: "POLICY_THRESHOLD_ABOVE_CAP", status: 400, when: "autoApproveAtOrBelow is above hardCap, which would make the cap unreachable" },
      { code: "POLICY_PER_ACTION_ABOVE_DAILY", status: 400, when: "perActionLimit is above dailyLimit, so one action would spend the day" },
      { code: "POLICY_NO_CAPABILITIES", status: 400, when: "allowedCapabilities is empty" },
      { code: "POLICY_EXPIRY_PAST", status: 400, when: "expiry has already passed; the registry would refuse it on chain" },
      { code: "POLICY_AMOUNT_INVALID", status: 400, when: "an amount is not a decimal string" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "policy_sync",
    publicName: "Policy sync",
    protocol: "A2MCP",
    method: "POST",
    path: "/consumer/policies/sync",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "It records a policy registration the caller already sent from their own wallet. The second half " +
      "of setup, and account control for the same reason the first half is.",
    },
    summary: "Reads a confirmed registration from chain and links the policy to the account that can sign for it.",
    intendedCaller: "an account owner who has just sent their own registerPolicy transaction",
    delivers: "the numeric policyId, the on-chain owner, and whether the policy became this account's default",
    input: {
      type: "object",
      title: "PolicySync",
      properties: {
        policyDraftId: { type: "string" },
        txHash: bytes32("The confirmed registerPolicy transaction YOUR wallet sent."),
      },
      required: ["policyDraftId", "txHash"],
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "PolicySynced",
      {
        policyId: { type: "string" },
        owner: address("Read from the PolicyRegistered event, never from the caller."),
        policyHash: bytes32("The anchored hash."),
        becameDefault: { type: "boolean" },
      },
      ["policyId", "owner", "policyHash"],
    ),
    validExample: {
      title: "Sync a confirmed registration",
      request: { policyDraftId: "pdft_0a3d0588efcc785f367e9ee8", txHash: `0x${"11".repeat(32)}` },
    },
    invalidExample: {
      title: "Sync a registration somebody else made",
      request: { policyDraftId: "pdft_0a3d0588efcc785f367e9ee8", txHash: `0x${"22".repeat(32)}` },
      refusalCode: "NOT_POLICY_OWNER",
    },
    predecessors: [
      ACCOUNT_PREDECESSOR,
      {
        what: "A policy draft, and a confirmed registerPolicy transaction for it.",
        why: "The draft holds the rules the anchored hash is checked against; the transaction is what made you the owner.",
        obtainableBy: "POST /consumer/policies/draft, then send the returned transaction from your own wallet",
      },
    ],
    sideEffects: [
      { what: "Stores the policy and links it to this account.", durable: true },
      { what: "Sets it as the default when the account has none.", durable: true },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "ACCOUNT_SESSION_REQUIRED", status: 401, when: "no account session accompanied the request" },
      { code: "DRAFT_NOT_FOUND", status: 404, when: "no such draft, or it belongs to another account" },
      { code: "NOT_POLICY_OWNER", status: 403, when: "the on-chain owner is not a policy-authority wallet of this account" },
      { code: "RULES_HASH_MISMATCH", status: 409, when: "the draft's rules do not hash to what the transaction anchored" },
      { code: "REGISTRATION_UNREADABLE", status: 502, when: "no PolicyRegistered event could be read from that transaction" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "set_default_policy",
    publicName: "Default policy",
    protocol: "A2MCP",
    /**
     * PUT, which is what the route has always been. The registry said POST, so a caller following our
     * own catalog or MCP tool list got a 405 naming the method they should have been told to use.
     * `registry-serves-what-it-advertises.test.ts` now checks every entry against the generated route
     * manifest so an advertised method cannot drift from the served one again.
     */
    method: "PUT",
    path: "/consumer/account/default-policy",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: false,
      reason:
      "It sets which policy an account uses by default. Configuration of somebody's account.",
    },
    summary: "Chooses which policy answers when a request names none.",
    intendedCaller: "an account owner holding more than one policy",
    delivers: "the chosen default, after checking the account can actually sign for it",
    input: {
      type: "object",
      title: "SetDefaultPolicy",
      properties: { policyId: { type: "string" } },
      required: ["policyId"],
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "DefaultPolicySet",
      { accountId: { type: "string" }, defaultPolicyId: { type: "string" } },
      ["accountId", "defaultPolicyId"],
    ),
    validExample: { title: "Choose a default", request: { policyId: "9001" } },
    invalidExample: { title: "Choose an expired policy", request: { policyId: "9001" }, refusalCode: "POLICY_EXPIRED" },
    predecessors: [ACCOUNT_PREDECESSOR, POLICY_PREDECESSOR],
    sideEffects: [{ what: "Changes which policy an unqualified request resolves to.", durable: true }],
    idempotency: "idempotent",
    refusals: [
      { code: "ACCOUNT_SESSION_REQUIRED", status: 401, when: "no account session accompanied the request" },
      { code: "POLICY_NOT_FOUND", status: 404, when: "no such policy on this account" },
      { code: "POLICY_NOT_ACTIVE", status: 409, when: "the policy is paused" },
      { code: "POLICY_EXPIRED", status: 409, when: "the policy has expired" },
      { code: "NOT_POLICY_OWNER", status: 403, when: "no wallet on this account owns it" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "approval_decide",
    publicName: "Approval decision",
    protocol: "A2MCP",
    method: "POST",
    path: "/consumer/approvals/:approvalRequestId/decide",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "live",
    deprecated: true,
    classification: {
      serviceClass: "ACCOUNT_CONTROL",
      strangerCallable: false,
      catalogVisible: true,
      reason:
      "A legacy human control route, replaced by the bound-action path for service-call-backed " +
      "approvals. It requires account state and refuses a modern paid approval request that has no " +
      "bound action, so a stranger calling it can only ever be refused. Kept mounted for compatibility, " +
      "marked deprecated, and removed from the listing where it was advertised as a free marketplace " +
      "service.",
    },
    summary: "Approves or rejects one escalated action, naming the exact payment it authorises.",
    intendedCaller: "the account owner, through a wallet-backed session",
    delivers: "the resolved state, and an explicit statement of whether anything was paid",
    input: {
      type: "object",
      title: "ApprovalDecision",
      properties: {
        decision: { type: "string", enum: ["APPROVE", "REJECT"] },
        approvalDigest: {
          type: "string",
          pattern: "^apd_[0-9a-f]{64}$",
          description:
            "REQUIRED. The digest you were shown, covering intent, quote, amount, asset, provider, capability, recipient, policy, version, nonce and expiry. A decision without it is not a decision: a re-quote changes the digest, and approving the old one would agree to a number you were never shown.",
        },
      },
      required: ["decision", "approvalDigest"],
      additionalProperties: false,
    },
    output: OK_ENVELOPE(
      "ApprovalDecided",
      {
        state: { type: "string", enum: ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "EXECUTED"] },
        outcome: { type: "string", description: "APPROVED_AWAITING_EXECUTION when provider execution is disabled." },
        paid: { type: "boolean", description: "Whether money actually moved. Approving is not paying." },
        repeat: { type: "boolean", description: "True when this repeated an identical earlier decision." },
      },
      ["state", "outcome", "paid"],
    ),
    validExample: {
      title: "Approve the exact quote",
      request: { decision: "APPROVE", approvalDigest: `apd_${"a".repeat(64)}` },
    },
    invalidExample: {
      title: "Say yes without naming what",
      request: { decision: "APPROVE" },
      refusalCode: "APPROVAL_DIGEST_REQUIRED",
    },
    predecessors: [
      ACCOUNT_PREDECESSOR,
      {
        what: "A pending approval request, raised because an action exceeded the policy's automatic-approval threshold.",
        why: "There is nothing to decide until the policy engine asks.",
        obtainableBy: "GET /consumer/approvals lists them; they are created by the decision path, never by a caller",
      },
      CHANNEL_BINDING_PREDECESSOR,
    ],
    sideEffects: [
      { what: "Records a decision bound to the exact payment digest.", durable: true },
      { what: "Resolves the approval request. It does NOT execute anything.", durable: true },
    ],
    idempotency: "idempotent",
    refusals: [
      { code: "ACCOUNT_SESSION_REQUIRED", status: 401, when: "no account session accompanied the request" },
      { code: "APPROVAL_DIGEST_REQUIRED", status: 400, when: "approvalDigest was omitted" },
      { code: "APPROVAL_NOT_FOUND", status: 404, when: "no such approval, or it belongs to another account" },
      { code: "APPROVAL_DIGEST_MISMATCH", status: 409, when: "the digest no longer describes this payment — the quote changed" },
      { code: "APPROVAL_NOT_PENDING", status: 409, when: "already resolved, or superseded by a re-quote" },
      { code: "APPROVAL_ALREADY_DECIDED", status: 409, when: "this actor already answered, and differently" },
      { code: "APPROVAL_EXPIRED", status: 410, when: "the approval expired before it was answered" },
    ],
    schemaVersion: "1.0.0",
  },
];

export const SERVICE_BY_ID: ReadonlyMap<string, ServiceDefinition> = new Map(SERVICES.map((s) => [s.toolId, s]));

export function serviceById(toolId: string): ServiceDefinition | undefined {
  return SERVICE_BY_ID.get(toolId);
}

/** The refusal envelope, exported so generators can reference one shape rather than restating it. */
export { ERROR_ENVELOPE };

/** Re-exported for the fixture generator, which builds requests from the same patterns the schemas use. */
export { ADDRESS_PATTERN, BYTES32_PATTERN, UINT256_PATTERN };
