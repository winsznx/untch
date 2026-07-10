import { defineChain, type Address, type Chain, type Hex } from "viem";

/**
 * Receipt-writer configuration. Two consumer shapes:
 *   • the SELLER only enqueues — it needs Postgres + Redis, never the writer key or the RPC.
 *   • the WORKER anchors — it needs all of the above PLUS the writer private key + the X Layer RPC.
 *
 * So config is split: `EnqueueConfig` (seller-safe) and `WorkerConfig` (writer, holds the key).
 */

export const X_LAYER_TESTNET_ID = 1952 as const;
export const X_LAYER_MAINNET_ID = 196 as const;

/** Deployed UntchReceipts (§10.3) on X Layer testnet — the anchoring target. */
export const RECEIPTS_CONTRACT_DEFAULT: Address =
  "0x0c64997277b7d94d2999dea22a123cac56334863";

export const xLayerTestnet: Chain = defineChain({
  id: X_LAYER_TESTNET_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech", "https://xlayertestrpc.okx.com"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer-testnet" } },
  testnet: true,
});

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
  const rpcUrl = process.env.RPC_URL?.trim() || xLayerTestnet.rpcUrls.default.http[0]!;
  const writerPrivateKey = requireEnv("WRITER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(writerPrivateKey)) {
    throw new Error("WRITER_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }
  const receiptsContract = (process.env.RECEIPTS_CONTRACT?.trim() ||
    RECEIPTS_CONTRACT_DEFAULT) as Address;

  return {
    ...loadStorageConfig(),
    rpcUrl,
    chain: xLayerTestnet,
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
