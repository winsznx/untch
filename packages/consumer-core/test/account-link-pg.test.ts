import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createPool, runMigrations, type Pool } from "../src/db";
import { PgAccountStore, newAccountId, newWalletBindingId } from "../src/accounts";
import {
  LINK_MAX_ATTEMPTS,
  PgLinkRequestStore,
  canonicaliseCode,
  codeMatches,
  hashCode,
  newLinkCode,
  newLinkRequestId,
  returnUrlAllowed,
} from "../src/account-link";

/**
 * Migration 016 against real Postgres: revocation, scope separation, channel authority, link codes.
 *
 * Every property worth asserting here is a constraint or a partial index — "one ACTIVE binding per
 * address", "a decider must be verified", "two concurrent redemptions cannot both win". None of them
 * live in TypeScript, and a suite against an in-memory stand-in would be testing a reimplementation of
 * Postgres that has never guarded anything.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

function allMigrations(): { name: string; sql: string }[] {
  const dirs = readdirSync(PACKAGES, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => join(PACKAGES, e.name, "migrations"));
  const files: { name: string; sql: string }[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of entries) {
      if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * This suite's OWN database, for the reason the two-process controller suite established.
 *
 * Node's test runner runs FILES in parallel. Three suites in this directory reset the public schema
 * to build a known starting shape, and run together they drop it from under each other — which shows
 * up as `relation "untch_accounts" does not exist` in whichever one lost, and looks exactly like
 * flakiness. It is not: it is a shared-resource collision, and only isolation fixes the class rather
 * than the instance.
 *
 * The name is stable rather than randomised. `runMigrations` is idempotent and every test creates its
 * own account, so reuse costs nothing and a fresh database per run would leave a pile of them behind
 * on a developer machine.
 */
const OWN_DATABASE = "untch_test_account_link";

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

async function applyWholeRepository(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );
  const files = allMigrations();
  assert.ok(files.some((f) => f.name === "016_account_linking.sql"), "016 is not on disk");
  for (const { name, sql } of files) {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }
  assert.deepEqual(await runMigrations(pool), [], "a migration this package owns was not applied");
}

const EVM_A = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const EVM_B = "0x0e79371813e88f31c2b60c80bad391a952039095";
const NOW = "2026-08-01T12:00:00.000Z";

// ── pure helpers, no database needed ─────────────────────────────────────────

describe("the one-time code itself", () => {
  test("a retyped code matches regardless of case, spacing or hyphens", () => {
    const code = newLinkCode();
    const stored = hashCode(code);
    assert.equal(codeMatches(code.toLowerCase(), stored), true);
    assert.equal(codeMatches(code.replace(/-/g, ""), stored), true);
    assert.equal(codeMatches(` ${code} `, stored), true);
    // ...and a different code does not, which is the half that matters.
    assert.equal(codeMatches(newLinkCode(), stored), false);
  });

  test("the code is base32 and long enough that the attempt limit is a backstop, not the defence", () => {
    const canonical = canonicaliseCode(newLinkCode());
    assert.equal(canonical.length, 20, "20 base32 characters is 100 bits");
    assert.match(canonical, /^[A-Z2-7]+$/);
  });

  test("a malformed stored hash is a refusal, never a throw", () => {
    assert.equal(codeMatches("ABCD-EFGH-IJKL-MNOP-QRST", "not-a-digest"), false);
  });

  test("a return URL is allowed only when its ORIGIN matches exactly", () => {
    const allowed = ["https://www.untch.xyz", "https://asp.untch.xyz"];
    assert.equal(returnUrlAllowed("https://www.untch.xyz/approvals", allowed), true);
    // The attack a startsWith check would wave through: a different host sharing a prefix.
    assert.equal(returnUrlAllowed("https://www.untch.xyz.evil.test/steal", allowed), false);
    assert.equal(returnUrlAllowed("https://evil.test/?x=https://www.untch.xyz", allowed), false);
    assert.equal(returnUrlAllowed("http://www.untch.xyz/approvals", allowed), false);
    assert.equal(returnUrlAllowed("javascript:alert(1)", allowed), false);
    assert.equal(returnUrlAllowed("not a url at all", allowed), false);
  });
});

// ── the database ─────────────────────────────────────────────────────────────

