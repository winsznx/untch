import {
  evaluateIntentSerialized,
  type Decision,
  type Ledger,
  type PerAgentLock,
  type SpendIntentInput,
} from "@untch/policy-engine";
import { toEnginePolicy, type PolicyProvider, type StoredPolicy } from "@untch/policy-store";
import type { ReceiptEnqueuer } from "@untch/receipt-writer";
import {
  verifyDelivery,
  type AcceptanceCriteria,
  type Delivery,
  type VerifyOutcome,
} from "@untch/proof-engine";
import type { Hex } from "viem";
import {
  IntentValidationError,
  intentHashOf,
  parseFullIntent,
  parseStruct,
  toCanonicalView,
} from "./intent";
import type { InMemoryIntentStore } from "./ledger-state";

/**
 * Framework-agnostic handlers for the two buyer-facing tools. Each returns `{ status, body }` so it is
 * unit-testable with the REAL policy engine and NO network — the Express layer (`server.ts`) forwards
 * the result. `preflight_payment` surfaces exactly what `evaluateIntentSerialized` returns; it never
 * rewrites a decision, reason, or trace entry.
 *
 * As of the policy-store work these tools no longer use a hardcoded fixture policy: both resolve a
 * REAL, durable policy from Postgres by `policyId` (via `PolicyProvider`). The fixture is gone.
 */

export interface HandlerResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

/** §11 error envelope `{code, message, retryable, docsUrl}`. `docsUrl` is null — no public docs
 *  site exists yet (honest null, not a fabricated link). */
function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

/** Read the required top-level `policyId` (a uint256 decimal string) from a tool request body. */
function readPolicyId(body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.policyId;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) return raw.trim();
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  return null;
}

