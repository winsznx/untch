/**
 * The one-shot Solana production proof gate.
 *
 * WHY THIS EXISTS RATHER THAN A FLAG
 *
 * Proving that the deployed worker can settle on Solana requires production to be able to spend from
 * the Solana treasury. The obvious way to allow that is `CONSUMER_SOLANA_EXECUTION_ENABLED=1`, and
 * that is the wrong way: the worker polls continuously, so a single boolean grants standing authority
 * over every queued Solana intent for as long as it is set. The blast radius of a proof should be the
 * proof.
 *
 * So the gate authorises ONE payment, named in advance. Not a provider, not a capability, not a
 * window: one intent ID, for one capability, at one ceiling, before one expiry. Everything else on
 * the Solana rail stays refused while the gate is open, including intents that are already queued and
 * would otherwise be eligible the instant the rail came up.
 *
 * SINGLE USE IS A DURABLE CLAIM TAKEN BEFORE THE SIGNER
 *
 * The first version of this gate inferred consumption AFTER the fact: had any execution for the proof
 * intent reached PAID or ACKNOWLEDGED? That is unsound, and unsound in the direction that costs money.
 * Between invoking the signer and writing PAID, the credential is built, the transaction is signed, a
 * sponsor receives it and broadcasts it, and none of those leave a mark of ours. A crash in that window
 * is indistinguishable from never having tried, so the inference reports "unused" for a gate that may
 * already have spent, and the next attempt pays twice.
 *
 * The gate therefore no longer asks "did this succeed?" It asks, before the fact, "may this worker
 * acquire the sole right to reach the signer?" That acquisition is a conditional write on a durable
 * row, so its answer survives the crash the inference could not. See `solana-proof-claim.ts` for the
 * state machine and the deliberately strict release rule.
 *
 * An in-process latch sits on top as defence in depth, and nothing depends on it alone.
 *
 * EVERY CHECK REFUSES, NONE CLAMP
 *
 * A gate that quietly reduced an over-ceiling payment to the ceiling would still be authorising a
 * payment nobody approved. Each mismatch below throws, and the signer is never reached, which is the
 * property the tests assert directly rather than inferring from an absence of spend.
 */

import { formatMoney, gtMoney, type Money } from "./money";
import { normalizedError, ProviderError } from "./errors";
import type { CaipChainId } from "./assets";
import type { ConsumerStore } from "./repo";
import type {
  SolanaProofGateState,
  SolanaProofProgress,
  SolanaProofScope,
} from "./solana-proof-claim";

/** Solana mainnet, in the CAIP-2 spelling this build treats as canonical. */
const SOLANA_PREFIX = "solana:";

export interface SolanaProofGateConfig {
  /** False unless `CONSUMER_SOLANA_PROOF_MODE` is explicitly on. */
  readonly enabled: boolean;
  readonly intentId: string | null;
  readonly providerId: string | null;
  readonly capability: string | null;
  readonly maxAmount: Money | null;
  /** Epoch ms. The gate refuses at or after this instant. */
  readonly expiresAt: number | null;
}

export interface ProofAuthorisationInput {
  readonly intentId: string;
  readonly providerId: string;
  /** The intent's action type, e.g. `shop.search`. */
  readonly capability: string;
  readonly amount: Money;
  readonly chain: CaipChainId;
  /** The worker attempt asking for the claim. Recorded so a held claim names its holder. */
  readonly executionId: string;
}

