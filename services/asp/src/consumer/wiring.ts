/**
 * Consumer Pack wiring.
 *
 * Follows the house pattern exactly: `initConsumerWiring()` returns `ConsumerWiring | null`, and
 * `null` means the capability is genuinely unconfigured — the routes then answer 503 with a NAMED
 * reason, exactly as the policy, score and report stores already do. There is no in-memory fallback
 * for a production path. A consumer purchase silently backed by a Map would be precisely the kind of
 * fake this repository refuses to ship.
 *
 * What degrades gracefully, and what does not:
 *   • No DATABASE_URL       ⇒ the whole pack is off (503). Nothing here is safe without durability.
 *   • No treasury key       ⇒ discovery and quoting still work; execution reports
 *                             TREASURY_INSUFFICIENT. Reading is useful on its own.
 *   • No escalation wiring  ⇒ an escalated intent WAITS. It is never auto-approved.
 *   • No SIWX key           ⇒ SIWX-gated providers report PROVIDER_UNAUTHORIZED.
 *   • No Redis              ⇒ the outbox is drained by the periodic sweep instead of a tick. Slower,
 *                             never lossy — the same posture receipt-writer takes.
 */

import {
  loadExecutionPolicy,
  loadPublicBaseUrl,
  loadRailKeys,
  loadRailRpc,
  loadSiwxKey,
  createPool,
  type Pool,
  flagOn,
  loadConsumerFlags,
  describeFlags,
  runMigrations,
  PgConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  chainProfile,
  parseMoney,
  BASE_MAINNET,
  SOLANA_MAINNET,
  TEMPO_MAINNET,
  type CaipChainId,
  type ConsumerStore,
  type ExecutionPolicyConfig,
  type RailClient,
} from "@untch/consumer-core";
import {
  MppTempoClient,
  PROVIDER_SEEDS,
  SiwxSigner,
  X402EvmExactClient,
  X402SolanaExactClient,
  assertSeedMatchesAdapters,
  buildAdapterRegistry,
  type AdapterRegistry,
} from "@untch/consumer-providers";
import type { Ledger } from "@untch/policy-engine";
import type { PolicyProvider } from "@untch/policy-store";
import { ConsumerOrchestrator, type ConsumerEscalationGateway, type ConsumerReceiptSink } from "./orchestrator";
import { OutboxDispatcher, SseHub } from "./dispatcher";
import { makeFundingPrice } from "./funding-price";
import { PgNonceStore } from "./auth";

