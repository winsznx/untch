import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { createPool, runMigrations, type Pool } from "@untch/consumer-core";
import { makeAccountRoutesDeps, registerAccountRoutes } from "../src/consumer/account-routes";
import { registerMarketplaceRoutes, readClaim } from "../src/consumer/marketplace-continuity";
import { buildLinkMessage } from "../src/consumer/account-auth";
import type { SiweVerifier } from "../src/consumer/auth";
import type { HandlerResult } from "../src/handlers";

/**
 * Marketplace continuity: the same account, reached from OKX and from the web.
 *
 * The demo this suite is: a marketplace call arrives with an agent id nobody has proven, gets
 * ACCOUNT_LINK_REQUIRED, the person signs with their wallet, and the SAME account then answers for
 * that agent id — with the task visible on it.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const DOMAIN = "asp.untch.xyz";
const SECRET = "test-marketplace-session-secret";
const CHAIN_ID = 196;
const OWN_DATABASE = "untch_test_marketplace";

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

const LOCAL_VERIFIER: SiweVerifier = {
  async verify({ message, signature }) {
    for (const a of [OWNER, STRANGER]) {
      if (await verifyMessage({ address: a.address, message, signature: signature as Hex })) return true;
    }
    return false;
  },
};

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

let pool: Pool;
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

  const deps = makeAccountRoutesDeps({
    pool,
    verifier: LOCAL_VERIFIER,
    domain: DOMAIN,
    publicBaseUrl: "https://asp.untch.xyz",
    secret: SECRET,
    allowedReturnOrigins: ["https://www.untch.xyz"],
  });

  const app = express();
  app.use(express.json({ limit: "64kb" }));
  registerAccountRoutes(app, send, deps);
  registerMarketplaceRoutes(app, send, {
    accounts: deps.accounts,
    links: deps.links,
    publicBaseUrl: deps.publicBaseUrl,
    allowedReturnOrigins: deps.allowedReturnOrigins,
  });

  baseUrl = await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
}

type Res = { status: number; body: Record<string, unknown> };

async function post(path: string, body: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, token: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Complete a link request the way a person would after opening the link. */
async function completeLink(
  linkRequestId: string,
  oneTimeCode: string,
  signer: typeof OWNER,
): Promise<Res> {
  // The nonce lives on the link request; a real client reads it from the /link page. The message is
  // built the same way the server builds it, which is the point — the fields are the bindings.
  const { rows } = await pool.query<{ siwe_nonce: string }>(
    "SELECT siwe_nonce FROM untch_account_link_requests WHERE link_request_id = $1",
    [linkRequestId],
  );
  const nonce = rows[0]?.siwe_nonce as string;
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
  return post("/consumer/account/link/complete", {
    linkRequestId,
    code: oneTimeCode,
    message,
    signature: await signer.signMessage({ message }),
  });
}

