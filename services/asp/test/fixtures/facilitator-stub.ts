import express from "express";
import type { Server } from "node:http";

/**
 * A local stand-in for the OKX facilitator's discovery call, and nothing more.
 *
 * WHY THIS EXISTS
 *
 * `paymentMiddleware` cannot emit a single 402 until it has asked a facilitator which payment kinds
 * it supports; with no answer it throws `no supported payment kinds loaded from any facilitator` and
 * every priced route 500s. So a suite that wants to assert the SHAPE of a challenge — its price,
 * network, token and payee — has a choice between real seller credentials, which cannot live in CI,
 * and answering that one discovery call locally.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not verify and it does not settle. Those two endpoints are left unmounted, so a test that
 * drifted into trying to complete a payment against this stub gets a 404 rather than a fabricated
 * success. The only thing being substituted is the answer to "what do you support", which is
 * configuration; everything downstream of it stays the real SDK making its real decisions.
 */

/** The one payment kind this service sells: `exact` on X Layer, x402 v2. */
export const SUPPORTED_KINDS = Object.freeze({
  kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:196" }],
});

export interface FacilitatorStub {
  readonly url: string;
  /** How many discovery calls the middleware made. Zero means the SDK never initialised. */
  readonly calls: () => number;
  close(): Promise<void>;
}

export async function startFacilitatorStub(): Promise<FacilitatorStub> {
  let calls = 0;
  const app = express();
  app.get("/api/v6/pay/x402/supported", (_req, res) => {
    calls += 1;
    res.json({ code: "0", data: SUPPORTED_KINDS });
  });
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("facilitator stub did not bind");
  return {
    // production-surface-allow: localhost — an ephemeral in-test listener, never a published URL.
    url: `http://127.0.0.1:${address.port}`,
    calls: () => calls,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The decoded `PAYMENT-REQUIRED` challenge, in the shape the assertions actually read. */
export interface DecodedChallenge {
  readonly x402Version: number;
  readonly resource: { readonly url: string; readonly description: string; readonly mimeType: string };
  readonly accepts: readonly {
    readonly scheme: string;
    readonly network: string;
    readonly amount: string;
    readonly asset: string;
    readonly payTo: string;
  }[];
}

/**
 * Read the challenge the SDK published.
 *
 * The header is the authoritative carrier in x402 v2 — the 402 body is `{}` — so a test that read
 * the body would be asserting on the absence of information rather than on the contract.
 */
export function decodeChallenge(header: string | null): DecodedChallenge {
  if (!header) throw new Error("no PAYMENT-REQUIRED header on the response");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as DecodedChallenge;
}
