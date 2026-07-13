import { RECEIPTS_CONTRACT_DEFAULT, xLayerTestnet } from "@untch/receipt-writer";
import type { Address, Chain, Hex } from "viem";

/**
 * Reports config. Two shapes, mirroring receipt-writer / trust-bureau:
 *   • the SELLER reads receipts/ledger/escalations to assemble a report — it needs DATABASE_URL but
 *     NEVER the writer key (default posture: the seller does not hold the writer key).
 *   • the ANCHOR path (the prove scripts, or an optionally-wired per-call anchorer) additionally needs
 *     the WRITER key + the UntchReceipts address to submit `anchorAudit`.
 *
 * The anchoring target is the SAME deployed UntchReceipts (§10.3) on X Layer testnet the receipt writer
 * and score anchorer already use, with the SAME authorized writer key — receipts, scores, and audit
 * reports share one contract and one anchor event family.
 */
export const AUDIT_ANCHOR_CHAIN: Chain = xLayerTestnet;
export const AUDIT_RECEIPTS_CONTRACT: Address = RECEIPTS_CONTRACT_DEFAULT;
export const DEFAULT_RPC_URL = "https://testrpc.xlayer.tech";

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
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly receiptsContract: Address;
  readonly writerPrivateKey: Hex;
}

/** Config for the anchor path / proofs. Needs WRITER_PRIVATE_KEY; RPC + contract default to testnet. */
export function loadAnchorConfig(): AnchorConfig {
  const key = requireEnv("WRITER_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("WRITER_PRIVATE_KEY is not a 0x 32-byte key");
  return {
    rpcUrl: process.env.RPC_URL?.trim() || DEFAULT_RPC_URL,
    chain: AUDIT_ANCHOR_CHAIN,
    receiptsContract:
      (process.env.RECEIPTS_CONTRACT?.trim() as Address | undefined) ?? AUDIT_RECEIPTS_CONTRACT,
    writerPrivateKey: key as Hex,
  };
}
