import {
  activeChain,
  activeRpcUrl,
  CONTRACTS_BY_CHAIN,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
} from "@untch/shared";
import type { Address, Chain, Hex } from "viem";

/**
 * Receipt-writer configuration. Two consumer shapes:
 *   • the SELLER only enqueues — it needs Postgres + Redis, never the writer key or the RPC.
 *   • the WORKER anchors — it needs all of the above PLUS the writer private key + the X Layer RPC.
 *
 * So config is split: `EnqueueConfig` (seller-safe) and `WorkerConfig` (writer, holds the key).
 *
 * The chain + RPC are resolved through the single shared source (packages/shared/src/chains.ts) via
 * the CHAIN_ID/NETWORK env contract — no chain constants live here. Default network is testnet.
 */

export { X_LAYER_MAINNET_ID, X_LAYER_TESTNET_ID, xLayerMainnet, xLayerTestnet } from "@untch/shared";

/** Deployed UntchReceipts (§10.3) on X Layer testnet — the anchoring target on the default network. */
export const RECEIPTS_CONTRACT_DEFAULT: Address =
  CONTRACTS_BY_CHAIN[X_LAYER_TESTNET_ID]!.receipts;

/**
 * UntchReceipts address per network, sourced from the shared CONTRACTS_BY_CHAIN registry (chains.ts)
 * so there is one canonical address per net. Testnet + mainnet are both deployed; a run on any other
 * chain has no default and must pass RECEIPTS_CONTRACT explicitly — fails loudly rather than anchoring
 * to a stale-network address. NOTE: mainnet UntchReceipts is writer-dark until its 72h timelock elapses
 * (deploy Phase 2) — this address is correct now; writes only succeed post-Phase-2.
 */
export const RECEIPTS_CONTRACT_BY_CHAIN: Partial<Record<number, Address>> = {
  [X_LAYER_TESTNET_ID]: CONTRACTS_BY_CHAIN[X_LAYER_TESTNET_ID]!.receipts,
  [X_LAYER_MAINNET_ID]: CONTRACTS_BY_CHAIN[X_LAYER_MAINNET_ID]!.receipts,
};

export function resolveReceiptsContract(chainId: number, override?: string): Address {
  const addr = override?.trim() || RECEIPTS_CONTRACT_BY_CHAIN[chainId];
  if (!addr) {
    throw new Error(
      `No UntchReceipts address for chainId ${chainId} — deploy UntchReceipts to that network and set RECEIPTS_CONTRACT.`,
    );
  }
  return addr as Address;
}

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

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** Storage config shared by both roles. */
export interface StorageConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
}

export function loadStorageConfig(): StorageConfig {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
  };
}

/** Seller-side: enqueue only. No signing key, no RPC. */
export type EnqueueConfig = StorageConfig;

/** Batching + anchoring thresholds and the writer identity (worker only). */
export interface WorkerConfig extends StorageConfig {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly receiptsContract: Address;
  readonly writerPrivateKey: Hex;
  /** §7.4 "N receipts" trigger. */
  readonly batchMaxSize: number;
  /** §7.4 "T secs" trigger, in milliseconds. */
  readonly batchMaxWaitMs: number;
  /** §7.4 retry budget before DEGRADED_UNANCHORED ("RETRY ×5 backoff"). */
  readonly retryMax: number;
  /** base backoff in ms; attempt k waits ~ base * 2^(k-1). */
  readonly retryBackoffBaseMs: number;
  /** §7.4 "CONFIRMED (X Layer finality depth)" — confirmations before CONFIRMED. */
  readonly confirmDepth: number;
  /** how often the confirm/reorg watcher sweeps SUBMITTED batches, ms. */
  readonly reconcileIntervalMs: number;
}

export function loadWorkerConfig(): WorkerConfig {
  const chain = activeChain(process.env);
  const rpcUrl = activeRpcUrl(process.env);
  const writerPrivateKey = requireEnv("WRITER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(writerPrivateKey)) {
    throw new Error("WRITER_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }
  const receiptsContract = resolveReceiptsContract(chain.id, process.env.RECEIPTS_CONTRACT);

  return {
    ...loadStorageConfig(),
    rpcUrl,
    chain,
    receiptsContract,
    writerPrivateKey: writerPrivateKey as Hex,
    batchMaxSize: optInt("BATCH_MAX_SIZE", 25),
    batchMaxWaitMs: optInt("BATCH_MAX_WAIT_MS", 10_000),
    retryMax: optInt("RETRY_MAX", 5),
    retryBackoffBaseMs: optInt("RETRY_BACKOFF_BASE_MS", 500),
    confirmDepth: optInt("CONFIRM_DEPTH", 3),
    reconcileIntervalMs: optInt("RECONCILE_INTERVAL_MS", 5_000),
  };
}
