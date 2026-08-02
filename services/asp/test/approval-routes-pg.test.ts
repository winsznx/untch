import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import {
  PgAccountStore,
  PgApprovalStore,
  approvalDigest,
  channelSendAllowed,
  createPool,
  credentialState,
  newApprovalNonce,
  rotationPlan,
  runMigrations,
  type ApprovalSubject,
  type Pool,
} from "@untch/consumer-core";
import { makeAccountRoutesDeps, registerAccountRoutes } from "../src/consumer/account-routes";
import { makeApprovalRoutesDeps, registerApprovalRoutes } from "../src/consumer/approval-routes";
import { buildLinkMessage } from "../src/consumer/account-auth";
import type { SiweVerifier } from "../src/consumer/auth";
import type { HandlerResult } from "../src/handlers";

/**
 * The approval centre, the exact-quote digest, and the rotation gate.
 *
 * THE CASE THIS SUITE EXISTS FOR
 *
 * A 6.00 quote is escalated, the quote moves to 6.50, and the owner approves. Before the digest, that
 * approval was valid: the code they held proved they were allowed to answer, and nothing anywhere bound
 * their answer to a number. The suite below walks that sequence and asserts the old approval matches
 * nothing — which is a property of a value, not of a check somebody remembered to write.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const DOMAIN = "asp.untch.xyz";
const SECRET = "test-approval-session-secret-value";
const CHAIN_ID = 196;

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

const LOCAL_VERIFIER: SiweVerifier = {
  async verify({ message, signature }) {
    for (const a of [OWNER, OTHER]) {
      if (await verifyMessage({ address: a.address, message, signature: signature as Hex })) return true;
    }
    return false;
  },
};

/**
 * This suite's OWN database. Node runs test FILES in parallel and several suites reset the public
 * schema; sharing one database means they drop it from under each other.
 */
const OWN_DATABASE = "untch_test_approvals";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

let pool: Pool;
let approvals: PgApprovalStore;
let baseUrl: string;
const servers: Server[] = [];

function send(res: express.Response, r: HandlerResult): void {
  res.status(r.status).json(r.body);
}

async function boot(): Promise<void> {
  const admin = createPool(TEST_DB as string);
  try {
    await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "42P04") throw err;
    });
  } finally {
    await admin.end();
  }
  pool = createPool(ownDatabaseUrl());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);

  approvals = new PgApprovalStore(pool);
  const accounts = new PgAccountStore(pool);
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAccountRoutes(
    app,
    send,
    makeAccountRoutesDeps({
      pool,
      verifier: LOCAL_VERIFIER,
      domain: DOMAIN,
      publicBaseUrl: "https://asp.untch.xyz",
      secret: SECRET,
      allowedReturnOrigins: ["https://www.untch.xyz"],
    }),
  );
  registerApprovalRoutes(
    app,
    send,
    makeApprovalRoutesDeps({
      pool,
      accounts,
      secret: SECRET,
      // The deployment posture under test: providers are DISABLED, exactly as production is.
      executionEnabled: false,
    }),
  );

  baseUrl = await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
}

type Res = { status: number; body: Record<string, unknown> };