/** Read the gate out of the environment. Absent values mean disabled, never permissive. */
export function loadSolanaProofGate(
  env: Record<string, string | undefined>,
  parseAmount: (raw: string) => Money,
): SolanaProofGateConfig {
  const on = env.CONSUMER_SOLANA_PROOF_MODE?.trim() === "1";
  const rawMax = env.CONSUMER_SOLANA_PROOF_MAX_USDC?.trim();
  const rawExpiry = env.CONSUMER_SOLANA_PROOF_EXPIRES_AT?.trim();
  let expiresAt: number | null = null;
  if (rawExpiry) {
    const parsed = Date.parse(rawExpiry);
    expiresAt = Number.isFinite(parsed) ? parsed : null;
  }
  let maxAmount: Money | null = null;
  if (rawMax) {
    try {
      maxAmount = parseAmount(rawMax);
    } catch {
      // An unparseable ceiling is left NULL, which the authoriser treats as a refusal rather than as
      // "no ceiling". A malformed limit must never widen authority.
      maxAmount = null;
    }
  }
  return {
    enabled: on,
    intentId: env.CONSUMER_SOLANA_PROOF_INTENT_ID?.trim() || null,
    providerId: env.CONSUMER_SOLANA_PROOF_PROVIDER?.trim() || null,
    capability: env.CONSUMER_SOLANA_PROOF_CAPABILITY?.trim() || null,
    maxAmount,
    expiresAt,
  };
}

export class SolanaProofGate {
  private readonly config: SolanaProofGateConfig;
  private readonly store: ConsumerStore;
  private readonly clock: () => number;
  /** Defence in depth only. Durability comes from the store row, never from this. */
  private latched = false;
  /** The claim this instance holds, so progress can be appended to the right row. */
  private scopeHash: string | null = null;

