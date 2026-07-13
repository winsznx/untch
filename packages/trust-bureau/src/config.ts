import { resolveReceiptsContract } from "@untch/receipt-writer";
import { activeChain, activeRpcUrl } from "@untch/shared";
import type { Address, Chain, Hex } from "viem";

/**
 * Bureau config. Two shapes, mirroring receipt-writer's split:
 *   • the SELLER reads/writes score_snapshots + reads receipts/escalations — it needs DATABASE_URL and
 *     (for the vendor wallet feature) an RPC URL, but NEVER the writer key.
 *   • the ANCHOR job (prove-score-anchor / an epoch cron) additionally needs the WRITER key + the
 *     UntchReceipts address to submit anchorScore.
 *
 * The anchoring target is the SAME deployed UntchReceipts (§10.3) on X Layer testnet the receipt writer
 * already anchors to, with the SAME authorized writer key — scores and receipts share one contract.
 */
export const SCORE_ANCHOR_CHAIN: Chain = activeChain(process.env);
export const SCORE_RECEIPTS_CONTRACT: Address = resolveReceiptsContract(SCORE_ANCHOR_CHAIN.id);
export const DEFAULT_RPC_URL = activeRpcUrl(process.env);

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

export interface AnchorConfig {
  readonly databaseUrl: string;
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly receiptsContract: Address;
  readonly writerPrivateKey: Hex;
}

/** Config for the anchor job / proof. Needs DATABASE_URL + WRITER_PRIVATE_KEY; RPC + contract default. */
export function loadAnchorConfig(): AnchorConfig {
  const key = requireEnv("WRITER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("WRITER_PRIVATE_KEY is not a 0x 32-byte key");
  const chain = activeChain(process.env);
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    rpcUrl: activeRpcUrl(process.env),
    chain,
    receiptsContract: resolveReceiptsContract(chain.id, process.env.RECEIPTS_CONTRACT),
    writerPrivateKey: key as Hex,
  };
}