export interface ConsumerWiring {
  readonly store: ConsumerStore;
  readonly registry: ProviderRegistry;
  readonly adapters: AdapterRegistry;
  readonly treasury: TreasuryRouter;
  readonly orchestrator: ConsumerOrchestrator;
  readonly dispatcher: OutboxDispatcher;
  readonly hub: SseHub;
  readonly fundingPrice: ReturnType<typeof makeFundingPrice>;
  readonly config: ExecutionPolicyConfig;
  readonly publicBaseUrl: string;
  /** Rails a key is configured for. Surfaced so the operator UI can say what is actually live. */
  readonly availableRails: readonly CaipChainId[];
  /**
   * The same pool the Consumer Pack migrates and reads through.
   *
   * Exposed so the SIWE nonce store shares it rather than opening a second one: nonces live in a
   * table created by THIS package's migrations, and a separate pool would mean a deployment could
   * have a nonce store pointing at a database where 009 had never run.
   */
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface ConsumerWiringInputs {
  readonly policyProvider: PolicyProvider;
  readonly ledger: Ledger;
  readonly escalation: ConsumerEscalationGateway | null;
  readonly receipts: ConsumerReceiptSink | null;
  readonly log?: (line: string, data?: unknown) => void;
}

export async function initConsumerWiring(
  inputs: ConsumerWiringInputs,
): Promise<ConsumerWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) return null;

  const log = inputs.log ?? ((line: string) => console.log(line));
  const config = loadExecutionPolicy();
  const publicBaseUrl = loadPublicBaseUrl();

  const pool = createPool(databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) log(`[consumer] applied migrations: ${applied.join(", ")}`);

  const store = new PgConsumerStore(pool);

  // ── seed the durable registry ────────────────────────────────────────────
  //
  // The seed INTRODUCES a provider; it does not re-assert its status on every boot.
  //
  // An unconditional upsert here was a live control failure in both directions. A provider promoted
  // to `verified` after a real observed settlement would be silently DEMOTED to the seed's `sandbox`
  // on the next deploy, disabling a working integration for no visible reason. Worse, a provider
  // deliberately set to `disabled` during an incident — the documented response to a compromised
  // merchant — would be silently RE-ENABLED by the next deploy, which is the control failing at
  // exactly the moment it matters.
  //
  // So: insert when absent, and afterwards only refresh the descriptive fields (base URL, chains,
  // provenance) that the seed genuinely owns. Maturity and `enabled` are OPERATIONAL state and stay
  // with the operator.
  for (const seed of PROVIDER_SEEDS) {
    const existing = await store.getProvider(seed.provider.providerId);
    if (!existing) {
      await store.upsertProvider(seed.provider);
    } else if (existing.baseUrl !== seed.provider.baseUrl) {
      // Only the BASE URL is refreshed from the seed. Maturity, `enabled` and `provenance` all stay
      // with the operator: `provenance` is where a promotion records its evidence (the settlement
      // transaction hash), and re-asserting the seed's generic text over it would erase the only
      // durable record of WHY a provider is verified.
      await store.upsertProvider({
        ...seed.provider,
        maturity: existing.maturity,
        enabled: existing.enabled,
        provenance: existing.provenance,
      });
      log(
        `[consumer] refreshed ${seed.provider.providerId} base URL; kept operator state ` +
          `(maturity=${existing.maturity}, enabled=${existing.enabled}) and its provenance`,
      );
    }

    // A capability is INTRODUCED once. Its maturity and notes then belong to the operator, for the
    // same reason: `notes` is where a promoted capability records its settlement evidence.
    const existingCaps = await store.listCapabilities(seed.provider.providerId);
    for (const cap of seed.capabilities) {
      if (!existingCaps.some((c) => c.capability === cap.capability)) {
        await store.upsertCapability(cap);
      }
    }
  }

  const adapters = buildAdapterRegistry();
  // Fails loudly at boot rather than at the first request: a capability advertised in the registry
  // with nothing behind it would be routable and then unfulfillable.
  assertSeedMatchesAdapters(adapters);

  // ── rails ─────────────────────────────────────────────────────────────────
  const keys = loadRailKeys();
  const rpc = loadRailRpc();
  const rails = new Map<CaipChainId, RailClient>();

  rails.set(
    BASE_MAINNET,
    new X402EvmExactClient({
      chain: BASE_MAINNET,
      evmChainId: chainProfile(BASE_MAINNET).evmChainId ?? 8453,
      privateKey: (keys.base?.secret ?? null) as `0x${string}` | null,
      rpcUrl: rpc.base,
    }),
  );
  rails.set(
    SOLANA_MAINNET,
    new X402SolanaExactClient({
      chain: SOLANA_MAINNET,
      secretKey: keys.solana?.secret ?? null,
      rpcUrl: rpc.solana,
      /**
       * A FOURTH switch, separate from the pack, the provider and the treasury account.
       *
       * Each of the other three answers a different question: is the Consumer Pack on, is this
       * merchant allowed, is this float armed. None of them answers "may this rail sign a Solana
       * transaction at all", and that question deserves its own answer because the artifact this
       * rail produces is submitted by a third party rather than by Untch.
       */
      executionEnabled: flagOn(process.env.CONSUMER_SOLANA_EXECUTION_ENABLED),
    }),
  );
  rails.set(TEMPO_MAINNET, new MppTempoClient({ chain: TEMPO_MAINNET }));

  const pauses = new StorePauseChecker(store);
  const treasury = new TreasuryRouter({
    store,
    rails,
    pauses,
    onLowBalance: (treasuryRef, observed, floor) => {
      log(
        `[consumer] LOW TREASURY BALANCE ${treasuryRef}: ${observed.amount} (floor ${floor.amount}) — ` +
          "replenish per docs/consumer-pack-runbook.md",
      );
    },
  });

  const flags = loadConsumerFlags();
  log(`[consumer] ${describeFlags(flags, PROVIDER_SEEDS.map((s) => s.provider.providerId))}`);
  if (!flags.packEnabled) {
    log("[consumer] CONSUMER_PACK_ENABLED is not set — every consumer route will refuse.");
  } else if (!flags.executionEnabled) {
    log("[consumer] CONSUMER_EXECUTION_ENABLED is not set — discovery and quoting only. This is the default.");
  }

  const availableRails = treasury.availableRails();
  if (availableRails.length === 0) {
    log(
      "[consumer] NO SETTLEMENT RAIL is configured (no CONSUMER_TREASURY_*_PRIVATE_KEY). Discovery " +
        "and quoting work; execution will report TREASURY_INSUFFICIENT. This is the honest degraded " +
        "mode, not a failure.",
    );
  } else {
    log(`[consumer] settlement rails available: ${availableRails.join(", ")}`);
  }

  // ── treasury accounts ─────────────────────────────────────────────────────
  // Registered from the rails that actually have a key, with their PUBLIC addresses only. Disabled
  // by default: an operator enables an account after funding it, which is the moment the float
  // becomes real.
  const baseRail = rails.get(BASE_MAINNET);
  if (baseRail?.available()) {
    // Same rule as the provider seed: introduce the account, then leave the operator's `enabled`
    // alone. Re-asserting it on every boot would let a redeploy silently re-arm a float that an
    // operator had deliberately disabled — the exact inverse of a kill switch.
    const usdc = asset("base.usdc");
    const existing = await store.getTreasuryAccount("base-usdc-settlement");
    await store.upsertTreasuryAccount({
      treasuryRef: "base-usdc-settlement",
      asset: usdc,
      purpose: "SETTLEMENT",
      address: baseRail.address(),
      minBalance: parseMoney(
        process.env.CONSUMER_TREASURY_BASE_MIN_BALANCE_USDC?.trim() ||
          process.env.CONSUMER_BASE_MIN_BALANCE?.trim() ||
          "5.00",
        usdc,
      ),
      dailyLimit: parseMoney(
        process.env.CONSUMER_TREASURY_BASE_DAILY_LIMIT_USDC?.trim() ||
          process.env.CONSUMER_BASE_DAILY_LIMIT?.trim() ||
          "500.00",
        usdc,
      ),
      enabled: existing
        ? existing.enabled
        : flagOn(process.env.CONSUMER_BASE_TREASURY_ENABLED) ||
          flagOn(process.env.CONSUMER_TREASURY_BASE_ENABLED),
    });
  }
  await store.upsertTreasuryAccount({
    treasuryRef: "xlayer-usdt0-funding",
    asset: asset("xlayer.usdt0"),
    purpose: "FUNDING",
    // The funding leg lands wherever the ASP's x402 payTo points; recorded for reconciliation only.
    address: process.env.PAY_TO_ADDRESS?.trim() ?? "0x0000000000000000000000000000000000000000",
    minBalance: parseMoney("0.00", asset("xlayer.usdt0")),
    dailyLimit: parseMoney("0.00", asset("xlayer.usdt0")),
    enabled: true,
  });

  const siwxKey = loadSiwxKey();
  const siwx = siwxKey === null ? null : new SiwxSigner({ privateKey: siwxKey as `0x${string}` });
  if (siwx === null) {
    log("[consumer] no CONSUMER_SIWX_PRIVATE_KEY — SIWX-gated provider endpoints will 403");
  }

  const registry = new ProviderRegistry({
    store,
    flags,
    gate: { executionFloor: "verified", allowSandboxExecution: config.allowSandboxExecution },
    onSandboxExecution: (providerId, capability) => {
      log(
        `[consumer] SANDBOX EXECUTION: ${providerId}.${capability} is executing under ` +
          "CONSUMER_ALLOW_SANDBOX_EXECUTION=1. This provider has NOT had a settlement verified.",
      );
    },
  });
  if (config.allowSandboxExecution) {
    log(
      "[consumer] CONSUMER_ALLOW_SANDBOX_EXECUTION=1 — sandbox providers may execute. Every such " +
        "intent is stamped, and no receipt will imply the provider was verified.",
    );
  }

  const hub = new SseHub();
  const orchestrator = new ConsumerOrchestrator({
    store,
    registry,
    adapters,
    treasury,
    policyProvider: inputs.policyProvider,
    ledger: inputs.ledger,
    escalation: inputs.escalation,
    receipts: inputs.receipts,
    config,
    publicBaseUrl,
    siwx,
    log,
  });

  const dispatcher = new OutboxDispatcher({ store, hub, log });
  const fundingPrice = makeFundingPrice({ store, log });

  return {
    store,
    registry,
    adapters,
    treasury,
    orchestrator,
    dispatcher,
    hub,
    fundingPrice,
    config,
    publicBaseUrl,
    availableRails,
    pool,
    async close(): Promise<void> {
      hub.closeAll();
      await pool.end();
    },
  };
}

