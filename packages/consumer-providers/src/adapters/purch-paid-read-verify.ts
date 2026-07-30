/**
 * Verifying a PAID READ from persisted evidence alone.
 *
 * WHY THIS EXISTS
 *
 * The first bounded Purch proof settled 0.010000 USDC on Solana mainnet, returned five real products,
 * and produced a receipt saying `untchVerified: false, method: NONE`. That was accurate. `verifyDelivery`
 * was written for a physical shipment, where Untch can prove an order was PLACED and cannot prove a
 * parcel arrived — the carrier is reachable only through Purch's paid tracking endpoint, and Untch says
 * so rather than implying more.
 *
 * For a paid READ that reasoning gives the wrong answer. There is no parcel and no carrier: the returned
 * result IS the delivered service. The check was simply never made shape-aware, and this module is the
 * shape-aware half.
 *
 * WHAT IT CLAIMS, AND WHAT IT DOES NOT
 *
 * It claims the paid search service ran and returned a schema-valid result BOUND to the authorised
 * request and to the settled execution that paid for it. That binding is the whole assertion.
 *
 * It does NOT claim any listing is factually correct, currently priced, in stock, or that the merchant
 * ranked honestly. Untch cannot know those and will not imply it. A verification that overstated its
 * reach would be worse than the `NONE` it replaces, because `NONE` at least reads as an absence.
 *
 * WHY IT IS PURE
 *
 * Every input is something production already persisted. It makes no request, holds no key, and cannot
 * reach a signer or a rail — there is nothing in this module's imports that could. That matters because
 * a verifier that re-fetched the result would be checking a NEW answer against an old payment, which
 * proves nothing about what was actually bought, and would spend money to do it.
 */

import {
  sha256Hex,
  stableStringify,
  type CapabilityExecutionShape,
  type Money,
} from "@untch/consumer-core";
import { parseSearchProducts, PURCH_ENDPOINT_CLASS_SEARCH, type SearchProduct } from "./purch";

/** Bumped when the checks below change. Recorded on every verification so versions stay comparable. */
export const PAID_READ_VERIFIER_VERSION = "purch-paid-read/1.0.0" as const;

export interface PaidReadVerificationInput {
  readonly intentId: string;
  readonly providerId: string;
  readonly capability: string;
  readonly executionShape: CapabilityExecutionShape;
  /** The authorised quote's recorded terms, as persisted. */
  readonly quoteTerms: Readonly<Record<string, unknown>>;
  readonly quoteCost: Money;
  readonly quoteHash: string | null;
  readonly settlementRecipient: string;
  readonly settlementChain: string;
  readonly settlementAssetSymbol: string;
  readonly settlementMint: string | null;
  /** The reservation ceiling, in the settlement asset's atomic units. */
  readonly reservedAtomic: bigint | null;
  /** The armed proof-gate ceiling where one governed this execution. */
  readonly gateCeilingAtomic: bigint | null;
  /** Every execution attempt on record. More than one is a refusal, not a choice. */
  readonly executions: readonly {
    readonly state: string;
    readonly settlementTxHash: string | null;
    readonly settlementChain: string | null;
    readonly settledAtomic: bigint | null;
  }[];
  /** The registered settlement authority the payment was expected to come from. */
  readonly registeredAuthority: string | null;
  /** The provider's attested payload, exactly as persisted at execution time. */
  readonly attestedFields: Readonly<Record<string, unknown>>;
  readonly attestedStatus: string;
  /** The request the intent was created with, as persisted. */
  readonly request: Readonly<Record<string, unknown>>;
}

export interface PaidReadVerification {
  readonly verified: boolean;
  readonly method: "PAID_READ_RESULT_BINDING";
  readonly detail: string;
  readonly refusals: readonly { readonly code: string; readonly detail: string }[];
  readonly resultHash: string | null;
  readonly requestHash: string | null;
  readonly productCount: number | null;
  /** A hash over every input read, so an identical redrive produces an identical record. */
  readonly evidenceDigest: string;
}

const CANONICAL_SOLANA_USDC_SYMBOL = "USDC";

/**
 * Recompute the result hash the adapter wrote at execution time.
 *
 * Deliberately the SAME expression `executePaidRead` uses. Two spellings of "hash the result" would be
 * two chances to disagree, and a verifier that computed a different digest from identical data would
 * report a mismatch that was its own.
 */
export function paidReadResultHash(query: string, products: readonly SearchProduct[]): string {
  return `0x${sha256Hex(stableStringify({ query, products } as unknown as Record<string, unknown>))}`;
}

/**
 * Verify one persisted paid read.
 *
 * Collects EVERY refusal rather than stopping at the first. An operator deciding whether a receipt can
 * be revised needs the whole picture, and a verifier that returned one reason at a time would turn that
 * into several round trips through production.
 */
