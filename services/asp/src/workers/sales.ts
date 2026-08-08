/**
 * The durable record of a settled marketplace sale.
 *
 * WHY THIS EXISTS
 *
 * An independent buyer paid for four standalone tools. Every one settled on X Layer, the seller balance
 * moved by exactly the sum of the fees, and this system recorded nothing. The reconciliation job, the
 * receipt trail and the revenue record all showed zero for money actually received — which for a
 * product whose claim is that every decision is receipted is the worst kind of gap.
 *
 * WHY IT DOES NOT WRITE `untch_x402_service_calls`
 *
 * That table's `account_id` is NOT NULL and references `untch_accounts`. It models a call belonging to
 * somebody's governed policy, which is right for the preflight/verify pipeline and wrong for a stranger
 * buying a name generator. The alternative — minting an account from the payment signature — would
 * treat an EIP-3009 authorization as an identity assertion, and this codebase draws that line
 * deliberately everywhere else.
 *
 * FAILING TO RECORD MUST NOT FAIL THE SALE
 *
 * The buyer has paid and the handler has produced their result. Throwing here would deny them the work
 * they just paid for in order to protect a bookkeeping row, which is the wrong trade — so a write
 * failure is logged loudly and swallowed. That is a deliberate asymmetry, not an oversight: money
 * moving without a record is bad, and money moving without the buyer getting their result is worse.
 */

import type { Pool } from "@untch/consumer-core";
import { SERVICES } from "../registry/services";

export interface SettledSale {
  readonly route: string;
  readonly payer: string;
  readonly payTo: string;
  readonly token: string;
  readonly network: string;
  readonly amountBaseUnits: string;
  readonly transactionHash: string | null;
  readonly facilitatorStatus: string | null;
  readonly responseStatus: number;
  readonly responseBytes: number;
  readonly authorizationNonce: string | null;
}

/** `sale_` plus 26 base32 characters, matching the id shape the rest of the schema uses. */
const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function newSaleId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = "";
  for (const b of bytes) out += BASE32[b % 32];
  return `sale_${out}`;
}

/** The registry's stable id for a path, so a later route rename does not orphan the history. */
const toolIdFor = (route: string): string | null =>
  SERVICES.find((s) => s.path === route)?.toolId ?? null;

export async function recordSale(
  pool: Pool,
  sale: SettledSale,
  log: (line: string) => void = console.error,
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO untch_marketplace_sales
         (sale_id, route, tool_id, payer, pay_to, token, network, amount_base_units,
          transaction_hash, facilitator_status, response_status, response_bytes, authorization_nonce)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (authorization_nonce) WHERE authorization_nonce IS NOT NULL DO NOTHING`,
      [
        newSaleId(),
        sale.route,
        toolIdFor(sale.route),
        // Lowercased so a checksummed and an unchecksummed address are one buyer, not two.
        sale.payer.toLowerCase(),
        sale.payTo.toLowerCase(),
        sale.token.toLowerCase(),
        sale.network,
        sale.amountBaseUnits,
        sale.transactionHash,
        sale.facilitatorStatus,
        sale.responseStatus,
        sale.responseBytes,
        sale.authorizationNonce,
      ],
    );
  } catch (err) {
    /**
     * Loud, because a silent accounting failure is exactly what produced the gap this table exists to
     * close. Everything needed to reconstruct the row by hand from the chain is in this line.
     */
    log(
      `[sales] FAILED TO RECORD A SETTLED SALE — ${(err as Error).message} — ` +
        JSON.stringify({
          route: sale.route,
          payer: sale.payer,
          amount: sale.amountBaseUnits,
          tx: sale.transactionHash,
          nonce: sale.authorizationNonce,
        }),
    );
  }
}
