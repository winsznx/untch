import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import {
  InMemoryConsumerStore,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  loadConsumerFlags,
  money,
  type AdapterContext,
  type CaipChainId,
  type ConsumerStore,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type ProviderQuote,
  type QuoteInput,
  type RailClient,
} from "@untch/consumer-core";
import type { AdapterRegistry, ConsumerProviderAdapter } from "@untch/consumer-providers";
import type { Ledger, LedgerWindowState, SpendIntentInput } from "@untch/policy-engine";
import { ConsumerOrchestrator } from "../src/consumer/orchestrator";
import { OutboxDispatcher, SseHub } from "../src/consumer/dispatcher";
import { makeFundingPrice } from "../src/consumer/funding-price";
import { registerConsumerQuotePreviewRoute, OPERATOR_QUOTE_PREVIEW_ROUTE } from "../src/consumer/operator-quote-routes";
import { resetOperatorAuthAudit, resetOperatorAuthThrottle } from "../src/internal-auth";
import type { ConsumerWiring } from "../src/consumer/wiring";

/**
 * The keyless live quote probe.
 *
 * It exists because the only way to discover that `shop.search` could not be quoted was to create a
 * production intent and watch it die — consuming the id, requiring a terminal transition, and doing all
 * of it inside an arming window with a treasury signer installed. This route answers the same question
 * for free, with the rail disarmed.
 *
 * The properties worth testing are what it does NOT do: it must create nothing, reserve nothing, mint no
 * payment capability, and refuse to be pointed anywhere the registry did not name.
 */

const SOLANA: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const SOL_USDC = asset("solana.usdc");
const OPS_TOKEN = ["quote", "preview", "test", "token"].join("-");
const PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";

const servers: Server[] = [];
after(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
});

/** Records what it was asked, and explodes if anything tries to pay through it. */
const seen: { shape: string | undefined; params: Record<string, unknown> | null; payment: unknown } = {
  shape: undefined,
  params: null,
  payment: "never-set",
};

