import {
  createPool,
  loadOperatorConfig,
  PgPolicyRepo,
  PolicyProvider,
  PolicyService,
  runMigrations,
  ViemPolicyRegistry,
} from "@untch/policy-store";

/**
 * Policy-store wiring for the seller (PRD §6.2 / §8 / §10.1). Split by capability:
 *
 *   • READ path (`provider`) — present whenever DATABASE_URL is set. preflight_payment +
 *     create_spend_intent load real stored policies through it. No key, no chain.
 *   • WRITE path (`service`) — present only when OPERATOR_PRIVATE_KEY is ALSO set. The
 *     create/update/pause_policy tools sign real PolicyRegistry txs through it. When the key is
 *     absent, `service` is null and those tools return 503 (this instance can read policies but not
 *     mutate them) — an honest capability boundary, never a fabricated signer.
 *
 * The operator key is the interim demo/burner wallet 0x98F43e… (see README → "Operator signing"): a
 * TEMPORARY stand-in for the operator's own dashboard-connected wallet. Only an instance that runs the
 * mutation tools ever holds it; the read path never does.
 *
 * Uses the SAME Railway Postgres the receipt writer provisioned (no second instance) — its migration
 * (002_policies.sql) lands in the shared, forward-only migration history.
 */
export interface PolicyWiring {
  readonly provider: PolicyProvider;
  readonly service: PolicyService | null;
  close(): Promise<void>;
}

export async function initPolicyWiring(): Promise<PolicyWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    console.log(
      "[asp] policy store NOT wired (DATABASE_URL unset) — preflight/create have no policy source.",
    );
    return null;
  }

  const pool = createPool(databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`[asp] policy-store migrations applied: ${applied.join(", ")}`);

  const repo = new PgPolicyRepo(pool);
  const provider = new PolicyProvider(repo);

  let service: PolicyService | null = null;
  if (process.env.OPERATOR_PRIVATE_KEY?.trim()) {
    const cfg = loadOperatorConfig();
    const chain = new ViemPolicyRegistry({
      chain: cfg.chain,
      rpcUrl: cfg.rpcUrl,
      registry: cfg.registry,
      operatorPrivateKey: cfg.operatorPrivateKey,
    });
    service = new PolicyService(repo, chain);
    console.log(
      `[asp] policy store wired — operator ${chain.ownerAddress} (INTERIM demo wallet) signs registry txs at ${cfg.registry}.`,
    );
  } else {
    console.log(
      "[asp] policy store wired READ-ONLY (OPERATOR_PRIVATE_KEY unset) — create/update/pause_policy return 503.",
    );
  }

  return {
    provider,
    service,
    async close() {
      await pool.end();
    },
  };
}
