import { decodePaymentResponseHeader } from "@okxweb3/x402-fetch";
import {
  guardedPay,
  type ChallengeBinding,
  type GuardOutcome,
  type PreflightDecision,
  type PreflightFn,
  type SignAndPay,
} from "@untch/x402-guard";
import { makeBuyerFetch, makeRecordingFetch } from "./buyer";

/**
 * The real buyer-side integration of @untch/x402-guard (PRD §14 Mode B) — the middleware that
 * REPLACES the old ad-hoc "fetch the 402, then immediately sign whatever came back" path. Every
 * outbound paid call the buyer makes now routes through the guard: 402 → Challenge Binding Check →
 * preflight decision → (APPROVE) the buyer's OWN signer runs.
 *
 * The middleware never holds the buyer key. The key lives ONLY inside `makeBuyerFetch` here, behind
 * the injected `signAndPay` callback; the guard decides whether to call it and never sees it.
 */

export interface SettledPayment {
  readonly status: number;
  readonly body: string;
  readonly settlement: unknown;
  readonly settlementTx: string | null;
  readonly paymentSignature: string | undefined;
}

function settlementTxOf(res: Response): { settlement: unknown; settlementTx: string | null } {
  const header = res.headers.get("PAYMENT-RESPONSE");
  const settlement = header ? decodePaymentResponseHeader(header) : null;
  const settlementTx = (settlement as { transaction?: string } | null)?.transaction ?? null;
  return { settlement, settlementTx };
}

/**
 * Build the caller's OWN signer as an injected `signAndPay`. It pays the guarded resource with the
 * buyer's key via the OKX x402 wrapper (EIP-3009), returning the settled payment. The guard invokes
 * this ONLY after APPROVE.
 */
export function makeSignAndPay(buyerKey: `0x${string}`): SignAndPay {
  return async (ctx) => {
    const recording = makeRecordingFetch();
    const payFetch = makeBuyerFetch(buyerKey, recording);
    const res = await payFetch(ctx.url, {
      method: ctx.method,
      headers: ctx.headers,
      ...(ctx.body !== undefined ? { body: ctx.body as string } : {}),
    });
    const body = await res.text();
    const { settlement, settlementTx } = settlementTxOf(res);
    const settled: SettledPayment = {
      status: res.status,
      body,
      settlement,
      settlementTx,
      paymentSignature: recording.getPaymentSignature(),
    };
    return settled;
  };
}

export interface PreflightCallResult {
  readonly decision: string;
  readonly settlementTx: string | null;
  readonly raw: Record<string, unknown>;
}

/**
 * Build the injected `preflight` fn as a REAL paid `preflight_payment` call (§11, $0.05 x402) against
 * the live seller. How preflight pays for itself is the caller's concern — exactly the DI boundary the
 * guard relies on. Returns the engine's decision verbatim (plus the preflight's own settlement tx,
 * stashed for the proof). Records the last call so the driver can report it.
 */
export function makePaidPreflight(
  buyerKey: `0x${string}`,
  sellerUrl: string,
  intent: Record<string, unknown>,
  policyId: string,
  onResult?: (r: PreflightCallResult) => void,
): PreflightFn {
  const url = `${sellerUrl.replace(/\/$/, "")}/preflight_payment`;
  return async () => {
    const recording = makeRecordingFetch();
    const payFetch = makeBuyerFetch(buyerKey, recording);
    const res = await payFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent, policyId }),
    });
    const raw = (await res.json()) as Record<string, unknown>;
    const { settlementTx } = settlementTxOf(res);
    const decision = typeof raw.decision === "string" ? raw.decision : "BLOCKED_FAIL_CLOSED";
    onResult?.({ decision, settlementTx, raw });
    // Surface the §8.2 fields the guard/poll handle use; keep everything else verbatim. Optional
    // fields are OMITTED when absent (exactOptionalPropertyTypes), never set to undefined.
    const out: Record<string, unknown> = {
      decision,
      receiptRef: (raw.receiptRef as { receiptId: string; status: string } | null) ?? null,
      ruleTrace: raw.ruleTrace,
    };
    if (Array.isArray(raw.reasons)) out.reasons = raw.reasons;
    if (typeof raw.intentHash === "string") out.intentHash = raw.intentHash;
    if (typeof raw.policyId === "string") out.policyId = raw.policyId;
    return out as PreflightDecision;
  };
}

export interface GuardedCallParams {
  readonly buyerKey: `0x${string}`;
  readonly sellerUrl: string;
  readonly resourceUrl: string;
  readonly method?: string;
  readonly expectedBinding: ChallengeBinding;
  readonly intent: Record<string, unknown>;
  readonly policyId: string;
  readonly onPreflight?: (r: PreflightCallResult) => void;
}

/** One guarded outbound paid call, fully wired: CBC + real paid preflight + the buyer's own signer. */
export function guardedBuyerCall(params: GuardedCallParams): Promise<GuardOutcome> {
  return guardedPay(
    {
      url: params.resourceUrl,
      method: params.method ?? "GET",
      expectedBinding: params.expectedBinding,
    },
    {
      preflight: makePaidPreflight(
        params.buyerKey,
        params.sellerUrl,
        params.intent,
        params.policyId,
        params.onPreflight,
      ),
      signAndPay: makeSignAndPay(params.buyerKey),
    },
  );
}
