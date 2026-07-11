import type { Address } from "viem";
import { getServerSession } from "../auth/server";

/**
 * Session scoping for the dashboard's seeded data.
 *
 * The dashboard's seeded rows (intents, decisions, receipts, ledger, escalations, vendor history) are the
 * history of ONE identity: the demo operator wallet that ran this build's real testnet cycles. There is no
 * per-address off-chain indexer, so a different connected wallet genuinely has no Untch history to show.
 *
 * `getScope` reads the signed-in session and answers exactly one question: is the caller the demo operator,
 * and therefore the owner of the seeded history? Every seeded screen uses this to show its real data to the
 * demo operator and an honest empty/zero state to any other wallet (or to a visitor who has not signed in),
 * instead of leaking the demo operator's data to whoever is connected.
 */

/** The one identity the seeded history belongs to (also the burner that deployed the testnet contracts). */
export const DEMO_OPERATOR_WALLET = "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b" as const;

export interface Scope {
  readonly address: Address | null;
  readonly authenticated: boolean;
  /** True only when the signed-in wallet is the demo operator that owns the seeded history. */
  readonly isDemoOperator: boolean;
}

export async function getScope(): Promise<Scope> {
  const session = await getServerSession();
  const address = session?.address ?? null;
  return {
    address,
    authenticated: session !== null,
    isDemoOperator: address !== null && address.toLowerCase() === DEMO_OPERATOR_WALLET.toLowerCase(),
  };
}