/** True iff the intent commits to exactly this stored policy's ruleset hash (binding integrity). */
function intentBoundToPolicy(intent: SpendIntentInput, stored: StoredPolicy): boolean {
  return intent.policyHash.toLowerCase() === stored.policyHash.toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// create_spend_intent — unpriced: validate, canonicalize, hash, bind to a real policy, cache
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDeps {
  readonly intentStore: InMemoryIntentStore;
  readonly policyProvider: PolicyProvider;
  /** Optional SpendIntentRegistry writer. When set, intents ≥ anchorIntentsAbove are registered. */
  readonly intentRegistry?: import("./intent-registry").IntentRegistryClient | null;
}

/**
 * `create_spend_intent` (bundled / unpriced). Validates, hashes, binds to a real policy, caches.
 * When `intentRegistry` is wired and policy.anchorIntentsAbove is met, registers on SpendIntentRegistry.
 * Otherwise returns an honest onchain status (unwired / below_anchor_threshold), never a silent lie.
 */
export async function handleCreateSpendIntent(
  body: unknown,
  deps: CreateDeps,
): Promise<HandlerResult> {
  const policyId = readPolicyId(body);
  if (!policyId) {
    return {
      status: 400,
      body: errorEnvelope("POLICY_ID_REQUIRED", "a `policyId` (uint256 decimal string) is required"),
    };
  }

  let parsed: { input: SpendIntentInput; intentHash: Hex };
  try {
    parsed = parseFullIntent(body);
  } catch (err) {
    if (err instanceof IntentValidationError) {
      return { status: 400, body: errorEnvelope(err.code, err.message) };
    }
    throw err;
  }

  const stored = await deps.policyProvider.loadStored(policyId);
  if (!stored) {
    return {
      status: 404,
      body: errorEnvelope("POLICY_NOT_FOUND", `no stored policy with id ${policyId}`),
    };
  }
  if (!intentBoundToPolicy(parsed.input, stored)) {
    return {
      status: 400,
      body: errorEnvelope(
        "POLICY_BINDING_MISMATCH",
        `intent.policyHash ${parsed.input.policyHash} does not equal stored policy ${policyId}'s policyHash ${stored.policyHash}`,
      ),
    };
  }

  deps.intentStore.put(parsed.intentHash, parsed.input);

  // §10.2 on-chain anchor when threshold met and writer wired
  const { shouldAnchorIntent } = await import("./intent-registry");
  const rules = stored.rules as { anchorIntentsAbove?: number };
  let onchain: Record<string, unknown>;
  if (!deps.intentRegistry) {
    onchain = { registered: false, status: "unwired", reason: "INTENT_WRITER_PRIVATE_KEY not configured" };
  } else if (!shouldAnchorIntent(parsed.input.amount, rules)) {
    onchain = {
      registered: false,
      status: "below_anchor_threshold",
      reason:
        typeof rules.anchorIntentsAbove === "number"
          ? `amount ${parsed.input.amount} < anchorIntentsAbove ${rules.anchorIntentsAbove}`
          : "policy has no anchorIntentsAbove",
    };
  } else {
    const struct = {
      owner: parsed.input.owner,
      buyerAgentId: parsed.input.buyerAgentId,
      workerAgentId: parsed.input.workerAgentId,
      token: parsed.input.token,
      maxAmount: parsed.input.maxAmount,
      taskHash: parsed.input.taskHash,
      acceptanceHash: parsed.input.acceptanceHash,
      schemaHash: parsed.input.schemaHash,
      policyHash: parsed.input.policyHash,
      deadline: parsed.input.deadline,
      nonce: parsed.input.nonce,
    };
    onchain = await deps.intentRegistry.register(struct, BigInt(policyId));
  }

  return {
    status: 200,
    body: {
      intentHash: parsed.intentHash,
      canonicalIntent: toCanonicalView(parsed.input),
      policyId,
      policyVersion: stored.version,
      onchain,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// preflight_payment — priced $0.05: load the real policy, run the real engine, surface it verbatim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §7.2 / §27 escalation gateway. When preflight yields an `ESCALATED_*` decision, the SERVER creates
 * the escalation record + fans out to the operator's channel here — so the guard's poll() has a real
 * escalation to resolve against WITHOUT the operator-side driver having to host the service. The gateway
 * gets everything it needs off the decision the handler already has in hand: the resolved intent (for
 * the amount), the decision (reason/intentHash/policyId), the stored policy (approvals config), and the
 * exact `pollRef` the guard will poll by (`receiptRef.receiptId ?? intentHash`). Kept as a narrow
 * interface so the handler stays unit-testable with no escalation/Postgres/Telegram dependency.
 */
export interface EscalationGateway {
  onEscalated(args: {
    readonly input: SpendIntentInput;
    readonly decision: Decision;
    readonly stored: StoredPolicy;
    readonly pollRef: string;
  }): Promise<void>;
}

export interface PreflightDeps {
  readonly policyProvider: PolicyProvider;
  readonly ledger: Ledger;
  readonly intentStore: InMemoryIntentStore;
  /** Injectable clock for deterministic tests; defaults to the engine's `Date.now`. */
  readonly now?: () => number;
  /** Injectable per-agent lock (isolate tests); defaults to the engine's module singleton. */
  readonly lock?: PerAgentLock;
  /** §7.4 receipt writer. When present, the decision is durably enqueued and a real
   *  {receiptId, status:"QUEUED"} is returned in `receiptRef`. Absent ⇒ `receiptRef` stays null. */
  readonly receiptEnqueuer?: ReceiptEnqueuer;
  /** §7.2 escalation gateway. When present AND the decision is `ESCALATED_*`, the server creates the
   *  escalation so the guard's poll() resolves for real. Absent ⇒ no escalation is created (poll stays
   *  PENDING) — an honest capability boundary, never a fabricated approval. */
  readonly escalationGateway?: EscalationGateway;
  /** Optional intent registry for post-decision setStatus. */
  readonly intentRegistry?: import("./intent-registry").IntentRegistryClient | null;
  /** Optional Mode C oracle signer (env ORACLE_PRIVATE_KEY). */
  readonly oracleSigner?: import("./oracle-signer").OracleSigner | null;
  /** Optional bureau for vendor.lcbFloor snapshot inject. */
  readonly scoreDataSource?: import("@untch/trust-bureau").ScoreDataSource | null;
}

/**
 * Resolve the intent to evaluate from the request body. Accepts (per §11):
 *   • `{ intent: {…full…} }`         — inline intent, parsed + validated here;
 *   • `{ intentHash: "0x…" }`        — resolved from the in-memory store (a prior create on this
 *                                       instance); misses ⇒ honest 404 telling the caller to
 *                                       resubmit inline (no IntentRegistry to fall back to yet);
 *   • both                           — inline parsed AND cross-checked: recomputed hash must equal
 *                                       the supplied `intentHash`, else 400 (binding integrity).
 * Top-level intent fields (no `intent` wrapper) are also accepted as inline, for convenience.
 */
function resolveIntent(
  body: unknown,
  store: InMemoryIntentStore,
): { input: SpendIntentInput } | HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const hasInlineWrapper = b.intent !== undefined && b.intent !== null;
  const inlineSource = hasInlineWrapper ? b.intent : b;
  const intentHash = typeof b.intentHash === "string" ? b.intentHash : undefined;

  const looksInline =
    hasInlineWrapper ||
    (typeof (inlineSource as Record<string, unknown>)?.owner === "string" &&
      (inlineSource as Record<string, unknown>)?.taskHash !== undefined);

  if (looksInline) {
    let parsed: { input: SpendIntentInput; intentHash: Hex };
    try {
      parsed = parseFullIntent(inlineSource);
    } catch (err) {
      if (err instanceof IntentValidationError) {
        return { status: 400, body: errorEnvelope(err.code, err.message) };
      }
      throw err;
    }
    if (intentHash && intentHash.toLowerCase() !== parsed.intentHash.toLowerCase()) {
      return {
        status: 400,
        body: errorEnvelope(
          "INTENT_HASH_MISMATCH",
          `provided intentHash ${intentHash} does not match the recomputed hash ${parsed.intentHash} of the inline intent`,
        ),
      };
    }
    return { input: parsed.input };
  }

  if (intentHash) {
    const found = store.get(intentHash);
    if (!found) {
      return {
        status: 404,
        body: errorEnvelope(
          "INTENT_NOT_FOUND",
          `intentHash ${intentHash} is not in this instance's in-memory store (created on another instance, or lost on restart). Resubmit with the inline intent, or re-create via create_spend_intent.`,
        ),
      };
    }
    return { input: found };
  }

  return {
    status: 400,
    body: errorEnvelope(
      "INTENT_REQUIRED",
      "provide either `intentHash` (from create_spend_intent) or an inline `intent` with the §8.1 struct + operational fields",
    ),
  };
}

function isHandlerResult(x: { input: SpendIntentInput } | HandlerResult): x is HandlerResult {
  return "status" in x;
}

/**
 * `preflight_payment` ($0.05, priced x402). Loads the REAL stored policy named by `policyId`, then
 * runs the REAL, deterministic `evaluateIntentSerialized` (per-agent lock → read ledger → evaluate →
 * commit if APPROVED) against it + the in-memory ledger window. Returns the §8.2 decision record
 * VERBATIM — decision, reasons, and ruleTrace are the engine's own, unmodified.
 *
 * Policy resolution (replaces the old fixture):
 *   • `policyId` missing ⇒ 400 POLICY_ID_REQUIRED.
 *   • `policyId` not in the store ⇒ the engine is handed a null policy and fail-closes to
 *     BLOCKED_NO_ACTIVE_POLICY (I2) — an honest block, not an error.
 *   • intent bound to a DIFFERENT policy hash than the stored one ⇒ 400 POLICY_BINDING_MISMATCH,
 *     so a decision is never returned for an intent that did not commit to the evaluated ruleset.
 *
 * `receiptRef` (§7.4): when a receipt writer is wired, the decision is durably enqueued and
 * `receiptRef` is a real {receiptId, status:"QUEUED"} returned IMMEDIATELY — the response never blocks
 * on batching or on-chain confirmation. When no writer is wired, or the durable enqueue fails,
 * `receiptRef` is null — an honest "not queued", never a fabricated ref. `sig` stays null: the EIP-712
 * oracle signer (§7.5, Mode C) does not exist yet and preflight is advisory (Mode A), which never signs.
 */
export async function handlePreflightPayment(
  body: unknown,
  deps: PreflightDeps,
): Promise<HandlerResult> {
  const policyId = readPolicyId(body);
  if (!policyId) {
    return {
      status: 400,
      body: errorEnvelope("POLICY_ID_REQUIRED", "a `policyId` (uint256 decimal string) is required"),
    };
  }

  const resolved = resolveIntent(body, deps.intentStore);
  if (isHandlerResult(resolved)) return resolved;

  const stored = await deps.policyProvider.loadStored(policyId);
  if (stored && !intentBoundToPolicy(resolved.input, stored)) {
    return {
      status: 400,
      body: errorEnvelope(
        "POLICY_BINDING_MISMATCH",
        `intent.policyHash ${resolved.input.policyHash} does not equal stored policy ${policyId}'s policyHash ${stored.policyHash}`,
      ),
    };
  }

  return evaluatePreflight(resolved.input, policyId, stored, body, deps);
}

/**
 * The decision itself, once an intent and a policy are in hand.
 *
 * Split out of `handlePreflightPayment` when the public, account-derived route arrived. The two routes
 * differ entirely in how they OBTAIN the intent — one is handed a protocol struct, the other derives
 * one from an account, a policy and a service definition — and not at all in how it is judged. Sharing
 * this function is what makes that true rather than aspirational: there is one call to the engine, one
 * receipt enqueue, one escalation gateway, and no second path where a rule could quietly differ.
 */
export async function evaluatePreflight(
  input: SpendIntentInput,
  policyId: string,
  stored: StoredPolicy | null,
  body: unknown,
  deps: PreflightDeps,
): Promise<HandlerResult> {
  const resolved = { input };
  const policy = stored ? toEnginePolicy(stored) : null;

  const opts: { now?: () => number; lock?: PerAgentLock } = {};
  if (deps.now) opts.now = deps.now;
  if (deps.lock) opts.lock = deps.lock;

  // Assemble CBC / vendor LCB / proof-tier injects for the full RULE_EVAL chain
  const { assemblePreflightInjects, wrapLedgerWithInjects } = await import("./preflight-state");
  const injects = await assemblePreflightInjects(
    resolved.input,
    body,
    deps.scoreDataSource ?? null,
  );
  const ledger = wrapLedgerWithInjects(deps.ledger, injects);

  const decision: Decision = await evaluateIntentSerialized(
    resolved.input,
    policy,
    ledger,
    opts,
  );

  // §7.4: durably enqueue the decision receipt and return its ref immediately. The enqueue writes the
  // receipt + ledger row to Postgres and signals the worker — it never awaits a batch or a chain
  // confirmation. A failure here (e.g. Postgres down) leaves receiptRef null rather than lying.
  let receiptRef: { receiptId: Hex; status: "QUEUED" } | null = null;
  if (deps.receiptEnqueuer) {
    try {
      receiptRef = await deps.receiptEnqueuer.enqueue(resolved.input, decision);
    } catch (err) {
      console.error("[asp] receipt enqueue failed — returning receiptRef: null", err);
    }
  }

  // §7.2: if the engine ESCALATED, create the escalation server-side so poll() resolves for real. The
  // pollRef MUST equal what the x402-guard poll handle computes — `receiptRef.receiptId ?? intentHash`
  // (see @untch/x402-guard poll.ts) — so the buyer's poll and this record are the same escalation. A
  // failure here is logged, not fatal: the decision is still returned; poll() then stays PENDING and
  // times out to DENY (fail-closed), never a fabricated approval.
  if (deps.escalationGateway && stored && decision.decision.startsWith("ESCALATED")) {
    const pollRef = receiptRef?.receiptId ?? decision.intentHash;
    try {
      await deps.escalationGateway.onEscalated({ input: resolved.input, decision, stored, pollRef });
    } catch (err) {
      console.error("[asp] escalation create failed — poll() will stay PENDING until timeout", err);
    }
  }

  // §10.2 post-decision status on registry (only if previously registered — setStatus fails otherwise)
  if (deps.intentRegistry && (decision.decision === "APPROVED" || decision.decision.startsWith("BLOCKED"))) {
    const { IntentStatus } = await import("./intent-registry");
    const status =
      decision.decision === "APPROVED" ? IntentStatus.APPROVED : IntentStatus.BLOCKED;
    try {
      await deps.intentRegistry.setStatus(decision.intentHash, status);
    } catch (err) {
      console.error("[asp] intent setStatus failed (intent may not be registered)", err);
    }
  }

  // Mode C oracle sig — only on APPROVED when vaultAddress provided and signer wired
  let sig: Record<string, unknown> | null = null;
  const b = (body ?? {}) as Record<string, unknown>;
  const vaultAddress =
    typeof b.vaultAddress === "string" && /^0x[0-9a-fA-F]{40}$/.test(b.vaultAddress)
      ? (b.vaultAddress as `0x${string}`)
      : null;
  if (decision.decision === "APPROVED" && deps.oracleSigner && vaultAddress) {
    try {
      const signed = await deps.oracleSigner.signSpend({
        vault: vaultAddress,
        recipient: resolved.input.recipientAddress,
        amount: resolved.input.maxAmount,
        token: resolved.input.token,
        intentHash: decision.intentHash,
      });
      sig = {
        signature: signed.sig,
        nonce: signed.nonce.toString(),
        expiry: signed.expiry.toString(),
        digest: signed.digest,
        vault: signed.vault,
      };
    } catch (err) {
      console.error("[asp] oracle sign failed", err);
      sig = { error: "ESCALATED_SIGNER_DOWN", message: err instanceof Error ? err.message : String(err) };
    }
  }

  return {
    status: 200,
    body: {
      // Surfaced verbatim from the engine — not altered.
      decision: decision.decision,
      reasons: decision.reasons,
      ruleTrace: decision.rules,
      // §8.2 identifiers, also straight from the engine.
      intentHash: decision.intentHash,
      policyId: decision.policyId,
      policyVersion: decision.policyVersion,
      evaluatedAt: decision.evaluatedAt,
      // §7.4 real receipt ref (or null when unwired / enqueue failed).
      receiptRef,
      // Mode C: oracle sig when wired + vaultAddress; else null (honest).
      sig,
    },
  };
}

/** Exposed for a symmetry check in tests: recompute an intent's hash without evaluating. */
export function hashOnly(body: unknown): Hex {
  return parseStruct(body).intentHash;
}

// ─────────────────────────────────────────────────────────────────────────────
// verify_delivery — priced $0.10: resolve the intent, run REAL T0, write a REAL verify receipt
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyDeps {
  readonly policyProvider: PolicyProvider;
  readonly intentStore: InMemoryIntentStore;
  /** Injectable clock for deterministic tests; defaults to the proof engine's `Date.now`. */
  readonly now?: () => number;
  /** §7.4 receipt writer. When present, the verify result is durably enqueued as a VERIFY-kind receipt
   *  carrying the REAL verifyResult/proofTier (§10.3). Absent ⇒ `receiptRef` stays null (honest). */
  readonly receiptEnqueuer?: ReceiptEnqueuer;
}

/**
 * Where the intent T0 verified against came from:
 *   • `store-committed` — the intent this instance actually cached from a prior `create_spend_intent`
 *     (the authoritative committed record). Its `acceptanceHash` is what T0 bound against.
 *   • `caller-supplied` — no cached record existed (never created here, or lost on restart), so T0 ran
 *     against intent data the CALLER supplied inline. Lower confidence: nothing on our side proves this
 *     is the intent that was originally committed. Trust Bureau (built next) weights it accordingly.
 */
export type IntentProvenance = "store-committed" | "caller-supplied";

interface ResolvedForVerify {
  readonly input: SpendIntentInput;
  readonly provenance: IntentProvenance;
}

/**
 * Intent resolution for verify_delivery — UNLIKE preflight's `resolveIntent`, the cached record is
 * AUTHORITATIVE for T0. When the supplied `intentHash` hits the store, T0 verifies against the STORED
 * intent's committed `acceptanceHash`, never whatever the caller also sent inline. If an inline intent
 * is supplied alongside a store hit, it must match the stored record EXACTLY (its recomputed hash must
 * equal both the stored record's hash AND the `intentHash` parameter) — otherwise the call is rejected
 * with `ACCEPTANCE_MISMATCH`, never a silent preference for either side. Inline data is used for T0
 * ONLY on a genuine store miss, and the outcome is then labeled `caller-supplied`.
 */
function resolveIntentForVerify(
  body: unknown,
  store: InMemoryIntentStore,
): ResolvedForVerify | HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const hasInlineWrapper = b.intent !== undefined && b.intent !== null;
  const topLevelLooksInline =
    !hasInlineWrapper && typeof b.owner === "string" && b.taskHash !== undefined;
  const inlineSource = hasInlineWrapper ? b.intent : topLevelLooksInline ? b : undefined;
  const intentHashParam = typeof b.intentHash === "string" ? b.intentHash : undefined;

  let parsedInline: { input: SpendIntentInput; intentHash: Hex } | null = null;
  if (inlineSource !== undefined) {
    try {
      parsedInline = parseFullIntent(inlineSource);
    } catch (err) {
      if (err instanceof IntentValidationError) {
        return { status: 400, body: errorEnvelope(err.code, err.message) };
      }
      throw err;
    }
  }

  if (intentHashParam) {
    const stored = store.get(intentHashParam);
    if (stored) {
      // Store hit — the cached record is AUTHORITATIVE. If inline was also supplied, it must match the
      // stored record exactly; a tampered acceptanceHash (or any struct field) changes the recomputed
      // hash and is rejected here rather than silently preferred.
      if (parsedInline) {
        const storedHash = intentHashOf(stored);
        const inlineHash = parsedInline.intentHash;
        const matches =
          inlineHash.toLowerCase() === storedHash.toLowerCase() &&
          inlineHash.toLowerCase() === intentHashParam.toLowerCase() &&
          parsedInline.input.acceptanceHash.toLowerCase() === stored.acceptanceHash.toLowerCase();
        if (!matches) {
          return {
            status: 400,
            body: errorEnvelope(
              "ACCEPTANCE_MISMATCH",
              `inline intent does not match the stored record for ${intentHashParam}: ` +
                `inline hash ${inlineHash} / acceptanceHash ${parsedInline.input.acceptanceHash} vs ` +
                `stored hash ${storedHash} / acceptanceHash ${stored.acceptanceHash}. ` +
                `The stored (committed) intent is authoritative for T0 — resubmit matching data or omit the inline intent.`,
            ),
          };
        }
      }
      return { input: stored, provenance: "store-committed" };
    }

    // Store miss. Inline may stand in, but only if it binds to the supplied hash — and the result is
    // labeled caller-supplied (lower confidence).
    if (parsedInline) {
      if (intentHashParam.toLowerCase() !== parsedInline.intentHash.toLowerCase()) {
        return {
          status: 400,
          body: errorEnvelope(
            "INTENT_HASH_MISMATCH",
            `provided intentHash ${intentHashParam} does not match the recomputed hash ${parsedInline.intentHash} of the inline intent`,
          ),
        };
      }
      return { input: parsedInline.input, provenance: "caller-supplied" };
    }
    return {
      status: 404,
      body: errorEnvelope(
        "INTENT_NOT_FOUND",
        `intentHash ${intentHashParam} is not in this instance's in-memory store (created on another instance, or lost on restart — there is no SpendIntentRegistry yet). Resubmit with the inline intent (it will be verified as caller-supplied, lower confidence).`,
      ),
    };
  }

  // No intentHash parameter — a pure inline verify. There is no committed reference to be authoritative
  // against, so the intent is caller-supplied by definition.
  if (parsedInline) {
    return { input: parsedInline.input, provenance: "caller-supplied" };
  }
  return {
    status: 400,
    body: errorEnvelope(
      "INTENT_REQUIRED",
      "provide either `intentHash` (from create_spend_intent) or an inline `intent` with the §8.1 struct + operational fields",
    ),
  };
}

/** Read the acceptance-criteria doc from the request body (optional; the proof engine FAILs a
 *  committed-but-unpresented spec rather than passing it). Must be a JSON object when present. */
function readCriteria(body: unknown): AcceptanceCriteria | undefined | HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const raw = b.acceptanceCriteria ?? b.criteria;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { status: 400, body: errorEnvelope("CRITERIA_MALFORMED", "acceptanceCriteria must be a JSON object") };
  }
  return raw as AcceptanceCriteria;
}

