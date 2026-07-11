import {
  createPool,
  runMigrations,
  PgScoreDataSource,
  ViemWalletProfileProvider,
  type ScoreDataSource,
  type WalletProfileProvider,
} from "@untch/trust-bureau";
import { CHAIN } from "./config";

/**
 * Optional §12 Bureau wiring for the seller. When DATABASE_URL is present (the Railway production
 * deploy), score_vendor/score_buyer read the shared Postgres receipt/escalation history and persist
 * score_snapshots. When it is absent (local dev, unit tests), this stays null and the routes 503 — an
 * honest "no score store configured", never a fabricated score.
 *
 * The wallet_operational_profile feature queries X Layer MAINNET (the chain payout recipients live on)
 * via a public RPC — read-only, no key. If XLAYER_RPC_URL is unset the chain's default RPC is used.
 * The seller never holds the writer key: on-chain SCORE ANCHORING is a separate epoch job / the
 * prove-score-anchor script, not a per-call seller action.
 */
export interface ScoreWiring {
  readonly dataSource: ScoreDataSource;
  readonly walletProvider: WalletProfileProvider;
  close(): Promise<void>;
}

export async function initScoreWiring(): Promise<ScoreWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log("[asp] Bureau NOT wired (DATABASE_URL unset) — score_vendor/score_buyer will 503.");
    return null;
  }

  const pool = createPool(databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`[asp] trust-bureau migrations applied: ${applied.join(", ")}`);

  const rpcUrl =
    process.env.XLAYER_RPC_URL?.trim() || (CHAIN.rpcUrls.default.http[0] as string);
  const walletProvider = new ViemWalletProfileProvider({ chain: CHAIN, rpcUrl });

  console.log("[asp] Bureau wired — score_vendor/score_buyer will compute real §12 scores.");
  return {
    dataSource: new PgScoreDataSource(pool),
    walletProvider,
    async close() {
      await pool.end();
    },
  };
}
