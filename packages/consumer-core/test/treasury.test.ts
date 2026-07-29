import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  InMemoryConsumerStore,
  NoopRebalancer,
  ProviderRegistry,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  assertRebalancingDisabled,
  isProviderError,
  money,
  parseMoney,
  publicToolState,
  publicToolStateFor,
  type AssetRef,
  type CaipChainId,
  type ConsumerStore,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
  type Rebalancer,
} from "../src/index";

const USDC = asset("base.usdc");
const BASE: CaipChainId = "eip155:8453";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

/** A rail client that records what it was asked to do and never touches a network. */
class FakeRail implements RailClient {
  readonly chain = BASE;
  readonly calls: PaymentRequest[] = [];
  constructor(private balance: bigint = 1_000_000_000n) {}
  address(): string {
    return "0x00000000000000000000000000000000000000AA";
  }
  available(): boolean {
    return true;
  }
  async balanceOf(a: AssetRef): Promise<{ amount: bigint; asset: AssetRef }> {
    return money(this.balance, a);
  }
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    this.calls.push(req);
    return {
      paymentHeader: "fake",
      headerName: "X-PAYMENT",
      txHash: null,
      amount: req.amount,
      recipient: req.recipient,
      chain: BASE,
    };
  }
}

const RECIPIENT = "0xABcb091D90419E1c8AD4818f1B33FC4645501892";

async function setup(over: { balance?: bigint; minBalance?: string; dailyLimit?: string } = {}): Promise<{
  store: ConsumerStore;
  router: TreasuryRouter;
  rail: FakeRail;
}> {
  const store = new InMemoryConsumerStore(() => NOW);
  const rail = new FakeRail(over.balance ?? 1_000_000_000n);
  await store.upsertTreasuryAccount({
    treasuryRef: "base-usdc-settlement",
    asset: USDC,
    purpose: "SETTLEMENT",
    address: rail.address(),
    minBalance: parseMoney(over.minBalance ?? "0.00", USDC),
    dailyLimit: parseMoney(over.dailyLimit ?? "0.00", USDC),
    enabled: true,
  });
  const router = new TreasuryRouter({
    store,
    rails: new Map([[BASE, rail]]),
    pauses: new StorePauseChecker(store),
    clock: () => NOW,
  });
  return { store, router, rail };
}

async function mint(router: TreasuryRouter, over: { max?: string; recipients?: string[] } = {}) {
  return router.issueCapability({
    capabilityId: "cap_1",
    intentId: "ci_1",
    providerId: "stabledomains",
    asset: USDC,
    maxAmount: parseMoney(over.max ?? "20.00", USDC),
    allowedRecipients: over.recipients ?? [RECIPIENT],
  });
}

const payReq = (over: Partial<PaymentRequest> = {}): PaymentRequest => ({
  amount: parseMoney("20.00", USDC),
  recipient: RECIPIENT,
  challenge: {},
  resourceUrl: "https://stabledomains.dev/api/register",
  method: "POST",
  ...over,
});

describe("treasury — an adapter can only do what its capability permits", () => {
  test("a payment within every bound succeeds and reaches the rail exactly once", async () => {
    const { router, rail } = await setup();
    const cap = await mint(router);
    await cap.pay(payReq());
    assert.equal(rail.calls.length, 1);
  });

  test("paying MORE than the ceiling is refused", async () => {
    const { router, rail } = await setup();
    const cap = await mint(router, { max: "20.00" });
    await assert.rejects(() => cap.pay(payReq({ amount: parseMoney("20.01", USDC) })), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE");
      return true;
    });
    assert.equal(rail.calls.length, 0, "the rail must never be reached on a refusal");
  });

  test("paying a recipient NOT on the allowlist is refused — the context-swap control", async () => {
    const { router, rail } = await setup();
    const cap = await mint(router);
    await assert.rejects(
      () => cap.pay(payReq({ recipient: "0x000000000000000000000000000000000000dEaD" })),
      (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAYMENT_CHALLENGE_UNACCEPTABLE");
        assert.match(e.normalized.message, /not on the capability's allowlist/);
        return true;
      },
    );
    assert.equal(rail.calls.length, 0);
  });

  test("paying in a DIFFERENT asset than the capability is scoped to is refused", async () => {
    const { router, rail } = await setup();
    const cap = await mint(router);
    const usdt0 = asset("xlayer.usdt0");
    await assert.rejects(() => cap.pay(payReq({ amount: parseMoney("1.00", usdt0) })));
    assert.equal(rail.calls.length, 0);
  });

  test("a non-positive payment is refused", async () => {
    const { router } = await setup();
    const cap = await mint(router);
    await assert.rejects(() => cap.pay(payReq({ amount: money(0n, USDC) })));
  });

  test("recipient matching is case-insensitive (EVM checksum vs lowercase)", async () => {
    const { router, rail } = await setup();
    const cap = await mint(router, { recipients: [RECIPIENT.toLowerCase()] });
    await cap.pay(payReq({ recipient: RECIPIENT }));
    assert.equal(rail.calls.length, 1);
  });

  test("an empty recipient allowlist cannot even be minted", async () => {
    const { router } = await setup();
    await assert.rejects(() => mint(router, { recipients: [] }), (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /empty recipient allowlist/);
      return true;
    });
  });
});

