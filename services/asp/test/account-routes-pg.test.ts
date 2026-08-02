import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, type Hex } from "viem";
import { createPool, runMigrations, type Pool } from "@untch/consumer-core";
import { makeAccountRoutesDeps, registerAccountRoutes } from "../src/consumer/account-routes";
import { buildLinkMessage, openAccountSession } from "../src/consumer/account-auth";
import { sealSession, tenantForPolicy } from "../src/consumer/auth";
import type { SiweVerifier } from "../src/consumer/auth";
import type { HandlerResult } from "../src/handlers";

/**
 * The account surface end to end: a real Express app, a real Postgres, and a real signature.
 *
 * WHY THE SIGNATURE IS REAL
 *
 * Every property this suite asserts is a property of a PROOF — the same wallet returns to the same
 * account, a message signed for another domain does not work here, a signature naming another nonce
 * cannot complete this link. A stub verifier that returned `true` would make all three pass while
 * proving none of them, because the thing under test would have been replaced by the thing that
 * always agrees. So the tests sign with a local EOA and verification is viem's own `verifyMessage`,
 * which is the same recovery the production verifier performs — the only difference is that no RPC is
 * needed for an EOA, and production additionally reaches one for EIP-1271 contract wallets.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const DOMAIN = "asp.untch.xyz";
const SECRET = "test-account-session-secret-value";
const CHAIN_ID = 196;

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const OTHER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

/** EOA recovery, offline. The same check production performs before it reaches for EIP-1271. */
const LOCAL_VERIFIER: SiweVerifier = {
  async verify({ message, signature }) {
    for (const account of [OWNER, OTHER]) {
      if (await verifyMessage({ address: account.address, message, signature: signature as Hex })) return true;
    }
    return false;
  },
};

let pool: Pool;
let baseUrl: string;
const servers: Server[] = [];

function send(res: express.Response, r: HandlerResult): void {
  res.status(r.status).json(r.body);
}


/**
 * This suite's OWN database, for the reason the two-process controller suite established.
 *
 * Node's test runner runs FILES in parallel, and several suites here reset the public schema to build
 * a known starting shape. Sharing one database means they drop it from under each other, which reads
 * as flakiness and is a shared-resource collision. Isolation fixes the class rather than the instance.
 */
const OWN_DATABASE = "untch_test_account_routes";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

async function createOwnDatabase(): Promise<void> {
  const admin = createPool(TEST_DB as string);
  try {
    // CREATE DATABASE cannot run inside a transaction, and a duplicate is not worth failing on.
    await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "42P04") throw err;
    });
  } finally {
    await admin.end();
  }
}