class PreviewAdapter implements ConsumerProviderAdapter {
  readonly providerId = "purch";
  capabilities(): never[] {
    return [];
  }
  async health(): Promise<{ healthy: boolean; latencyMs: number | null; httpStatus: number | null; detail: string }> {
    return { healthy: true, latencyMs: 1, httpStatus: 200, detail: "test" };
  }
  async discover(): Promise<never> {
    throw new Error("a preview must never call discover — discover PAYS");
  }
  async quote(input: QuoteInput, ctx: AdapterContext): Promise<ProviderQuote> {
    seen.shape = input.executionShape;
    seen.params = { ...input.params };
    seen.payment = ctx.discoveryPayment;
    return {
      providerId: this.providerId,
      providerRef: input.providerRef,
      cost: money(10_000n, SOL_USDC),
      settlementRecipient: PAY_TO,
      settlementChain: SOLANA,
      settlementAsset: SOL_USDC,
      summary: "Paid search",
      terms: { executionShape: "PAID_READ", shippingRequired: false, contactRequired: false },
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
  }
  async execute(): Promise<never> {
    throw new Error("a preview must never execute");
  }
  async getStatus(): Promise<never> {
    throw new Error("not reachable");
  }
  async verifyDelivery(): Promise<never> {
    throw new Error("not reachable");
  }
  normalizeError(err: unknown): never {
    throw err;
  }
}

/** A rail that throws on every method. A preview must never reach one. */
const EXPLODING_RAIL = new Proxy({} as RailClient, {
  get(_t, prop) {
    if (prop === "chain") return SOLANA;
    if (prop === "available") return () => false;
    throw new Error(`THE PREVIEW REACHED THE RAIL via ${String(prop)}`);
  },
});

class MemoryLedger implements Ledger {
  async read(): Promise<LedgerWindowState> {
    return { budgetUsage: { settledToday: 0, reservedActiveToday: 0, effectiveToday: 0 }, recentIntents: [], lastCallByService: {}, callsInLastHour: 0 };
  }
  async commitApproved(_k: string, _i: SpendIntentInput): Promise<void> {}
}

async function harness(): Promise<{ url: string; store: ConsumerStore }> {
  const store = new InMemoryConsumerStore();
  await store.upsertProvider({
    providerId: "purch",
    displayName: "Purch",
    maturity: "verified",
    baseUrl: "https://api.purch.test",
    protocol: "x402",
    chains: [SOLANA],
    provenance: "quote-preview test",
    enabled: true,
  });
  await store.upsertCapability({
    providerId: "purch",
    capability: "shop.search",
    maturity: "verified",
    executionShape: "PAID_READ",
    notes: "quote-preview test",
  });

  const adapter = new PreviewAdapter();
  const adapters: AdapterRegistry = { get: () => adapter, has: () => true, all: () => [adapter] };
  const env: NodeJS.ProcessEnv = {
    INTERNAL_OPS_TOKEN: OPS_TOKEN,
    UNTCH_ENVIRONMENT: "production",
    CONSUMER_PACK_ENABLED: "1",
  };
  const config = {
    allowSandboxExecution: false,
    maxSingleExecutionDisplay: "1.00",
    quoteTtlSec: 600,
    fundingTtlSec: 900,
    providerTimeoutMs: 5_000,
    executeTimeoutMs: 5_000,
    breakerThreshold: 5,
    breakerCooldownMs: 60_000,
  };
  const treasury = new TreasuryRouter({
    store,
    // The rail is present and EXPLODES if touched, which is how "no signer was loaded" is proven.
    rails: new Map<CaipChainId, RailClient>([[SOLANA, EXPLODING_RAIL]]),
    pauses: new StorePauseChecker(store),
  });
  const orchestrator = new ConsumerOrchestrator({
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(env),
    }),
    adapters,
    treasury,
    policyProvider: { async load() { return null; }, async loadStored() { return null; } } as never,
    ledger: new MemoryLedger(),
    escalation: null,
    receipts: null,
    config,
    publicBaseUrl: "https://asp.untch.test",
    siwx: null,
  });

  const wiring = {
    store,
    registry: new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: false },
      flags: loadConsumerFlags(env),
    }),
    adapters,
    treasury,
    orchestrator,
    dispatcher: new OutboxDispatcher({ store, hub: new SseHub() }),
    hub: new SseHub(),
    fundingPrice: makeFundingPrice({ store }),
    config,
    publicBaseUrl: "https://asp.untch.test",
    availableRails: [],
    pool: null,
    async close() {},
  } as unknown as ConsumerWiring;

  const app = express();
  app.use(express.json());
  registerConsumerQuotePreviewRoute(app, { wiring, env });
  const url = await new Promise<string>((r) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      r(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
  return { url, store };
}

async function post(url: string, body: unknown, token: string | null = OPS_TOKEN): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${url}${OPERATOR_QUOTE_PREVIEW_ROUTE}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const VALID = {
  provider: "purch",
  capability: "shop.search",
  request: { query: "wireless mouse" },
  maxProviderAmount: "0.020000",
};

describe("the keyless live quote probe", () => {
  test("it requires the operator token", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    assert.equal((await post(h.url, VALID, null)).status, 401);
    assert.equal((await post(h.url, VALID, "wrong-token")).status, 401);
  });

  test("it prices the real adapter path and creates nothing", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    const r = await post(h.url, VALID);

    assert.equal(r.status, 200);
    assert.equal(r.body.executionShape, "PAID_READ");
    const quote = r.body.quote as Record<string, unknown>;
    assert.equal(quote.amount, "0.010000");
    assert.equal(quote.asset, "USDC");
    assert.equal(quote.chain, SOLANA);
    assert.equal(quote.recipient, PAY_TO);

    const checks = r.body.checks as Record<string, unknown>;
    assert.equal(checks.withinCeiling, true);
    assert.equal(checks.assetConfirmedForChain, true);
    assert.equal(checks.shippingRequired, false);
    assert.equal(checks.contactRequired, false);

    // ── nothing was created ──
    assert.deepEqual(await h.store.listIntents({ limit: 50 }), []);
    // ── the adapter was told the shape, and handed NO payment capability ──
    assert.equal(seen.shape, "PAID_READ");
    assert.equal(seen.payment, null);
    // ── the request reached the adapter unchanged, with no purchase fields injected ──
    assert.deepEqual(seen.params, { query: "wireless mouse" });
  });

  test("an amount above the stated ceiling is reported, not silently accepted", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    const r = await post(h.url, { ...VALID, maxProviderAmount: "0.005000" });
    assert.equal(r.status, 200);
    assert.equal((r.body.checks as Record<string, unknown>).withinCeiling, false);
  });

  /**
   * A preview that could be pointed anywhere would be a way to make production fetch arbitrary hosts with
   * an operator token as the only credential.
   */
  test("it refuses every field production derives", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    for (const field of ["providerUrl", "recipient", "payTo", "tokenMint", "mint", "chain", "treasury", "rail"]) {
      const r = await post(h.url, { ...VALID, [field]: "anything" });
      assert.equal(r.status, 400, `${field} must be refused`);
      assert.equal(r.body.code, "QUOTE_PREVIEW_INVALID");
      const refusals = r.body.refusals as { code: string }[];
      assert.ok(refusals.some((x) => x.code === "FIELD_NOT_ACCEPTED"), field);
    }
  });

  test("a malformed request is a 400 with named refusals, never HTML", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    for (const body of [{}, { ...VALID, capability: "not.a.capability" }, { ...VALID, request: "nope" }, { ...VALID, maxProviderAmount: "" }]) {
      const r = await post(h.url, body);
      assert.equal(r.status, 400);
      assert.ok(Array.isArray(r.body.refusals));
    }
  });

  test("an unknown provider or capability is a named refusal rather than a crash", async () => {
    resetOperatorAuthThrottle();
    resetOperatorAuthAudit();
    const h = await harness();
    const r = await post(h.url, { ...VALID, provider: "nosuchprovider" });
    assert.equal(r.status, 409);
    assert.equal(r.body.code, "CAPABILITY_UNAVAILABLE");
    assert.equal(r.body.created, false);
    assert.equal(r.body.settled, false);
  });
});