describe("treasury — a capability is single-use", () => {
  test("a SECOND pay() on the same capability is refused, not a second payment", async () => {
    // The race two workers on one intent would otherwise win twice.
    const { router, rail } = await setup();
    const cap = await mint(router);
    await cap.pay(payReq());
    await assert.rejects(() => cap.pay(payReq()), (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /already consumed or expired/);
      return true;
    });
    assert.equal(rail.calls.length, 1, "exactly one payment reached the rail");
  });

  test("minting a second live capability for the same intent is refused", async () => {
    const { router } = await setup();
    await mint(router);
    await assert.rejects(
      () =>
        router.issueCapability({
          capabilityId: "cap_2",
          intentId: "ci_1",
          providerId: "stabledomains",
          asset: USDC,
          maxAmount: parseMoney("20.00", USDC),
          allowedRecipients: [RECIPIENT],
        }),
      /already has a live payment capability/,
    );
  });

  test("redemption happens BEFORE signing, so a crash cannot permit a re-sign", async () => {
    // A rail that throws stands in for the process dying between redeem and settle. The capability
    // must already be spent, so the retry path is reconciliation, not a second payment.
    const store = new InMemoryConsumerStore(() => NOW);
    const throwingRail: RailClient = {
      chain: BASE,
      address: () => "0x00000000000000000000000000000000000000AA",
      available: () => true,
      balanceOf: async (a) => money(1_000_000_000n, a),
      pay: async () => {
        throw new Error("connection reset mid-flight");
      },
    };
    await store.upsertTreasuryAccount({
      treasuryRef: "base-usdc-settlement",
      asset: USDC,
      purpose: "SETTLEMENT",
      address: "0x00000000000000000000000000000000000000AA",
      minBalance: parseMoney("0.00", USDC),
      dailyLimit: parseMoney("0.00", USDC),
      enabled: true,
    });
    const router = new TreasuryRouter({
      store,
      rails: new Map([[BASE, throwingRail]]),
      pauses: new StorePauseChecker(store),
      clock: () => NOW,
    });
    const cap = await mint(router);
    await assert.rejects(() => cap.pay(payReq()), /connection reset/);
    const record = await store.getCapability("cap_1");
    assert.notEqual(record?.consumedAt, null, "the capability must be spent even though signing failed");
  });
});

