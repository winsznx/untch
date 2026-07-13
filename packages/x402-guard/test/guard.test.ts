import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyDecision, guardedPay } from "../src/guard";
import type { ChallengeBinding, GuardDeps, PreflightDecision } from "../src/types";

const RESOURCE = "https://untch-asp-production.up.railway.app/preflight_payment";

const CHALLENGE = {
  x402Version: 2,
  error: "Payment required",
  resource: { url: RESOURCE, description: "Untch preflight", mimeType: "application/json" },
  accepts: [
    {
      scheme: "exact",
      network: "eip155:196",
      amount: "50000",
      asset: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
      payTo: "0x98f43eabcad380f4f1f0587ae945bc8c79e43c0b",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USD₮0",
        version: "1",
        nonce: "0xdeadbeef",
        expiry: "1893456300",
        intentHash: "0x" + "b".repeat(64),
        policyId: "42",
      },
    },
  ],
};

/** The binding a well-behaved caller authorized — matches the untampered challenge exactly. */
const AUTHORIZED: ChallengeBinding = {
  recipient: "0x98f43eabcad380f4f1f0587ae945bc8c79e43c0b",
  token: "0x779ded0c9e1022225f8e0630b35a9b54be713736",
  amount: "50000",
  resourceUrl: RESOURCE,
  endpoint: RESOURCE,
  method: "POST",
  nonce: "0xdeadbeef",
  expiry: "1893456300",
  intentHash: "0x" + "b".repeat(64),
  policyId: "42",
};

function challenge402(): Response {
  const header = Buffer.from(JSON.stringify(CHALLENGE), "utf8").toString("base64");
  return new Response("payment required", {
    status: 402,
    headers: { "payment-required": header },
  });
}

function fetchReturning(res: Response): typeof fetch {
  return (async () => res) as unknown as typeof fetch;
}

interface Spy {
  signCalls: number;
  preflightCalls: number;
}

function deps(
  decision: PreflightDecision | (() => Promise<PreflightDecision>),
  spy: Spy,
  overrides: Partial<GuardDeps> = {},
): GuardDeps {
  return {
    fetchImpl: fetchReturning(challenge402()),
    clock: () => 1_893_456_000_000,
    preflight: async () => {
      spy.preflightCalls++;
      return typeof decision === "function" ? decision() : decision;
    },
    signAndPay: async (ctx) => {
      spy.signCalls++;
      return { settled: true, paidResource: ctx.challenge.resourceUrl };
    },
    ...overrides,
  };
}

test("classifyDecision maps codes by prefix", () => {
  assert.equal(classifyDecision("APPROVED"), "APPROVE");
  assert.equal(classifyDecision("ESCALATED_THRESHOLD"), "ESCALATE");
  assert.equal(classifyDecision("BLOCKED_BUDGET"), "BLOCK");
  assert.equal(classifyDecision("REJECTED_MALFORMED"), "BLOCK");
  assert.equal(classifyDecision("anything-unknown"), "BLOCK"); // fail-closed
});

test("APPROVE: binding + preflight pass ⇒ caller's signer runs exactly once, response returned", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps({ decision: "APPROVED" }, spy),
  );
  assert.equal(out.status, "APPROVED");
  assert.equal(spy.preflightCalls, 1);
  assert.equal(spy.signCalls, 1);
  if (out.status === "APPROVED") {
    assert.deepEqual(out.response, { settled: true, paidResource: RESOURCE });
  }
});

test("BLOCK (preflight): decision withholds ⇒ signer NEVER runs", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps({ decision: "BLOCKED_BUDGET", reasons: ["daily budget exceeded"] }, spy),
  );
  assert.equal(out.status, "BLOCKED");
  if (out.status === "BLOCKED") assert.equal(out.code, "BLOCKED_BUDGET");
  assert.equal(spy.preflightCalls, 1);
  assert.equal(spy.signCalls, 0);
});

