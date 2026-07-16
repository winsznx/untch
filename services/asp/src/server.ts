import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  CAFE_LATTE_PRICE,
  CAFE_LATTE_ROUTE,
  CAFE_MENU_ROUTE,
  CATALOG_ROUTE,
  CHECK_DOMAINS_ROUTE,
  CREATE_INTENT_ROUTE,
  CREATE_POLICY_ROUTE,
  DISPUTE_PRICE,
  DISPUTE_ROUTE,
  ESCALATION_STATUS_ROUTE,
  loadSellerConfig,
  NETWORK,
  PAUSE_POLICY_ROUTE,
  PING_PRICE,
  PING_ROUTE,
  PREFLIGHT_PRICE,
  PREFLIGHT_ROUTE,
  RANK_OPTIONS_ROUTE,
  RECEIPT_STATUS_ROUTE,
  RECONCILE_PRICE,
  RECONCILE_ROUTE,
  RESUME_POLICY_ROUTE,
  SCORE_BUYER_ROUTE,
  SCORE_PRICE,
  SCORE_VENDOR_ROUTE,
  SEO_TIPS_ROUTE,
  SUGGEST_NAMES_PRICE,
  SUGGEST_NAMES_ROUTE,
  SYNC_POLICY_ROUTE,
  UPDATE_POLICY_ROUTE,
  VERIFY_PRICE,
  VERIFY_ROUTE,
  type SellerConfig,
} from "./config";
import {
  handleCafeMenu,
  handleCafeOrderLatte,
  handleCatalog,
  handleCheckDomains,
  handleRankOptions,
  handleSeoTips,
  handleSuggestNames,
} from "./consumer-handlers";
import {
  handleCreateSpendIntent,
  handlePreflightPayment,
  handleVerifyDelivery,
  type HandlerResult,
} from "./handlers";
import {
  handleCreateSpendPolicy,
  handlePausePolicy,
  handleResumePolicy,
  handleSyncPolicyRegistration,
  handleUpdatePolicy,
} from "./policy-handlers";
import { handleScoreVendor, handleScoreBuyer } from "./score-handlers";
import { handleGenerateDisputePacket, handleReconcileAgentSpend } from "./report-handlers";
import { createLedgerState } from "./ledger-state";
import { initReceiptWiring, type ReceiptWiring } from "./receipts";
import { initPolicyWiring, type PolicyWiring } from "./policy-wiring";
import { initEscalationWiring, type EscalationWiring } from "./escalation-wiring";
import { initScoreWiring, type ScoreWiring } from "./score-wiring";
import { initReportWiring, type ReportWiring } from "./report-wiring";

/**
 * Untch A2MCP seller. Real, settled, pay-per-call x402 on X Layer mainnet (eip155:196) via the OKX
 * hosted facilitator — the same rail D0.1 proved. Tools:
 *
 *   • GET  /ping_untch          — $0.01  health-check / proof-of-rail (D0.1).
 *   • POST /create_spend_intent — BUNDLED (unpriced): validate + canonicalize + hash a §8.1 bounded
 *                                 SpendIntent via @untch/canon, bound to a REAL stored policy by
 *                                 policyId. Returns {intentHash, canonicalIntent, policyId, onchain:null}.
 *   • POST /preflight_payment   — $0.05 (§11): loads the REAL durable policy named by policyId and runs
 *                                 the REAL @untch/policy-engine (§7.1, deterministic, no LLM) against it
 *                                 + the in-memory ledger. Returns {decision, reasons[], ruleTrace[],
 *                                 receiptRef, sig}. The hardcoded fixture policy is GONE.
 *   • POST /create_spend_policy — build the UNSIGNED registerPolicy calldata for the CALLER's own wallet
 *                                 to sign + submit (the backend never signs — per-caller ownership).
 *   • POST /sync_policy_registration — record the durable row from the caller's confirmed tx, owner read
 *                                 from the on-chain PolicyRegistered event (never assumed).
 *   • POST /update_policy       — operator: revise a policy's ruleset on-chain + in Postgres.
 *   • POST /pause_policy        — operator: pause a policy on-chain + in Postgres.
 *   • POST /resume_policy       — operator: resume a paused policy.
 *
 * `create_spend_policy` needs no signing key (it only builds calldata). `update/pause/resume_policy` still
 * sign with the INTERIM demo/burner operator wallet (see README → "Operator signing"); they are unpriced
 * admin routes in this build, not buyer x402 calls.
 *
 * The seller HMAC-authenticates to the facilitator with the OKX API triple. It never holds the buyer's
 * key — the buyer signs an EIP-3009 authorization itself; the facilitator submits it.
 */
