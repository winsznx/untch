import { createHash } from "node:crypto";
import type { Request } from "express";
import { authorizationDigest, type AuthorizedTerms } from "@untch/consumer-core";

/**
 * The payment authorization as EVIDENCE, never as a capability.
 *
 * WHY THE HANDLER CANNOT BE GIVEN THE THING THAT PAYS
 *
 * The escalated branch has to record WHICH payment authorised the request it is about to raise: a
 * nonce to key the attempt on, a payer, a token, an amount, a recipient and a chain. Every one of those
 * is a fact. None of them is a permission.
 *
 * The tempting shape is to hand the handler whatever the middleware is holding — the payload, the
 * facilitator client, a settle callback — because it is right there and it already has the fields. That
 * would put a thing that can move money inside a function whose entire guarantee is that it cannot, and
 * the guarantee would then be a comment rather than a type.
 *
 * So the boundary parses the verified authorization into THIS, which is inert by construction: strings
 * and nulls, no functions, no client, no signature, no bearer. `assertInertAuthorizationContext` below
 * fails `tsc` if a future edit adds a callable field, and `DecisionOnlyDeps` still cannot name a
 * settlement capability at all.
 *
 * WHAT IS DELIBERATELY ABSENT
 *
 * The signature and the complete signed authorization. Both are bearer instruments: anything holding
 * one can spend it, so a value that travels into application code, gets logged, or reaches a database
 * must not contain either. `authorizationDigest` is what lets a later comparison prove the terms are
 * the same without keeping the thing that could redeem them.
 */

export interface VerifiedPaymentAuthorizationContext {
  readonly scheme: string;
  readonly network: string;
  /** The account the funds move FROM, as the authorization itself names it. */
  readonly payer: string;
  readonly token: string;
  readonly amount: string;
  readonly payTo: string;
  /** CAIP-2. The same string the payment attempt and the finalizer compare on. */
  readonly chain: string;
  readonly validAfter: string | null;
  readonly validBefore: string | null;
  readonly authorizationNonce: string;
  /** A digest over the terms only. Never over the signature. */
  readonly authorizationDigest: string;
  /** One-way, truncated. Correlates two log lines and redeems nothing. */
  readonly headerFingerprint: string;
  readonly verifiedAt: string;
}

/**
 * THE COMPILE-TIME TEST THAT THIS VALUE CANNOT ACT.
 *
 * Resolves to the offending key names when `T` carries any function-valued property, and to `never`
 * when it carries none. A settlement function, a facilitator client, a treasury signer, a provider
 * executor and a money-moving callback are all callable, so a single check covers the whole class
 * rather than enumerating names somebody would forget to extend.
 */
export type CallablePropertiesIn<T> = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [K in keyof T]-?: NonNullable<T[K]> extends (...args: any[]) => any ? K : never;
}[keyof T];

/** Compiles only while `T` has no callable property. The argument is the proof. */
export function assertInertAuthorizationContext<T>(
  _witness: CallablePropertiesIn<T> extends never ? true : never,
): void {
  // Nothing to run. The type checker is the assertion.
}

// Evaluated on every `tsc` run of this service.
assertInertAuthorizationContext<VerifiedPaymentAuthorizationContext>(true);

/**
 * The headers an x402 client presents its authorization in.
 *
 * Both spellings, because the protocol has shipped under each and a request that named the older one
 * would otherwise be treated as unauthenticated by this parser while the middleware had already
 * verified and charged it.
 */
const PRESENTED_HEADERS = ["payment-signature", "x-payment"] as const;

export function rawPaymentAuthorizationHeader(req: Request): string | null {
  for (const name of PRESENTED_HEADERS) {
    const value = req.header(name);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

/**
 * Numbers arrive as numbers, strings or bigint-ish strings depending on the client. They are stored and
 * compared as strings, so they are normalised here rather than at three later call sites.
 */
const num = (v: unknown): string | null => {
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return str(v);
};

/**
 * Parse a VERIFIED authorization into the inert value.
 *
 * `paymentMiddleware` has already verified the presented authorization by the time any handler runs —
 * an invalid one is answered with a 402 and never reaches `next()`. So this does not re-verify a
 * signature it deliberately does not keep; it reads what was verified and hands on the facts.
 *
 * Returns null when there is nothing to read. A null here means "this request carried no authorization
 * we can name", and the escalated branch refuses on it rather than raising an approval it cannot key to
 * a payment.
 */
export function parseVerifiedPaymentAuthorization(
  raw: string | null,
  opts: { readonly chainId: number; readonly now?: () => number } = { chainId: 0 },
): VerifiedPaymentAuthorizationContext | null {
  if (!raw) return null;

  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof decoded !== "object" || decoded === null) return null;

  const accepted = (decoded.accepted ?? {}) as Record<string, unknown>;
  const payload = (decoded.payload ?? {}) as Record<string, unknown>;
  const authorization = (payload.authorization ?? {}) as Record<string, unknown>;

  const authorizationNonce = str(authorization.nonce);
  const payer = str(authorization.from);
  const payTo = str(accepted.payTo) ?? str(authorization.to);
  const token = str(accepted.asset);
  const amount = str(accepted.amount) ?? num(authorization.value);
  const network = str(accepted.network);
  const scheme = str(accepted.scheme);

  /**
   * Every field below is load-bearing: the nonce keys the attempt, and the other five are what
   * `finalizeSettlement` compares the settlement against. A context missing any of them could not be
   * checked later, so it is refused here rather than stored with a hole in it.
   */
  if (!authorizationNonce || !payer || !payTo || !token || !amount) return null;

  /**
   * The chain is taken from the authorization's own network when it states one, and from the
   * deployment's chain id otherwise. Never the other way round: a value the payer signed outranks a
   * value this process happens to be configured with.
   */
  const chain = network && network.includes(":") ? network : `eip155:${opts.chainId}`;

  const terms: AuthorizedTerms = {
    authorizationNonce,
    payer,
    token,
    amount,
    payTo,
    chain,
  };

  const nowMs = (opts.now ?? Date.now)();
  return {
    scheme: scheme ?? "exact",
    network: network ?? chain,
    payer,
    token,
    amount,
    payTo,
    chain,
    validAfter: num(authorization.validAfter),
    validBefore: num(authorization.validBefore),
    authorizationNonce,
    authorizationDigest: authorizationDigest(terms),
    headerFingerprint: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    verifiedAt: new Date(nowMs).toISOString(),
  };
}

/** The terms the finalizer compares a settlement against, taken from the inert context. */
export function authorizedTermsOf(context: VerifiedPaymentAuthorizationContext): AuthorizedTerms {
  return {
    authorizationNonce: context.authorizationNonce,
    payer: context.payer,
    token: context.token,
    amount: context.amount,
    payTo: context.payTo,
    chain: context.chain,
  };
}
