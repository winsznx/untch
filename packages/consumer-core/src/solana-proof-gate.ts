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
 * SINGLE USE IS DURABLE, NOT REMEMBERED
 *
 * An in-memory "already used" boolean is worthless here, because the failure it needs to survive is a
 * restart, and a restart is exactly what clears it. Consumption is therefore derived from state that
 * outlives the process: whether any execution for that intent has already reached PAID or
 * ACKNOWLEDGED on a Solana chain. If one has, the gate refuses. A crash mid-settlement leaves the
 * durable record behind, so the conservative answer survives a crash rather than being erased by it.
 *
 * An in-process latch sits on top as defence in depth, but nothing depends on it alone.
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
  /** Defence in depth only. Durability comes from the store, never from this. */
  private latched = false;

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
   * Authorise exactly one payment, or throw.
   *
   * Ordering is deliberate. The cheap identity checks run before the store is touched, so a queued
   * intent that is simply not the proof is refused without a query. The durable consumption check
   * runs LAST among the refusals, because it is the only one that costs a round trip.
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
    if (!input.chain.startsWith(SOLANA_PREFIX)) {
      this.refuse(`${input.chain} is not a Solana chain`);
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
    if (this.latched) {
      this.refuse("the gate was already used in this process");
    }

    /**
     * The durable single-use check.
     *
     * Keyed on the intent rather than on a counter, because the gate authorises exactly one intent and
     * "that intent already settled" is a fact the database keeps across restarts. A counter in memory
     * would be cleared by the very event this must survive.
     */
    const executions = await this.store.listExecutions(input.intentId);
    const settled = executions.find(
      (e) =>
        (e.state === "PAID" || e.state === "ACKNOWLEDGED") &&
        e.settlementChain !== null &&
        e.settlementChain.startsWith(SOLANA_PREFIX),
    );
    if (settled) {
      this.refuse(
        `intent ${input.intentId} already has a settled Solana execution ` +
          `(${settled.executionId}, ${settled.state}). The gate is single-use and stays consumed ` +
          "across restarts",
      );
    }
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