/** Read the delivery (`{payload?, payloadHash?}`) — accepts a `delivery` wrapper or top-level fields.
 *  At least one of payload / payloadHash must be present. */
function readDelivery(body: unknown): Delivery | HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const wrapper = (b.delivery ?? null) as Record<string, unknown> | null;
  const payload = wrapper && "payload" in wrapper ? wrapper.payload : b.payload;
  const payloadHashRaw = wrapper && "payloadHash" in wrapper ? wrapper.payloadHash : b.payloadHash;

  let payloadHash: Hex | undefined;
  if (payloadHashRaw !== undefined && payloadHashRaw !== null) {
    if (typeof payloadHashRaw !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(payloadHashRaw)) {
      return { status: 400, body: errorEnvelope("DELIVERY_MALFORMED", "payloadHash must be a 0x-prefixed 32-byte hex string") };
    }
    payloadHash = payloadHashRaw.toLowerCase() as Hex;
  }

  if (payload === undefined && payloadHash === undefined) {
    return {
      status: 400,
      body: errorEnvelope("DELIVERY_REQUIRED", "provide a delivery `payload` (for schema checks) and/or a `payloadHash` (for exact-hash checks)"),
    };
  }
  const out: Delivery = {};
  return { ...out, ...(payload !== undefined ? { payload } : {}), ...(payloadHash !== undefined ? { payloadHash } : {}) };
}