describe("bindings that can be revoked", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgAccountStore;

  before(async () => {
    await createOwnDatabase();
    pool = createPool(ownDatabaseUrl());
    await applyWholeRepository(pool);
    store = new PgAccountStore(pool);
  });

  after(async () => {
    await pool.end();
  });

  // The title used to say this "frees the address for a replacement". It never did, and the body
  // never checked it: what it binds below is a DIFFERENT address (EVM_B) to the SAME account. The
  // address EVM_A stays claimed forever — see the permanence suite — and the wrong title was the
  // only thing in the repository suggesting otherwise.
  test("a revoked wallet keeps its row and stops resolving, and a different address may replace it", async () => {
    // #given an account whose authority is a proven wallet
    const account = await store.createAccount({ by: "test" });
    const bindingId = newWalletBindingId();
    await store.linkWallet({
      bindingId,
      accountId: account.accountId,
      chainKind: "evm",
      address: EVM_A,
      role: "primary",
      proofKind: "siwe",
      proofRef: "nonce-1",
      verifiedAt: NOW,
      walletProvider: "okx-agentic-wallet",
      by: "siwe",
    });
    await store.setPrimaryWallet({ accountId: account.accountId, bindingId, by: "siwe" });
    assert.equal((await store.accountForWallet("evm", EVM_A))?.accountId, account.accountId);

    // #when the binding is revoked
    assert.equal(await store.revokeWallet({ bindingId, by: "owner" }), true);

    // #then it no longer authenticates...
    assert.equal(await store.accountForWallet("evm", EVM_A), null);
    // ...the account stops pointing at an authority that no longer exists...
    assert.equal((await store.getAccount(account.accountId))?.primaryWalletBindingId, null);
    // ...and the evidence that it once existed survives, which is the part a dispute needs.
    const revoked = await store.walletBinding(bindingId);
    assert.equal(revoked?.status, "REVOKED");
    assert.ok(revoked?.revokedAt, "a revoked binding must say when");
    assert.equal(revoked?.verifiedAt, NOW, "the original proof is not erased by ending it");

    // #and a replacement wallet may now become primary — 015's index counted revoked rows and could not.
    const replacement = newWalletBindingId();
    const { bound } = await store.linkWallet({
      bindingId: replacement,
      accountId: account.accountId,
      chainKind: "evm",
      address: EVM_B,
      role: "primary",
      proofKind: "siwe",
      proofRef: "nonce-2",
      verifiedAt: NOW,
      by: "siwe",
    });
    assert.equal(bound, true);
    assert.equal((await store.accountForWallet("evm", EVM_B))?.accountId, account.accountId);
  });

  test("revoking twice is not a second revocation", async () => {
    const account = await store.createAccount({ by: "test" });
    const bindingId = newWalletBindingId();
    await store.linkWallet({
      bindingId,
      accountId: account.accountId,
      chainKind: "evm",
      address: "0x1111111111111111111111111111111111111111",
      role: "primary",
      proofKind: "siwe",
      proofRef: "n",
      verifiedAt: NOW,
      by: "siwe",
    });
    assert.equal(await store.revokeWallet({ bindingId, by: "owner" }), true);
    assert.equal(await store.revokeWallet({ bindingId, by: "owner" }), false);
  });

  test("a primary wallet carries policy authority; a settlement wallet does not", async () => {
    const account = await store.createAccount({ by: "test" });
    await store.linkWallet({
      accountId: account.accountId,
      chainKind: "evm",
      address: "0x2222222222222222222222222222222222222222",
      role: "primary",
      proofKind: "siwe",
      proofRef: "n",
      verifiedAt: NOW,
      by: "siwe",
    });
    await store.linkWallet({
      accountId: account.accountId,
      chainKind: "solana",
      address: "FSW47vDcXcJfN9G6h1jFmRr9kQpXbYzE2sTuVwXyZaBc",
      role: "settlement",
      proofKind: "declared",
      proofRef: null,
      verifiedAt: null,
      by: "operator",
    });

    const wallets = await store.walletsFor(account.accountId);
    const primary = wallets.find((w) => w.role === "primary");
    const settlement = wallets.find((w) => w.role === "settlement");
    assert.deepEqual([...(primary?.scopes ?? [])].sort(), ["identity", "policy-authority"]);
    // A wallet funds move THROUGH proves nothing about who may authorise them. Collapsing the two is
    // how a treasury key ends up able to sign for an account.
    assert.deepEqual([...(settlement?.scopes ?? [])], ["identity"]);
  });

  test("an account cannot make another account's wallet, or a revoked one, its authority", async () => {
    const mine = await store.createAccount({ by: "test" });
    const theirs = await store.createAccount({ by: "test" });
    const theirBinding = newWalletBindingId();
    await store.linkWallet({
      bindingId: theirBinding,
      accountId: theirs.accountId,
      chainKind: "evm",
      address: "0x3333333333333333333333333333333333333333",
      role: "primary",
      proofKind: "siwe",
      proofRef: "n",
      verifiedAt: NOW,
      by: "siwe",
    });

    await assert.rejects(
      () => store.setPrimaryWallet({ accountId: mine.accountId, bindingId: theirBinding, by: "attacker" }),
      /not an active binding/,
    );

    await store.revokeWallet({ bindingId: theirBinding, by: "owner" });
    await assert.rejects(
      () => store.setPrimaryWallet({ accountId: theirs.accountId, bindingId: theirBinding, by: "owner" }),
      /not an active binding/,
    );
  });

  test("a marketplace identity resolves ONLY once a wallet has signed for it", async () => {
    const account = await store.createAccount({ by: "test" });

    // #given an agent id seen in a header — a claim, recorded for audit and nothing more
    await store.linkMarketplace({
      accountId: account.accountId,
      marketplace: "okx",
      agentId: "6047",
      buyerId: null,
      provenBy: "unproven",
      verifiedAt: null,
      by: "request-header",
    });
    assert.equal(await store.accountForMarketplaceIdentity("okx", "6047"), null);

    // #when the same identity is proven by the account's own wallet
    await store.linkMarketplace({
      accountId: account.accountId,
      marketplace: "okx",
      agentId: "6047",
      buyerId: "buyer-1",
      taskRef: "task-9",
      serviceOrderRef: "order-3",
      bindingMethod: "wallet-signature",
      provenBy: "wallet-signature",
      verifiedAt: NOW,
      by: "siwe",
    });

    // #then it resolves, carrying the order and task it was bound through
    const resolved = await store.accountForMarketplaceIdentity("okx", "6047");
    assert.equal(resolved?.account.accountId, account.accountId);
    assert.equal(resolved?.binding.taskRef, "task-9");
    assert.equal(resolved?.binding.serviceOrderRef, "order-3");
  });

  test("a marketplace identity cannot be silently claimed by a second account", async () => {
    const first = await store.createAccount({ by: "test" });
    const second = await store.createAccount({ by: "test" });
    await store.linkMarketplace({
      accountId: first.accountId,
      marketplace: "okx",
      agentId: "7001",
      buyerId: null,
      provenBy: "wallet-signature",
      verifiedAt: NOW,
      by: "siwe",
    });

    const { bound } = await store.linkMarketplace({
      accountId: second.accountId,
      marketplace: "okx",
      agentId: "7001",
      buyerId: null,
      provenBy: "wallet-signature",
      verifiedAt: NOW,
      by: "siwe",
    });
    assert.equal(bound, false, "the second account must not acquire the identity");
    assert.equal((await store.accountForMarketplaceIdentity("okx", "7001"))?.account.accountId, first.accountId);
  });

  test("an expired marketplace binding stops resolving without being revoked", async () => {
    const account = await store.createAccount({ by: "test" });
    await store.linkMarketplace({
      accountId: account.accountId,
      marketplace: "okx",
      agentId: "7002",
      buyerId: null,
      provenBy: "wallet-signature",
      verifiedAt: NOW,
      expiresAt: "2020-01-01T00:00:00.000Z",
      by: "siwe",
    });
    assert.equal(await store.accountForMarketplaceIdentity("okx", "7002"), null);
  });
});