describe("marketplace continuity", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  before(async () => {
    await boot();
  });

  after(async () => {
    for (const s of servers) s.close();
    await pool.end();
  });

  test("an unlinked marketplace call is refused with everything needed to fix it", async () => {
    const res = await post("/consumer/marketplace/resolve", {
      marketplace: "okx",
      agentId: "6047",
      taskRef: "task-1",
      serviceOrderRef: "order-1",
    });

    // 409, not 401: there is nothing wrong with the caller's credentials — there are none, and that
    // is a state to move out of rather than an authentication failure to retry.
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "ACCOUNT_LINK_REQUIRED");
    assert.ok(res.body.linkRequestId, "the refusal must carry the way forward");
    assert.ok(res.body.linkUrl);
    assert.ok(res.body.oneTimeCode);
    assert.ok(res.body.expiresAt);
    assert.match(String(res.body.nextStep), /approves a payment/);

    // The task is echoed so a client can show WHICH job is being interrupted.
    const ctx = res.body.marketplaceContext as Record<string, unknown>;
    assert.equal(ctx.taskRef, "task-1");
    assert.equal(ctx.verifiedByHost, false, "OKX exposes no request signing this host can check");
  });

  test("after linking, the same agent id resolves to the same account the web session sees", async () => {
    // #given an unlinked marketplace call
    const refused = await post("/consumer/marketplace/resolve", {
      marketplace: "okx",
      agentId: "7100",
      taskRef: "task-7100",
      serviceOrderRef: "order-7100",
    });
    assert.equal(refused.status, 409);

    // #when the person opens the link and signs with their wallet
    const linked = await completeLink(
      refused.body.linkRequestId as string,
      refused.body.oneTimeCode as string,
      OWNER,
    );
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const accountId = linked.body.accountId as string;
    const token = (linked.body.session as { token: string }).token;

    // #then the marketplace call resolves — to the SAME account
    const resolved = await post("/consumer/marketplace/resolve", {
      marketplace: "okx",
      agentId: "7100",
      taskRef: "task-7100",
    });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.code, "RESOLVED");
    assert.equal(resolved.body.accountId, accountId);

    // #and the web dashboard sees the same account, carrying that marketplace binding
    const seen = await get("/consumer/account", token);
    assert.equal(seen.body.accountId, accountId);
    const bindings = seen.body.marketplaceBindings as Array<Record<string, unknown>>;
    const binding = bindings.find((b) => b.agentId === "7100");
    assert.ok(binding, "the marketplace identity must be visible on the account");
    assert.equal(binding.carriesAuthority, true);
    assert.equal(binding.taskRef, "task-7100");

    // #and the marketplace-created task is reconciled to the account
    const { rows } = await pool.query<{ account_id: string; agent_id: string }>(
      "SELECT account_id, agent_id FROM untch_marketplace_jobs WHERE job_id = $1",
      ["task-7100"],
    );
    assert.equal(rows[0]?.account_id, accountId, "the job created on OKX belongs to the web account");
  });

  test("resolving tells the caller whether a preflight naming no policy would work", async () => {
    const refused = await post("/consumer/marketplace/resolve", { marketplace: "okx", agentId: "7200" });
    await completeLink(refused.body.linkRequestId as string, refused.body.oneTimeCode as string, STRANGER);

    const resolved = await post("/consumer/marketplace/resolve", { marketplace: "okx", agentId: "7200" });
    assert.equal(resolved.body.policySelected, false);
    // One round trip, rather than a refusal three calls later.
    assert.match(String(resolved.body.nextStep), /no default policy/);
  });

  test("an agent id nobody proved cannot be claimed by a second wallet", async () => {
    const first = await post("/consumer/marketplace/resolve", { marketplace: "okx", agentId: "7300" });
    await completeLink(first.body.linkRequestId as string, first.body.oneTimeCode as string, OWNER);

    // A different wallet trying to adopt the same agent id starts its own link request…
    const second = await post("/consumer/marketplace/resolve", { marketplace: "okx", agentId: "7300" });
    // …but the identity already resolves, so it never gets one.
    assert.equal(second.status, 200);
    assert.equal(second.body.code, "RESOLVED");
  });

  test("a claim read from a body is never marked verified", () => {
    // A field that says "verified" because something was PRESENT is the exact mistake. OKX exposes no
    // request-signing scheme this host can check, so every agent id arriving here is unverified.
    const claim = readClaim({ agentId: "9999", marketplace: "okx", taskRef: "t" });
    assert.equal(claim?.verifiedByHost, false);
    assert.equal(readClaim({}), null, "a body with no agentId is not a claim");
  });

  test("an unlinked call records the agent id for audit without granting it anything", async () => {
    await post("/consumer/marketplace/resolve", { marketplace: "okx", agentId: "7400", taskRef: "task-7400" });
    // The link request holds the claim as CONTEXT. No marketplace binding exists yet, so nothing
    // resolves — the claim has somewhere to live without having become an authority.
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM untch_marketplace_bindings WHERE agent_id = $1",
      ["7400"],
    );
    assert.equal(rows[0]?.count, "0");
    const stored = await pool.query<{ marketplace_agent_id: string }>(
      "SELECT marketplace_agent_id FROM untch_account_link_requests WHERE marketplace_agent_id = $1",
      ["7400"],
    );
    assert.equal(stored.rows.length, 1);
  });

  test("a request with no agentId is refused rather than guessed at", async () => {
    const res = await post("/consumer/marketplace/resolve", { marketplace: "okx" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "AGENT_ID_REQUIRED");
  });
});
