import type { Hex } from "viem";
import type { ReceiptsRepo } from "./repo";
import type { ReceiptStatusView } from "./types";

/**
 * Query one receipt's current status by receiptId — a minimal slice of the eventual §11 `get_ledger`
 * tool (one receipt's lifecycle, not the whole ledger). Reads straight from Postgres, so it reflects
 * the durable source of truth regardless of chain state.
 */
export function getReceiptStatus(
  repo: ReceiptsRepo,
  receiptId: Hex,
): Promise<ReceiptStatusView | null> {
  return repo.statusOf(receiptId);
}

const RECEIPT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

export function isReceiptId(value: string): value is Hex {
  return RECEIPT_ID_RE.test(value);
}