describe("channel bindings decide, or they do not", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgAccountStore;

  before(async () => {
    await createOwnDatabase();
    pool = createPool(ownDatabaseUrl());
    await runMigrations(pool);
    store = new PgAccountStore(pool);
  });

  after(async () => {
    await pool.end();
  });

  test("a channel that may decide must have been verified", async () => {
    const account = await store.createAccount({ by: "test" });
    await assert.rejects(
      () =>
        store.linkChannel({
          accountId: account.accountId,
          channel: "telegram",
          channelUserId: "tg-1",
          channelChatId: "tg-1",
          displayLabel: null,
          canDecide: true,
          verifiedAt: null,
          by: "test",
        }),
      /must carry the time it was verified/,
    );
  });

  test("email is bound for delivery and can never answer", async () => {
    const account = await store.createAccount({ by: "test" });
    await store.linkChannel({
      accountId: account.accountId,
      channel: "email",
      channelUserId: "owner@example.test",
      channelChatId: null,
      displayLabel: "owner@example.test",
      canDecide: false,
      verifiedAt: NOW,
      by: "test",
    });
    // The lookup an inbound decision would use finds nothing, so a reply parser added later still
    // cannot turn a sender address into an authority.
    assert.equal(await store.decidingChannel("email", "owner@example.test"), null);
    const bound = await store.channelsFor(account.accountId);
    assert.equal(bound.find((c) => c.channel === "email")?.canDecide, false);
  });

  test("one platform identity decides for at most one account", async () => {
    const first = await store.createAccount({ by: "test" });
    const second = await store.createAccount({ by: "test" });
    const bind = (accountId: string) =>
      store.linkChannel({
        accountId,
        channel: "telegram",
        channelUserId: "tg-shared",
        channelChatId: "tg-shared",
        displayLabel: null,
        canDecide: true,
        verifiedAt: NOW,
        by: "test",
      });

    assert.equal((await bind(first.accountId)).bound, true);
    // Without the partial unique index an inbound callback would have two possible owners.
    assert.equal((await bind(second.accountId)).bound, false);
    assert.equal((await store.decidingChannel("telegram", "tg-shared"))?.accountId, first.accountId);
  });

  test("a revoked channel stops deciding and stays on the record", async () => {
    const account = await store.createAccount({ by: "test" });
    const { bound } = await store.linkChannel({
      bindingId: "cbnd_revoke_me",
      accountId: account.accountId,
      channel: "discord",
      channelUserId: "dc-1",
      channelChatId: null,
      displayLabel: null,
      canDecide: true,
      verifiedAt: NOW,
      by: "test",
    });
    assert.equal(bound, true);
    assert.equal(await store.revokeChannel({ bindingId: "cbnd_revoke_me", by: "owner" }), true);
    assert.equal(await store.decidingChannel("discord", "dc-1"), null);
    assert.equal((await store.channelsFor(account.accountId)).find((c) => c.channel === "discord")?.status, "REVOKED");
  });
});