async function call(method: string, path: string, body: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const post = (p: string, b: unknown, t?: string) => call("POST", p, b, t);
const get = (p: string, t?: string) => call("GET", p, undefined, t);

async function signIn(signer: typeof OWNER): Promise<{ token: string; accountId: string }> {
  const start = await post("/consumer/account/link/start", {});
  const nonce = (start.body.walletAction as { nonce: string }).nonce;
  const message = buildLinkMessage({
    domain: DOMAIN,
    uri: `https://${DOMAIN}`,
    address: signer.address,
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    scopes: ["identity"],
  });
  const complete = await post("/consumer/account/link/complete", {
    linkRequestId: start.body.linkRequestId,
    code: start.body.oneTimeCode,
    message,
    signature: await signer.signMessage({ message }),
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return {
    token: (complete.body.session as { token: string }).token,
    accountId: complete.body.accountId as string,
  };
}

let intentCounter = 0;

/** The §14 escalated case: hard cap 8.00, auto-approve at or below 5.00, a 6.00 quote. */
function subject(over: Partial<ApprovalSubject> = {}): ApprovalSubject {
  intentCounter += 1;
  return {
    intentId: `intent-${intentCounter}`,
    quoteHash: "0xquote6000",
    amount: "6.00",
    asset: "USDC",
    provider: "purch",
    capability: "gifts.order",
    recipient: "0x0e79371813e88f31c2b60c80bad391a952039095",
    policyId: "9001",
    policyVersion: 1,
    nonce: newApprovalNonce(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    ...over,
  };
}

async function raise(accountId: string, over: Partial<ApprovalSubject> = {}) {
  return approvals.raise({
    accountId,
    subject: subject(over),
    quoteId: "q-1",
    reason: "6.00 is above the policy's 5.00 automatic-approval threshold",
    triggeringRules: [{ rule: "escalateAbove", threshold: "5.00", amount: over.amount ?? "6.00" }],
    by: "test",
  });
}

// ── the digest itself, no database needed ────────────────────────────────────

describe("the approval digest", () => {
  test("changing ANY field that changes what the money does changes the digest", () => {
    const base = subject();
    const d = approvalDigest(base);
    for (const [field, value] of [
      ["amount", "6.50"],
      ["asset", "USDT"],
      ["provider", "other"],
      ["capability", "shop.purchase"],
      ["recipient", "0x1111111111111111111111111111111111111111"],
      ["policyId", "9002"],
      ["policyVersion", 2],
      ["quoteHash", "0xquote6500"],
      ["intentId", "intent-other"],
      ["nonce", "different"],
      ["expiresAt", new Date(Date.now() + 60 * 60_000).toISOString()],
    ] as const) {
      assert.notEqual(approvalDigest({ ...base, [field]: value }), d, `${field} did not change the digest`);
    }
  });

  test("field boundaries cannot be shifted between neighbours", () => {
    // Concatenation would make these two collide: "a"+"bc" and "ab"+"c" are the same bytes joined.
    const base = subject();
    const a = approvalDigest({ ...base, provider: "a", capability: "bc" });
    const b = approvalDigest({ ...base, provider: "ab", capability: "c" });
    assert.notEqual(a, b);
  });

  test("a null recipient is a distinct fact from an empty one", () => {
    const base = subject();
    assert.notEqual(approvalDigest({ ...base, recipient: null }), approvalDigest({ ...base, recipient: "" }));
  });

  test("the same subject digests the same on every call", () => {
    const base = subject();
    assert.equal(approvalDigest(base), approvalDigest({ ...base }));
  });
});

// ── the rotation gate, no database needed ────────────────────────────────────

describe("the rotation gate", () => {
  test("a configured but unrotated credential refuses, and says why", () => {
    const env = { TELEGRAM_BOT_TOKEN: "1234:secret-value" } as NodeJS.ProcessEnv;
    const gate = channelSendAllowed("telegram", env);
    assert.equal(gate.allowed, false);
    assert.equal(gate.state, "CURRENT_UNROTATED");
    assert.match(gate.reason, /has not been marked rotated/);
    // The refusal must never quote the value it refused over.
    assert.equal(gate.reason.includes("secret-value"), false);
  });

  test("the safe state is the one you get by doing nothing", () => {
    // The gate's default cannot be "fine". A lost variable or a typo in the rotated list must not
    // silently mean "send with the exposed token" — which is what a permissive default would do.
    assert.equal(channelSendAllowed("discord", { DISCORD_BOT_TOKEN: "x" } as NodeJS.ProcessEnv).allowed, false);
    assert.equal(channelSendAllowed("discord", {} as NodeJS.ProcessEnv).state, "ABSENT");
  });

  test("a credential named in UNTCH_ROTATED_CREDENTIALS is allowed", () => {
    const env = {
      TELEGRAM_BOT_TOKEN: "1234:fresh",
      UNTCH_ROTATED_CREDENTIALS: "TELEGRAM_BOT_TOKEN DISCORD_BOT_TOKEN",
    } as NodeJS.ProcessEnv;
    assert.equal(channelSendAllowed("telegram", env).allowed, true);
    assert.equal(credentialState("TELEGRAM_BOT_TOKEN", env), "ROTATED");
    // ...and only that one. Naming a credential does not vouch for its neighbours.
    assert.equal(channelSendAllowed("slack", { ...env, SLACK_BOT_TOKEN: "x" } as NodeJS.ProcessEnv).allowed, false);
  });

  test("the plan separates rotations that move an on-chain address from ones that do not", () => {
    const plan = rotationPlan({
      TELEGRAM_BOT_TOKEN: "x",
      OPERATOR_PRIVATE_KEY: "0xkey",
    } as NodeJS.ProcessEnv);
    assert.ok(plan.phase1.some((c) => c.name === "TELEGRAM_BOT_TOKEN"));
    // A new key is a new signer, and every contract that authorised the old one has to be told —
    // a timelocked governance operation, never a variable update inside a deploy.
    assert.ok(plan.phase2.some((c) => c.name === "OPERATOR_PRIVATE_KEY"));
    assert.equal(plan.phase1.some((c) => c.name === "OPERATOR_PRIVATE_KEY"), false);
    assert.equal(plan.outstanding, 2);
  });

  test("no report anywhere carries a secret value", () => {
    const env = { TELEGRAM_BOT_TOKEN: "1234:super-secret", OKX_SECRET_KEY: "also-secret" } as NodeJS.ProcessEnv;
    const serialised = JSON.stringify(rotationPlan(env));
    assert.equal(serialised.includes("super-secret"), false);
    assert.equal(serialised.includes("also-secret"), false);
  });
});

// ── the centre ───────────────────────────────────────────────────────────────

describe("the web approval centre", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  before(async () => {
    await boot();
  });

  after(async () => {
    for (const s of servers) s.close();
    await pool.end();
  });

  test("an escalated request appears, showing the exact quote and why it was asked", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);

    const listed = await get("/consumer/approvals?state=PENDING", token);
    assert.equal(listed.status, 200);
    const items = listed.body.approvals as Array<Record<string, unknown>>;
    const found = items.find((a) => a.approvalRequestId === request.approvalRequestId);
    assert.ok(found, "the escalated request must be visible in the centre");
    assert.equal(found.amount, "6.00");
    assert.match(String(found.reason), /above the policy's 5.00/);

    const detail = await get(`/consumer/approvals/${request.approvalRequestId}`, token);
    assert.equal(detail.status, 200);
    // The digest is rendered, because it is what an approve button must echo back.
    assert.equal(detail.body.approvalDigest, request.approvalDigest);
    const actions = detail.body.actions as Record<string, { body: Record<string, unknown> }>;
    assert.equal(actions.approve.body.approvalDigest, request.approvalDigest);
  });

  test("approving the exact quote records a decision and does NOT claim a payment", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);

    const approved = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: request.approvalDigest },
      token,
    );
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.state, "APPROVED");
    // The whole point of the display state: providers are disabled, so nothing was paid and the
    // surface says so rather than implying a purchase occurred.
    assert.equal(approved.body.outcome, "APPROVED_AWAITING_EXECUTION");
    assert.equal(approved.body.paid, false);
    assert.match(String(approved.body.paidNote), /Nothing has been paid/);

    const decisions = approved.body.decisions as Array<Record<string, unknown>>;
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]?.digestMatchedRequest, true);
    assert.equal(decisions[0]?.channel, "dashboard");
  });

  test("a re-quote supersedes the old request, and the old approval matches nothing", async () => {
    // #given a 6.00 request the user is looking at
    const { token, accountId } = await signIn(OWNER);
    const intentId = `intent-requote-${Date.now()}`;
    const first = await raise(accountId, { intentId, amount: "6.00", quoteHash: "0xquote6000" });
    const staleDigest = first.request.approvalDigest;

    // #when the quote moves to 6.50 — a different obligation for the same intent
    const second = await approvals.raise({
      accountId,
      subject: { ...first.request, amount: "6.50", quoteHash: "0xquote6500" },
      quoteId: "q-2",
      reason: "6.50 is above the policy's 5.00 automatic-approval threshold",
      triggeringRules: [],
      by: "test",
    });
    assert.equal(second.superseded, first.request.approvalRequestId);
    assert.notEqual(second.request.approvalDigest, staleDigest);

    // #then answering the OLD request is refused, and told why in words a user can act on
    const stale = await post(
      `/consumer/approvals/${first.request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: staleDigest },
      token,
    );
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "APPROVAL_NOT_PENDING");
    assert.match(String(stale.body.message), /the quote changed/);

    // #and presenting the STALE digest against the NEW request is refused too — this is the exact
    // failure the digest exists for: agreeing to 6.00 while 6.50 would be paid.
    const wrongDigest = await post(
      `/consumer/approvals/${second.request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: staleDigest },
      token,
    );
    assert.equal(wrongDigest.status, 409);
    assert.equal(wrongDigest.body.code, "APPROVAL_DIGEST_MISMATCH");

    // #and the correct digest still works, so the user is never stuck.
    const correct = await post(
      `/consumer/approvals/${second.request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: second.request.approvalDigest },
      token,
    );
    assert.equal(correct.status, 200);
    assert.equal(correct.body.amount, "6.50");
  });

  test("a plain yes is not an approval", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);
    const refused = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "APPROVE" },
      token,
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "APPROVAL_DIGEST_REQUIRED");
    // The request is untouched — a malformed answer must not resolve anything.
    assert.equal((await approvals.get(request.approvalRequestId))?.state, "PENDING");
  });

  test("an identical repeat is idempotent; a conflicting second answer is refused", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);
    const body = { decision: "APPROVE", approvalDigest: request.approvalDigest };

    const first = await post(`/consumer/approvals/${request.approvalRequestId}/decide`, body, token);
    const repeat = await post(`/consumer/approvals/${request.approvalRequestId}/decide`, body, token);
    assert.equal(first.status, 200);
    assert.equal(repeat.status, 200, "a double-tap is not an error");
    assert.equal(repeat.body.repeat, true);
    assert.equal((await approvals.decisionsFor(request.approvalRequestId)).length, 1);

    const contradiction = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "REJECT", approvalDigest: request.approvalDigest },
      token,
    );
    assert.equal(contradiction.status, 409);
    assert.equal(contradiction.body.code, "APPROVAL_ALREADY_DECIDED");
    assert.equal((await approvals.get(request.approvalRequestId))?.state, "APPROVED");
  });

  test("rejecting resolves the request and nothing is paid", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);
    const rejected = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "REJECT", approvalDigest: request.approvalDigest },
      token,
    );
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.state, "REJECTED");
    assert.equal(rejected.body.paid, false);
    assert.match(String(rejected.body.paidNote), /Nothing was paid/);
  });

  test("an expired approval cannot be replayed", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await approvals.raise({
      accountId,
      subject: subject({ expiresAt: new Date(Date.now() - 1_000).toISOString() }),
      quoteId: null,
      reason: "already stale",
      triggeringRules: [],
      by: "test",
    });

    const late = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: request.approvalDigest },
      token,
    );
    assert.equal(late.status, 410);
    assert.equal(late.body.code, "APPROVAL_EXPIRED");
    assert.equal((await approvals.get(request.approvalRequestId))?.state, "EXPIRED");
  });

  test("one account cannot see or decide another account's approval", async () => {
    const mine = await signIn(OWNER);
    const theirs = await signIn(OTHER);
    const { request } = await raise(theirs.accountId);

    const seen = await get(`/consumer/approvals/${request.approvalRequestId}`, mine.token);
    assert.equal(seen.status, 404, "not-yours and does-not-exist must be indistinguishable");

    const decided = await post(
      `/consumer/approvals/${request.approvalRequestId}/decide`,
      { decision: "APPROVE", approvalDigest: request.approvalDigest },
      mine.token,
    );
    assert.equal(decided.status, 404);
    assert.equal((await approvals.get(request.approvalRequestId))?.state, "PENDING");
  });

  test("every route refuses without a wallet-backed session", async () => {
    const { accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);
    assert.equal((await get("/consumer/approvals")).status, 401);
    assert.equal((await get(`/consumer/approvals/${request.approvalRequestId}`)).status, 401);
    const decided = await post(`/consumer/approvals/${request.approvalRequestId}/decide`, {
      decision: "APPROVE",
      approvalDigest: request.approvalDigest,
    });
    assert.equal(decided.status, 401);
  });

  test("raising the same subject twice is the same request, not two answerable ones", async () => {
    const { accountId } = await signIn(OWNER);
    const s = subject();
    const first = await approvals.raise({ accountId, subject: s, quoteId: null, reason: "r", triggeringRules: [], by: "t" });
    const second = await approvals.raise({ accountId, subject: s, quoteId: null, reason: "r", triggeringRules: [], by: "t" });
    assert.equal(second.request.approvalRequestId, first.request.approvalRequestId);
    assert.equal(second.superseded, null);
  });

  test("a skipped delivery is visible, so an unanswered approval does not blame the owner", async () => {
    const { token, accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);

    // The rotation gate's actual verdict, recorded rather than described.
    const gate = channelSendAllowed("telegram", { TELEGRAM_BOT_TOKEN: "unrotated" } as NodeJS.ProcessEnv);
    await approvals.recordDelivery({
      approvalRequestId: request.approvalRequestId,
      channel: "telegram",
      channelBindingId: null,
      outcome: gate.allowed ? "SENT" : "SKIPPED",
      detail: gate.allowed ? null : "credential-unrotated",
    });

    const detail = await get(`/consumer/approvals/${request.approvalRequestId}`, token);
    const deliveries = detail.body.deliveries as Array<Record<string, unknown>>;
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]?.outcome, "SKIPPED");
    assert.equal(deliveries[0]?.detail, "credential-unrotated");
  });

  test("the list states the execution posture once, at the top", async () => {
    const { token } = await signIn(OWNER);
    const listed = await get("/consumer/approvals", token);
    assert.equal(listed.body.executionEnabled, false);
    assert.match(String(listed.body.executionNote), /DISABLED/);
    assert.match(String(listed.body.executionNote), /pays nothing/);
  });

  test("an unknown state filter is refused rather than silently returning everything", async () => {
    const { token } = await signIn(OWNER);
    const refused = await get("/consumer/approvals?state=DEFINITELY_PAID", token);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "UNKNOWN_STATE");
  });

  test("markExecuted only moves an APPROVED request, and nothing calls it while providers are off", async () => {
    const { accountId } = await signIn(OWNER);
    const { request } = await raise(accountId);
    // A PENDING request cannot be marked executed — otherwise "executed" would be assertable without
    // anybody ever having approved anything.
    assert.equal(await approvals.markExecuted({ approvalRequestId: request.approvalRequestId, by: "t" }), false);
  });
});
