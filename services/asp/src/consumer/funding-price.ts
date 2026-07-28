/**
 * The variable-value funding leg.
 *
 * This is the piece that keeps the fixed OKX A2MCP call price honest. A marketplace call fee of
 * $0.05 is what the agent pays Untch for orchestration; a $20.00 domain registration is a different
 * amount, owed to a different party, at a different moment. Conflating them would mean either
 * charging every caller the maximum a purchase might cost, or settling purchases out of a fee — and
 * both are worse than the extra leg.
 *
 * The mechanism is `DynamicPrice`, which the installed `@okxweb3/x402-core@0.1.0` supports:
 *
 *     type DynamicPrice = (context: HTTPRequestContext) => Price | Promise<Price>
 *     type Price = string | number | { asset, amount, extra? }
 *
 * (verified in x402HTTPResourceServer-BqdilVCp.d.ts:59,90 — not assumed).
 *
 * So `POST /consumer/fund/:intentId` is registered ONCE with a price FUNCTION. The function reads the
 * intentId out of the request path, loads the intent, and returns its exact authorised atomic amount.
 * The 402 the caller receives therefore names that intent's own figure, and the settlement that
 * follows is bound to it.
 *
 * Every failure path THROWS rather than returning a fallback price. A price function that fell back
 * to a default would let an unknown, expired or already-funded intent be paid for — which is exactly
 * the set of cases that must not be payable.
 */

import {
  displayMoney,
  type ConsumerStore,
  type Money,
} from "@untch/consumer-core";

/** The subset of the x402 request context this needs. Kept structural so it is trivially testable. */
export interface FundingPriceContext {
  readonly path: string;
}

export interface FundingPrice {
  readonly asset: string;
  readonly amount: string;
  readonly extra?: Record<string, unknown>;
}

export class FundingPriceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "FundingPriceError";
  }
}

/** `/consumer/fund/ci_abc123` → `ci_abc123`. Returns null for anything else. */
export function intentIdFromFundingPath(path: string): string | null {
  const match = /\/consumer\/fund\/([A-Za-z0-9_-]{3,64})\/?$/.exec(path.split("?")[0] ?? path);
  return match?.[1] ?? null;
}

export interface FundingPriceDeps {
  readonly store: ConsumerStore;
  readonly clock?: () => number;
  readonly log?: (line: string, data?: unknown) => void;
}

/**
 * Build the DynamicPrice function.
 *
 * The five refusals below are the whole point of doing this dynamically rather than statically, and
 * each closes a way a caller could otherwise pay the wrong amount for the wrong thing.
 */
export function makeFundingPrice(deps: FundingPriceDeps): (ctx: FundingPriceContext) => Promise<FundingPrice> {
  const clock = deps.clock ?? Date.now;
  const log = deps.log ?? (() => {});

  return async (ctx: FundingPriceContext): Promise<FundingPrice> => {
    const intentId = intentIdFromFundingPath(ctx.path);
    if (intentId === null) {
      throw new FundingPriceError("BAD_FUNDING_PATH", `cannot read an intent id from ${ctx.path}`);
    }

    const intent = await deps.store.getIntent(intentId);
    if (!intent) {
      throw new FundingPriceError("INTENT_NOT_FOUND", `no consumer intent ${intentId}`);
    }

    // 1. Only an intent that is actually waiting for money may be paid.
    if (intent.state !== "AWAITING_FUNDING") {
      throw new FundingPriceError(
        "INTENT_NOT_AWAITING_FUNDING",
        `intent ${intentId} is ${intent.state}, not AWAITING_FUNDING`,
      );
    }

    // 2. A funded intent is never payable twice, even before the state advances.
    const existing = await deps.store.getFunding(intentId);
    if (existing) {
      throw new FundingPriceError("ALREADY_FUNDED", `intent ${intentId} has already been funded`);
    }

    // 3. An expired funding window is not payable. Otherwise a stale link stays live forever.
    if (intent.expiresAt !== null && Date.parse(intent.expiresAt) <= clock()) {
      throw new FundingPriceError("FUNDING_EXPIRED", `the funding window for ${intentId} has closed`);
    }

    // 4. The quote behind the amount must still be fresh — the price is only the price while it is.
    if (intent.quoteExpiresAt !== null && Date.parse(intent.quoteExpiresAt) <= clock()) {
      throw new FundingPriceError("QUOTE_EXPIRED", `the quote for ${intentId} has expired`);
    }

    // 5. There must BE an amount, and it must be positive.
    const amount: Money | null = intent.fundingAmount;
    if (amount === null || amount.amount <= 0n || amount.asset.address === null) {
      throw new FundingPriceError("NO_AUTHORISED_AMOUNT", `intent ${intentId} has no authorised amount`);
    }

    log("[consumer] funding price quoted", { intentId, amount: displayMoney(amount) });

    return {
      asset: amount.asset.address,
      // Atomic units as an exact decimal STRING — the amount the approval bound, to the unit.
      amount: amount.amount.toString(),
      extra: { intentId, decimals: amount.asset.decimals, token: amount.asset.symbol },
    };
  };
}