/**
 * `verify_delivery` ($0.10, priced x402 — §11). Resolves the intent named by the request (inline or by
 * `intentHash`, the SAME resolver preflight uses), recovers the COMMITTED §8.1 `acceptanceHash`, and
 * runs the REAL, deterministic `@untch/proof-engine` T0 (no LLM — invariant I1) against the presented
 * acceptance criteria + delivery. It then writes a REAL VERIFY receipt whose `verifyResult`/`proofTier`
 * finally reflect what happened (PASS/FAIL/skipped/tier-0), not the default 0 every prior receipt held.
 *
 * REQUIRED_TIER is T0 (0) in this build: policy-driven tier escalation (`proof.requireTierAbove`) rides
 * with the still-stubbed `proof.tierRequired` policy rule and the T1+ tiers themselves, so a higher
 * required tier would return VERIFY_TIER_NOT_IMPLEMENTED — an honest unmet result, never a silent pass.
 *
 * `receiptRef` (§7.4): when a receipt writer is wired, the VERIFY receipt is durably enqueued and its
 * {receiptId, status:"QUEUED"} returned immediately; when unwired or the enqueue fails, `receiptRef` is
 * null — an honest "not queued", never a fabricated ref.
 */
export async function handleVerifyDelivery(body: unknown, deps: VerifyDeps): Promise<HandlerResult> {
  const policyId = readPolicyId(body);
  if (!policyId) {
    return { status: 400, body: errorEnvelope("POLICY_ID_REQUIRED", "a `policyId` (uint256 decimal string) is required") };
  }

  const resolved = resolveIntentForVerify(body, deps.intentStore);
  if (isHandlerResult(resolved)) return resolved;

  const stored = await deps.policyProvider.loadStored(policyId);
  if (!stored) {
    return { status: 404, body: errorEnvelope("POLICY_NOT_FOUND", `no stored policy with id ${policyId}`) };
  }
  if (!intentBoundToPolicy(resolved.input, stored)) {
    return {
      status: 400,
      body: errorEnvelope(
        "POLICY_BINDING_MISMATCH",
        `intent.policyHash ${resolved.input.policyHash} does not equal stored policy ${policyId}'s policyHash ${stored.policyHash}`,
      ),
    };
  }

  const criteria = readCriteria(body);
  if (criteria && "status" in criteria) return criteria;
  const delivery = readDelivery(body);
  if ("status" in delivery) return delivery;

  const intentHash = intentHashOf(resolved.input);
  const outcome: VerifyOutcome = verifyDelivery({
    intentHash,
    acceptanceHash: resolved.input.acceptanceHash,
    ...(criteria ? { criteria } : {}),
    delivery,
    ...(deps.now ? { now: deps.now } : {}),
  });

  // §7.4: durably enqueue the VERIFY receipt (real verifyResult/proofTier) and return its ref. A failure
  // here (e.g. Postgres down) leaves receiptRef null rather than lying.
  let receiptRef: { receiptId: Hex; status: "QUEUED" } | null = null;
  if (deps.receiptEnqueuer) {
    try {
      receiptRef = await deps.receiptEnqueuer.enqueueVerify(resolved.input, {
        policyId: stored.id,
        intentHash,
        verifyResultCode: outcome.verifyResultCode,
        proofTier: outcome.proofTier,
        payloadHash: outcome.payloadHash,
        verifiedAt: outcome.verifiedAt,
        provenance: resolved.provenance,
      });
    } catch (err) {
      console.error("[asp] verify receipt enqueue failed — returning receiptRef: null", err);
    }
  }

  return {
    status: 200,
    body: {
      // §7.3 verification result — surfaced verbatim from the proof engine.
      intentHash,
      final: outcome.final,
      recommendation: outcome.recommendation,
      requiredTier: outcome.requiredTier,
      achievedTier: outcome.achievedTier,
      proofTier: outcome.proofTier,
      verifyResult: outcome.verifyResultCode,
      tierResults: outcome.tierResults,
      diffs: outcome.diffs,
      hygieneEvent: outcome.hygieneEvent,
      payloadHash: outcome.payloadHash,
      verifiedAt: outcome.verifiedAt,
      // Whether T0 verified the STORED committed intent or CALLER-supplied inline data (lower
      // confidence). Labeled so a store miss is never silently treated as a committed-intent result.
      intentProvenance: resolved.provenance,
      // §7.4 real receipt ref (or null when unwired / enqueue failed).
      receiptRef,
    },
  };
}
