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


/**
 * Well-known DEVELOPMENT keys, rejected outright wherever a real key is expected.
 *
 * These are the default accounts every Anvil and Hardhat install ships with. They are published in
 * the tools' own documentation, they appear in this repository's local-fork scripts and tests, and
 * anyone in the world can spend from them. Shape validation cannot catch them — they are perfectly
 * well-formed 32-byte keys.
 *
 * The failure this prevents is mundane and therefore likely: someone copies a key out of a soak
 * script or a test fixture into a `.env` while debugging, and it survives into a deployment. Without
 * this check the treasury router would accept it and every settlement would sign with an address the
 * public controls.
 *
 * Rejected in EVERY environment, not just production. A "dev-only" escape hatch is exactly the flag
 * that gets set in production during an incident, and no legitimate local flow needs these keys to
 * pass through `loadRailKeys` — the local scripts import them directly.
 */
const WELL_KNOWN_DEV_KEYS: ReadonlySet<string> = new Set([
  // Anvil / Hardhat default account #0
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  // Anvil / Hardhat default account #1 — the one GitGuardian flags in this repository
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  // Anvil / Hardhat default account #2
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  // Anvil / Hardhat default account #3
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
  // Anvil / Hardhat default account #4
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
]);

/**
 * Validates a private key's shape AND that it is not a published development key.
 *
 * The error deliberately names the variable and says what to do, because the person who hits it is
 * mid-incident and should not have to work out why a syntactically valid key was refused.
 */
function assertUsableEvmKey(varName: string, value: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${varName} is not a valid 0x 32-byte private key`);
  }
  if (WELL_KNOWN_DEV_KEYS.has(value.toLowerCase())) {
    throw new Error(
      `${varName} is a PUBLISHED development key (an Anvil/Hardhat default account). ` +
        "Anyone can spend from it. Generate a fresh key; never promote one out of a test fixture or a soak script.",
    );
  }
}

/** Exported so a deployment check can assert the same rule without constructing a treasury router. */
export function isWellKnownDevKey(value: string): boolean {
  return WELL_KNOWN_DEV_KEYS.has(value.trim().toLowerCase());
}

export function loadRailKeys(env: NodeJS.ProcessEnv = process.env): RailKeys {
  const base = env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  const solana = env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim();
  const tempo = env.CONSUMER_TREASURY_TEMPO_PRIVATE_KEY?.trim();

  if (base) assertUsableEvmKey("CONSUMER_TREASURY_BASE_PRIVATE_KEY", base);
  if (tempo) assertUsableEvmKey("CONSUMER_TREASURY_TEMPO_PRIVATE_KEY", tempo);
  // Solana secrets are a different encoding entirely, so the EVM shape check does not apply. The
  // published-key check still would, but no Solana rail is executable in this build.

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
  assertUsableEvmKey("CONSUMER_SIWX_PRIVATE_KEY", k);
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
