import assert from "node:assert/strict";
import { describe, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { after } from "node:test";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { POLICY_REGISTRY_ABI, ViemRegistryReader } from "@untch/policy-store";
import { evaluateIntent, ENGINE_VERSION, IMPLEMENTED_RULES, RULE_MANIFEST_HASH } from "@untch/policy-engine";
import {
  accountRefHash,
  metadataHashV2,
  metadataV2Of,
  policySnapshotHashOf,
  publicDecisionProjection,
  quoteDigestOf,
} from "@untch/consumer-core";

/**
 * Contract parity: the fake and the real thing must agree on SHAPE, not merely on intent.
 *
 * FIVE DEFECTS, ONE CAUSE
 *
 * Every production-only failure found in this pass had the same structure — a tested path and a
 * served path that were never the same path:
 *
 *   1. `mapPreflightRequest` was written, tested, and wired to nothing.
 *   2. The web link button read a `message` field `link/start` has never returned.
 *   3. `/consumer/policies/draft` returned 500 for its entire life, because viem hands back the
 *      `uint64` expiry as a BigInt and `FakeRegistry` returned `expiry.toString()`. The double was
 *      SERIALISABLE where the real reader is not, so the suite was green and the route was dead.
 *   4. `hardCap` and `duplicates.keys` were anchored on chain and never read by any rule.
 *   5. A hand-rolled `Ledger` double returned fields `LedgerWindowState` does not have, so every
 *      decision came back BLOCKED_FAIL_CLOSED and looked like a finding.
 *
 * Numbers 3 and 5 are the same bug in two places: a double that is EASIER to work with than the
 * production type. This file makes that specific mistake fail.
 *
 * WHAT PARITY MEANS HERE
 *
 * Not "the values match" — the primitive TYPES match, the nullability matches, and the boundary that
 * consumes them is the real one. A test asserting `args[2] === "1790726400"` passes against a string
 * and against a BigInt coerced by `==`. Asserting `typeof args[2] === "bigint"` does not.
 */

const REGISTRY = getAddress("0xa2177E6D8682367637A3C2aF53E2cF8088EFA954");
const AGENT = getAddress("0x5a2C16C74e9E15cF74add824F2ef97D6B3FbaB64");
const HASH = `0x${"8b".repeat(32)}` as Hex;
const EXPIRY = 1790726400n;

const servers: Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** The real reader, with a public client that is never used: `buildRegister` is pure encoding. */
function realReader(): ViemRegistryReader {
  return new ViemRegistryReader({
    chain: {
      id: 196,
      name: "X Layer Mainnet",
      nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
      rpcUrls: { default: { http: ["https://rpc.xlayer.tech"] } },
    },
    rpcUrl: "https://rpc.xlayer.tech",
    registry: REGISTRY,
  });
}

describe("the registry reader's return shape", () => {
  test("expiry comes back as a BigInt, and any double must too", () => {
    const call = realReader().buildRegister(AGENT, HASH, EXPIRY);
    // The assertion that would have caught defect 3 on day one.
    assert.equal(typeof call.args[0], "string", "agent is an address string");
    assert.equal(typeof call.args[1], "string", "policyHash is a hex string");
    assert.equal(typeof call.args[2], "bigint", "expiry is a BigInt — a double returning a string hides a 500");
    assert.equal(call.args.length, 3);
  });

  test("the calldata is the ABI encoding and nothing else", () => {
    const call = realReader().buildRegister(AGENT, HASH, EXPIRY);
    assert.equal(
      call.calldata,
      encodeFunctionData({ abi: POLICY_REGISTRY_ABI, functionName: "registerPolicy", args: [AGENT, HASH, EXPIRY] }),
    );
    // 4-byte selector plus three 32-byte words. Anything appended is a different transaction.
    assert.equal((call.calldata.length - 2) / 2, 100);
  });
});

/**
 * The real serializer.
 *
 * `res.json` is what production runs and `JSON.stringify` is what it calls. A suite that asserts on
 * an object in memory never reaches the throw, which is exactly how defect 3 survived.
 */
async function serveThrough(body: unknown): Promise<{ status: number; text: string }> {
  const app = express();
  app.get("/x", (_req, res) => {
    res.status(200).json(body);
  });
  // The same error boundary shape production uses: a throw inside the handler becomes a 500.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ code: "INTERNAL_ERROR" });
  });
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  servers.push(server);
  const addr = server.address();
  const port = typeof addr === "object" && addr !== null ? addr.port : 0;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/x`);
    return { status: res.status, text: await res.text() };
  } catch {
    // A throw inside `res.json` can abort the socket before any response is written. That is a
    // failure to serve, which is the thing being detected.
    return { status: 0, text: "connection aborted" };
  }
}

describe("the real serializer boundary", () => {
  test("a BigInt anywhere in a response body fails to serve", async () => {
    const result = await serveThrough({ transaction: { args: ["0xabc", 1790726400n] } });
    assert.notEqual(result.status, 200, "express cannot serialise a BigInt; a suite that never serves will not notice");
  });

  test("the same body with the BigInt stringified serves cleanly", async () => {
    const result = await serveThrough({ transaction: { args: ["0xabc", "1790726400"] } });
    assert.equal(result.status, 200);
    assert.match(result.text, /1790726400/);
  });

  test("a real draft-shaped response, built from the real reader, survives the real serializer", async () => {
    const call = realReader().buildRegister(AGENT, HASH, EXPIRY);
    const body = {
      transaction: {
        chainId: call.chainId,
        to: call.to,
        functionName: call.functionName,
        // Exactly what the route does. If this line is ever reverted, this test fails.
        args: call.args.map((a) => (typeof a === "bigint" ? a.toString() : a)),
        data: call.calldata,
        value: "0x0",
      },
    };
    const result = await serveThrough(body);
    assert.equal(result.status, 200);
    const parsed = JSON.parse(result.text) as { transaction: { args: unknown[] } };
    for (const a of parsed.transaction.args) assert.notEqual(typeof a, "bigint");
  });
});

describe("the decision-evidence writer's primitive types", () => {
  test("every V2 hash is a 0x-prefixed 32-byte hex string, not a Buffer or a BigInt", () => {
    const terms = {
      lineage: "ord_1",
      version: 1,
      amount: "4.00",
      asset: "USDT0",
      chain: "eip155:196",
      provider: "untch",
      capability: "owned_work.demo",
      recipient: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba",
      paramsHash: `0x${"11".repeat(32)}` as Hex,
      acceptanceHash: null,
      expiry: "2026-08-02T18:00:00.000Z",
      nonce: "1",
    };
    const snapshot = {
      policyId: "1",
      policyHash: HASH,
      owner: AGENT.toLowerCase(),
      governedAgent: AGENT.toLowerCase(),
      chainId: 196,
      registry: REGISTRY.toLowerCase(),
      currency: "USDT0",
      rules: { hardCap: 8 },
      version: 1,
      expiryAtEval: "2026-09-30T00:00:00.000Z",
      statusAtEval: "ACTIVE",
      activeAtEval: true,
      defaultForAccount: true,
      observedAt: "2026-08-02T15:00:00.000Z",
    };
    const hashes = [
      quoteDigestOf(terms),
      policySnapshotHashOf(snapshot),
      accountRefHash("acct_1"),
      RULE_MANIFEST_HASH,
    ];
    for (const h of hashes) {
      assert.equal(typeof h, "string");
      assert.match(h, /^0x[0-9a-f]{64}$/, `${h} is not a canonical 32-byte hex string`);
    }
  });

  test("the evaluator identity is strings and a number, never a symbol or a BigInt", () => {
    assert.equal(typeof ENGINE_VERSION, "string");
    assert.equal(typeof RULE_MANIFEST_HASH, "string");
    assert.equal(typeof IMPLEMENTED_RULES.length, "number");
  });

  test("a committed V2 metadata object survives the real serializer", async () => {
    const meta = metadataV2Of({
      accountRefHash: accountRefHash("acct_1"),
      quoteDigest: HASH,
      policySnapshotHash: HASH,
      policyHash: HASH,
      engineVersion: ENGINE_VERSION,
      ruleManifestHash: RULE_MANIFEST_HASH as Hex,
      intentHash: HASH,
      decision: "APPROVED",
      evaluatedAt: "2026-08-02T15:00:00.000Z",
    });
    const result = await serveThrough({ meta, commitment: metadataHashV2(meta) });
    assert.equal(result.status, 200);
  });
});

/**
 * The ledger double that produced a false finding.
 *
 * `LedgerWindowState` has `spentTodayByAgent`, `recentIntents`, `lastCallByService` and
 * `callsInLastHour`. A double returning `{daySpend, windowCalls, duplicates, lastCallAt}` type-checks
 * through an `as unknown as` cast and makes every decision BLOCKED_FAIL_CLOSED — which reads as a
 * discovery about the policy rather than a bug in the test.
 */
describe("the ledger window shape", () => {
  const REQUIRED_KEYS = ["spentTodayByAgent", "recentIntents", "lastCallByService", "callsInLastHour"] as const;

  test("the production empty-ledger shape has exactly the keys the engine reads", async () => {
    const { createLedgerState } = await import("../src/ledger-state");
    const state = await createLedgerState().ledger.read("partition");
    for (const key of REQUIRED_KEYS) {
      assert.ok(key in state, `a real ledger window must carry ${key}`);
    }
    assert.equal(typeof state.spentTodayByAgent, "number");
    assert.ok(Array.isArray(state.recentIntents));
    assert.equal(typeof state.callsInLastHour, "number");
  });

  test("a plausible-looking wrong shape fails closed rather than deciding", () => {
    const wrong = {
      daySpend: 0,
      windowCalls: [],
      duplicates: [],
      lastCallAt: null,
    } as unknown as Parameters<typeof evaluateIntent>[2];
    const policy = {
      id: "1",
      version: 1,
      status: "ACTIVE" as const,
      policyHash: HASH,
      rules: {
        budgets: { daily: 20, token: "USDT0" },
        perCallCap: 8,
        hardCap: 8,
        escalateAbove: 5,
        categories: { allow: [], deny: [] },
        recipients: { allow: [], deny: [] },
        agents: { allowWorkerIds: [], denyWorkerIds: [] },
        duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
        cooldowns: { sameServiceMin: 0 },
        rateLimit: { callsPerHour: 60 },
        expiry: "2026-09-30T00:00:00.000Z",
      },
    };
    const intent = {
      owner: AGENT.toLowerCase() as Address,
      buyerAgentId: 1n,
      workerAgentId: 2n,
      token: "0x779ded0c9e1022225f8e0630b35a9b54be713736" as Address,
      maxAmount: 4_000_000n,
      taskHash: HASH,
      acceptanceHash: HASH,
      schemaHash: HASH,
      policyHash: HASH,
      deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      nonce: 1n,
      endpoint: "https://asp.untch.xyz/owned/demo",
      paramsHash: HASH,
      recipientAddress: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba" as Address,
      category: "owned_work.demo",
      amount: 4,
    };
    const d = evaluateIntent(intent, policy, wrong);
    // The engine is right and the DOUBLE is wrong. Asserting this pins which of the two is at fault,
    // so the next person to see BLOCKED_FAIL_CLOSED checks their fixture before the policy.
    assert.equal(d.decision, "BLOCKED_FAIL_CLOSED");
  });
});

describe("public projections cannot leak by default", () => {
  test("adding a field to the evidence row does not add it to the public projection", () => {
    const withExtra = {
      decisionId: "dec_1",
      intentId: "int_1",
      intentHash: HASH,
      accountId: "acct_secret",
      accountRefHash: accountRefHash("acct_secret"),
      policyId: "1",
      policyHash: HASH,
      policySnapshotHash: HASH,
      quoteDigest: HASH,
      engineVersion: "2",
      ruleManifestHash: HASH,
      decision: "APPROVED",
      ruleTrace: [],
      evaluatedAt: "2026-08-02T15:00:00.000Z",
      metadataSchemaVersion: 2 as const,
      completeness: "V2_COMPLETE" as const,
      // A field a future migration might add without thinking about the public surface.
      internalOperatorNote: "do not publish",
    };
    const pub = publicDecisionProjection(withExtra);
    assert.equal("internalOperatorNote" in pub, false, "an allow-list projection must ignore unknown fields");
    assert.equal("accountId" in pub, false);
    assert.equal(JSON.stringify(pub).includes("acct_secret"), false);
  });
});
