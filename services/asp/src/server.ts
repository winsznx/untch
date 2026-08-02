import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { privateKeyToAccount } from "viem/accounts";
import { paymentMiddleware, x402ResourceServer } from "@okxweb3/x402-express";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import {
  BRAND_PACK_PRICE,
  BRAND_PACK_ROUTE,
  CAFE_LATTE_PRICE,
  CAFE_LATTE_ROUTE,
  CAFE_MENU_ROUTE,
  CATALOG_ROUTE,
  CHECK_DOMAINS_ROUTE,
  CREATE_INTENT_ROUTE,
  CREATE_POLICY_ROUTE,
  DETECT_DUP_PRICE,
  DETECT_DUP_ROUTE,
  DISPUTE_PRICE,
  DISPUTE_ROUTE,
  ESCALATION_STATUS_ROUTE,
  GET_LEDGER_ROUTE,
  loadSellerConfig,
  LOG_RECEIPT_ROUTE,
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
  REDACT_META_PRICE,
  REDACT_META_ROUTE,
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
  handleBrandPack,
  handleCafeMenu,
  handleCafeOrderLatte,
  handleCatalog,
  handleCheckDomains,
  handleRankOptions,
  handleSeoTips,
  handleSuggestNames,
} from "./consumer-handlers";
import {
  handleDetectDuplicate,
  handleGetLedger,
  handleLogReceipt,
  handleRedactPaymentMetadata,
} from "./s11-handlers";
import { initIntentRegistry } from "./intent-registry";
import { initOracleSigner } from "./oracle-signer";
import {
  handleCreateSpendIntent,
  handlePreflightPayment,
  handleVerifyDelivery,
  type HandlerResult,
  type PreflightDeps,
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
import type { PolicyProvider } from "@untch/policy-store";
import { initEscalationWiring, type EscalationWiring } from "./escalation-wiring";
import { initScoreWiring, type ScoreWiring } from "./score-wiring";
import { initReportWiring, type ReportWiring } from "./report-wiring";
import { assertIdentityRegistry } from "./erc8004/assert-identity";
import { buildRegistrationCard } from "./erc8004/registration-card";
import {
  AGENT_REGISTRATION_PATH,
  DEFAULT_WELL_KNOWN_PATH,
} from "./erc8004/constants";
import { consumerPricedRoutes, registerConsumerRoutes } from "./consumer/routes";
import { PgNonceStore, describeAuthMode, loadConsumerAuthConfig, makeSiweVerifier } from "./consumer/auth";
import { makeAccountRoutesDeps, registerAccountRoutes } from "./consumer/account-routes";
import { registerAgenticLinkRoutes } from "./consumer/agentic-link-routes";
import { registerPolicyRoutes } from "./consumer/policy-routes";
import { makeApprovalRoutesDeps, registerApprovalRoutes } from "./consumer/approval-routes";
import { registerMarketplaceRoutes } from "./consumer/marketplace-continuity";
import { initConsumerWiring, startConsumerWorkers, type ConsumerWiring } from "./consumer/wiring";
import { makeConsumerEscalationGateway, makeConsumerReceiptSink } from "./consumer/bridges";
import { registerConsumerOperatorRoutes } from "./consumer/operator-routes";
import { registerConsumerSettlementRoutes } from "./consumer/operator-settlement-routes";
import { registerConsumerQuotePreviewRoute } from "./consumer/operator-quote-routes";
import { registerConsumerVerifyRoutes } from "./consumer/operator-verify-routes";
import { asset, loadConsumerFlags, loadSolanaProofGate, readSchemaState } from "@untch/consumer-core";
import { findOwnedService } from "@untch/owned-work";
import {
  handlePublicPreflight,
  looksPublic,
  type PublicPreflightDeps,
} from "./public-dto/preflight";
import { handlePublicVerify, looksPublicVerify, type PublicVerifyDeps } from "./public-dto/verify";
import { DeploymentLifecycle, describeDeployment } from "./deployment-info";
import { registerDeploymentRoutes, HEALTH_ROUTE, DEPLOYMENT_INFO_ROUTE } from "./deployment-routes";
import { challengeDescription, registerRegistryRoutes } from "./registry/routes";
import { SETTLEMENT_TOKEN } from "./config";
import { installUnhandledRejectionGuard, registerJsonErrorBoundary } from "./http-errors";

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
  consumerWiring: ConsumerWiring | null = null,
  /**
   * Present only when the process was booted through the real startup path.
   *
   * Null means "this app was constructed without a lifecycle", which is the case in the local buyer
   * driver and in tests. The health route then reports STARTING rather than pretending to be ready,
   * because a default of ready is the failure this whole mechanism exists to prevent.
   */
  lifecycle: DeploymentLifecycle | null = null,
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

  // Railway terminates TLS before forwarding to Express. Trust its forwarded
  // protocol so x402's resource.url stays HTTPS and matches the marketplace URL.
  app.set("trust proxy", 1);

  /**
   * Readiness and deployment identity, registered BEFORE the payment gate.
   *
   * Ordering is the point. Registered after `paymentMiddleware` these would be reachable only by a
   * paying caller, and a platform health probe cannot pay. A health check that 402s reads as an
   * unhealthy container, which would make every deployment fail for the wrong reason.
   */
  registerDeploymentRoutes(app, lifecycle);

  /**
   * The contract, published before the paywall.
   *
   * These sit here for the same reason the health routes do: registered after `paymentMiddleware`
   * they would be reachable only by a paying caller. The failure being corrected is that the 402 body
   * was `{}`, so the only way to learn what a tool took was to pay for a refusal — a discovery
   * document behind that same paywall would reproduce the problem with extra steps.
   */
  const publicBaseUrl = process.env.ASP_PUBLIC_URL?.trim() || "https://asp.untch.xyz";
  registerRegistryRoutes(app, {
    baseUrl: publicBaseUrl,
    network: NETWORK,
    payTo: config.payTo,
    asset: {
      symbol: SETTLEMENT_TOKEN.symbol,
      address: SETTLEMENT_TOKEN.address,
      decimals: SETTLEMENT_TOKEN.decimals,
    },
  });

  // Payment gate FIRST: an unpaid request to a priced route 402s here without touching the body.
  app.use(
    paymentMiddleware(
      {
        [`GET ${PING_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PING_PRICE },
          description: challengeDescription("ping_untch", publicBaseUrl),
          mimeType: "application/json",
        },
        // Some marketplace validators probe a listed endpoint with GET/HEAD even when
        // the service is invoked with POST. Keep those probes paid and explicit rather
        // than letting Express turn them into an unhelpful 404.
        [`HEAD ${PING_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PING_PRICE },
          description: challengeDescription("ping_untch", publicBaseUrl),
          mimeType: "application/json",
        },
        [`GET ${PREFLIGHT_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PREFLIGHT_PRICE },
          description: challengeDescription("preflight_payment", publicBaseUrl),
          mimeType: "application/json",
        },
        [`HEAD ${PREFLIGHT_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PREFLIGHT_PRICE },
          description: challengeDescription("preflight_payment", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${PREFLIGHT_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: PREFLIGHT_PRICE },
          description: challengeDescription("preflight_payment", publicBaseUrl),
          mimeType: "application/json",
        },
        [`GET ${VERIFY_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: VERIFY_PRICE },
          description: challengeDescription("verify_delivery", publicBaseUrl),
          mimeType: "application/json",
        },
        [`HEAD ${VERIFY_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: VERIFY_PRICE },
          description: challengeDescription("verify_delivery", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${VERIFY_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: VERIFY_PRICE },
          description: challengeDescription("verify_delivery", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${SCORE_VENDOR_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SCORE_PRICE },
          description: challengeDescription("score_vendor", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${SCORE_BUYER_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SCORE_PRICE },
          description: challengeDescription("score_buyer", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${DISPUTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: DISPUTE_PRICE },
          description: challengeDescription("generate_dispute_packet", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${RECONCILE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: RECONCILE_PRICE },
          description: challengeDescription("reconcile_agent_spend", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${CAFE_LATTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: CAFE_LATTE_PRICE },
          description: challengeDescription("cafe_order_latte", publicBaseUrl),
          mimeType: "application/json",
        },
        [`GET ${CAFE_LATTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: CAFE_LATTE_PRICE },
          description: challengeDescription("cafe_order_latte", publicBaseUrl),
          mimeType: "application/json",
        },
        [`HEAD ${CAFE_LATTE_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: CAFE_LATTE_PRICE },
          description: challengeDescription("cafe_order_latte", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${SUGGEST_NAMES_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: SUGGEST_NAMES_PRICE },
          description: challengeDescription("suggest_names", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${BRAND_PACK_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: BRAND_PACK_PRICE },
          description: challengeDescription("brand_pack", publicBaseUrl),
          mimeType: "application/json",
        },
        [`GET ${BRAND_PACK_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: BRAND_PACK_PRICE },
          description: challengeDescription("brand_pack", publicBaseUrl),
          mimeType: "application/json",
        },
        [`HEAD ${BRAND_PACK_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: BRAND_PACK_PRICE },
          description: challengeDescription("brand_pack", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${DETECT_DUP_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: DETECT_DUP_PRICE },
          description: challengeDescription("detect_duplicate", publicBaseUrl),
          mimeType: "application/json",
        },
        [`POST ${REDACT_META_ROUTE}`]: {
          accepts: { scheme: "exact", network: NETWORK, payTo: config.payTo, price: REDACT_META_PRICE },
          description: challengeDescription("redact_payment_metadata", publicBaseUrl),
          mimeType: "application/json",
        },
        // ── Consumer Pack ──────────────────────────────────────────────────
        // Fixed prices are the ORCHESTRATION fee. The variable purchase value is a separate leg:
        // POST /consumer/fund/:intentId carries a DynamicPrice function that resolves each intent's
        // own exact authorised amount at request time.
        ...consumerPricedRoutes({
          network: NETWORK,
          payTo: config.payTo,
          fundingPrice: consumerWiring?.fundingPrice ?? null,
        }),
      },
      resourceServer,
    ),
  );

  const intentRegistry = initIntentRegistry();
  const oracleSigner = initOracleSigner();
  if (intentRegistry) {
    console.log(`[asp] SpendIntentRegistry wired at ${intentRegistry.registry} (chain ${intentRegistry.chainId})`);
  } else {
    console.log("[asp] SpendIntentRegistry NOT wired (set INTENT_WRITER_PRIVATE_KEY) — onchain stays honest unwired");
  }
  if (oracleSigner) {
    console.log("[asp] Mode C oracle signer wired (ORACLE_PRIVATE_KEY) — pass vaultAddress on preflight for sig");
  }

  // Body parsing AFTER the gate: only paid/unpriced requests that reach a handler get parsed.
  app.use(express.json({ limit: "64kb" }));

  /**
   * Assigned further down, once the account store exists; read by the preflight route above, which
   * only runs per request. Declared here so the route can close over one binding rather than the
   * account wiring having to be hoisted above every other registration to satisfy an ordering nobody
   * would otherwise care about.
   */
  let publicPreflightDeps: PublicPreflightDeps | null = null;
  let publicVerifyDeps: PublicVerifyDeps | null = null;

  /** The settlement asset this deployment actually confirms. Refuses at import when it is unconfirmed. */
  const settlementAsset = asset("xlayer.usdt0");

  // HEAD is accepted only as a paid compatibility probe. It must never execute a
  // business operation or settle a payment, so a verified HEAD remains 405.
  for (const route of [PING_ROUTE, PREFLIGHT_ROUTE, VERIFY_ROUTE, CAFE_LATTE_ROUTE, BRAND_PACK_ROUTE]) {
    app.head(route, (_req, res) => res.status(405).end());
  }

  // GET is accepted as a paid compatibility probe on the four POST-only business
  // routes (marketplace validators that GET-probe a listed endpoint). Same rule as
  // HEAD: a verified GET here must never execute a business operation, since query
  // parameters are not an acceptable transport for SpendIntent/policy/delivery
  // payloads (proxy + access logs). Real calls stay POST-only.
  for (const route of [PREFLIGHT_ROUTE, VERIFY_ROUTE, CAFE_LATTE_ROUTE, BRAND_PACK_ROUTE]) {
    app.get(route, (_req, res) => res.status(405).json(errorBody("USE_POST", "this endpoint is POST-only; GET is accepted only as a paid compatibility probe")));
  }

  app.get(PING_ROUTE, (_req, res) => {
    res.json({ ok: true, tool: "ping_untch", ts: new Date().toISOString() });
  });

  // ── ERC-8004 registration card (unpriced; required for marketplace card render) ──
  const serveRegistrationCard = (_req: Request, res: Response) => {
    const card = buildRegistrationCard({
      payTo: config.payTo,
      baseUrl: process.env.ASP_PUBLIC_URL?.trim() || "https://asp.untch.xyz",
    });
    res.setHeader("cache-control", "public, max-age=60");
    res.setHeader("access-control-allow-origin", "*");
    res.type("application/json").status(200).json(card);
  };
  app.get(AGENT_REGISTRATION_PATH, serveRegistrationCard);
  app.get(DEFAULT_WELL_KNOWN_PATH, serveRegistrationCard);

  // ── Consumer catalog + lifestyle + Launch Pack ─────────────────────────────
  app.get(CATALOG_ROUTE, (_req, res) => send(res, handleCatalog()));
  app.get(CAFE_MENU_ROUTE, (_req, res) => send(res, handleCafeMenu()));
  app.post(CAFE_LATTE_ROUTE, (req, res) => send(res, handleCafeOrderLatte(req.body)));
  app.post(SUGGEST_NAMES_ROUTE, (req, res, next) => {
    handleSuggestNames(req.body).then((r) => send(res, r)).catch(next);
  });
  app.post(BRAND_PACK_ROUTE, (req, res, next) => {
    handleBrandPack(req.body).then((r) => send(res, r)).catch(next);
  });
  app.post(CHECK_DOMAINS_ROUTE, (req, res, next) => {
    handleCheckDomains(req.body).then((r) => send(res, r)).catch(next);
  });
  app.post(RANK_OPTIONS_ROUTE, (req, res) => send(res, handleRankOptions(req.body)));
  app.post(SEO_TIPS_ROUTE, (req, res) => send(res, handleSeoTips(req.body)));

  // §11 tools (priced in middleware where applicable; free get_ledger / log_receipt)
  app.post(DETECT_DUP_ROUTE, (req, res) => send(res, handleDetectDuplicate(req.body, ledgerState.ledger)));
  app.post(REDACT_META_ROUTE, (req, res) => send(res, handleRedactPaymentMetadata(req.body)));
  app.post(GET_LEDGER_ROUTE, (req, res) => send(res, handleGetLedger(req.body, ledgerState.ledger)));
  app.post(LOG_RECEIPT_ROUTE, (req, res, next) => {
    handleLogReceipt(req.body, receiptWiring).then((r) => send(res, r)).catch(next);
  });

  app.post(CREATE_INTENT_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    handleCreateSpendIntent(req.body, {
      intentStore: ledgerState.intentStore,
      policyProvider: policyWiring.provider,
      intentRegistry,
    })
      .then((result) => send(res, result))
      .catch(next);
  });

  /**
   * One route, two request shapes, one engine.
   *
   * The PUBLIC shape — provider, capability, task, maxSpend, currency, deadline — is what the
   * registered contract has published for two passes, and until now nothing served it. It is tried
   * first, and only when the account plumbing it needs is actually wired: a deployment without a
   * session secret or an account store cannot honestly resolve an account, and answering a public
   * request by falling through to the protocol path would refuse it for the wrong reason (a missing
   * `owner` field) instead of the right one.
   *
   * The PROTOCOL shape stays exactly as it was, for `create_spend_intent` callers who already hold a
   * struct. The shapes are disjoint, so nothing has to choose between them.
   */
  const preflightEngineDeps = (provider: PolicyProvider): PreflightDeps => ({
    policyProvider: provider,
    ledger: ledgerState.ledger,
    intentStore: ledgerState.intentStore,
    ...(receiptWiring ? { receiptEnqueuer: receiptWiring.enqueuer } : {}),
    ...(escalationWiring ? { escalationGateway: escalationWiring.gateway } : {}),
    intentRegistry,
    oracleSigner,
    scoreDataSource: scoreWiring?.dataSource ?? null,
  });

  app.post(PREFLIGHT_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    const engineDeps = preflightEngineDeps(policyWiring.provider);
    if (publicPreflightDeps && looksPublic(req.body)) {
      handlePublicPreflight(req.body, req.header("authorization"), publicPreflightDeps, engineDeps)
        .then((result) => send(res, result))
        .catch(next);
      return;
    }
    handlePreflightPayment(req.body, engineDeps)
      .then((result) => send(res, result))
      .catch(next);
  });

  app.post(VERIFY_ROUTE, (req, res, next) => {
    if (!policyWiring) return send(res, policyStoreUnconfigured());
    if (publicVerifyDeps && looksPublicVerify(req.body)) {
      handlePublicVerify(req.body, req.header("authorization"), publicVerifyDeps)
        .then((result) => send(res, result))
        .catch(next);
      return;
    }
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

  // ── Consumer Pack routes (governed consumer execution) ─────────────────────
  // Registered AFTER express.json so handlers see a parsed body, and after every existing route so
  // nothing already serving changes shape. A null wiring answers 503 with a named reason.
  /**
   * Ownership proof for tenant-scoped consumer reads.
   *
   * It needs three things that only exist here: a secret to sign sessions with, the policy store to
   * check who actually owns a policy, and the Consumer Pack's own pool so nonces live in the
   * database migration 009 created. Any of them missing means sessions cannot be minted, and the
   * auth routes say so with a 503 instead of pretending.
   */
  const consumerAuthConfig = loadConsumerAuthConfig();
  const consumerAuth =
    consumerAuthConfig.secret && consumerWiring && policyWiring
      ? {
          config: consumerAuthConfig,
          nonces: new PgNonceStore(consumerWiring.pool),
          verifier: makeSiweVerifier(process.env.XLAYER_RPC_URL?.trim() || "https://rpc.xlayer.tech"),
          policyProvider: policyWiring.provider,
        }
      : null;
  console.log(describeAuthMode(consumerAuthConfig));

  registerConsumerRoutes(
    app,
    consumerWiring,
    // The public receipt page reports the real anchor state. Without a receipt writer it degrades to
    // "not recorded" rather than claiming a pending anchor that will never arrive.
    receiptWiring ? (receiptId) => receiptWiring.status(receiptId) : null,
    consumerAuth,
  );

  /**
   * The ACCOUNT surface — a wallet proving who it is, without naming a policy.
   *
   * Registered beside the policy-scoped auth routes rather than inside them because it answers a
   * different question. `/consumer/auth/*` asks "may this signer read THIS policy" and needs the policy
   * store to answer. This asks "who is this signer", which needs no policy to exist at all — and that
   * is the whole point: a user with no policy yet is exactly the user who needs to sign in so they can
   * create one.
   */
  const accountRoutesDeps =
    consumerAuthConfig.secret && consumerWiring
      ? makeAccountRoutesDeps({
          pool: consumerWiring.pool,
          verifier: makeSiweVerifier(process.env.XLAYER_RPC_URL?.trim() || "https://rpc.xlayer.tech"),
          domain: consumerAuthConfig.domain,
          publicBaseUrl: consumerWiring.publicBaseUrl,
          secret: consumerAuthConfig.secret,
        })
      : null;
  registerAccountRoutes(app, send, accountRoutesDeps);

  /**
   * The PRIMARY wallet path: OKX Onchain OS Agentic Wallet, linked through an agent rather than a
   * browser provider. Registered beside the browser routes rather than replacing them, because a user
   * who deliberately wants an extension wallet to own their policies may still have one — it is just
   * no longer the default, and it can no longer present itself as the agentic wallet.
   */
  registerAgenticLinkRoutes(
    app,
    send,
    accountRoutesDeps && consumerWiring && consumerAuthConfig.secret
      ? {
          accounts: accountRoutesDeps.accounts,
          links: accountRoutesDeps.links,
          verifier: accountRoutesDeps.verifier,
          domain: consumerAuthConfig.domain,
          publicBaseUrl: consumerWiring.publicBaseUrl,
          webBaseUrl: process.env.UNTCH_WEB_BASE_URL?.trim() || "https://untch-web-production.up.railway.app",
          secret: consumerAuthConfig.secret,
        }
      : null,
  );

  /**
   * What the public preflight route needs to derive an account's authority.
   *
   * Declared here, after the account store exists, and read by a route registered earlier — safe
   * because the route body runs per request, long after this line. Null when the account store or the
   * session secret is missing, and the route then falls through to the protocol shape rather than
   * pretending it resolved an account it could not read.
   *
   * `network` is the settlement asset this deployment actually confirms, not a symbol from a config
   * string. A request naming any other currency is refused by name rather than judged against a token
   * nobody verified.
   */
  publicPreflightDeps =
    accountRoutesDeps && policyWiring && consumerAuthConfig.secret
      ? {
          accounts: accountRoutesDeps.accounts,
          policies: policyWiring.provider,
          ownedService: (provider: string, capability: string) => findOwnedService(provider, capability),
          network: {
            token: settlementAsset.address as `0x${string}`,
            symbol: settlementAsset.symbol,
            decimals: settlementAsset.decimals,
          },
          sessionSecret: consumerAuthConfig.secret,
          executionEnabled: loadConsumerFlags().executionEnabled,
        }
      : null;

  /**
   * What the public verify route needs. It reads the CONSUMER store rather than the policy store,
   * because a verification is about an execution and a settlement, not about a ruleset.
   */
  publicVerifyDeps =
    accountRoutesDeps && consumerWiring && consumerAuthConfig.secret
      ? {
          store: consumerWiring.store,
          accounts: accountRoutesDeps.accounts,
          sessionSecret: consumerAuthConfig.secret,
          executionEnabled: loadConsumerFlags().executionEnabled,
        }
      : null;

  /**
   * The public policy journey — draft here, register from your own wallet, sync back.
   *
   * It needs both wirings: the account store to know whose wallet is asking, and the policy store to
   * canonicalise, hash and read the confirmed registration. Either missing means the journey answers
   * a named 503 rather than a route that half-works.
   */
  registerPolicyRoutes(
    app,
    send,
    accountRoutesDeps && policyWiring && consumerWiring && consumerAuthConfig.secret
      ? {
          accounts: accountRoutesDeps.accounts,
          registration: policyWiring.registration,
          policies: policyWiring.provider,
          secret: consumerAuthConfig.secret,
        }
      : null,
  );

  /**
   * The web approval centre.
   *
   * `executionEnabled` is passed in rather than read at render time, and it decides what an APPROVED
   * request is CALLED. With providers disabled the surface says APPROVED_AWAITING_EXECUTION and states
   * that nothing was paid — the difference between an honest demo and a claim that a purchase happened.
   */
  registerApprovalRoutes(
    app,
    send,
    accountRoutesDeps && consumerWiring && consumerAuthConfig.secret
      ? makeApprovalRoutesDeps({
          pool: consumerWiring.pool,
          accounts: accountRoutesDeps.accounts,
          secret: consumerAuthConfig.secret,
          // Read from the FLAGS, which is where `CONSUMER_EXECUTION_ENABLED` actually lives.
          // `wiring.config` is the execution POLICY (caps, rails, providers) and carries no such
          // field — the root tsconfig cannot see this file, and the ASP's own tsconfig caught it.
          executionEnabled: loadConsumerFlags().executionEnabled,
        })
      : null,
  );

  /**
   * Marketplace continuity.
   *
   * An agent id arriving from OKX is a claim in a request. This route turns "we do not know you" into
   * a link the same person can complete with the wallet that actually carries authority — rather than
   * trusting the claim, or refusing with no way forward.
   */
  registerMarketplaceRoutes(
    app,
    send,
    accountRoutesDeps
      ? {
          accounts: accountRoutesDeps.accounts,
          links: accountRoutesDeps.links,
          publicBaseUrl: accountRoutesDeps.publicBaseUrl,
          allowedReturnOrigins: accountRoutesDeps.allowedReturnOrigins,
        }
      : null,
  );

  /**
   * The authenticated operator control surface.
   *
   * Registered here rather than beside `/internal/deployment-info` because it needs `express.json()`
   * to have run and it needs the Consumer Pack wiring, both of which only exist at this point. It is
   * the same credential as deployment-info — one operator token, one comparison, in
   * `src/internal-auth.ts` — and it deliberately sits OUTSIDE the x402 priced-route table: an
   * operator control route is not a product, and pricing it would mean an outage in the facilitator
   * could stop an operator from inspecting production.
   */
  registerConsumerOperatorRoutes(app, {
    wiring: consumerWiring,
    policyProvider: policyWiring?.provider ?? null,
    lifecycle,
    flags: loadConsumerFlags(),
  });

  /**
   * Registering a settlement float, separately from being able to spend from it.
   *
   * Same credential and same posture as the intent routes above. It is a distinct surface because the
   * two acts are distinct: an intent route decides what production would DO, and this one records what
   * production settles FROM. Collapsing them would put a durable treasury write behind a route whose
   * whole documented promise is that preflight writes nothing.
   */
  registerConsumerSettlementRoutes(app, { wiring: consumerWiring, lifecycle });

  /**
   * The keyless live quote probe.
   *
   * Same credential, same posture. It sits beside the intent routes because it answers the question they
   * cannot answer without creating something: would this exact request price correctly against the live
   * provider. Learning that from a real intent costs an intent id and a terminal state, which is what the
   * first bounded production proof paid.
   */
  registerConsumerQuotePreviewRoute(app, { wiring: consumerWiring });

  /**
   * Re-running delivery verification over evidence production already holds.
   *
   * Same credential and posture. It exists because a receipt is a historical claim: the first bounded
   * Purch proof recorded `untchVerified: false` truthfully, and the honest way to correct that later is
   * to append a dated verification rather than edit the row. It writes no settlement and cannot pay.
   */
  registerConsumerVerifyRoutes(app, { wiring: consumerWiring });

  /**
   * The JSON error boundary, registered LAST and deliberately so.
   *
   * Everything above answers in the §11 envelope. Below this line Express used to answer for the
   * requests nobody wrote a route for — with HTML, and with a stack trace attached whenever NODE_ENV
   * is not "production", which on this deployment it is not. `GET /consumer/auth/nonce` is the case
   * that made it concrete: an advertised path, the wrong verb, and an HTML page where the catalog
   * promised a contract.
   *
   * It replaces the malformed-JSON handler that used to sit here, which is now one branch inside it.
   */
  registerJsonErrorBoundary(app);

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

/**
 * The Base treasury's PUBLIC address, for the deployment attestation.
 *
 * Derivation is one-way, so this publishes nothing the chain does not already show. It is worth
 * reporting because "which treasury is this deployment actually holding" is a question the incident
 * made concrete, and an operator comparing an expected address against a serving one should not have to
 * infer it from a balance.
 *
 * Any failure returns null. A malformed key is a real condition to surface elsewhere, and it must not
 * take down startup from inside a reporting helper.
 */
function baseTreasuryAddress(): string | null {
  const key = process.env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  if (!key) return null;
  try {
    return privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    return null;
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1]);
if (isMain) {
  /**
   * Installed before anything can reject. A rejection during wiring would otherwise terminate the
   * process before the lifecycle below has a chance to record why.
   */
  installUnhandledRejectionGuard();

  const config = loadSellerConfig();

  /**
   * The lifecycle is created FIRST, before any wiring can throw.
   *
   * Everything after this point can fail, and when it does the health route has to be able to say so.
   * Constructing this later would leave a window where the process is up, the port may be bound, and
   * nothing can report that the startup sequence never finished.
   */
  const lifecycle = new DeploymentLifecycle(process.env);

  Promise.all([
    initReceiptWiring(),
    initPolicyWiring(),
    initEscalationWiring(),
    initScoreWiring(),
    initReportWiring(),
  ])
    .then(
      async ([receiptWiring, policyWiring, escalationWiring, scoreWiring, reportWiring]: [
        ReceiptWiring | null,
        PolicyWiring | null,
        EscalationWiring | null,
        ScoreWiring | null,
        ReportWiring | null,
      ]) => {
        // The Consumer Pack composes the wirings above rather than duplicating them: it borrows the
        // real policy provider, the real §7.1 ledger window, the real §7.2 approval pipeline and the
        // real §7.4 receipt writer. It is null when DATABASE_URL is unset, and every consumer route
        // then answers 503 with a named reason.
        const ledgerState2 = createLedgerState();
        const consumerWiring = policyWiring
          ? await initConsumerWiring({
              policyProvider: policyWiring.provider,
              ledger: ledgerState2.ledger,
              escalation: makeConsumerEscalationGateway(
                escalationWiring,
                escalationWiring ? escalationWiring.gateway : null,
              ),
              receipts: makeConsumerReceiptSink(receiptWiring),
            })
          : null;
        if (consumerWiring) {
          startConsumerWorkers(consumerWiring, { log: (line) => console.log(line) });
        } else {
          console.log("[asp] Consumer Pack NOT wired (needs DATABASE_URL + a policy store) — /consumer/* returns 503");
        }

        /**
         * What the database ACTUALLY has, read rather than assumed.
         *
         * The gate code being compiled in says nothing about whether migration 011 ran. Those two facts
         * diverged during the incident this reporting exists for: the code that knew about the gate never
         * started, so the schema it needed was never created, while the operator had already granted the
         * authority the gate was supposed to bound. Reporting them as separate fields keeps them from
         * being conflated again.
         */
        lifecycle.recordGateCode(typeof loadSolanaProofGate === "function");
        if (consumerWiring) {
          lifecycle.recordRails(consumerWiring.availableRails);
          try {
            const schema = await readSchemaState(consumerWiring.pool);
            lifecycle.recordSchema(
              schema.migrationVersion,
              schema.proofGateTablePresent && schema.proofGateLiveIndexPresent,
            );
          } catch (err) {
            // A schema probe that cannot run is a readiness failure, not a warning. Serving with an
            // unknown schema is exactly the state that must not be armed.
            lifecycle.markFailed(`schema probe failed: ${(err as Error).message}`);
            console.error(`[asp] schema probe failed: ${(err as Error).message}`);
          }
        }
        lifecycle.recordBaseTreasury(baseTreasuryAddress());

        createSellerApp(config, receiptWiring, policyWiring, escalationWiring, scoreWiring, reportWiring, consumerWiring, lifecycle).listen(config.port, () => {
          // A boot line in the container's own stdout, addressed to whoever is reading the logs.
          // production-surface-allow: localhost — it is not served to any caller.
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
          console.log(`[asp]   POST ${BRAND_PACK_ROUTE} ${BRAND_PACK_PRICE}  ·  POST ${SUGGEST_NAMES_ROUTE} ${SUGGEST_NAMES_PRICE}`);
          console.log(`[asp]   free builder: check_domains (RDAP) / rank_options / seo_tips`);
          console.log(`[asp]   GET  ${AGENT_REGISTRATION_PATH}  ·  GET ${DEFAULT_WELL_KNOWN_PATH}  (ERC-8004 card)`);
          if (consumerWiring) {
            console.log(`[asp]   Consumer Pack: GET /consumer/catalog free · shop/domains/travel/gifts/notify`);
            console.log(`[asp]     variable purchase value funds at POST /consumer/fund/:intentId (x402 DynamicPrice)`);
            console.log(
              `[asp]     settlement rails: ${consumerWiring.availableRails.length > 0 ? consumerWiring.availableRails.join(", ") : "NONE (discovery + quoting only)"}`,
            );
          }
          console.log(`[asp]   GET  ${HEALTH_ROUTE}  (readiness, unauthenticated — the platform health gate)`);
          console.log(`[asp]   GET  ${DEPLOYMENT_INFO_ROUTE}  (operator token required)`);
          console.log(`[asp] network ${NETWORK} · payTo ${config.payTo}`);

          /**
           * Readiness is declared HERE, and nowhere earlier.
           *
           * By this line the wirings resolved, the workers started, the schema was probed and the port is
           * bound. Marking ready any sooner would let the platform route traffic to a process that had
           * not finished one of those, which is the difference between "the container is up" and "the
           * deployment is serving".
           *
           * A failed schema probe has already moved the lifecycle to FAILED, and markReady refuses to
           * overwrite that, so this cannot paper over a startup failure.
           */
          lifecycle.markReady();
          console.log(`\n${describeDeployment(lifecycle.snapshot())}\n`);
        });
        // Non-blocking integrity probe — logs only; never blocks serving the card.
        assertIdentityRegistry()
          .then((r) => {
            if (r.ok) {
              console.log(`[asp] ERC-8004 Identity OK ${r.address} name=${r.name} symbol=${r.symbol}`);
            } else {
              console.warn(`[asp] ERC-8004 Identity assert failed: ${r.error}`);
            }
          })
          .catch((e) => console.warn(`[asp] ERC-8004 Identity probe error: ${(e as Error).message}`));
      },
    )
    .catch((err) => {
      /**
       * Recorded before exiting, so the reason survives in the logs next to the deployment identity
       * rather than only as a bare stack trace. The process still exits non-zero: a service that cannot
       * wire itself must not stay up answering health checks, and Railway's ON_FAILURE restart policy
       * is the right response to it.
       */
      lifecycle.markFailed(`wiring init failed: ${(err as Error).message}`);
      console.error(`[asp] failed to init wiring: ${(err as Error).message}`);
      console.error(`\n${describeDeployment(lifecycle.snapshot())}\n`);
      process.exit(1);
    });
}