describe("treasury — limits and floats", () => {
  test("a payment that would breach the per-tx cap is refused at MINT time", async () => {
    const { store, router } = await setup();
    await store.upsertProviderLimit({
      providerId: "stabledomains",
      asset: USDC,
      perTxMax: parseMoney("10.00", USDC),
      dailyMax: parseMoney("1000.00", USDC),
    });
    await assert.rejects(() => mint(router, { max: "20.00" }), (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /per-transaction cap/);
      return true;
    });
  });

  test("a payment that would take the float below its floor is refused", async () => {
    // 15 USDC on hand, 10 USDC floor, 20 USDC payment ⇒ refuse.
    const { router } = await setup({ balance: 15_000_000n, minBalance: "10.00" });
    await assert.rejects(() => mint(router, { max: "20.00" }), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "TREASURY_INSUFFICIENT");
      return true;
    });
  });

  test("a rail with no signing key reports TREASURY_INSUFFICIENT rather than degrading", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    const router = new TreasuryRouter({
      store,
      rails: new Map(),
      pauses: new StorePauseChecker(store),
      clock: () => NOW,
    });
    await assert.rejects(() => mint(router), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "TREASURY_INSUFFICIENT");
      assert.match(e.normalized.message, /signing key is not configured/);
      return true;
    });
  });

  test("reconcile records drift and never silently corrects it", async () => {
    const { store, router, rail } = await setup();
    const cap = await mint(router);
    await cap.pay(payReq());
    // Ledger has no settlement group yet, so the on-chain balance and the ledger disagree.
    const drifts = await router.reconcile();
    assert.equal(drifts.length, 1);
    const observed = await store.latestBalanceObservation("base-usdc-settlement");
    assert.equal(observed?.onchain.amount, await rail.balanceOf(USDC).then((m) => m.amount));
    assert.equal(observed?.ledger.amount, 0n);
  });
});

describe("treasury — kill switches", () => {
  for (const [label, scope, target] of [
    ["global", "GLOBAL", "*"],
    ["provider", "PROVIDER", "stabledomains"],
    ["chain", "CHAIN", BASE],
  ] as const) {
    test(`a ${label} pause blocks capability issuance`, async () => {
      const { store, router } = await setup();
      await store.setPause({
        scope,
        target,
        paused: true,
        reason: "operator test",
        setBy: "op",
        updatedAt: new Date(NOW).toISOString(),
      });
      await assert.rejects(() => mint(router), (e: unknown) => {
        assert.ok(isProviderError(e) && e.normalized.code === "PAUSED");
        return true;
      });
    });
  }

  test("a disengaged pause flag does not block", async () => {
    const { store, router } = await setup();
    await store.setPause({
      scope: "GLOBAL",
      target: "*",
      paused: false,
      reason: "resumed",
      setBy: "op",
      updatedAt: new Date(NOW).toISOString(),
    });
    await mint(router);
  });
});

describe("treasury — request-path rebalancing is structurally disabled", () => {
  test("the shipped rebalancer is disabled", () => {
    assertRebalancingDisabled(new NoopRebalancer());
  });

  test("constructing a router with an ENABLED rebalancer throws", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    const enabled: Rebalancer = { enabled: true, rebalance: async () => {} };
    assert.throws(
      () =>
        new TreasuryRouter({
          store,
          rails: new Map(),
          pauses: new StorePauseChecker(store),
          rebalancer: enabled,
        }),
      /no tested production bridge/,
    );
  });
});

describe("registry — maturity gates execution", () => {
  async function withProvider(
    providerMaturity: "verified" | "sandbox" | "experimental" | "disabled",
    capMaturity = providerMaturity,
    allowSandbox = false,
  ): Promise<ProviderRegistry> {
    const store = new InMemoryConsumerStore(() => NOW);
    await store.upsertProvider({
      providerId: "p1",
      displayName: "P1",
      maturity: providerMaturity,
      baseUrl: "https://example.test",
      protocol: "x402",
      chains: [BASE],
      provenance: "test",
      enabled: true,
    });
    await store.upsertCapability({
      providerId: "p1",
      capability: "domains.register",
      maturity: capMaturity,
      notes: "",
    });
    return new ProviderRegistry({
      store,
      gate: { executionFloor: "verified", allowSandboxExecution: allowSandbox },
      clock: () => NOW,
    });
  }

  test("a verified provider executes", async () => {
    const r = await withProvider("verified");
    const resolved = await r.assertExecutable("p1", "domains.register");
    assert.equal(resolved.sandboxOverride, false);
  });

  test("a sandbox provider is REFUSED by default", async () => {
    const r = await withProvider("sandbox");
    await assert.rejects(() => r.assertExecutable("p1", "domains.register"), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "PROVIDER_NOT_EXECUTABLE");
      assert.match(e.normalized.message, /CONSUMER_ALLOW_SANDBOX_EXECUTION/);
      return true;
    });
  });

  test("a sandbox provider executes under the explicit opt-in, and is STAMPED as an override", async () => {
    const r = await withProvider("sandbox", "sandbox", true);
    const resolved = await r.assertExecutable("p1", "domains.register");
    assert.equal(resolved.sandboxOverride, true);
  });

  test("an experimental provider is refused EVEN WITH the sandbox opt-in", async () => {
    // The escape hatch reaches exactly one rung. It is not a general override.
    const r = await withProvider("experimental", "experimental", true);
    await assert.rejects(() => r.assertExecutable("p1", "domains.register"), (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /cannot be configured around/);
      return true;
    });
  });

  test("a capability may be LESS mature than its provider, and the lower wins", async () => {
    const r = await withProvider("verified", "experimental", true);
    await assert.rejects(() => r.assertExecutable("p1", "domains.register"));
  });

  test("a capability can NEVER be more mature than its provider", async () => {
    // Provider sandbox + capability verified must resolve to sandbox, not verified.
    const r = await withProvider("sandbox", "verified", false);
    await assert.rejects(() => r.assertExecutable("p1", "domains.register"), (e: unknown) => {
      assert.ok(isProviderError(e));
      assert.match(e.normalized.message, /is 'sandbox'/);
      return true;
    });
  });

  test("an undeclared capability is CAPABILITY_UNAVAILABLE, not a silent fallback", async () => {
    const r = await withProvider("verified");
    await assert.rejects(() => r.assertExecutable("p1", "travel.book"), (e: unknown) => {
      assert.ok(isProviderError(e) && e.normalized.code === "CAPABILITY_UNAVAILABLE");
      return true;
    });
  });

  test("an unknown provider is refused", async () => {
    const r = await withProvider("verified");
    await assert.rejects(() => r.assertExecutable("nope", "domains.register"));
  });
});