/**
 * The background loops.
 *
 * Deliberately plain intervals rather than a BullMQ queue. The receipt writer's queue exists because
 * anchoring batches across processes needs coordination; these three are idempotent sweeps over
 * durable rows, and every one of them is safe to run concurrently on several instances — the CAS
 * transition and the unique constraints see to that. Adding a broker would buy nothing and add a
 * failure mode.
 */
export function startConsumerWorkers(
  wiring: ConsumerWiring,
  opts: {
    readonly dispatchIntervalMs?: number;
    readonly executeIntervalMs?: number;
    readonly sweepIntervalMs?: number;
    readonly nonceSweepIntervalMs?: number;
    readonly log?: (line: string, data?: unknown) => void;
  } = {},
): { stop(): void } {
  const log = opts.log ?? (() => {});
  const timers: NodeJS.Timeout[] = [];

  const every = (ms: number, name: string, fn: () => Promise<unknown>): void => {
    const t = setInterval(() => {
      fn().catch((err: unknown) => log(`[consumer] ${name} failed: ${(err as Error).message}`));
    }, ms);
    t.unref();
    timers.push(t);
  };

  every(opts.dispatchIntervalMs ?? 1000, "outbox dispatch", () => wiring.dispatcher.drain(200));

  every(opts.executeIntervalMs ?? 2000, "execution", async () => {
    const queued = await wiring.store.listIntents({ state: "EXECUTION_QUEUED", limit: 5 });
    for (const intent of queued) await wiring.orchestrator.executeIntent(intent.intentId);
    const acked = await wiring.store.listIntents({ state: "PROVIDER_ACKNOWLEDGED", limit: 5 });
    for (const intent of acked) await wiring.orchestrator.verifyAndComplete(intent.intentId);
    const delivering = await wiring.store.listIntents({ state: "DELIVERY_PENDING", limit: 5 });
    for (const intent of delivering) await wiring.orchestrator.verifyAndComplete(intent.intentId);
  });

  /**
   * Expired SIWE nonces.
   *
   * They are harmless once expired — the consume query already refuses them — so this is hygiene, not
   * a control. It runs on its own slow timer rather than inside the 30s sweep because a nonce table
   * that grows unboundedly is a disk problem, and coupling it to the money sweep would make a slow
   * DELETE able to delay expiry and ambiguity reconciliation.
   */
  every(opts.nonceSweepIntervalMs ?? 15 * 60_000, "nonce sweep", async () => {
    const removed = await new PgNonceStore(wiring.pool).sweep(Date.now());
    if (removed > 0) log(`[consumer] swept ${removed} expired auth nonces`);
  });

  every(opts.sweepIntervalMs ?? 30_000, "sweep", async () => {
    const expired = await wiring.orchestrator.expireStale(50);
    const reconciled = await wiring.orchestrator.reconcileAmbiguous();
    const drift = await wiring.treasury.reconcile();
    for (const d of drift) {
      log(`[consumer] treasury drift on ${d.treasuryRef}: ${d.drift.amount} atomic units`);
    }
    if (expired > 0 || reconciled > 0) {
      log(`[consumer] sweep: ${expired} expired, ${reconciled} ambiguous executions resolved`);
    }
    wiring.hub.heartbeat(new Date().toISOString());
  });

  return {
    stop(): void {
      for (const t of timers) clearInterval(t);
    },
  };
}