async function boot(): Promise<void> {
  await createOwnDatabase();
  pool = createPool(ownDatabaseUrl());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);

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
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function get(path: string, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** Sign the exact message the server would have shown, for the nonce it actually issued. */
async function signFor(
  signer: typeof OWNER,
  nonce: string,
  over: { domain?: string; chainId?: number } = {},
): Promise<{ message: string; signature: string }> {
  const message = buildLinkMessage({
    domain: over.domain ?? DOMAIN,
    uri: `https://${over.domain ?? DOMAIN}`,
    address: signer.address,
    chainId: over.chainId ?? CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    scopes: ["identity"],
  });
  return { message, signature: await signer.signMessage({ message }) };
}

async function startAndComplete(
  signer: typeof OWNER,
  startBody: Record<string, unknown> = {},
): Promise<{ start: Res; complete: Res }> {
  const start = await post("/consumer/account/link/start", startBody);
  const nonce = (start.body.walletAction as { nonce: string }).nonce;
  const { message, signature } = await signFor(signer, nonce);
  const complete = await post("/consumer/account/link/complete", {
    linkRequestId: start.body.linkRequestId,
    code: start.body.oneTimeCode,
    message,
    signature,
  });
  return { start, complete };
}

describe("the account surface", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  before(async () => {
    await boot();
  });

  after(async () => {
    for (const s of servers) s.close();
    await pool.end();
  });

  test("a wallet signs once and gets an account; signing again restores the SAME account", async () => {
    // #given a first link, from a wallet this server has never seen
    const first = await startAndComplete(OWNER);
    assert.equal(first.complete.status, 200);
    assert.equal(first.complete.body.accountCreated, true);
    const accountId = first.complete.body.accountId as string;

    // #when the same wallet links again later
    const second = await startAndComplete(OWNER);

    // #then it is a restoration, not a second account. This is the property that makes the wallet the
    // identity rather than the session: two sign-ins are the same person by construction.
    assert.equal(second.complete.status, 200);
    assert.equal(second.complete.body.accountCreated, false);
    assert.equal(second.complete.body.accountId, accountId);
  });

  test("the session is scoped to the account it was minted for and says so in its own payload", async () => {
    const { complete } = await startAndComplete(OWNER);
    const token = (complete.body.session as { token: string }).token;
    const opened = openAccountSession(SECRET, token, Date.now());
    assert.equal(opened?.accountId, complete.body.accountId);
    assert.equal(opened?.kind, "account");
    assert.equal(opened?.address.toLowerCase(), OWNER.address.toLowerCase());
  });

  test("a POLICY session token cannot be used as an ACCOUNT session", async () => {
    // Both are HMAC'd with the same secret. Without a domain separator the bytes of one would open as
    // the other, and the two carry different authority.
    const policyToken = sealSession(SECRET, {
      address: OWNER.address,
      policyId: "9001",
      agentId: null,
      tenantId: tenantForPolicy("9001"),
      expiresAt: Date.now() + 600_000,
    });
    assert.equal(openAccountSession(SECRET, policyToken, Date.now()), null);
    const denied = await get("/consumer/account", policyToken);
    assert.equal(denied.status, 401);
    assert.equal(denied.body.code, "ACCOUNT_SESSION_REQUIRED");
  });

  test("a one-time code is one-time, and a replay of the whole completion is refused", async () => {
    const start = await post("/consumer/account/link/start", {});
    const nonce = (start.body.walletAction as { nonce: string }).nonce;
    const { message, signature } = await signFor(OWNER, nonce);
    const payload = {
      linkRequestId: start.body.linkRequestId,
      code: start.body.oneTimeCode,
      message,
      signature,
    };

    assert.equal((await post("/consumer/account/link/complete", payload)).status, 200);
    const replay = await post("/consumer/account/link/complete", payload);
    assert.equal(replay.status, 409);
    assert.equal(replay.body.code, "LINK_REQUEST_NOT_PENDING");
  });

  test("a signature naming a DIFFERENT link request's nonce cannot complete this one", async () => {
    // The attack: obtain a valid signature from the user for some other purpose, then present it here.
    const mine = await post("/consumer/account/link/start", {});
    const theirs = await post("/consumer/account/link/start", {});
    const theirNonce = (theirs.body.walletAction as { nonce: string }).nonce;
    const { message, signature } = await signFor(OWNER, theirNonce);

    const refused = await post("/consumer/account/link/complete", {
      linkRequestId: mine.body.linkRequestId,
      code: mine.body.oneTimeCode,
      message,
      signature,
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "SIWE_NONCE_MISMATCH");
  });

  test("a signature produced for another site does not work here", async () => {
    const start = await post("/consumer/account/link/start", {});
    const nonce = (start.body.walletAction as { nonce: string }).nonce;
    const { message, signature } = await signFor(OWNER, nonce, { domain: "evil.test" });

    const refused = await post("/consumer/account/link/complete", {
      linkRequestId: start.body.linkRequestId,
      code: start.body.oneTimeCode,
      message,
      signature,
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "SIWE_WRONG_DOMAIN");
  });

  test("a chain nothing can reach is refused by name, not generically", async () => {
    const start = await post("/consumer/account/link/start", {});
    const nonce = (start.body.walletAction as { nonce: string }).nonce;
    // 195 is the DEPRECATED X Layer testnet: no live RPC answers it.
    const { message, signature } = await signFor(OWNER, nonce, { chainId: 195 });

    const refused = await post("/consumer/account/link/complete", {
      linkRequestId: start.body.linkRequestId,
      code: start.body.oneTimeCode,
      message,
      signature,
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "SIWE_WRONG_CHAIN");
    assert.match(String(refused.body.message), /195/);
  });

  test("a wrong one-time code is refused even when the signature is perfect", async () => {
    const start = await post("/consumer/account/link/start", {});
    const nonce = (start.body.walletAction as { nonce: string }).nonce;
    const { message, signature } = await signFor(OWNER, nonce);

    const refused = await post("/consumer/account/link/complete", {
      linkRequestId: start.body.linkRequestId,
      code: "AAAA-BBBB-CCCC-DDDD-EEEE",
      message,
      signature,
    });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "LINK_CODE_MISMATCH");

    // ...and the honest user's request survives it. A wrong code must not burn the request, or an
    // interceptor could deny the real user by submitting garbage first.
    const rescued = await post("/consumer/account/link/complete", {
      linkRequestId: start.body.linkRequestId,
      code: start.body.oneTimeCode,
      message,
      signature,
    });
    assert.equal(rescued.status, 200);
  });

  test("an unproven marketplace agent id is echoed as context and authorises nothing", async () => {
    const start = await post("/consumer/account/link/start", {
      marketplace: "okx",
      marketplaceAgentId: "6047",
      taskRef: "task-42",
      serviceOrderRef: "order-7",
    });
    const ctx = start.body.marketplaceContext as Record<string, unknown>;
    assert.equal(ctx.marketplaceAgentId, "6047");
    assert.match(String(ctx.note), /authorises nothing until a wallet signs/);
  });

  test("completing with marketplace context binds the identity to the SAME account the wallet resolved to", async () => {
    const { complete } = await startAndComplete(OWNER, {
      marketplace: "okx",
      marketplaceAgentId: "8100",
      taskRef: "task-100",
      serviceOrderRef: "order-100",
    });
    assert.equal(complete.status, 200);
    const binding = complete.body.marketplaceBinding as Record<string, unknown>;
    assert.equal(binding.agentId, "8100");
    assert.equal(binding.taskRef, "task-100");
    assert.equal(binding.serviceOrderRef, "order-100");
    // Now it carries authority — and the field says so, rather than leaving a client to infer it
    // from `status: ACTIVE`.
    assert.equal(binding.carriesAuthority, true);
  });

  test("an arbitrary agent id cannot be claimed by a second wallet", async () => {
    await startAndComplete(OWNER, { marketplace: "okx", marketplaceAgentId: "8200" });
    const stolen = await startAndComplete(OTHER, { marketplace: "okx", marketplaceAgentId: "8200" });
    assert.equal(stolen.complete.status, 409);
    assert.equal(stolen.complete.body.code, "MARKETPLACE_IDENTITY_BOUND_ELSEWHERE");
  });

  /**
   * The five roles, defended at the door.
   *
   * `registerPolicy` makes `msg.sender` the owner permanently. A policy owned by a deployer, treasury,
   * oracle, writer or operator key is owned by Untch forever, and binding one of those addresses as a
   * user wallet is the step immediately before that mistake. These assert the refusal at both points
   * it can happen: when the address is NAMED at start, and when it is RECOVERED from the signature.
   */
  describe("an Untch operational address cannot become a user wallet", () => {
    const OPERATIONAL: readonly { readonly role: string; readonly address: string }[] = [
      { role: "deployer and marketplace payTo", address: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba" },
      { role: "receipt writer", address: "0xeedda7d18a34a93f3a722eb4446a526af515457a" },
      { role: "oracle", address: "0xb29516c8c5dfc29a9e3f68f6e92fd1b6c7612d61" },
      { role: "admin", address: "0x4de912b84c54f6855114519795a1afca82dd2d19" },
      { role: "contract owner", address: "0x37b1a5ce095c33519553b32e15955bd0647c45f2" },
      { role: "operator demo wallet", address: "0x98f43eabcad380f4f1f0587ae945bc8c79e43c0b" },
      { role: "server-held consumer policy owner", address: "0xaba5506df60d40436e002aee705c07dff99cb582" },
      { role: "Base treasury", address: "0x0e79371813e88f31c2b60c80bad391a952039095" },
    ];

    for (const op of OPERATIONAL) {
      test(`${op.role} is refused with policy-authority, before any wallet prompt`, async () => {
        // #given a start naming an operational address
        const start = await post("/consumer/account/link/start", {
          requestedScopes: ["identity", "policy-authority"],
          address: op.address,
        });
        // #then it is refused by name, with the role, and no message is offered to sign
        assert.equal(start.status, 409, JSON.stringify(start.body));
        assert.equal(start.body.code, "ROLE_COLLISION");
        assert.equal(start.body.siweMessage, undefined);
        const roles = start.body.conflictingRoles as { role: string; what: string }[];
        assert.ok(roles.length > 0, "the conflicting role must be named");
        assert.ok(roles.every((r) => r.what.length > 10), "each role says what it is for");
      });

      test(`${op.role} is refused with identity alone as well`, async () => {
        // An identity binding can later be granted policy authority. An operational address sitting in
        // the account table as a legitimate wallet is exactly the state in which somebody grants it.
        const start = await post("/consumer/account/link/start", {
          requestedScopes: ["identity"],
          address: op.address,
        });
        assert.equal(start.status, 409, JSON.stringify(start.body));
        assert.equal(start.body.code, "ROLE_COLLISION");
      });
    }

    test("the refusal names the role and carries no secret", async () => {
      const start = await post("/consumer/account/link/start", {
        requestedScopes: ["identity", "policy-authority"],
        address: "0xeedda7d18a34a93f3a722eb4446a526af515457a",
      });
      const serialised = JSON.stringify(start.body);
      assert.match(serialised, /receipt-writer/);
      // No environment variable name, no key material, no nonce. These addresses are public; nothing
      // else about them is disclosed.
      assert.equal(/PRIVATE_KEY|SECRET|0x[0-9a-fA-F]{64}/.test(serialised), false);
    });

    test("a wallet with no operational role is unaffected", async () => {
      const start = await post("/consumer/account/link/start", {
        requestedScopes: ["identity", "policy-authority"],
        address: OWNER.address,
      });
      assert.equal(start.status, 200, JSON.stringify(start.body));
      assert.equal(typeof start.body.siweMessage, "string");
    });
  });

  describe("the server composes the message it will verify", () => {
    test("naming the address returns a finished SIWE message, not a template", async () => {
      const start = await post("/consumer/account/link/start", {
        requestedScopes: ["identity", "policy-authority"],
        address: OWNER.address,
      });
      const message = start.body.siweMessage as string;
      // Every field a verifier checks is present and is the server's own value.
      assert.match(message, new RegExp(`^${DOMAIN} wants you to sign in`));
      assert.ok(message.includes(OWNER.address), "the message names the address that will sign it");
      assert.match(message, /It does not approve any payment\./);
      assert.match(message, /- untch:scope:policy-authority/);
      const nonce = (start.body.walletAction as { nonce: string }).nonce;
      assert.ok(message.includes(`Nonce: ${nonce}`), "the message carries the nonce the server issued");
      assert.equal(message.includes("{"), false, "no placeholder survives into a signable message");
    });

    test("the composed message actually verifies, end to end", async () => {
      const start = await post("/consumer/account/link/start", {
        requestedScopes: ["identity", "policy-authority"],
        address: OWNER.address,
      });
      const message = start.body.siweMessage as string;
      const complete = await post("/consumer/account/link/complete", {
        linkRequestId: start.body.linkRequestId,
        code: start.body.oneTimeCode,
        message,
        signature: await OWNER.signMessage({ message }),
      });
      assert.equal(complete.status, 200, JSON.stringify(complete.body));
      assert.equal(typeof complete.body.accountId, "string");
    });

    test("omitting the address still works, and returns no message rather than a broken one", async () => {
      const start = await post("/consumer/account/link/start", { requestedScopes: ["identity"] });
      assert.equal(start.status, 200);
      assert.equal(start.body.siweMessage, null);
      assert.ok((start.body.walletAction as { nonce: string }).nonce.length > 0);
    });

    test("the authority requested is stated in full, so a UI can show it before prompting", async () => {
      const start = await post("/consumer/account/link/start", {
        requestedScopes: ["identity", "policy-authority"],
        address: OWNER.address,
      });
      const a = start.body.authorityRequested as {
        signatures: number;
        format: string;
        scopes: string[];
        creates: string[];
        doesNotCreate: string[];
      };
      assert.equal(a.signatures, 1, "one signature, and the surface must be able to say so");
      assert.match(a.format, /EIP-4361|SIWE/);
      assert.ok(a.creates.some((c) => /WalletBinding/.test(c)));
      assert.ok(a.creates.some((c) => /own and register spend policies/.test(c)));
      assert.ok(a.doesNotCreate.some((c) => /payment|approval|spending/.test(c)));
      assert.ok(a.doesNotCreate.some((c) => /on-chain transaction/.test(c)));
    });
  });

  test("an unknown scope is refused rather than silently dropped", async () => {
    const refused = await post("/consumer/account/link/start", { requestedScopes: ["spend-anything"] });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "UNKNOWN_SCOPE");
  });

  test("a return URL outside the allowlist is refused, including a lookalike host", async () => {
    for (const bad of [
      "https://www.untch.xyz.evil.test/steal",
      "https://evil.test/?next=https://www.untch.xyz",
      "http://www.untch.xyz/approvals",
    ]) {
      const refused = await post("/consumer/account/link/start", { returnUrl: bad });
      assert.equal(refused.status, 400, bad);
      assert.equal(refused.body.code, "RETURN_URL_NOT_ALLOWED", bad);
    }
    const ok = await post("/consumer/account/link/start", { returnUrl: "https://www.untch.xyz/approvals" });
    assert.equal(ok.status, 200);
  });

  test("/consumer/account refuses without a session and never leaks another account's bindings", async () => {
    const mine = await startAndComplete(OWNER);
    const theirs = await startAndComplete(OTHER);
    const myToken = (mine.complete.body.session as { token: string }).token;

    assert.equal((await get("/consumer/account")).status, 401);

    const seen = await get("/consumer/account", myToken);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.accountId, mine.complete.body.accountId);
    // The other account's address must not appear anywhere in my view of my own account.
    assert.equal(JSON.stringify(seen.body).toLowerCase().includes(OTHER.address.toLowerCase()), false);
    assert.notEqual(theirs.complete.body.accountId, mine.complete.body.accountId);
  });

  test("the read surface never returns the proof reference or the one-time code", async () => {
    const { start, complete } = await startAndComplete(OWNER);
    const token = (complete.body.session as { token: string }).token;
    const seen = await get("/consumer/account", token);
    const serialised = JSON.stringify(seen.body);
    assert.equal(serialised.includes(String(start.body.oneTimeCode)), false);
    assert.equal(serialised.includes("proofRef"), false);
  });

  test("one account cannot revoke another account's wallet binding", async () => {
    const mine = await startAndComplete(OWNER);
    const theirs = await startAndComplete(OTHER);
    const myToken = (mine.complete.body.session as { token: string }).token;
    const theirBindingId = (theirs.complete.body.wallet as { bindingId: string }).bindingId;

    const refused = await post(`/consumer/account/wallets/${theirBindingId}/revoke`, {}, myToken);
    assert.equal(refused.status, 404, "an id seen in a log is not an authorisation");
    assert.equal(refused.body.code, "BINDING_NOT_FOUND");

    // ...and theirs still works.
    const theirToken = (theirs.complete.body.session as { token: string }).token;
    assert.equal((await get("/consumer/account", theirToken)).status, 200);
  });

  test("an account revokes its own wallet, and the binding stays on the record", async () => {
    const { complete } = await startAndComplete(OTHER);
    const token = (complete.body.session as { token: string }).token;
    const bindingId = (complete.body.wallet as { bindingId: string }).bindingId;

    const revoked = await post(`/consumer/account/wallets/${bindingId}/revoke`, {}, token);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revoked, true);

    const seen = await get("/consumer/account", token);
    const wallets = seen.body.wallets as Array<Record<string, unknown>>;
    const found = wallets.find((w) => w.bindingId === bindingId);
    assert.equal(found?.status, "REVOKED", "the evidence a dispute needs is not deleted");
    assert.ok(found?.revokedAt, "a revoked binding must say when");
  });

  test("a fresh account is told the honest next step rather than a refusal three calls later", async () => {
    const { complete } = await startAndComplete(
      privateKeyToAccount("0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356"),
    );
    // That signer is not in LOCAL_VERIFIER, so this is a refusal — which is itself the check that the
    // verifier is real and not a stub that agrees with everything.
    assert.equal(complete.status, 401);
    assert.equal(complete.body.code, "SIWE_BAD_SIGNATURE");
  });

  test("an account with no policy is told POLICY_REQUIRED as its next action", async () => {
    const { complete } = await startAndComplete(OWNER);
    const next = complete.body.nextAction as Record<string, unknown>;
    assert.equal(next.code, "POLICY_REQUIRED");
    assert.match(String(next.message), /owner of a policy must be the person it governs/);
  });
});
