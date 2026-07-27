/**
 * Consumer Pack configuration.
 *
 * The split mirrors receipt-writer's and policy-store's: a READ side that needs only DATABASE_URL,
 * and a SETTLEMENT side that additionally needs a signing key. Nothing here reads a key eagerly —
 * `loadRailKeys()` is called by the treasury router at construction and by nothing else, so a key
 * cannot leak into a config object that a handler happens to have in scope.
 *
 * The honest-null rule from the ASP applies throughout: an absent key is not a fallback into a mock,
 * it is a rail that is not available, reported as such.
 */

import { BASE_MAINNET, SOLANA_MAINNET, TEMPO_MAINNET, X_LAYER_MAINNET, type CaipChainId } from "./assets";

export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(`Missing required environment variable: ${varName}`);
    this.name = "MissingEnvError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new MissingEnvError(name);
  return v.trim();
}

function optEnv(name: string): string | null {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? null : v.trim();
}

export interface StorageConfig {
  readonly databaseUrl: string;
}

export function loadStorageConfig(): StorageConfig {
  return { databaseUrl: requireEnv("DATABASE_URL") };
}

/** The public base URL the funding request points a payer at. */
export function loadPublicBaseUrl(): string {
  return optEnv("ASP_PUBLIC_URL") ?? "https://asp.untch.xyz";
}

export interface RailKey {
  readonly chain: CaipChainId;
  readonly kind: "evm" | "solana";
  /** The secret itself. Held ONLY inside a rail client; never logged, never serialized. */
  readonly secret: string;
}

/**
 * The settlement signing keys, one per rail, all optional. A rail without a key is simply not
 * available — `TreasuryRouter` reports `TREASURY_INSUFFICIENT`/unavailable rather than degrading.
 */
export interface RailKeys {
  readonly base: RailKey | null;
  readonly solana: RailKey | null;
  readonly tempo: RailKey | null;
}

export function loadRailKeys(env: NodeJS.ProcessEnv = process.env): RailKeys {
  const base = env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  const solana = env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim();
  const tempo = env.CONSUMER_TREASURY_TEMPO_PRIVATE_KEY?.trim();

  if (base && !/^0x[0-9a-fA-F]{64}$/.test(base)) {
    throw new Error("CONSUMER_TREASURY_BASE_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }
  if (tempo && !/^0x[0-9a-fA-F]{64}$/.test(tempo)) {
    throw new Error("CONSUMER_TREASURY_TEMPO_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }

  return {
    base: base ? { chain: BASE_MAINNET, kind: "evm", secret: base } : null,
    solana: solana ? { chain: SOLANA_MAINNET, kind: "solana", secret: solana } : null,
    tempo: tempo ? { chain: TEMPO_MAINNET, kind: "evm", secret: tempo } : null,
  };
}

/** The SIWX identity key. Signs authentication only — it never holds or moves funds. */
export function loadSiwxKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const k = env.CONSUMER_SIWX_PRIVATE_KEY?.trim();
  if (!k) return null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error("CONSUMER_SIWX_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }
  return k;
}

export interface ExecutionPolicyConfig {
  /**
   * Whether a `sandbox` provider may execute. FALSE by default and in production. Setting it is a
   * deliberate, loudly-logged act, and every intent executed under it is stamped so a receipt can
   * never imply the provider was verified.
   */
  readonly allowSandboxExecution: boolean;
  /** Hard ceiling on any single consumer execution, as a decimal display string in the funding asset. */
  readonly maxSingleExecutionDisplay: string;
  /** Quote TTL in seconds. */
  readonly quoteTtlSec: number;
  /** How long a funding request stays payable. */
  readonly fundingTtlSec: number;
  /** Per-provider request timeout for discovery/quote. */
  readonly providerTimeoutMs: number;
  /** Per-provider request timeout for execution (a purchase is allowed to be slower). */
  readonly executeTimeoutMs: number;
  /** Consecutive failures before a provider's circuit opens. */
  readonly breakerThreshold: number;
  readonly breakerCooldownMs: number;
}

export function loadExecutionPolicy(env: NodeJS.ProcessEnv = process.env): ExecutionPolicyConfig {
  const num = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      throw new Error(`${name} must be a positive number, got ${JSON.stringify(raw)}`);
    }
    return n;
  };
  return {
    allowSandboxExecution: env.CONSUMER_ALLOW_SANDBOX_EXECUTION === "1",
    maxSingleExecutionDisplay: env.CONSUMER_MAX_SINGLE_EXECUTION?.trim() || "50.00",
    quoteTtlSec: num("CONSUMER_QUOTE_TTL_SEC", 600),
    fundingTtlSec: num("CONSUMER_FUNDING_TTL_SEC", 1800),
    providerTimeoutMs: num("CONSUMER_PROVIDER_TIMEOUT_MS", 2500),
    executeTimeoutMs: num("CONSUMER_EXECUTE_TIMEOUT_MS", 20000),
    breakerThreshold: num("CONSUMER_BREAKER_THRESHOLD", 5),
    breakerCooldownMs: num("CONSUMER_BREAKER_COOLDOWN_MS", 60000),
  };
}

/** RPC endpoints per settlement rail. Absent ⇒ that rail cannot be read or written. */
export interface RailRpcConfig {
  readonly base: string | null;
  readonly solana: string | null;
  readonly tempo: string | null;
  readonly xLayer: string | null;
}

export function loadRailRpc(env: NodeJS.ProcessEnv = process.env): RailRpcConfig {
  return {
    base: env.CONSUMER_BASE_RPC_URL?.trim() || "https://mainnet.base.org",
    solana: env.CONSUMER_SOLANA_RPC_URL?.trim() || null,
    tempo: env.CONSUMER_TEMPO_RPC_URL?.trim() || null,
    xLayer: env.RPC_URL?.trim() || null,
  };
}

export const FUNDING_CHAIN: CaipChainId = X_LAYER_MAINNET;

/**
 * The fee schedule, in basis points of the provider cost, per action family. Deliberately data:
 * a fee that lives in a conditional somewhere is a fee nobody can audit.
 */
export const FEE_BPS: Readonly<Record<string, number>> = Object.freeze({
  "shop.purchase": 200,
  "domains.register": 150,
  "domains.renew": 150,
  "travel.book": 200,
  "gifts.order": 200,
});

/** The disclosed cross-rail spread, in basis points. Covers price movement between the two legs. */
export const SPREAD_BPS = 50;

export function feeBpsFor(action: string): number {
  return FEE_BPS[action] ?? 0;
}
