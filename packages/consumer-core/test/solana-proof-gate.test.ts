/**
 * The one-shot Solana proof gate.
 *
 * The property under test is not "spending is limited". It is that a REFUSED payment never reaches a
 * signer. Those are different claims: a rail that signs and then discards the signature has already
 * put the treasury's authority into a buffer, and asserting only on the absence of a balance change
 * would pass for both. So the rail here counts its own invocations, and every refusal case asserts
 * that count is still zero.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  InMemoryConsumerStore,
  SolanaProofGate,
  StorePauseChecker,
  TreasuryRouter,
  asset,
  canReleasePreSign,
  describeProofGate,
  loadSolanaProofGate,
  money,
  parseMoney,
  type AssetRef,
  type CaipChainId,
  type Money,
  type PaymentRequest,
  type PaymentResult,
  type RailClient,
} from "../src/index";

const SOLANA: CaipChainId = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const BASE: CaipChainId = "eip155:8453";
const SOL_USDC = asset("solana.usdc");
const BASE_USDC = asset("base.usdc");
const PURCH_PAYTO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const NOW = Date.parse("2026-07-29T22:00:00.000Z");
const EXPIRY = "2026-07-29T22:10:00.000Z";
const INTENT = "ci_proof_target";

/** A rail that records whether it was ever asked to sign. */
class CountingRail implements RailClient {
  calls = 0;
  constructor(readonly chain: CaipChainId) {}
  available(): boolean {
    return true;
  }
  address(): string {
    return "HsTvSTrXn1HeDzUJTbH4ETXEKTTf2ifEXaQGGEEQ2XUy";
  }
  async balanceOf(a: AssetRef): Promise<Money> {
    return money(10_000_000n, a);
  }
  async pay(req: PaymentRequest): Promise<PaymentResult> {
    this.calls += 1;
    return {
      paymentHeader: "opaque",
      headerName: "PAYMENT-SIGNATURE",
      txHash: null,
      amount: req.amount,
      recipient: req.recipient,
      chain: this.chain,
    };
  }
}

function gateEnv(over: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    CONSUMER_SOLANA_PROOF_MODE: "1",
    CONSUMER_SOLANA_PROOF_INTENT_ID: INTENT,
    CONSUMER_SOLANA_PROOF_PROVIDER: "purch",
    CONSUMER_SOLANA_PROOF_CAPABILITY: "shop.search",
    CONSUMER_SOLANA_PROOF_MAX_USDC: "0.02",
    CONSUMER_SOLANA_PROOF_EXPIRES_AT: EXPIRY,
    ...over,
  };
}

async function harness(
  opts: {
    env?: Record<string, string | undefined>;
    chain?: CaipChainId;
    settlementAsset?: AssetRef;
    intentId?: string;
    providerId?: string;
    action?: string;
    now?: number;
    /** The CAPABILITY ceiling, distinct from the gate's. Raised when the gate must be the binding one. */
    capMax?: bigint;
  } = {},
): Promise<{ rail: CountingRail; pay: (amount: Money) => Promise<PaymentResult>; store: InMemoryConsumerStore }> {
  const chain = opts.chain ?? SOLANA;
  const settlementAsset = opts.settlementAsset ?? SOL_USDC;
  const intentId = opts.intentId ?? INTENT;
  const providerId = opts.providerId ?? "purch";
  const now = opts.now ?? NOW;
  const store = new InMemoryConsumerStore(() => now);
  const clock = (): number => now;

  await store.upsertTreasuryAccount({
    treasuryRef: `t-${chain}`,
    asset: settlementAsset,
    purpose: "SETTLEMENT",
    address: "HsTvSTrXn1HeDzUJTbH4ETXEKTTf2ifEXaQGGEEQ2XUy",
    minBalance: parseMoney("0.00", settlementAsset),
    dailyLimit: parseMoney("0.00", settlementAsset),
    enabled: true,
  });
  await store.createIntent(
    {
      intentId,
      tenantId: "t1",
      requestingAgentId: "a1",
      principalId: "p1",
      action: (opts.action ?? "shop.search") as never,
      category: "shopping",
      request: { query: "usb c cable" },
      policyId: "pol_1",
      correlationId: "c1",
      idempotencyKey: `k-${intentId}`,
      expiresAt: null,
    },
    { name: "consumer.intent.created", data: {} },
  );

  const rail = new CountingRail(chain);
  const gate = new SolanaProofGate({
    config: loadSolanaProofGate(opts.env ?? gateEnv(), (raw) => parseMoney(raw, settlementAsset)),
    store,
    clock,
  });
  const router = new TreasuryRouter({
    store,
    rails: new Map<CaipChainId, RailClient>([[chain, rail]]),
    pauses: new StorePauseChecker(store),
    clock,
    proofGate: gate,
  });

  const cap = await router.issueCapability({
    capabilityId: `cap-${intentId}`,
    intentId,
    providerId,
    asset: settlementAsset,
    maxAmount: money(opts.capMax ?? 20_000n, settlementAsset),
    allowedRecipients: [PURCH_PAYTO],
  });

  return {
    rail,
    store,
    pay: (amount: Money) =>
      cap.pay({
        amount,
        recipient: PURCH_PAYTO,
        challenge: {},
        resourceUrl: "https://api.purch.xyz/x402/search",
        method: "GET",
      }),
  };
}

