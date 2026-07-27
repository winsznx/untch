/**
 * The typed adapter contract, and the one implementation of the paid-request dance.
 *
 * `ConsumerProviderAdapter` is what a merchant integration implements. `ProviderTransport` is what it
 * gets to do it with, and its shape is the security boundary: an adapter can make an HTTP request and
 * — only inside `execute` — spend through a `PaymentCapability`. It never sees a key, never chooses a
 * base URL, and never decides whether a challenge is acceptable.
 *
 * The 402 → select → pay → retry loop lives HERE, once. Duplicating it per adapter is how payment
 * verification drifts: five copies of "which accepts[] entry do we take" become five different
 * answers to "is this token on the allowlist".
 */

import {
  normalizedError,
  ProviderError,
  sanitizeProviderText,
  unknownProviderError,
  type CaipChainId,
  type ConfirmedAsset,
  type DeliveryEvidence,
  type DiscoveryInput,
  type DiscoveryResult,
  type ExecuteInput,
  type Money,
  type NormalizedProviderError,
  type PaymentCapability,
  type ProviderCancellation,
  type ProviderExecution,
  type ProviderQuote,
  type ProviderReference,
  type ProviderStatus,
  type QuoteInput,
} from "@untch/consumer-core";
import { parseJsonBody, providerFetch, type ProviderResponse } from "./http";
import {
  classifyChallenge,
  decodeChallengeHeader,
  selectPayment,
  type SelectedPayment,
} from "./x402/challenge";
import { parseWwwAuthenticate, isMppOnly } from "./mpp/challenge";
import type { SiwxSigner } from "./siwx/sign";

export interface ProviderCapabilityDescriptor {
  readonly capability: string;
  readonly description: string;
  /** Whether this capability moves value. Non-value capabilities never touch the treasury. */
  readonly movesValue: boolean;
}

export interface AdapterContext {
  readonly correlationId: string;
  readonly timeoutMs: number;
  /** Rails a signing key exists for. Used when selecting from a multi-rail challenge. */
  readonly signableChains: ReadonlySet<CaipChainId>;
  /** SIWX identity. Absent ⇒ SIWX-gated endpoints report PROVIDER_UNAUTHORIZED, never a fake success. */
  readonly siwx: SiwxSigner | null;
  /**
   * A SMALL, separate spending authority for read calls.
   *
   * Discovery is not free on these providers — StableDomains charges $0.01 to search and $0.05 to
   * check a domain, and Purch charges $0.01 to search. Pretending otherwise would mean either not
   * integrating them or paying from the execution capability, and the second is much worse: it would
   * let a search consume authority a human granted for a purchase.
   *
   * So reads get their own capability, minted with a cents-scale ceiling and the provider's own
   * allowlisted payTo, covered by the fixed ASP call fee. Absent ⇒ paid discovery reports a typed
   * refusal rather than silently returning nothing.
   */
  readonly discoveryPayment: PaymentCapability | null;
  /** Injected for tests. */
  readonly fetchImpl?: typeof fetch;
  readonly resolveHost?: (host: string) => Promise<readonly string[]>;
  readonly clock?: () => number;
}

export interface ProviderHealth {
  readonly healthy: boolean;
  readonly latencyMs: number | null;
  readonly httpStatus: number | null;
  readonly detail: string;
}