export function verifyPersistedPaidRead(input: PaidReadVerificationInput): PaidReadVerification {
  const refusals: { code: string; detail: string }[] = [];
  const add = (code: string, detail: string): void => {
    refusals.push({ code, detail });
  };

  // ── identity ──
  if (input.providerId !== "purch") add("PROVIDER_MISMATCH", `this verifier is for purch, not ${input.providerId}`);
  if (input.capability !== "shop.search") {
    add("CAPABILITY_MISMATCH", `this verifier is for shop.search, not ${input.capability}`);
  }
  if (input.executionShape !== "PAID_READ") {
    add("SHAPE_UNSUPPORTED", `execution shape is ${input.executionShape}, not PAID_READ`);
  }
  if (input.quoteTerms.endpointClass !== PURCH_ENDPOINT_CLASS_SEARCH) {
    add(
      "ENDPOINT_CLASS_MISMATCH",
      `the quote was authorised against ${String(input.quoteTerms.endpointClass)}, not the paid search endpoint`,
    );
  }

  // ── exactly one execution ──
  //
  // Two executions on one intent means one authorisation may have paid twice, which is a question for a
  // human. A verifier that picked the "successful" one would be choosing which history to believe.
  if (input.executions.length === 0) add("NO_EXECUTION", "no execution attempt is recorded");
  if (input.executions.length > 1) {
    add("MULTIPLE_EXECUTIONS", `${input.executions.length} execution attempts exist; exactly one is expected`);
  }
  const execution = input.executions[0] ?? null;

  if (execution !== null) {
    if (execution.state !== "PAID" && execution.state !== "ACKNOWLEDGED") {
      add("EXECUTION_NOT_PAID", `the execution is ${execution.state}, not PAID or ACKNOWLEDGED`);
    }
    if (execution.settlementTxHash === null || execution.settlementTxHash.trim() === "") {
      add("SETTLEMENT_TX_MISSING", "no settlement transaction is recorded");
    }
    if (execution.settlementChain !== input.settlementChain) {
      add(
        "SETTLEMENT_CHAIN_MISMATCH",
        `the execution settled on ${String(execution.settlementChain)}, not ${input.settlementChain}`,
      );
    }

    // ── the amount, against every ceiling that bound it ──
    const settled = execution.settledAtomic;
    if (settled === null) {
      add("SETTLED_AMOUNT_MISSING", "the execution records no settled amount");
    } else {
      if (settled > input.quoteCost.amount) {
        add("ABOVE_AUTHORISED_QUOTE", `settled ${settled} exceeds the authorised ${input.quoteCost.amount}`);
      }
      if (input.reservedAtomic !== null && settled > input.reservedAtomic) {
        add("ABOVE_RESERVATION", `settled ${settled} exceeds the reservation ${input.reservedAtomic}`);
      }
      if (input.gateCeilingAtomic !== null && settled > input.gateCeilingAtomic) {
        add("ABOVE_GATE_CEILING", `settled ${settled} exceeds the proof-gate ceiling ${input.gateCeilingAtomic}`);
      }
      if (settled <= 0n) add("SETTLED_AMOUNT_NOT_POSITIVE", "the settled amount is not positive");
    }
  }

  // ── the asset and the authority ──
  if (input.settlementAssetSymbol.toUpperCase() !== CANONICAL_SOLANA_USDC_SYMBOL) {
    add("ASSET_MISMATCH", `settled in ${input.settlementAssetSymbol}, not canonical USDC`);
  }
  if (!input.settlementChain.startsWith("solana:")) {
    add("CHAIN_NOT_SOLANA", `settlement chain ${input.settlementChain} is not Solana mainnet`);
  }
  if (input.quoteTerms.mint !== undefined && input.settlementMint !== null && input.quoteTerms.mint !== input.settlementMint) {
    add("MINT_MISMATCH", "the quoted mint is not the registry's mint for this asset");
  }
  if (
    input.registeredAuthority !== null &&
    typeof input.quoteTerms.payTo === "string" &&
    input.quoteTerms.payTo === input.registeredAuthority
  ) {
    // Paying the treasury's own authority would mean the "merchant" was us.
    add("RECIPIENT_IS_OWN_TREASURY", "the quoted recipient is the registered treasury authority");
  }
  if (typeof input.quoteTerms.payTo === "string" && input.quoteTerms.payTo !== input.settlementRecipient) {
    add("RECIPIENT_MISMATCH", "the quoted payTo differs from the recorded settlement recipient");
  }

  // ── the request, and the result bound to it ──
  const requestHash = `0x${sha256Hex(stableStringify(input.request))}`;
  const quotedRequestHash = typeof input.quoteTerms.requestHash === "string" ? input.quoteTerms.requestHash : null;

  /**
   * The quote hashes the NORMALISED search, the intent stores the raw request.
   *
   * Comparing the two directly would fail whenever a caller sent an extra field the normaliser drops, so
   * the check is that the persisted result names the same query the request asked for — which is the
   * binding that actually matters — and that the quote carries a request hash at all.
   */
  if (quotedRequestHash === null) {
    add("QUOTE_REQUEST_HASH_MISSING", "the authorised quote records no request hash");
  }

  let resultHash: string | null = null;
  let productCount: number | null = null;
  const attestedQuery = typeof input.attestedFields.query === "string" ? input.attestedFields.query : null;
  const requestedQuery =
    typeof input.request.query === "string"
      ? input.request.query.trim()
      : typeof input.request.q === "string"
        ? input.request.q.trim()
        : null;

  if (attestedQuery === null) {
    add("RESULT_NOT_BOUND", "the persisted result records no query, so it is not bound to any request");
  } else if (requestedQuery === null) {
    add("REQUEST_QUERY_MISSING", "the intent's request carries no query to bind against");
  } else if (attestedQuery !== requestedQuery) {
    add(
      "RESULT_NOT_BOUND",
      "the persisted result answers a different query than the intent authorised",
    );
  }

  /**
   * No purchase artefact may appear in a paid read's result.
   *
   * A substituted purchase response would carry an order id and a shipment, and it would settle for a
   * very different amount. Refusing on the SHAPE of the result rather than only on its hash means a
   * substitution is caught even if someone recomputed the hash to match.
   */
  for (const forbidden of ["orderId", "shipment", "tracking", "shippingAddress", "email"]) {
    if (input.attestedFields[forbidden] !== undefined) {
      add("PURCHASE_RESULT_SUBSTITUTED", `the persisted result carries \`${forbidden}\`, which a paid read never has`);
    }
  }

  // ── the products, re-parsed through the same schema the adapter used ──
  let products: readonly SearchProduct[] = [];
  try {
    products = parseSearchProducts(input.attestedFields);
    productCount = products.length;
  } catch (err) {
    add("RESULT_SCHEMA_INVALID", `the persisted result does not parse as a Purch search: ${(err as Error).message}`);
  }

  if (productCount !== null && attestedQuery !== null) {
    resultHash = paidReadResultHash(attestedQuery, products);
    const storedHash = typeof input.attestedFields.resultHash === "string" ? input.attestedFields.resultHash : null;
    if (storedHash === null) {
      add("RESULT_HASH_MISSING", "the persisted result carries no result hash to check against");
    } else if (storedHash !== resultHash) {
      add(
        "RESULT_HASH_MISMATCH",
        "the persisted result does not hash to the value recorded at execution time",
      );
    }
    const storedCount = input.attestedFields.count;
    if (typeof storedCount === "number" && storedCount !== productCount) {
      add("RESULT_COUNT_MISMATCH", `the persisted result claims ${storedCount} products and parses to ${productCount}`);
    }
    if (productCount === 0) {
      add("RESULT_EMPTY", "the paid search returned no products, so nothing was delivered for the payment");
    }
  }

  if (input.attestedStatus !== "fulfilled" && input.attestedStatus !== "ACKNOWLEDGED") {
    add("PROVIDER_NOT_ACKNOWLEDGED", `the provider status is '${input.attestedStatus}', not fulfilled`);
  }

  /**
   * The digest over every input read, so an identical redrive lands on the row it already wrote.
   *
   * It covers the evidence, not the verdict: two verifier versions reading the same evidence produce the
   * same digest and different rows, which is exactly how a disagreement between them stays visible.
   */
  const evidenceDigest = `0x${sha256Hex(
    stableStringify({
      intentId: input.intentId,
      providerId: input.providerId,
      capability: input.capability,
      executionShape: input.executionShape,
      quoteTerms: input.quoteTerms,
      quoteCost: input.quoteCost.amount.toString(),
      quoteHash: input.quoteHash,
      settlementRecipient: input.settlementRecipient,
      settlementChain: input.settlementChain,
      settlementAssetSymbol: input.settlementAssetSymbol,
      settlementMint: input.settlementMint,
      reservedAtomic: input.reservedAtomic?.toString() ?? null,
      gateCeilingAtomic: input.gateCeilingAtomic?.toString() ?? null,
      executions: input.executions.map((e) => ({
        state: e.state,
        settlementTxHash: e.settlementTxHash,
        settlementChain: e.settlementChain,
        settledAtomic: e.settledAtomic?.toString() ?? null,
      })),
      registeredAuthority: input.registeredAuthority,
      attestedFields: input.attestedFields,
      attestedStatus: input.attestedStatus,
      request: input.request,
    }),
  )}`;

  const verified = refusals.length === 0;
  return {
    verified,
    method: "PAID_READ_RESULT_BINDING",
    detail: verified
      ? `the paid search returned ${productCount ?? 0} schema-valid products bound to the authorised ` +
        "request, paid by the recorded settlement. Untch verifies that the service ran and returned " +
        "what was bought; it does not verify that any listing is accurate, priced correctly or in stock."
      : `verification refused on ${refusals.length} ground(s): ${refusals.map((r) => r.code).join(", ")}`,
    refusals,
    resultHash,
    requestHash,
    productCount,
    evidenceDigest,
  };
}