/** Assert a refusal AND that no signer was reached. Both, always. */
async function refused(
  h: { rail: CountingRail; pay: (a: Money) => Promise<PaymentResult> },
  amount: Money,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(() => h.pay(amount), pattern);
  assert.equal(h.rail.calls, 0, "the signer was reached despite a refusal");
}

describe("Solana proof gate — the authorised payment is allowed exactly once", () => {
  test("the exact configured proof settles", async () => {
    const h = await harness();
    const r = await h.pay(money(10_000n, SOL_USDC));
    assert.equal(h.rail.calls, 1);
    assert.equal(r.headerName, "PAYMENT-SIGNATURE");
  });

  test("a payment at the ceiling is allowed, one unit over is not", async () => {
    const at = await harness();
    await at.pay(money(20_000n, SOL_USDC));
    assert.equal(at.rail.calls, 1);

    /**
     * The capability ceiling is raised to 1.00 here so the GATE is the binding constraint.
     *
     * With both set to 0.02 the capability refuses first, which is a correct refusal that proves
     * nothing about the gate. Making the gate the tighter of the two is what shows it narrows
     * authority below what the surrounding system would already have permitted.
     */
    const over = await harness({ capMax: 1_000_000n });
    await refused(over, money(20_001n, SOL_USDC), /exceeds the proof ceiling/);
  });
});

describe("Solana proof gate — identity must match exactly", () => {
  test("proof mode off refuses everything", async () => {
    const h = await harness({ env: gateEnv({ CONSUMER_SOLANA_PROOF_MODE: undefined }) });
    await refused(h, money(10_000n, SOL_USDC), /proof mode is not enabled/);
  });

  test("a missing intent, provider, capability, ceiling or expiry each refuse", async () => {
    for (const [key, pattern] of [
      ["CONSUMER_SOLANA_PROOF_INTENT_ID", /no proof intent is configured/],
      ["CONSUMER_SOLANA_PROOF_PROVIDER", /no proof provider is configured/],
      ["CONSUMER_SOLANA_PROOF_CAPABILITY", /no proof capability is configured/],
      ["CONSUMER_SOLANA_PROOF_MAX_USDC", /no usable proof ceiling/],
      ["CONSUMER_SOLANA_PROOF_EXPIRES_AT", /no proof expiry is configured/],
    ] as const) {
      const h = await harness({ env: gateEnv({ [key]: undefined }) });
      await refused(h, money(10_000n, SOL_USDC), pattern);
    }
  });

  test("an UNPARSEABLE ceiling refuses rather than meaning no ceiling", async () => {
    // A malformed limit must never widen authority. This is the direction the mistake matters in.
    const h = await harness({ env: gateEnv({ CONSUMER_SOLANA_PROOF_MAX_USDC: "not-a-number" }) });
    await refused(h, money(10_000n, SOL_USDC), /no usable proof ceiling/);
  });

  test("a DIFFERENT intent is refused, which is the queued-intent case", async () => {
    const h = await harness({ intentId: "ci_some_other_queued_intent" });
    await refused(h, money(10_000n, SOL_USDC), /not the authorised proof intent/);
  });

  test("a different provider is refused", async () => {
    const h = await harness({ providerId: "stableemail" });
    await refused(h, money(10_000n, SOL_USDC), /not the authorised proof provider/);
  });

  test("a different capability on the right intent is refused", async () => {
    const h = await harness({ action: "shop.purchase" });
    await refused(h, money(10_000n, SOL_USDC), /not the authorised proof capability/);
  });
});