export function createSellerApp(
  config: SellerConfig = loadSellerConfig(),
  receiptWiring: ReceiptWiring | null = null,
  policyWiring: PolicyWiring | null = null,
  escalationWiring: EscalationWiring | null = null,
  scoreWiring: ScoreWiring | null = null,
  reportWiring: ReportWiring | null = null,
): Express {
  const facilitatorClient = new OKXFacilitatorClient({
    apiKey: config.okxApiKey,
    secretKey: config.okxSecretKey,
    passphrase: config.okxPassphrase,
    baseUrl: process.env.OKX_X402_FACILITATOR_URL?.trim() || "https://web3.okx.com",
    syncSettle: true,
  });

  const resourceServer = new x402ResourceServer(facilitatorClient).register(
    NETWORK,
    new ExactEvmScheme(),
  );

  // Ephemeral §7.1 ledger-window + intent cache (the policy is now durable in Postgres, not here).
  const ledgerState = createLedgerState();

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
        [`POST ${VERIFY_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: VERIFY_PRICE },
          description: "Untch verify_delivery — deterministic §13/§7.3 T0 proof of a delivery vs committed acceptance criteria",
          mimeType: "application/json",
        },
        [`POST ${SCORE_VENDOR_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SCORE_PRICE },
          description: "Untch score_vendor — deterministic §12 vendor reliability score (weighted features, LCB, no LLM)",
          mimeType: "application/json",
        },
        [`POST ${SCORE_BUYER_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SCORE_PRICE },
          description: "Untch score_buyer — deterministic §12 buyer-hygiene score (fully receipt-backed, LCB, no LLM)",
          mimeType: "application/json",
        },
        [`POST ${DISPUTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: DISPUTE_PRICE },
          description: "Untch generate_dispute_packet — assemble an intent's evidence bundle from durable history, anchor via AuditAnchored (§10.3, no LLM)",
          mimeType: "application/json",
        },
        [`POST ${RECONCILE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: RECONCILE_PRICE },
          description: "Untch reconcile_agent_spend — assemble an agent's spend/blocked-waste report over a period, anchor via AuditAnchored (§10.3, no LLM)",
          mimeType: "application/json",
        },
        [`POST ${CAFE_LATTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: CAFE_LATTE_PRICE },
          description: "Untch demo café — paid oat latte order voucher (lifestyle / governed spend demo)",
          mimeType: "application/json",
        },
        [`POST ${SUGGEST_NAMES_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SUGGEST_NAMES_PRICE },
          description: "Untch Launch Pack — deterministic product name suggestions for builders",
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

  // ── Consumer catalog + free builder/lifestyle tools ────────────────────────
  app.get(CATALOG_ROUTE, (_req, res) => send(res, handleCatalog()));
  app.get(CAFE_MENU_ROUTE, (_req, res) => send(res, handleCafeMenu()));
  app.post(CAFE_LATTE_ROUTE, (req, res) => send(res, handleCafeOrderLatte(req.body)));
  app.post(SUGGEST_NAMES_ROUTE, (req, res) => send(res, handleSuggestNames(req.body)));
  app.post(CHECK_DOMAINS_ROUTE, (req, res) => send(res, handleCheckDomains(req.body)));
  app.post(RANK_OPTIONS_ROUTE, (req, res) => send(res, handleRankOptions(req.body)));
  app.post(SEO_TIPS_ROUTE, (req, res) => send(res, handleSeoTips(req.body)));

  app.post(CREATE_INTENT_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    handleCreateSpendIntent(req.body, {
      intentStore: ledgerState.intentStore,
      policyProvider: policyWiring.provider,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  app.post(PREFLIGHT_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    handlePreflightPayment(req.body, {
      policyProvider: policyWiring.provider,
      ledger: ledgerState.ledger,
      intentStore: ledgerState.intentStore,
      ...(receiptWiring ? { receiptEnqueuer: receiptWiring.enqueuer } : {}),
      ...(escalationWiring ? { escalationGateway: escalationWiring.gateway } : {}),
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  app.post(VERIFY_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    handleVerifyDelivery(req.body, {
      policyProvider: policyWiring.provider,
      intentStore: ledgerState.intentStore,
      ...(receiptWiring ? { receiptEnqueuer: receiptWiring.enqueuer } : {}),
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  // §12 Bureau tools. `scoreWiring` is null when DATABASE_URL is unset → 503 (no score store).
  app.post(SCORE_VENDOR_ROUTE, (req, res, next) => {
    if (!scoreWiring) return send(res, scoreStoreUnconfigured());
    handleScoreVendor(req.body, {
      dataSource: scoreWiring.dataSource,
      walletProvider: scoreWiring.walletProvider,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  app.post(SCORE_BUYER_ROUTE, (req, res, next) => {
    if (!scoreWiring) return send(res, scoreStoreUnconfigured());
    handleScoreBuyer(req.body, {
      dataSource: scoreWiring.dataSource,
      walletProvider: scoreWiring.walletProvider,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  // §11 report tools. `reportWiring` is null when DATABASE_URL is unset → 503 (no report store).
  app.post(DISPUTE_ROUTE, (req, res, next) => {
    if (!reportWiring) return send(res, reportStoreUnconfigured());
    handleGenerateDisputePacket(req.body, {
      dataSource: reportWiring.dataSource,
      anchorer: reportWiring.anchorer,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  app.post(RECONCILE_ROUTE, (req, res, next) => {
    if (!reportWiring) return send(res, reportStoreUnconfigured());
    handleReconcileAgentSpend(req.body, {
      dataSource: reportWiring.dataSource,
      anchorer: reportWiring.anchorer,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  // Operator policy tools. `registration` (per-caller create/sync) is present whenever the store is
  // wired; `service` (update/pause/resume signing) is null when OPERATOR_PRIVATE_KEY is unset → 503.
  const policyDeps = {
    registration: policyWiring?.registration ?? null,
    service: policyWiring?.service ?? null,
  };
  app.post(CREATE_POLICY_ROUTE, (req, res, next) => {
    handleCreateSpendPolicy(req.body, policyDeps).then((r) => send(res, r)).catch(next);
  });
  app.post(SYNC_POLICY_ROUTE, (req, res, next) => {
    handleSyncPolicyRegistration(req.body, policyDeps).then((r) => send(res, r)).catch(next);
  });
  app.post(UPDATE_POLICY_ROUTE, (req, res, next) => {
    handleUpdatePolicy(req.body, policyDeps).then((r) => send(res, r)).catch(next);
  });
  app.post(PAUSE_POLICY_ROUTE, (req, res, next) => {
    handlePausePolicy(req.body, policyDeps).then((r) => send(res, r)).catch(next);
  });
  app.post(RESUME_POLICY_ROUTE, (req, res, next) => {
    handleResumePolicy(req.body, policyDeps).then((r) => send(res, r)).catch(next);
  });

  // §7.4 status poll — GET /receipt_status/:receiptId. Unpriced; reads Postgres (durable source of truth).
  app.get(RECEIPT_STATUS_ROUTE, (req, res, next) => {
    if (!receiptWiring) {
      res.status(503).json(
        errorBody("RECEIPTS_NOT_CONFIGURED", "receipt writer is not wired on this instance (no DATABASE_URL/REDIS_URL)"),
      );
      return;
    }
    receiptWiring
      .status(req.params.receiptId ?? "")
      .then((result) => {
        if (result === "invalid") {
          res.status(400).json(errorBody("BAD_RECEIPT_ID", "receiptId must be a 0x-prefixed 32-byte hex string"));
        } else if (result === null) {
          res.status(404).json(errorBody("RECEIPT_NOT_FOUND", `no receipt with id ${req.params.receiptId}`));
        } else {
          res.json(result);
        }
      })
      .catch(next);
  });

  // §7.2 escalation status poll — GET /escalation_status/:pollRef. Unpriced; what the guard's poll()
  // resolves against. Returns the getState() state (PENDING/APPROVED/DENIED) + the record's final fields.
  app.get(ESCALATION_STATUS_ROUTE, (req, res, next) => {
    if (!escalationWiring) {
      res.status(503).json(
        errorBody("ESCALATION_NOT_CONFIGURED", "escalation service is not wired on this instance (needs DATABASE_URL/REDIS_URL + at least one of TELEGRAM_*/DISCORD_*/SLACK_*)"),
      );
      return;
    }
    escalationWiring
      .status(req.params.pollRef ?? "")
      .then((view) => res.json(view))
      .catch(next);
  });

  // Turn a malformed-JSON body (express.json SyntaxError) into the §11 error envelope, not HTML.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json(errorBody("BODY_NOT_JSON", "request body is not valid JSON"));
      return;
    }
    next(err);
  });

  return app;
}

function errorBody(code: string, message: string): Record<string, unknown> {
  return { code, message, retryable: false, docsUrl: null };
}

function policyStoreUnconfigured(): HandlerResult {
  return {
    status: 503,
    body: errorBody(
      "POLICY_STORE_NOT_CONFIGURED",
      "no policy store on this instance (DATABASE_URL unset) — preflight/create need a durable policy source",
    ),
  };
}

function scoreStoreUnconfigured(): HandlerResult {
  return {
    status: 503,
    body: errorBody(
      "SCORE_STORE_NOT_CONFIGURED",
      "no score store on this instance (DATABASE_URL unset) — score_vendor/score_buyer need the shared Postgres",
    ),
  };
}

function reportStoreUnconfigured(): HandlerResult {
  return {
    status: 503,
    body: errorBody(
      "REPORT_STORE_NOT_CONFIGURED",
      "no report store on this instance (DATABASE_URL unset) — generate_dispute_packet/reconcile_agent_spend need the shared Postgres receipt/ledger/escalation history",
    ),
  };
}

function send(res: Response, result: HandlerResult): void {
  res.status(result.status).json(result.body);
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  const config = loadSellerConfig();
  Promise.all([
    initReceiptWiring(),
    initPolicyWiring(),
    initEscalationWiring(),
    initScoreWiring(),
    initReportWiring(),
  ])
    .then(
      ([receiptWiring, policyWiring, escalationWiring, scoreWiring, reportWiring]: [
        ReceiptWiring | null,
        PolicyWiring | null,
        EscalationWiring | null,
        ScoreWiring | null,
        ReportWiring | null,
      ]) => {
        createSellerApp(config, receiptWiring, policyWiring, escalationWiring, scoreWiring, reportWiring).listen(config.port, () => {
          console.log(`[asp] listening on http://localhost:${config.port}`);
          console.log(`[asp]   GET  ${PING_ROUTE}          ${PING_PRICE}   (proof-of-rail health check)`);
          console.log(`[asp]   POST ${CREATE_INTENT_ROUTE}  bundled (canon hash + real-policy binding)`);
          console.log(`[asp]   POST ${PREFLIGHT_ROUTE}    ${PREFLIGHT_PRICE}   (real §7.1 preflight vs a real stored policy)`);
          console.log(`[asp]   POST ${VERIFY_ROUTE}     ${VERIFY_PRICE}   (real §13/§7.3 T0 delivery verification)`);
          console.log(`[asp]   POST ${SCORE_VENDOR_ROUTE} / ${SCORE_BUYER_ROUTE}  ${SCORE_PRICE}   (real §12 Bureau scoring, LCB)`);
          console.log(`[asp]   POST ${DISPUTE_ROUTE} ${DISPUTE_PRICE}   (dispute packet: assemble+hash+AuditAnchored)`);
          console.log(`[asp]   POST ${RECONCILE_ROUTE} ${RECONCILE_PRICE}   (reconcile spend/waste: assemble+hash+AuditAnchored)`);
          console.log(`[asp]   POST ${CREATE_POLICY_ROUTE} (unsigned build) → ${SYNC_POLICY_ROUTE} (caller signs; owner synced from chain)`);
          console.log(`[asp]   POST ${UPDATE_POLICY_ROUTE} / ${PAUSE_POLICY_ROUTE} / ${RESUME_POLICY_ROUTE}  (operator-signed, on-chain)`);
          console.log(`[asp]   GET  ${RECEIPT_STATUS_ROUTE}   (receipt status poll, §7.4)`);
          console.log(`[asp]   GET  ${ESCALATION_STATUS_ROUTE}  (escalation status poll, §7.2)`);
          console.log(`[asp]   GET  ${CATALOG_ROUTE}  free  ·  GET ${CAFE_MENU_ROUTE} free  ·  POST ${CAFE_LATTE_ROUTE} ${CAFE_LATTE_PRICE}`);
          console.log(`[asp]   POST ${SUGGEST_NAMES_ROUTE} ${SUGGEST_NAMES_PRICE}  ·  free builder: check_domains / rank_options / seo_tips`);
          console.log(`[asp] network ${NETWORK} · payTo ${config.payTo}`);
        });
      },
    )
    .catch((err) => {
      console.error(`[asp] failed to init wiring: ${(err as Error).message}`);
      process.exit(1);
    });
}
