import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  CREATE_INTENT_ROUTE,
  loadSellerConfig,
  NETWORK,
  PING_PRICE,
  PING_ROUTE,
  PREFLIGHT_PRICE,
  PREFLIGHT_ROUTE,
  type SellerConfig,
} from "./config";
import { handleCreateSpendIntent, handlePreflightPayment, type HandlerResult } from "./handlers";
import { createFixtureState } from "./policy-fixture";

/**
 * Untch A2MCP seller. Real, settled, pay-per-call x402 on X Layer mainnet (eip155:196) via the OKX
 * hosted facilitator — the same rail D0.1 proved. Tools:
 *
 *   • GET  /ping_untch          — $0.01  health-check / proof-of-rail (D0.1). KEPT as a liveness +
 *                                 minimal-price probe; `preflight_payment` is now the primary paid
 *                                 tool, but a $0.01 no-input GET is the cheapest way to check the
 *                                 facilitator round-trip still settles without minting an intent.
 *   • POST /create_spend_intent — BUNDLED (unpriced): validate + canonicalize + hash a §8.1 bounded
 *                                 SpendIntent via @untch/canon. No on-chain registration (§10.2 not
 *                                 built) — returns {intentHash, canonicalIntent, onchain:null}.
 *   • POST /preflight_payment   — $0.05 (§11): runs the REAL @untch/policy-engine (§7.1,
 *                                 deterministic, no LLM) against a DEMO fixture policy + in-memory
 *                                 ledger. Returns {decision, reasons[], ruleTrace[], receiptRef,
 *                                 sig} with receiptRef/sig explicitly null (subsystems not built).
 *
 * The seller HMAC-authenticates to the facilitator with the OKX API triple. It never holds the
 * buyer's key — the buyer signs an EIP-3009 authorization itself; the facilitator submits it.
 * `syncFacilitatorOnStart` (default true) is REQUIRED: the resource server cannot build a 402
 * `PAYMENT-REQUIRED` challenge until it has fetched supported kinds from the facilitator, so the
 * process must reach https://web3.okx.com at boot. `syncSettle:true` makes the facilitator wait
 * for on-chain confirmation so `PAYMENT-RESPONSE` carries the settlement tx hash.
 */
export function createSellerApp(config: SellerConfig = loadSellerConfig()): Express {
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
    // Live base, confirmed at D0.1 (the `.../facilitator` prefix is stale). Overridable via env.
    baseUrl: process.env.OKX_X402_FACILITATOR_URL?.trim() || "https://web3.okx.com",
    syncSettle: true,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    NETWORK,
    new ExactEvmScheme(),
  );

  // One shared bundle of DEMO fixture state (policy + in-memory ledger + intent store) for the
  // life of the process. Real Postgres/Redis wiring is a later step; this resets on restart.
  const fixture = createFixtureState();

  const app = express();

  // Payment gate FIRST: an unpaid request to a priced route 402s here without touching the body.
  app.use(
    paymentMiddleware(
      {
        [`GET ${PING_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PING_PRICE },
          description: "Untch hello-world ping — D0.1 proof-of-rail health check",
          mimeType: "application/json",
        },
        [`POST ${PREFLIGHT_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PREFLIGHT_PRICE },
          description: "Untch preflight_payment — deterministic §7.1 policy preflight of a bounded SpendIntent",
          mimeType: "application/json",
        },
      },
      resourceServer,
    ),
  );

  // Body parsing AFTER the gate: only paid/unpriced requests that reach a handler get parsed.
  app.use(express.json({ limit: "64kb" }));

  app.get(PING_ROUTE, (_req, res) => {
    res.json({ ok: true, tool: "ping_untch", ts: new Date().toISOString() });
  });

  app.post(CREATE_INTENT_ROUTE, (req, res) => {
    send(res, handleCreateSpendIntent(req.body, { intentStore: fixture.intentStore }));
  });

  app.post(PREFLIGHT_ROUTE, (req, res, next) => {
    handlePreflightPayment(req.body, {
      policy: fixture.policy,
      ledger: fixture.ledger,
      intentStore: fixture.intentStore,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  // Turn a malformed-JSON body (express.json SyntaxError) into the §11 error envelope, not HTML.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({
        code: "BODY_NOT_JSON",
        message: "request body is not valid JSON",
        retryable: false,
        docsUrl: null,
      });
      return;
    }
    next(err);
  });

  return app;
}

function send(res: Response, result: HandlerResult): void {
  res.status(result.status).json(result.body);
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  const config = loadSellerConfig();
  createSellerApp(config).listen(config.port, () => {
    console.log(`[asp] listening on http://localhost:${config.port}`);
    console.log(`[asp]   GET  ${PING_ROUTE}          ${PING_PRICE}   (proof-of-rail health check)`);
    console.log(`[asp]   POST ${CREATE_INTENT_ROUTE}  bundled (canonicalize + hash a SpendIntent)`);
    console.log(`[asp]   POST ${PREFLIGHT_ROUTE}    ${PREFLIGHT_PRICE}   (real §7.1 policy preflight)`);
    console.log(`[asp] network ${NETWORK} · payTo ${config.payTo}`);
  });
}
