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
  // Idempotent upserts. The seed is the source of truth for maturity and provenance; an operator can
  // still pause a provider, but cannot promote one past what the seed asserts without editing it.
  for (const seed of PROVIDER_SEEDS) {
    await store.upsertProvider(seed.provider);
    for (const cap of seed.capabilities) await store.upsertCapability(cap);
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
    await store.upsertTreasuryAccount({
      treasuryRef: "base-usdc-settlement",
      asset: asset("base.usdc"),
      purpose: "SETTLEMENT",
      address: baseRail.address(),
      minBalance: parseMoney(process.env.CONSUMER_BASE_MIN_BALANCE?.trim() || "5.00", asset("base.usdc")),
      dailyLimit: parseMoney(process.env.CONSUMER_BASE_DAILY_LIMIT?.trim() || "500.00", asset("base.usdc")),
      enabled: process.env.CONSUMER_BASE_TREASURY_ENABLED === "1",
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
