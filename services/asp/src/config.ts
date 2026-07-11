import { defineChain, type Address, type Chain } from "viem";

/**
 * D0.1 network decision — recorded here so it is visible at the point of use:
 *
 *   Network = X Layer MAINNET (eip155:196), NOT testnet (eip155:1952).
 *
 * Why not testnet: the OKX x402 facilitator + a settleable stablecoin only exist on mainnet
 * here — packages/shared/src/chains.ts (D0.3) records NO confirmed testnet USDT/USDG, and
 * @okxweb3/x402-evm documents only eip155:196 (default stablecoin USDT0, EIP-3009). So mainnet
 * at the documented $0.01 floor is the only real rail.
 *
 * The X Layer chain + USDT0 constants below are inlined (not imported from @untch/shared) so
 * this service deploys standalone to a cloud host. Values are the D0.3-verified ones — source
 * of truth remains packages/shared/src/chains.ts; keep them in sync if that file changes.
 */
export const NETWORK = "eip155:196" as const;
export const PING_ROUTE = "/ping_untch" as const;
export const PING_PRICE = "$0.01" as const;

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

/** §7.4 receipt status poll (unpriced) — GET /receipt_status/:receiptId. */
export const RECEIPT_STATUS_ROUTE = "/receipt_status/:receiptId" as const;

/** §7.2 escalation status poll (unpriced) — GET /escalation_status/:pollRef. What the guard's poll()
 *  resolves against: returns the getState() state + the escalation record's final fields. */
export const ESCALATION_STATUS_ROUTE = "/escalation_status/:pollRef" as const;

/**
 * Operator-facing policy tools (§11 create/update/pause_policy). These sign real PolicyRegistry
 * (§10.1) txs with the operator wallet. §11 prices them (0.50 / 0.10), but pricing is deliberately
 * DEFERRED with the dashboard wallet-connect flow (§15): in this interim build they are UNPRICED admin
 * routes signed by the demo/burner operator wallet — a TEMPORARY stand-in for the operator's own
 * connected wallet (see README → "Operator signing"). They are not buyer x402 calls.
 */
export const CREATE_POLICY_ROUTE = "/create_spend_policy" as const;
export const UPDATE_POLICY_ROUTE = "/update_policy" as const;
export const PAUSE_POLICY_ROUTE = "/pause_policy" as const;
export const RESUME_POLICY_ROUTE = "/resume_policy" as const;

export const DEFAULT_PORT = 4021;

export const CHAIN: Chain = defineChain({
  id: 196,
  name: "X Layer Mainnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer" } },
  testnet: false,
});

/** USDT0 on X Layer mainnet — the default EIP-3009 settlement token (D0.3-verified). */
export const SETTLEMENT_TOKEN = {
  symbol: "USD₮0",
  address: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736" as Address,
  decimals: 6,
} as const;

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
    sellerUrl: process.env.SELLER_URL ?? `http://localhost:${resolvePort()}`,
  };
}