describe("Solana proof gate — the window closes", () => {
  test("at the expiry instant the gate is already shut", async () => {
    const h = await harness({ now: Date.parse(EXPIRY) });
    await refused(h, money(10_000n, SOL_USDC), /the proof window closed/);
  });

  test("one millisecond before expiry it still works", async () => {
    const h = await harness({ now: Date.parse(EXPIRY) - 1 });
    await h.pay(money(10_000n, SOL_USDC));
    assert.equal(h.rail.calls, 1);
  });
});

describe("Solana proof gate — single use survives a restart", () => {
  test("execution rows are NOT what governs the gate any more", async () => {
    /**
     * This replaces two tests that asserted the OLD model, in which consumption was inferred from an
     * execution reaching PAID or ACKNOWLEDGED. That inference was the bug: it cannot tell "never tried"
     * from "signed, broadcast, crashed before we wrote anything", so it reported an unspent gate for a
     * proof that may already have paid.
     *
     * The gate row is now the authority. A settled execution row on its own neither consumes a fresh
     * gate nor is needed to consume a claimed one, and stating that directly stops the old inference
     * from creeping back in as an optimisation.
     */
    const h = await harness();
    await h.store.prepareExecution({
      executionId: "exec_prior",
      intentId: INTENT,
      providerId: "purch",
      attemptNo: 1,
      idempotencyKey: "k1",
      state: "PAID",
      providerReference: "ref",
      settlementTxHash: "SgxsTgw…",
      settlementChain: SOLANA,
      settledAmount: money(10_000n, SOL_USDC),
    } as never);

    // The gate row is untouched, so this proceeds. Under the old model it would have refused here for
    // the wrong reason, and would have PERMITTED the genuinely dangerous crash cases.
    await h.pay(money(10_000n, SOL_USDC));
    assert.equal(h.rail.calls, 1);
  });

  test("a FAILED prior execution row does not block a fresh gate", async () => {
    // Kept because the inverse matters: a failed attempt on the INTENT must not strand a gate that was
    // never claimed. Release of a CLAIMED gate is a separate and much stricter question, covered below.
    const h = await harness();
    await h.store.prepareExecution({
      executionId: "exec_failed",
      intentId: INTENT,
      providerId: "purch",
      attemptNo: 1,
      idempotencyKey: "k1",
      state: "FAILED",
      providerReference: null,
      settlementTxHash: null,
      settlementChain: null,
      settledAmount: null,
    } as never);
    await h.pay(money(10_000n, SOL_USDC));
    assert.equal(h.rail.calls, 1);
  });

  test("a second redemption of the same capability is refused", async () => {
    const h = await harness();
    await h.pay(money(10_000n, SOL_USDC));
    // The message now comes from the durable claim rather than the capability, because the gate is
    // checked first and refuses before redemption is even attempted.
    await assert.rejects(() => h.pay(money(10_000n, SOL_USDC)), /not ARMED|already consumed/);
    assert.equal(h.rail.calls, 1, "a second payment reached the signer");
  });
});

describe("Solana proof gate — Base is untouched", () => {
  test("Base settles with the gate armed and never consults it", async () => {
    // The gate exists to bound a Solana proof. A control that quietly changed a proven rail would be
    // a regression wearing a safeguard's clothes.
    const h = await harness({ chain: BASE, settlementAsset: BASE_USDC });
    await h.pay(money(10_000n, BASE_USDC));
    assert.equal(h.rail.calls, 1);
  });

  test("Base settles even with proof mode OFF entirely", async () => {
    const h = await harness({
      chain: BASE,
      settlementAsset: BASE_USDC,
      env: gateEnv({ CONSUMER_SOLANA_PROOF_MODE: undefined }),
    });
    await h.pay(money(10_000n, BASE_USDC));
    assert.equal(h.rail.calls, 1);
  });

  test("the gate governs Solana chains only", () => {
    assert.equal(SolanaProofGate.governs(SOLANA), true);
    assert.equal(SolanaProofGate.governs(BASE), false);
    assert.equal(SolanaProofGate.governs("eip155:196"), false);
  });
});