describe("link requests are consumed exactly once", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgAccountStore;
  let links: PgLinkRequestStore;

  before(async () => {
    await createOwnDatabase();
    pool = createPool(ownDatabaseUrl());
    await runMigrations(pool);
    store = new PgAccountStore(pool);
    links = new PgLinkRequestStore(pool);
  });

  after(async () => {
    await pool.end();
  });

  const context = {
    marketplace: "okx",
    marketplaceAgentId: "6047",
    marketplaceBuyerId: null,
    taskRef: "task-1",
    serviceOrderRef: null,
  };

  const create = (nowMs: number, nonce: string) =>
    links.create({
      requestedScopes: ["identity"],
      context,
      returnUrl: "https://www.untch.xyz/approvals",
      siweNonce: nonce,
      sourceRequestId: null,
      nowMs,
      by: "marketplace",
    });

  test("the code is returned once and is not readable from the row afterwards", async () => {
    const now = Date.parse(NOW);
    const { request, code } = await create(now, "nonce-a");
    const reread = await links.get(request.linkRequestId);
    assert.ok(reread, "the request must be readable");
    // Nothing on the read shape carries the code — only its hash is stored, and the hash is not
    // projected. A database backup, a log drain and a support query all see the same nothing.
    assert.equal(JSON.stringify(reread).includes(canonicaliseCode(code)), false);
  });

  test("two concurrent redemptions: exactly one wins", async () => {
    const now = Date.parse(NOW);
    const account = await store.createAccount({ by: "test" });
    const { request, code } = await create(now, "nonce-b");

    const [a, b] = await Promise.all([
      links.redeem({ linkRequestId: request.linkRequestId, code, accountId: account.accountId, nowMs: now, by: "t" }),
      links.redeem({ linkRequestId: request.linkRequestId, code, accountId: account.accountId, nowMs: now, by: "t" }),
    ]);
    const wins = [a, b].filter((r) => r.ok).length;
    assert.equal(wins, 1, "a read-then-write would let both win; the conditional UPDATE lets one");
    assert.equal((await links.get(request.linkRequestId))?.status, "COMPLETED");
  });

  test("a wrong code is refused, and costs an attempt", async () => {
    const now = Date.parse(NOW);
    const account = await store.createAccount({ by: "test" });
    const { request } = await create(now, "nonce-c");

    const bad = await links.redeem({
      linkRequestId: request.linkRequestId,
      code: newLinkCode(),
      accountId: account.accountId,
      nowMs: now,
      by: "t",
    });
    assert.deepEqual(bad, { ok: false, reason: "CODE_MISMATCH" });
    assert.equal((await links.get(request.linkRequestId))?.attempts, 1);
    assert.equal((await links.get(request.linkRequestId))?.status, "PENDING", "one wrong guess is not fatal");
  });

  test("guessing is bounded, and the right code stops working once the limit is passed", async () => {
    const now = Date.parse(NOW);
    const account = await store.createAccount({ by: "test" });
    const { request, code } = await create(now, "nonce-d");

    for (let i = 0; i < LINK_MAX_ATTEMPTS; i += 1) {
      await links.redeem({
        linkRequestId: request.linkRequestId,
        code: newLinkCode(),
        accountId: account.accountId,
        nowMs: now,
        by: "t",
      });
    }
    const afterLimit = await links.redeem({
      linkRequestId: request.linkRequestId,
      code,
      accountId: account.accountId,
      nowMs: now,
      by: "t",
    });
    assert.equal(afterLimit.ok, false);
    assert.equal((await links.get(request.linkRequestId))?.status, "CANCELLED");
  });

  test("an expired request is refused even with the correct code", async () => {
    const now = Date.parse(NOW);
    const account = await store.createAccount({ by: "test" });
    const { request, code } = await create(now, "nonce-e");

    const later = now + 11 * 60_000;
    const outcome = await links.redeem({
      linkRequestId: request.linkRequestId,
      code,
      accountId: account.accountId,
      nowMs: later,
      by: "t",
    });
    assert.deepEqual(outcome, { ok: false, reason: "EXPIRED" });
  });

  test("a completed request cannot be replayed against a second account", async () => {
    const now = Date.parse(NOW);
    const first = await store.createAccount({ by: "test" });
    const second = await store.createAccount({ by: "test" });
    const { request, code } = await create(now, "nonce-f");

    assert.equal((await links.redeem({ linkRequestId: request.linkRequestId, code, accountId: first.accountId, nowMs: now, by: "t" })).ok, true);
    const replay = await links.redeem({
      linkRequestId: request.linkRequestId,
      code,
      accountId: second.accountId,
      nowMs: now,
      by: "t",
    });
    assert.deepEqual(replay, { ok: false, reason: "ALREADY_COMPLETED" });
    assert.equal((await links.get(request.linkRequestId))?.accountId, first.accountId);
  });

  test("two requests cannot share a SIWE nonce", async () => {
    const now = Date.parse(NOW);
    await create(now, "nonce-shared");
    // A signature produced for one request would otherwise be redeemable against the other.
    await assert.rejects(() => create(now, "nonce-shared"), /untch_link_requests_nonce_unique/);
  });

  test("an unknown request id is refused without revealing whether it ever existed", async () => {
    const outcome = await links.redeem({
      linkRequestId: "ulnk_doesnotexistdoesnotexistxx",
      code: newLinkCode(),
      accountId: "acct_whatever",
      nowMs: Date.parse(NOW),
      by: "t",
    });
    assert.deepEqual(outcome, { ok: false, reason: "NOT_FOUND" });
  });

  test("the sweeper expires stale requests and leaves live ones alone", async () => {
    const now = Date.parse(NOW);
    const stale = await create(now, "nonce-g"); //  expires at now + 10m
    const live = await create(now + 5 * 60_000, "nonce-h"); // expires at now + 15m

    await links.expire(now + 12 * 60_000);
    assert.equal((await links.get(stale.request.linkRequestId))?.status, "EXPIRED");
    assert.equal((await links.get(live.request.linkRequestId))?.status, "PENDING");
  });
});

