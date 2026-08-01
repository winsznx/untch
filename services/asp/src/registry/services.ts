import {
  ADDRESS_PATTERN,
  BYTES32_PATTERN,
  ERROR_ENVELOPE,
  POLICY_HASH_PREDECESSOR,
  POLICY_PREDECESSOR,
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
    pricing: { kind: "paid", price: "$0.01", amountBaseUnits: "10000" },
    maturity: "live",
    summary: "Confirms that a paid call to this host settles end to end.",
    intendedCaller: "an integrator proving their x402 client can pay this host before wiring anything expensive",
    delivers: "a timestamped acknowledgement, after a real settled payment of $0.01",
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
    maturity: "blocked",
    summary:
      "Judges a proposed payment against a registered spend policy and returns allow, block or escalate, with the rule that decided it.",
    intendedCaller: "an operator funding an autonomous agent who wants every payment checked before it moves",
    delivers:
      "a decision, the ordered list of rules that were evaluated and what each one found, and a receipt reference for the decision",
    input: {
      type: "object",
      title: "PreflightRequest",
      description:
        "Either an inline intent, or the hash of one already created through create_spend_intent on THIS instance.",
      properties: {
        policyId: policyIdField,
        intent: SPEND_INTENT_INPUT,
        intentHash: bytes32(
          "The hash of an intent previously created on this instance. Resolves from an in-memory cache, so it is lost on restart and unknown to any other instance.",
        ),
        vaultAddress: address("Optional. When set, and an oracle key is configured, a Mode-C signature is returned."),
      },
      required: ["policyId"],
      /**
       * The choice, stated as a rule rather than as prose.
       *
       * `required: ["policyId"]` alone is what the registered listing effectively claimed, and it is
       * how a caller ends up sending one field and being refused for sixteen. The alternative is
       * expressed here so the generated description has to name it.
       */
      anyOf: [{ required: ["intent"] }, { required: ["intentHash"] }],
    },
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
      title: "Judge a $1.50 API call against policy 7",
      request: { policyId: "7", intent: EXAMPLE_INTENT },
    },
    invalidExample: {
      title: "Send maxAmount as a JSON number instead of a decimal string",
      request: { policyId: "7", intent: { ...EXAMPLE_INTENT, maxAmount: 2000000 } },
      refusalCode: "INTENT_MALFORMED",
    },
    predecessors: [POLICY_PREDECESSOR, POLICY_HASH_PREDECESSOR],
    sideEffects: [
      { what: "Records the decision in this instance's rolling ledger window.", durable: false },
      { what: "Writes a DECISION receipt and queues it for anchoring, when a receipt writer is wired.", durable: true },
    ],
    idempotency: "not-idempotent",
    refusals: [
      { code: "PAYMENT_REQUIRED", status: 402, when: "no valid payment accompanied the request" },
      { code: "POLICY_ID_REQUIRED", status: 400, when: "policyId is absent or is not a decimal string" },
      { code: "INTENT_REQUIRED", status: 400, when: "neither an inline intent nor an intentHash was given" },
      { code: "INTENT_MALFORMED", status: 400, when: "a field of the intent has the wrong type or format" },
      { code: "INTENT_NOT_FOUND", status: 404, when: "the intentHash is unknown to THIS instance" },
      { code: "POLICY_NOT_FOUND", status: 404, when: "no policy with that id is stored" },
      { code: "POLICY_BINDING_MISMATCH", status: 400, when: "policyHash does not equal the stored policy's hash" },
      { code: "POLICY_STORE_NOT_CONFIGURED", status: 503, when: "this instance has no policy store" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "verify_delivery",
    publicName: "Delivery verify",
    protocol: "A2MCP",
    method: "POST",
    path: "/verify_delivery",
    pricing: { kind: "paid", price: "$0.10", amountBaseUnits: "100000" },
    maturity: "blocked",
    summary:
      "Checks a delivered result against the acceptance criteria that were committed to before the work started, and records the verdict.",
    intendedCaller: "a buyer deciding whether work they commissioned has actually been delivered",
    delivers: "a pass or fail verdict against the committed criteria, and a durable receipt of that verdict",
    input: {
      type: "object",
      title: "VerifyRequest",
      properties: {
        policyId: policyIdField,
        intent: SPEND_INTENT_INPUT,
        intentHash: bytes32("The hash of an intent previously created on this instance."),
        acceptanceCriteria: {
          type: "object",
          description: "Optional. The criteria to judge against, when they were not committed on the intent.",
        },
        payload: { type: "object", description: "The delivered result itself." },
        payloadHash: bytes32("A hash of the delivered result, when the result itself is not being sent."),
      },
      required: ["policyId"],
      /** Two independent choices: which intent, and which delivery. Neither implies the other. */
      allOf: [
        { anyOf: [{ required: ["intent"] }, { required: ["intentHash"] }] },
        { anyOf: [{ required: ["payload"] }, { required: ["payloadHash"] }] },
      ],
    },
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
      title: "Verify a delivery against policy 7",
      request: { policyId: "7", intent: EXAMPLE_INTENT, payloadHash: `0x${"66".repeat(32)}` },
    },
    invalidExample: {
      title: "Omit both the delivered result and its hash",
      request: { policyId: "7", intent: EXAMPLE_INTENT },
      refusalCode: "DELIVERY_REQUIRED",
    },
    predecessors: [
      POLICY_PREDECESSOR,
      POLICY_HASH_PREDECESSOR,
      {
        what: "The acceptanceHash that was committed when the work was commissioned.",
        why: "Verification compares against what was agreed BEFORE the work, which is the only comparison that means anything afterwards.",
        obtainableBy: null,
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
      { code: "POLICY_ID_REQUIRED", status: 400, when: "policyId is absent or is not a decimal string" },
      { code: "INTENT_REQUIRED", status: 400, when: "neither an inline intent nor an intentHash was given" },
      { code: "INTENT_NOT_FOUND", status: 404, when: "the intentHash is unknown to THIS instance" },
      { code: "POLICY_NOT_FOUND", status: 404, when: "no policy with that id is stored" },
      { code: "POLICY_BINDING_MISMATCH", status: 400, when: "policyHash does not equal the stored policy's hash" },
      { code: "CRITERIA_MALFORMED", status: 400, when: "acceptanceCriteria was given but is not an object" },
      { code: "DELIVERY_REQUIRED", status: 400, when: "neither payload nor payloadHash was given" },
      { code: "DELIVERY_MALFORMED", status: 400, when: "payloadHash is not a 32-byte hex string" },
    ],
    schemaVersion: "1.0.0",
  },
  {
    toolId: "create_spend_intent",
    publicName: "Create spend intent",
    protocol: "A2MCP",
    method: "POST",
    path: "/create_spend_intent",
    pricing: { kind: "free", price: null, amountBaseUnits: null },
    maturity: "blocked",
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
    pricing: { kind: "paid", price: "$0.04", amountBaseUnits: "40000" },
    maturity: "demo",
    summary: "Buys a demonstration coffee voucher, to show a real payment against a real policy.",
    intendedCaller: "anyone evaluating what a governed agent purchase feels like without spending much",
    delivers: "an order id and a pickup code. The fulfilment is a demonstration, not a real coffee",
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
];

export const SERVICE_BY_ID: ReadonlyMap<string, ServiceDefinition> = new Map(SERVICES.map((s) => [s.toolId, s]));

export function serviceById(toolId: string): ServiceDefinition | undefined {
  return SERVICE_BY_ID.get(toolId);
}

/** The refusal envelope, exported so generators can reference one shape rather than restating it. */
export { ERROR_ENVELOPE };

/** Re-exported for the fixture generator, which builds requests from the same patterns the schemas use. */
export { ADDRESS_PATTERN, BYTES32_PATTERN, UINT256_PATTERN };