export interface ConsumerProviderAdapter {
  readonly providerId: string;
  capabilities(): readonly ProviderCapabilityDescriptor[];
  health(ctx: AdapterContext): Promise<ProviderHealth>;
  discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult>;
  quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote>;
  /** The ONLY method that receives spending authority, and it is scoped to a single intent. */
  execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution>;
  getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus>;
  cancel?(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderCancellation>;
  verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence>;
  normalizeError(err: unknown): NormalizedProviderError;
}

// ─────────────────────────────────────────────────────────────────────────────
// The paid-request dance
// ─────────────────────────────────────────────────────────────────────────────

export interface PaidRequestInput {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** Present ⇒ this call may spend. Absent ⇒ a 402 is a hard refusal, never a silent payment. */
  readonly payment?: PaymentCapability;
  /** Recipients the approval bound. Enforced during selection, before the signer is reached. */
  readonly allowedRecipients?: readonly string[];
  /** The ceiling per asset. Enforced during selection. */
  readonly ceilingFor?: (asset: ConfirmedAsset) => Money | null;
}

export interface PaidRequestResult {
  readonly response: ProviderResponse;
  readonly json: unknown;
  /** Present when the request actually paid. Null for a free or already-authorised call. */
  readonly settlement: {
    readonly amount: Money;
    readonly recipient: string;
    readonly chain: CaipChainId;
    readonly txHash: string | null;
  } | null;
}

/**
 * Base class carrying the transport. Adapters extend it and implement the merchant-specific parts;
 * nothing about payment selection is overridable.
 */
export abstract class BaseAdapter implements ConsumerProviderAdapter {
  abstract readonly providerId: string;

  /** From `consumer_providers.base_url` — never from a request. This is the SSRF boundary. */
  protected constructor(protected readonly baseUrl: string) {}

  abstract capabilities(): readonly ProviderCapabilityDescriptor[];
  abstract discover(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveryResult>;
  abstract quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote>;
  abstract execute(
    input: ExecuteInput,
    payment: PaymentCapability,
    ctx: AdapterContext,
  ): Promise<ProviderExecution>;
  abstract getStatus(ref: ProviderReference, ctx: AdapterContext): Promise<ProviderStatus>;
  abstract verifyDelivery(exec: ProviderExecution, ctx: AdapterContext): Promise<DeliveryEvidence>;

  /**
   * A health probe that costs nothing. It deliberately treats a 402 as HEALTHY: a paid endpoint
   * answering "payment required" is a paid endpoint working correctly, and a probe that called that
   * unhealthy would open the circuit breaker on every functioning provider in the catalogue.
   */
  async health(ctx: AdapterContext): Promise<ProviderHealth> {
    try {
      const res = await this.raw("GET", this.healthPath(), ctx, {});
      const healthy = res.status < 500;
      return {
        healthy,
        latencyMs: res.durationMs,
        httpStatus: res.status,
        detail: healthy ? "reachable" : `provider returned ${res.status}`,
      };
    } catch (err) {
      const n = this.normalizeError(err);
      return { healthy: false, latencyMs: null, httpStatus: n.httpStatus, detail: n.message };
    }
  }

  /** Overridable: the cheapest endpoint that proves the provider is up. */
  protected healthPath(): string {
    return "/openapi.json";
  }

  normalizeError(err: unknown): NormalizedProviderError {
    if (err instanceof ProviderError) return err.normalized;
    return unknownProviderError(err);
  }

  protected url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, "");
    const rel = path.startsWith("/") ? path : `/${path}`;
    return `${base}${rel}`;
  }