describe("identifiers carry the randomness their comments claim", () => {
  test("no id repeats its own prefix in its suffix", () => {
    // The defect this pins: `bytes[i % bytes.length]` over 17 bytes for 26 characters emitted
    // characters 0–16 and then repeated 0–8, so every id ended with a copy of its own beginning. It
    // was found by reading one back from production: ulnk_5c43hxjwpbcn37y445c43hxjwp.
    for (let n = 0; n < 200; n += 1) {
      const id = newLinkRequestId().slice("ulnk_".length);
      assert.equal(id.length, 26);
      const head = id.slice(0, 9);
      assert.notEqual(id.slice(17, 26), head, `suffix repeats prefix: ${id}`);

      const account = newAccountId().slice("acct_".length);
      assert.notEqual(account.slice(17, 26), account.slice(0, 9), `suffix repeats prefix: ${account}`);
    }
  });

  test("every character position varies across samples", () => {
    // A position fed by a reused byte would be perfectly correlated with an earlier one. Sampling
    // each position independently is what catches a wrap that happens to look plausible in one id.
    const samples = Array.from({ length: 300 }, () => canonicaliseCode(newLinkCode()));
    for (let pos = 0; pos < 20; pos += 1) {
      const distinct = new Set(samples.map((s) => s[pos]));
      assert.ok(distinct.size > 8, `position ${pos} took only ${distinct.size} distinct values`);
    }
  });

  test("ids do not collide across a large sample", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newLinkRequestId()));
    assert.equal(ids.size, 5000);
  });
});