describe("public tool state — a label projects the gate, and can never widen it", () => {
  const provider = (over: Partial<Parameters<typeof publicToolStateFor>[0]> = {}) => ({
    providerId: "p1",
    displayName: "P1",
    maturity: "verified" as const,
    baseUrl: "https://p1.test",
    protocol: "x402" as const,
    chains: ["eip155:8453" as CaipChainId],
    provenance: "test",
    enabled: true,
    ...over,
  });

  test("each internal rung maps to exactly one public state", () => {
    assert.equal(publicToolState("verified"), "LIVE");
    assert.equal(publicToolState("sandbox"), "BETA");
    assert.equal(publicToolState("experimental"), "SANDBOX");
    assert.equal(publicToolState("disabled"), "DISABLED");
  });

  test("a blocker separates 'we haven't finished' from 'the merchant won't admit us'", () => {
    assert.equal(publicToolState("experimental", null), "SANDBOX");
    assert.equal(publicToolState("experimental", "PARTNER_ACCESS"), "PARTNER_ACCESS_REQUIRED");
    assert.equal(publicToolState("experimental", "IDENTITY_REQUIRED"), "PARTNER_ACCESS_REQUIRED");
    assert.equal(publicToolState("experimental", "RAIL_UNAVAILABLE"), "PARTNER_ACCESS_REQUIRED");
    assert.equal(publicToolState("experimental", "PROVIDER_UNSUPPORTED"), "PARTNER_ACCESS_REQUIRED");
  });

  test("a blocker only ever downgrades — it can never suppress proven evidence", () => {
    // A settled payment plus a verified delivery is evidence; a leftover annotation is not. If a
    // blocker could mute a verified capability, a stale string would be able to hide a working
    // integration, and nobody reading the label would know why.
    assert.equal(publicToolState("verified", "PARTNER_ACCESS"), "LIVE");
    assert.equal(publicToolState("sandbox", "PARTNER_ACCESS"), "BETA");
  });

  test("a capability is capped by its provider, so a label cannot promote past the gate", () => {
    const cap = { providerId: "p1", capability: "mail.send", maturity: "verified" as const, notes: "" };
    assert.equal(publicToolStateFor(provider({ maturity: "sandbox" }), cap), "BETA");
    assert.equal(publicToolStateFor(provider({ maturity: "experimental" }), cap), "SANDBOX");
  });

  test("a disabled provider renders DISABLED whatever its capabilities claim", () => {
    const cap = { providerId: "p1", capability: "mail.send", maturity: "verified" as const, notes: "" };
    assert.equal(publicToolStateFor(provider({ enabled: false }), cap), "DISABLED");
  });
});