test("ESCALATE: returns a poll handle IMMEDIATELY, never blocks, signer NEVER runs", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps(
      { decision: "ESCALATED_THRESHOLD", receiptRef: { receiptId: "0x" + "9".repeat(64), status: "QUEUED" } },
      spy,
    ),
  );
  assert.equal(out.status, "ESCALATED");
  assert.equal(spy.signCalls, 0);
  if (out.status === "ESCALATED") {
    assert.equal(out.pollHandle.id, "0x" + "9".repeat(64));
    assert.equal(out.pollHandle.reason, "ESCALATED_THRESHOLD");
    const state = await out.pollHandle.poll();
    assert.equal(state.status, "PENDING"); // no resolver ⇒ still pending, never a silent approve
  }
});

test("ESCALATE poll() consults an injected resolver without the guard ever waiting", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps({ decision: "ESCALATED_PER_CALL_CAP", intentHash: "0x" + "7".repeat(64) }, spy, {
      escalationResolver: async ({ reason }) => ({ status: "DENIED", reason }),
    }),
  );
  assert.equal(out.status, "ESCALATED");
  if (out.status === "ESCALATED") {
    assert.equal(out.pollHandle.id, "0x" + "7".repeat(64)); // falls back to intentHash
    const state = await out.pollHandle.poll();
    assert.equal(state.status, "DENIED");
  }
});

test("CBC gate: a tampered recipient BLOCKS before preflight is ever paid AND before signing", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const tampered: ChallengeBinding = {
    ...AUTHORIZED,
    recipient: "0x9999999999999999999999999999999999999999", // caller authorized a DIFFERENT recipient
  };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: tampered },
    deps({ decision: "APPROVED" }, spy), // even though preflight WOULD approve
  );
  assert.equal(out.status, "BLOCKED");
  if (out.status === "BLOCKED") {
    assert.equal(out.code, "REJECTED_BINDING");
    assert.ok(out.binding && out.binding.ok === false && out.binding.field === "recipient");
  }
  assert.equal(spy.preflightCalls, 0, "preflight must not be paid for on a failed binding");
  assert.equal(spy.signCalls, 0, "signer must never run on a failed binding");
});

test("fail-closed: a preflight that throws ⇒ BLOCKED, signer NEVER runs", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps(
      () => {
        throw new Error("preflight endpoint 503");
      },
      spy,
    ),
  );
  assert.equal(out.status, "BLOCKED");
  if (out.status === "BLOCKED") assert.equal(out.code, "PREFLIGHT_UNAVAILABLE");
  assert.equal(spy.signCalls, 0);
});

test("fail-closed: a non-402 response ⇒ BLOCKED (no challenge to verify)", async () => {
  const spy: Spy = { signCalls: 0, preflightCalls: 0 };
  const out = await guardedPay(
    { url: RESOURCE, method: "POST", expectedBinding: AUTHORIZED },
    deps({ decision: "APPROVED" }, spy, {
      fetchImpl: fetchReturning(new Response("ok", { status: 200 })),
    }),
  );
  assert.equal(out.status, "BLOCKED");
  if (out.status === "BLOCKED") assert.equal(out.code, "NO_402_CHALLENGE");
  assert.equal(spy.preflightCalls, 0);
  assert.equal(spy.signCalls, 0);
});

test("no-private-key property: GuardDeps exposes only signAndPay; signing is the sole key surface", () => {
  // Structural guarantee — the guard is handed a signing CALLBACK, never key material. This test
  // documents the contract: the only signing-capable field on GuardDeps is `signAndPay`, and the guard
  // decides only WHETHER to invoke it (proven above: it runs on APPROVE only, never on BLOCK/ESCALATE).
  const d: GuardDeps = {
    preflight: async () => ({ decision: "APPROVED" }),
    signAndPay: async () => ({}),
  };
  assert.equal(typeof d.signAndPay, "function");
  assert.ok(!("privateKey" in d) && !("key" in d) && !("signer" in d));
});
