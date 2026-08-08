import { activeChain, settlementToken, X_LAYER_MAINNET_ID } from "@untch/shared";
import type { Chain } from "viem";

/**
 * D0.1 network decision — recorded here so it is visible at the point of use:
 *
 *   Default network = X Layer MAINNET (eip155:196), NOT testnet (eip155:1952).
 *
 * Why mainnet by default: the OKX x402 facilitator + a settleable stablecoin only exist on mainnet
 * here — packages/shared/src/chains.ts (D0.3) records NO confirmed testnet USDT/USDG, and
 * @okxweb3/x402-evm documents only eip155:196 (default stablecoin USDT0, EIP-3009). So mainnet
 * at the documented $0.01 floor is the only real rail.
 *
 * The chain + settlement token are resolved from the SINGLE shared source (packages/shared/src/chains.ts)
 * via the CHAIN_ID/NETWORK env contract — nothing is inlined. The seller falls back to mainnet when
 * neither var is set; setting CHAIN_ID/NETWORK switches every derived value with no code change.
 */
export const CHAIN: Chain = activeChain(process.env, X_LAYER_MAINNET_ID);
export const NETWORK = `eip155:${CHAIN.id}` as const;

/** The default x402 settlement token for the active network (mainnet ⇒ USDT0, D0.3-verified). */
export const SETTLEMENT_TOKEN = settlementToken(CHAIN.id);

/**
 * The health ping. FREE, and no longer a marketplace service.
 *
 * It used to cost $0.01, which is the whole objection: a health check is not a deliverable, and
 * charging for one bills a buyer to prove that x402 works rather than to receive anything. It stays
 * mounted and stays useful — an agent should be able to ask whether this service is up before it
 * decides to spend — it simply no longer has a price or a listing entry.
 */
export const PING_ROUTE = "/ping_untch" as const;

/** Step-2 tools (§11). `create_spend_intent` is bundled/unpriced; `preflight_payment` is the
 *  priced tool ($0.05, §11), settled the same way as `ping_untch` — real USDT0 via the OKX x402
 *  facilitator. Both are POST + JSON body; the buyer wrapper resends the body across the 402. */
export const CREATE_INTENT_ROUTE = "/create_spend_intent" as const;
export const PREFLIGHT_ROUTE = "/preflight_payment" as const;
export const PREFLIGHT_PRICE = "$0.05" as const;

/** §11 verify_delivery — priced $0.10, settled the same way as preflight (real USDT0 via the OKX x402
 *  facilitator). Runs the real §13/§7.3 T0 Proof Engine and writes a real VERIFY receipt. */
export const VERIFY_ROUTE = "/verify_delivery" as const;
export const VERIFY_PRICE = "$0.10" as const;

/** §11 Untch Bureau tools — priced $0.20 each, settled the same way as preflight/verify (real USDT0 via
 *  the OKX x402 facilitator). Deterministic §12 weighted scoring with LCB enforcement; no LLM (I1). */
export const SCORE_VENDOR_ROUTE = "/score_vendor" as const;
export const SCORE_BUYER_ROUTE = "/score_buyer" as const;
export const SCORE_PRICE = "$0.20" as const;

/** §11 report tools — deterministic aggregation over durable receipt/ledger/escalation history, hashed
 *  and anchored via UntchReceipts.anchorAudit (§10.3 AuditAnchored). No LLM (I1).
 *  • generate_dispute_packet — $0.50 (§11), per intentRef.
 *  • reconcile_agent_spend   — §11 lists $0.25/day · $1.00/wk. The x402 middleware prices one static
 *    value per route, so this build charges the $0.25 base rate for BOTH day and week reports; the
 *    day/week differentiated (discounted-week) pricing is DEFERRED with the dashboard wallet-connect
 *    flow, the SAME honest posture the policy tools already take (see "Reconcile pricing" in README).
 *    The tool still produces day OR week reports correctly — only the differentiated price is deferred. */
export const DISPUTE_ROUTE = "/generate_dispute_packet" as const;
export const DISPUTE_PRICE = "$0.50" as const;
export const RECONCILE_ROUTE = "/reconcile_agent_spend" as const;
export const RECONCILE_PRICE = "$0.25" as const;

/** Consumer / lifestyle / builder tools (multi-service ASP surface). */
export const CATALOG_ROUTE = "/catalog" as const;
export const CAFE_MENU_ROUTE = "/cafe/menu" as const;
/**
 * The cafe demo. FREE, and explicitly a simulation.
 *
 * It used to cost $0.04 and it does not buy anyone a coffee: no merchant is contacted, no order is
 * placed, nothing is delivered. Charging for it made a demonstration look like a purchase, which is
 * the one thing a marketplace listing must never do. It stays as a free, clearly-labelled
 * demonstration of the intent shape and drops out of the listing.
 */
export const CAFE_LATTE_ROUTE = "/cafe/order/latte" as const;
export const SUGGEST_NAMES_ROUTE = "/builder/suggest_names" as const;
export const SUGGEST_NAMES_PRICE = "$0.01" as const;
export const BRAND_PACK_ROUTE = "/builder/brand_pack" as const;
export const BRAND_PACK_PRICE = "$0.05" as const;
export const CHECK_DOMAINS_ROUTE = "/builder/check_domains" as const;
export const RANK_OPTIONS_ROUTE = "/builder/rank_options" as const;
export const SEO_TIPS_ROUTE = "/builder/seo_tips" as const;