describe("Solana proof gate — the redacted description", () => {
  test("describe() carries no treasury address and no secret", () => {
    const gate = new SolanaProofGate({
      config: loadSolanaProofGate(gateEnv(), (raw) => parseMoney(raw, SOL_USDC)),
      store: new InMemoryConsumerStore(),
      clock: () => NOW,
    });
    const d = JSON.stringify(gate.describe());
    assert.equal(d.includes("HsTvSTrXn1He"), false);
    assert.match(d, /"capability":"shop.search"/);
    assert.match(d, /"expired":false/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The crash window
//
// These are the cases the FIRST version of this gate got wrong. It inferred consumption from whether an
// execution had reached PAID, which cannot distinguish "never tried" from "signed, broadcast, and
// crashed before we wrote anything". Each test below sits at a different point in that window and
// asserts the same thing: the gate stays consumed, and no signer is reached.
// ─────────────────────────────────────────────────────────────────────────────

/** Build a gate over a shared store, as a distinct process would. */
function gateOver(store: InMemoryConsumerStore, now = NOW): SolanaProofGate {
  return new SolanaProofGate({
    config: loadSolanaProofGate(gateEnv(), (raw) => parseMoney(raw, SOL_USDC)),
    store,
    clock: () => now,
  });
}

const authInput = (executionId: string): Parameters<SolanaProofGate["assertAuthorised"]>[0] => ({
  intentId: INTENT,
  providerId: "purch",
  capability: "shop.search",
  amount: money(10_000n, SOL_USDC),
  chain: SOLANA,
  executionId,
});

describe("Solana proof gate — the durable claim", () => {
  test("two workers race and exactly ONE wins the claim", async () => {
    // #given one store and two gate instances, as two workers would be
    const store = new InMemoryConsumerStore(() => NOW);
    const a = gateOver(store);
    const b = gateOver(store);

    // #when both try to authorise the same proof
    const results = await Promise.allSettled([
      a.assertAuthorised(authInput("exec_a")),
      b.assertAuthorised(authInput("exec_b")),
    ]);

    // #then exactly one succeeded, and the loser was told why
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    assert.equal(won.length, 1, "more than one worker acquired the right to sign");
    assert.equal(lost.length, 1);
    assert.match(
      String((lost[0] as PromiseRejectedResult).reason),
      /another worker claimed this proof first|is CLAIMED, not ARMED/,
    );
  });

  test("the winning claim names its holder and marks signer access", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    const gate = gateOver(store);
    await gate.assertAuthorised(authInput("exec_winner"));

    const hash = gate.claimedScopeHash();
    assert.ok(hash, "the gate did not retain its scope hash");
    const row = await store.getSolanaProofGate(hash);
    assert.equal(row?.state, "CLAIMED");
    assert.equal(row?.claimedByExecution, "exec_winner");
    assert.ok(row?.claimedAt);
    // Signer access is recorded straight after the claim, which is what makes release decidable.
    assert.ok(row?.signerReachedAt, "signer access was not recorded");
  });

  test("a RESTART while CLAIMED refuses a fresh signing attempt", async () => {
    // The exact scenario the old model failed. A crash after claiming leaves a CLAIMED row, and a
    // brand new process reading the same database must refuse rather than see an unspent gate.
    const store = new InMemoryConsumerStore(() => NOW);
    await gateOver(store).assertAuthorised(authInput("exec_before_crash"));

    const afterRestart = gateOver(store);
    await assert.rejects(
      () => afterRestart.assertAuthorised(authInput("exec_after_restart")),
      /is CLAIMED, not ARMED/,
    );
  });

  for (const [label, progress, state] of [
    ["after credential construction", { credentialCreatedAt: new Date(NOW).toISOString() }, null],
    ["after transaction signing", { txSignature: "SgxsTgw" }, null],
    ["after broadcast, before signature persistence", { txSubmittedAt: new Date(NOW).toISOString() }, null],
    ["after signature persistence, before PAID", { txSignature: "SgxsTgw" }, null],
    ["after settlement, before acknowledgement", { settledAt: new Date(NOW).toISOString() }, "SETTLED"],
    ["after acknowledgement", { acknowledgedAt: new Date(NOW).toISOString() }, "ACKNOWLEDGED"],
    ["after an ambiguous provider timeout", { manualReviewReason: "provider timed out after settlement" }, "MANUAL_REVIEW"],
  ] as const) {
    test(`a crash ${label} leaves the gate unusable`, async () => {
      const store = new InMemoryConsumerStore(() => NOW);
      const first = gateOver(store);
      await first.assertAuthorised(authInput("exec_first"));
      await first.recordProgress(progress as never, state as never);

      const afterRestart = gateOver(store);
      await assert.rejects(
        () => afterRestart.assertAuthorised(authInput("exec_retry")),
        /not ARMED/,
        `a crash ${label} left the gate reusable`,
      );
    });
  }
});

describe("Solana proof gate — release requires proving nothing was signed", () => {
  test("a gate that never reached the signer CAN be released", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    const scope = {
      intentId: INTENT,
      providerId: "purch",
      capability: "shop.search",
      chain: SOLANA,
      asset: SOL_USDC,
      maxAmount: money(20_000n, SOL_USDC),
      expiresAt: EXPIRY,
    };
    const armed = await store.armSolanaProofGate(scope, new Date(NOW).toISOString());
    const released = await store.releaseSolanaProofGatePreSign(
      armed.scopeHash,
      "the run stopped at the policy step",
      new Date(NOW).toISOString(),
    );
    assert.equal(released?.state, "RELEASED_PRE_SIGN");
  });

  test("a gate that DID reach the signer cannot be released, however the attempt ended", async () => {
    // A FAILED execution is exactly what an ambiguous broadcast also produces, so failure can never be
    // the evidence for release. This is the rule that keeps a stranded proof from becoming a double
    // payment.
    const store = new InMemoryConsumerStore(() => NOW);
    const gate = gateOver(store);
    await gate.assertAuthorised(authInput("exec_signed"));
    const hash = gate.claimedScopeHash() as string;

    const refused = await store.releaseSolanaProofGatePreSign(
      hash,
      "the attempt reported FAILED",
      new Date(NOW).toISOString(),
    );
    assert.equal(refused, null, "a gate that reached the signer was released");

    const row = await store.getSolanaProofGate(hash);
    assert.equal(row?.state, "CLAIMED");
    assert.equal(canReleasePreSign(row as never).ok, false);
    assert.match(canReleasePreSign(row as never).why, /the signer was reached at/);
  });

  test("each individual trace of signer access blocks release on its own", async () => {
    for (const field of ["credentialCreatedAt", "txSignature", "txSubmittedAt", "settledAt"] as const) {
      const store = new InMemoryConsumerStore(() => NOW);
      const scope = {
        intentId: `${INTENT}_${field}`,
        providerId: "purch",
        capability: "shop.search",
        chain: SOLANA,
        asset: SOL_USDC,
        maxAmount: money(20_000n, SOL_USDC),
        expiresAt: EXPIRY,
      };
      const armed = await store.armSolanaProofGate(scope, new Date(NOW).toISOString());
      const value = field === "txSignature" ? "SgxsTgw" : new Date(NOW).toISOString();
      await store.recordSolanaProofProgress(
        armed.scopeHash,
        { [field]: value } as never,
        null,
        new Date(NOW).toISOString(),
      );
      const refused = await store.releaseSolanaProofGatePreSign(
        armed.scopeHash,
        "attempting release",
        new Date(NOW).toISOString(),
      );
      assert.equal(refused, null, `${field} did not block release`);
    }
  });
});

describe("Solana proof gate — the operator view", () => {
  test("describeProofGate reports what a retry decision needs and no secrets", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    const gate = gateOver(store);
    await gate.assertAuthorised(authInput("exec_described"));
    await gate.recordProgress({ txSignature: "SgxsTgwVZnmK", settledAt: new Date(NOW).toISOString() }, "SETTLED");

    const row = await store.getSolanaProofGate(gate.claimedScopeHash() as string);
    const view = describeProofGate(row as never);
    assert.equal(view.state, "SETTLED");
    assert.equal(view.signerReached, true);
    assert.equal(view.reusable, false);
    assert.equal(view.txSignature, "SgxsTgwVZnmK");
    // Nothing that would make the log itself a liability.
    const json = JSON.stringify(view);
    assert.equal(json.includes("SECRET"), false);
    assert.equal(json.includes("alchemy"), false);
  });

  test("listSolanaProofGates returns rows for the diagnostic", async () => {
    const store = new InMemoryConsumerStore(() => NOW);
    await gateOver(store).assertAuthorised(authInput("exec_listed"));
    const rows = await store.listSolanaProofGates(10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.scope.capability, "shop.search");
  });
});