  protected async raw(
    method: string,
    path: string,
    ctx: AdapterContext,
    headers: Readonly<Record<string, string>>,
    body?: unknown,
  ): Promise<ProviderResponse> {
    return providerFetch({
      method,
      url: this.url(path),
      headers,
      timeoutMs: ctx.timeoutMs,
      correlationId: ctx.correlationId,
      ...(body === undefined ? {} : { body }),
      ...(ctx.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}),
      ...(ctx.resolveHost ? { resolveHost: ctx.resolveHost } : {}),
    });
  }

  /**
   * One request, handling 402 in whichever of its three forms arrives.
   *
   * The single most important line in this method is the `if (!input.payment)` branch: an adapter
   * that hits a 402 on a call it was NOT given spending authority for gets a typed refusal. Discovery
   * and quoting cannot pay by accident, no matter what a merchant asks for.
   */
  protected async paid(input: PaidRequestInput, ctx: AdapterContext): Promise<PaidRequestResult> {
    const headers: Record<string, string> = { ...(input.headers ?? {}) };

    let res = await this.raw(input.method, input.path, ctx, headers, input.body);

    // ── SIWX (a 402 with an empty accepts[] plus a sign-in-with-x extension) ──
    const firstChallenge = decodeChallengeHeader(res.headers["payment-required"]);
    let classified = classifyChallenge(firstChallenge);

    if (res.status === 402 && classified.kind === "siwx") {
      if (!ctx.siwx || !ctx.siwx.available()) {
        throw new ProviderError(
          normalizedError(
            "PROVIDER_UNAUTHORIZED",
            `${this.providerId} requires SIWX wallet authentication for ${input.path}, and no SIWX ` +
              "identity key is configured on this instance",
          ),
        );
      }
      const credential = await ctx.siwx.sign(classified.request);
      headers[credential.headerName] = credential.headerValue;
      res = await this.raw(input.method, input.path, ctx, headers, input.body);
      classified = classifyChallenge(decodeChallengeHeader(res.headers["payment-required"]));
    }

    if (res.status !== 402) {
      return { response: res, json: parseJsonBody(res), settlement: null };
    }

    // ── a genuine payment challenge ──
    const mpp = parseWwwAuthenticate(res.headers["www-authenticate"]);
    if (classified.kind !== "payment") {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          isMppOnly(false, mpp)
            ? `${this.providerId} offered only MPP (${mpp?.method ?? "unknown"}), which this build ` +
              "parses but cannot execute — see packages/consumer-providers/src/mpp/challenge.ts"
            : `${this.providerId} returned a 402 with no usable payment challenge`,
          { httpStatus: 402 },
        ),
      );
    }

    if (!input.payment) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          `${this.providerId} demanded payment for ${input.path}, but this call carries no payment ` +
            "capability — a discovery or quote request must never settle",
          { httpStatus: 402 },
        ),
      );
    }

    const selected: SelectedPayment = selectPayment(classified.challenge, {
      signableChains: ctx.signableChains,
      ceilingFor: input.ceilingFor ?? (() => input.payment?.maxAmount ?? null),
      ...(input.allowedRecipients ? { allowedRecipients: input.allowedRecipients } : {}),
    });

    const result = await input.payment.pay({
      amount: selected.amount,
      recipient: selected.recipient,
      challenge: classified.challenge as unknown as Record<string, unknown>,
      resourceUrl: this.url(input.path),
      method: input.method,
    });

    headers[result.headerName] = result.paymentHeader;

    // The paid retry. From here on the outcome is AMBIGUOUS on any transport failure: the payment
    // header has left the building and the provider may act on it even if we never see the response.
    let paidRes: ProviderResponse;
    try {
      paidRes = await this.raw(input.method, input.path, ctx, headers, input.body);
    } catch (err) {
      const n = this.normalizeError(err);
      throw new ProviderError(
        normalizedError(
          "PAYMENT_AMBIGUOUS",
          `the paid retry to ${this.providerId}${input.path} failed after the payment authorization ` +
            `was sent (${n.message}) — the outcome is unknown and must not be retried`,
          { paymentSettled: false, sideEffectPossible: true },
        ),
      );
    }

    if (paidRes.status === 402) {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_FAILED",
          `${this.providerId} rejected the payment authorization for ${input.path}`,
          { httpStatus: 402 },
        ),
      );
    }

    const settlementTx = readSettlementTx(paidRes.headers["payment-response"]);

    return {
      response: paidRes,
      json: parseJsonBody(paidRes),
      settlement: {
        amount: selected.amount,
        recipient: selected.recipient,
        chain: selected.option.network,
        txHash: settlementTx ?? result.txHash,
      },
    };
  }

  /**
   * Read a provider's 402 WITHOUT paying it.
   *
   * This is how a quote learns the exact price. It matters that the number in a quote is the
   * provider's own atomic amount from its own challenge, rather than a display string we converted:
   * a converted price is a second opinion about what something costs, and the approval a human gives
   * should bind to the merchant's figure, not to ours.
   *
   * Free by construction — the request is sent unpaid and the 402 is the answer we wanted.
   */
  protected async probe402(
    method: string,
    path: string,
    ctx: AdapterContext,
    body?: unknown,
  ): Promise<SelectedPayment> {
    const res = await this.raw(method, path, ctx, {}, body);
    if (res.status !== 402) {
      throw new ProviderError(
        normalizedError(
          "PROVIDER_BAD_REQUEST",
          `expected a 402 price challenge from ${this.providerId}${path}, got ${res.status}`,
          { httpStatus: res.status },
        ),
      );
    }
    const classified = classifyChallenge(decodeChallengeHeader(res.headers["payment-required"]));
    if (classified.kind !== "payment") {
      throw new ProviderError(
        normalizedError(
          "PAYMENT_CHALLENGE_UNACCEPTABLE",
          classified.kind === "siwx"
            ? `${this.providerId}${path} is SIWX-gated, so it carries no price challenge to quote from`
            : `${this.providerId}${path} returned a 402 with no payment options`,
          { httpStatus: 402 },
        ),
      );
    }
    return selectPayment(classified.challenge, {
      signableChains: ctx.signableChains,
      ceilingFor: () => null,
    });
  }

  /**
   * Classify an HTTP status into the error taxonomy. Adapters override only where a merchant's
   * semantics genuinely differ; the default is deliberately conservative about ambiguity.
   */
  protected classifyStatus(res: ProviderResponse, context: string): ProviderError {
    const snippet = sanitizeProviderText(res.text, 200);
    const retryAfterRaw = res.headers["retry-after"];
    const retryAfterMs =
      retryAfterRaw !== undefined && /^\d+$/.test(retryAfterRaw)
        ? Number.parseInt(retryAfterRaw, 10) * 1000
        : null;

    if (res.status === 429) {
      return new ProviderError(
        normalizedError("PROVIDER_RATE_LIMITED", `${context}: rate limited`, {
          httpStatus: 429,
          retryAfterMs: retryAfterMs ?? 5000,
        }),
      );
    }
    if (res.status === 401 || res.status === 403) {
      return new ProviderError(
        normalizedError("PROVIDER_UNAUTHORIZED", `${context}: ${snippet}`, { httpStatus: res.status }),
      );
    }
    if (res.status === 400 || res.status === 422) {
      return new ProviderError(
        normalizedError("PROVIDER_BAD_REQUEST", `${context}: ${snippet}`, { httpStatus: res.status }),
      );
    }
    if (res.status === 404 || res.status === 409 || res.status === 410) {
      return new ProviderError(
        normalizedError("PROVIDER_REJECTED", `${context}: ${snippet}`, { httpStatus: res.status }),
      );
    }
    if (res.status >= 500) {
      return new ProviderError(
        normalizedError("PROVIDER_UNAVAILABLE", `${context}: provider returned ${res.status}`, {
          httpStatus: res.status,
          retryAfterMs: retryAfterMs ?? 2000,
        }),
      );
    }
    return new ProviderError(
      normalizedError("PROVIDER_UNKNOWN", `${context}: unexpected status ${res.status}`, {
        httpStatus: res.status,
      }),
    );
  }
}

/** Read the settlement tx out of the x402 `PAYMENT-RESPONSE` header, if the provider sent one. */
function readSettlementTx(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8"));
    if (decoded && typeof decoded === "object") {
      const tx = (decoded as Record<string, unknown>).transaction;
      if (typeof tx === "string" && tx.length > 0) return tx;
    }
  } catch {
    // A provider that sends an undecodable PAYMENT-RESPONSE has not given us a hash. Reporting null
    // is correct; inventing one would put a fabricated reference into a receipt.
  }
  return null;
}
