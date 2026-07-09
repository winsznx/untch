import {
  evaluateIntentSerialized,
  type Decision,
  type Ledger,
  type PerAgentLock,
  type Policy,
  type SpendIntentInput,
} from "@untch/policy-engine";
import type { Hex } from "viem";
import {
  IntentValidationError,
  parseFullIntent,
  parseStruct,
  toCanonicalView,
} from "./intent";
import type { InMemoryIntentStore } from "./policy-fixture";

/**
 * Framework-agnostic handlers for the two Step-2 tools. Each returns `{ status, body }` so it is
 * unit-testable with the REAL policy engine and NO network — the Express layer (`server.ts`) just
 * forwards the result. `preflight_payment` surfaces exactly what `evaluateIntentSerialized`
 * returns; it never rewrites a decision, reason, or trace entry.
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

// ─────────────────────────────────────────────────────────────────────────────
// create_spend_intent — unpriced: validate, canonicalize, hash, return
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateDeps {
  readonly intentStore: InMemoryIntentStore;
}

/**
 * `create_spend_intent` (bundled / unpriced). Validates the untrusted intent, canonicalizes it,
 * and hashes the §8.1 bounded object via `@untch/canon` (`hashSpendIntent` — the SAME path the
 * policy engine uses, so this hash is identical to the one preflight derives). Caches the parsed
 * intent so a later `preflight_payment` can resolve it by `intentHash`. Does NOT register anything
 * on-chain — the `SpendIntentRegistry` (§10.2) does not exist yet, so `onchain` is explicitly null.
 */
export function handleCreateSpendIntent(body: unknown, deps: CreateDeps): HandlerResult {
  let parsed: { input: SpendIntentInput; intentHash: Hex };
  try {
    parsed = parseFullIntent(body);
  } catch (err) {
    if (err instanceof IntentValidationError) {
      return { status: 400, body: errorEnvelope(err.code, err.message) };
    }
    throw err;
  }

  deps.intentStore.put(parsed.intentHash, parsed.input);

  return {
    status: 200,
    body: {
      intentHash: parsed.intentHash,
      canonicalIntent: toCanonicalView(parsed.input),
      // No IntentRegistry yet (§10.2) — nothing is anchored on-chain. Explicitly null, not faked.
      onchain: null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// preflight_payment — priced $0.05: run the real engine, surface its decision verbatim
// ─────────────────────────────────────────────────────────────────────────────

export interface PreflightDeps {
  readonly policy: Policy;
  readonly ledger: Ledger;
  readonly intentStore: InMemoryIntentStore;
  /** Injectable clock for deterministic tests; defaults to the engine's `Date.now`. */
  readonly now?: () => number;
  /** Injectable per-agent lock (isolate tests); defaults to the engine's module singleton. */
  readonly lock?: PerAgentLock;
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
          `intentHash ${intentHash} is not in this instance's in-memory store (created on another instance, or lost on restart — there is no SpendIntentRegistry yet). Resubmit with the inline intent.`,
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
 * `preflight_payment` ($0.05, priced x402). Resolves the intent, then runs the REAL, deterministic
 * `evaluateIntentSerialized` (per-agent lock → read ledger → evaluate → commit if APPROVED) against
 * the fixture policy + in-memory ledger. Returns the §8.2 decision record VERBATIM — decision,
 * reasons, and ruleTrace are the engine's own, unmodified.
 *
 * `receiptRef` and `sig` are explicitly null:
 *   • receiptRef — the receipt writer (§7.4 UntchReceipts) does not exist yet, so no receipt is
 *     anchored/queued. Null, not a fabricated ref.
 *   • sig — the EIP-712 oracle signature (§7.5, Mode C) is produced by a signer service that does
 *     not exist yet, and preflight here is advisory (Mode A), which never signs. Null, not faked.
 */
export async function handlePreflightPayment(
  body: unknown,
  deps: PreflightDeps,
): Promise<HandlerResult> {
  const resolved = resolveIntent(body, deps.intentStore);
  if (isHandlerResult(resolved)) return resolved;

  const opts: { now?: () => number; lock?: PerAgentLock } = {};
  if (deps.now) opts.now = deps.now;
  if (deps.lock) opts.lock = deps.lock;

  const decision: Decision = await evaluateIntentSerialized(
    resolved.input,
    deps.policy,
    deps.ledger,
    opts,
  );

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
      // Explicitly null — subsystems not built yet (see doc comment above). Never faked.
      receiptRef: null,
      sig: null,
    },
  };
}

/** Exposed for a symmetry check in tests: recompute an intent's hash without evaluating. */
export function hashOnly(body: unknown): Hex {
  return parseStruct(body).intentHash;
}