  constructor(deps: {
    readonly config: SolanaProofGateConfig;
    readonly store: ConsumerStore;
    readonly clock?: () => number;
  }) {
    this.config = deps.config;
    this.store = deps.store;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** Whether this chain is governed by the gate at all. Base is untouched by any of this. */
  static governs(chain: CaipChainId): boolean {
    return chain.startsWith(SOLANA_PREFIX);
  }

  private refuse(why: string): never {
    throw new ProviderError(
      normalizedError(
        "PAYMENT_CHALLENGE_UNACCEPTABLE",
        `the Solana one-shot proof gate refused this payment: ${why}. No signer was reached.`,
      ),
    );
  }

  /**
   * Authorise exactly one payment by taking a DURABLE CLAIM, or throw.
   *
   * The claim is the correction to this gate's original design. The first version asked "has any
   * execution for this intent reached PAID?", which is a question about the past that cannot be
   * answered correctly after a crash: between the signer being invoked and PAID being written the
   * credential is built, the transaction is signed, a sponsor receives it and broadcasts it, and none
   * of that leaves a mark of ours. A crash in that window looks identical to never having tried.
   *
   * So this asks a different question, before the fact rather than after it: may this worker acquire
   * the sole right to reach the signer? The acquisition is a conditional write on a durable row, so
   * the answer survives the crash that the inference could not.
   *
   * Ordering is deliberate. Every cheap identity check runs BEFORE the claim, so a queued intent that
   * is simply not the proof is refused without touching the gate row and without consuming anything.
   * The claim is the last thing that happens, immediately before the signer becomes reachable.
   */
  async assertAuthorised(input: ProofAuthorisationInput): Promise<void> {
    if (!SolanaProofGate.governs(input.chain)) return;

    const c = this.config;
    if (!c.enabled) {
      this.refuse("proof mode is not enabled, so no Solana payment is authorised in production");
    }
    if (!c.intentId) this.refuse("no proof intent is configured");
    if (!c.providerId) this.refuse("no proof provider is configured");
    if (!c.capability) this.refuse("no proof capability is configured");
    if (!c.maxAmount) this.refuse("no usable proof ceiling is configured");
    if (c.expiresAt === null) this.refuse("no proof expiry is configured");

    if (input.intentId !== c.intentId) {
      this.refuse(
        `intent ${input.intentId} is not the authorised proof intent. Other queued Solana ` +
          "intents stay blocked while the gate is open",
      );
    }
    if (input.providerId !== c.providerId) {
      this.refuse(`provider ${input.providerId} is not the authorised proof provider ${c.providerId}`);
    }
    if (input.capability !== c.capability) {
      this.refuse(`capability ${input.capability} is not the authorised proof capability ${c.capability}`);
    }
    if (gtMoney(input.amount, c.maxAmount)) {
      this.refuse(
        `${formatMoney(input.amount)} exceeds the proof ceiling ${formatMoney(c.maxAmount)}. ` +
          "The ceiling is a refusal, not a clamp",
      );
    }
    const now = this.clock();
    if (now >= c.expiresAt) {
      this.refuse(
        `the proof window closed at ${new Date(c.expiresAt).toISOString()} and it is now ` +
          new Date(now).toISOString(),
      );
    }

    const scope: SolanaProofScope = {
      intentId: c.intentId,
      providerId: c.providerId,
      capability: c.capability,
      chain: input.chain,
      asset: input.amount.asset,
      maxAmount: c.maxAmount,
      expiresAt: new Date(c.expiresAt).toISOString(),
    };
    const atIso = new Date(now).toISOString();

    /**
     * Arm then claim, both durable.
     *
     * Arming is idempotent by scope hash, so a restart mid-proof does not create a second gate. The
     * claim is a compare-and-set that only an ARMED row satisfies, which is what makes two concurrent
     * workers produce exactly one winner and makes a restart-while-CLAIMED keep losing.
     */
    const armed = await this.store.armSolanaProofGate(scope, atIso);
    this.scopeHash = armed.scopeHash;

    if (armed.state !== "ARMED") {
      this.refuse(
        `the gate for this scope is ${armed.state}, not ARMED` +
          (armed.claimedAt ? `, claimed at ${armed.claimedAt}` : "") +
          (armed.txSignature ? `, signature ${armed.txSignature}` : "") +
          ". It is single-use and stays consumed across restarts. Inspect it before deciding " +
          "whether anything may be retried",
      );
    }

    const claimed = await this.store.claimSolanaProofGate(armed.scopeHash, input.executionId, atIso);
    if (!claimed) {
      this.refuse(
        "another worker claimed this proof first, or it was already consumed. This process will " +
          "not reach the signer",
      );
    }

    /**
     * Record signer access IMMEDIATELY after winning the claim.
     *
     * Written here rather than at the moment the key is touched because the very next thing the caller
     * does is reach the rail, and a mark written after that would sit on the wrong side of the window
     * this whole mechanism exists to close. Recording it slightly early can only ever make release
     * stricter, which is the direction that costs a retry rather than a double payment.
     */
    await this.store.recordSolanaProofProgress(
      armed.scopeHash,
      { signerReachedAt: atIso },
      null,
      atIso,
    );
  }

  /** The scope hash of the claim this instance holds, once one has been taken. */
  claimedScopeHash(): string | null {
    return this.scopeHash;
  }

  /** Append settlement or acknowledgement evidence to the claim this instance holds. */
  async recordProgress(
    progress: SolanaProofProgress,
    state: SolanaProofGateState | null = null,
  ): Promise<void> {
    if (!this.scopeHash) return;
    await this.store.recordSolanaProofProgress(
      this.scopeHash,
      progress,
      state,
      new Date(this.clock()).toISOString(),
    );
  }

  /**
   * Latch the in-process guard after a settlement.
   *
   * Called for completeness, and deliberately not the mechanism anything relies on: the durable
   * record written by the execution itself is what makes consumption survive.
   */
  markUsed(): void {
    this.latched = true;
  }

  /** A redacted view for logs and health output. Never includes the treasury or any secret. */
  describe(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      intentId: this.config.intentId,
      providerId: this.config.providerId,
      capability: this.config.capability,
      maxAmount: this.config.maxAmount ? formatMoney(this.config.maxAmount) : null,
      expiresAt: this.config.expiresAt ? new Date(this.config.expiresAt).toISOString() : null,
      expired: this.config.expiresAt === null ? null : this.clock() >= this.config.expiresAt,
      latchedInProcess: this.latched,
    };
  }
}