/** §11 remaining tools. */
export const DETECT_DUP_ROUTE = "/detect_duplicate" as const;
export const DETECT_DUP_PRICE = "$0.02" as const;
export const REDACT_META_ROUTE = "/redact_payment_metadata" as const;
export const REDACT_META_PRICE = "$0.02" as const;
export const GET_LEDGER_ROUTE = "/get_ledger" as const;
export const LOG_RECEIPT_ROUTE = "/log_receipt" as const;

/** §7.4 receipt status poll (unpriced) — GET /receipt_status/:receiptId. */
export const RECEIPT_STATUS_ROUTE = "/receipt_status/:receiptId" as const;

/** §7.2 escalation status poll (unpriced) — GET /escalation_status/:pollRef. What the guard's poll()
 *  resolves against: returns the getState() state + the escalation record's final fields. */
export const ESCALATION_STATUS_ROUTE = "/escalation_status/:pollRef" as const;
/**
 * Declared here rather than in `approval-routes.ts`, which imports Express.
 *
 * The Worker needs the path to refuse it by name, and importing the constant from its Express home
 * pulled `iconv-lite` into the bundle, whose module-scope `require_streams(...)` is not a function
 * under workerd. The deploy failed with exactly that while `--dry-run` passed, which is why the deploy
 * script checks the live Worker rather than the upload's exit code.
 */
export const APPROVAL_DECIDE_ROUTE = "/consumer/approvals/:approvalRequestId/decide" as const;

/**
 * Operator-facing policy tools (§11 create/update/pause_policy). These sign real PolicyRegistry
 * (§10.1) txs with the operator wallet. §11 prices them (0.50 / 0.10), but pricing is deliberately
 * DEFERRED with the dashboard wallet-connect flow (§15): in this interim build they are UNPRICED admin
 * routes signed by the demo/burner operator wallet — a TEMPORARY stand-in for the operator's own
 * connected wallet (see README → "Operator signing"). They are not buyer x402 calls.
 */
export const CREATE_POLICY_ROUTE = "/create_spend_policy" as const;
/** Second half of the per-caller create flow: record the durable row from the caller's confirmed tx. */
export const SYNC_POLICY_ROUTE = "/sync_policy_registration" as const;
export const UPDATE_POLICY_ROUTE = "/update_policy" as const;
export const PAUSE_POLICY_ROUTE = "/pause_policy" as const;
export const RESUME_POLICY_ROUTE = "/resume_policy" as const;

export const DEFAULT_PORT = 4021;

/** All consumer priced routes for payment middleware registration. */
export const CONSUMER_PRICED_ROUTES = {
  suggestNames: { methodPath: `POST ${SUGGEST_NAMES_ROUTE}` as const, price: SUGGEST_NAMES_PRICE },
  brandPack: { methodPath: `POST ${BRAND_PACK_ROUTE}` as const, price: BRAND_PACK_PRICE },
} as const;

/**
 * The route the local buyer drivers and the guard proofs pay, now that the ping is free.
 *
 * They need SOMETHING priced to exercise a real 402 → sign → replay → settle round trip, and until
 * now that was `ping_untch` at $0.01. `redact_payment_metadata` is the honest successor: it is the
 * cheapest route that still charges, it has no predecessors a driver would have to construct, and
 * unlike a health check it returns a real artifact for the money.
 */
export const PROOF_OF_RAIL_ROUTE = REDACT_META_ROUTE;
export const PROOF_OF_RAIL_PRICE = REDACT_META_PRICE;
/** The same price in USDT0 base units (6dp), for drivers that build an authorization by hand. */
export const PROOF_OF_RAIL_PRICE_ATOMIC = "20000" as const;

export type SellerConfig = {
  okxApiKey: string;
  okxSecretKey: string;
  okxPassphrase: string;
  payTo: `0x${string}`;
  port: number;
};

export type BuyerConfig = {
  buyerPrivateKey: `0x${string}`;
  sellerUrl: string;
};

/** Thrown when a required env var is absent — callers turn this into a STOP/BLOCKED exit. */
export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(`Missing required environment variable: ${varName}`);
    this.name = "MissingEnvError";
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new MissingEnvError(name);
  }
  return value.trim();
}

function asAddress(value: string, varName: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${varName} is not a valid 0x EVM address: ${value}`);
  }
  return value as `0x${string}`;
}

function asPrivateKey(value: string, varName: string): `0x${string}` {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${varName} is not a valid 0x 32-byte private key`);
  }
  return value as `0x${string}`;
}

/** Railway injects PORT; fall back to ASP_PORT then the default. */
function resolvePort(): number {
  const raw = process.env.PORT ?? process.env.ASP_PORT;
  return raw ? Number(raw) : DEFAULT_PORT;
}

export function loadSellerConfig(): SellerConfig {
  return {
    okxApiKey: requireEnv("OKX_API_KEY"),
    okxSecretKey: requireEnv("OKX_SECRET_KEY"),
    okxPassphrase: requireEnv("OKX_PASSPHRASE"),
    payTo: asAddress(requireEnv("PAY_TO_ADDRESS"), "PAY_TO_ADDRESS"),
    port: resolvePort(),
  };
}

export function loadBuyerConfig(): BuyerConfig {
  return {
    buyerPrivateKey: asPrivateKey(requireEnv("BUYER_PRIVATE_KEY"), "BUYER_PRIVATE_KEY"),
    // loadBuyerConfig is called only by `pnpm pay` and the proof drivers; nothing the seller serves
    // reads it. production-surface-allow: localhost — the local buyer driver's own default target.
    sellerUrl: process.env.SELLER_URL ?? `http://localhost:${resolvePort()}`,
  };
}
