import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, test } from "node:test";
import { createPool, runMigrations, type Pool } from "../src/db";
import { AccountAuthorityError, PgAccountStore, newAccountId, newDraftId } from "../src/accounts";

/**
 * The account model against real Postgres, because everything worth testing about it is a constraint.
 *
 * Uniqueness, the refusal to move an address between accounts, the refusal to default to a policy an
 * account does not hold, the refusal to record a proof nobody can date — none of those live in
 * TypeScript. They live in indexes and CHECKs, and a test that asserted them against an in-memory
 * stand-in would be testing a reimplementation of Postgres that has never guarded anything.
 *
 * THE MIGRATIONS COME FROM EVERY PACKAGE, applied by hand rather than by `runMigrations`.
 *
 * All five packages migrate the SAME database and share one `schema_migrations` table, but each
 * package's runner reads only its OWN directory. Calling `runMigrations` here would build a schema
 * containing 007–015 and nothing else — a shape that has never existed in production, where 001–006
 * were applied by receipt-writer, policy-store, escalation and trust-bureau first. A suite against a
 * schema that has never existed can pass while the real upgrade fails, which is the same reasoning
 * `migrate-upgrade.test.ts` records.
 *
 * So the whole repository's files are applied in global filename order, exactly as production reached
 * its current state, and `runMigrations` is then asserted to have nothing left to do.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE: it
 * drops and recreates the public schema.
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
 * Apply every migration in the repository, in global filename order, recording each as the real
 * runner would — then assert the runner has nothing left to do.
 *
 * The second half is the real check. If 015 had failed to apply, or had been recorded without running,
 * `runMigrations` would try it again and return a non-empty list.
 */
async function applyWholeRepository(pool: Pool): Promise<void> {
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await pool.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  const files = allMigrations();
  assert.ok(
    files.some((f) => f.name === "015_untch_accounts.sql"),
    "015 is not on disk",
  );

  for (const { name, sql } of files) {
    await pool.query(sql);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ($1) ON CONFLICT DO NOTHING", [name]);
  }

  const leftover = await runMigrations(pool);
  assert.deepEqual(leftover, [], "a migration this package owns was not applied by the manual pass");
}

const EVM = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SOL = "FSW47vDcXcJfN9G6h1jFmRr9kQpXbYzE2sTuVwXyZaBc";
const NOW = "2026-08-01T12:00:00.000Z";

describe("the account model", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgAccountStore;

  before(async () => {
    pool = createPool(TEST_DB as string);
    await applyWholeRepository(pool);
    store = new PgAccountStore(pool);
  });

  after(async () => {
    await pool.end();
  });

  test("an account is created with its provenance recorded", async () => {
    const account = await store.createAccount({ displayName: "Ada", by: "siwe" });
    assert.match(account.accountId, /^acct_[a-z0-9]{26}$/);
    assert.equal(account.status, "ACTIVE");
    assert.equal(account.createdBy, "siwe", "how an account came to exist has to be readable later");
    assert.equal(account.defaultPolicyId, null, "a new account has not chosen a default");
  });

  test("a proven wallet resolves to its account; a declared one does not", async () => {
    const proven = await store.createAccount({ by: "siwe" });
    await store.linkWallet({
      accountId: proven.accountId,
      chainKind: "evm",
      address: EVM.toUpperCase(),
      role: "primary",
      proofKind: "siwe",
      proofRef: "nonce-1",
      verifiedAt: NOW,
      by: "siwe",
    });
    const found = await store.accountForWallet("evm", EVM);
    assert.equal(found?.accountId, proven.accountId, "case must not create a second identity");

    // A declared address is one somebody wrote down. Resolving it would turn a note into a credential.
    const declared = await store.createAccount({ by: "operator" });
    await store.linkWallet({
      accountId: declared.accountId,
      chainKind: "solana",
      address: SOL,
      role: "settlement",
      proofKind: "declared",
      proofRef: null,
      verifiedAt: null,
      by: "operator",
    });
    assert.equal(await store.accountForWallet("solana", SOL), null);
  });

  test("a binding cannot claim a signature without saying when it was verified", async () => {
    const account = await store.createAccount({ by: "siwe" });
    await assert.rejects(
      () =>
        store.linkWallet({
          accountId: account.accountId,
          chainKind: "evm",
          address: "0x1111111111111111111111111111111111111111",
          role: "primary",
          proofKind: "siwe",
          proofRef: null,
          verifiedAt: null,
          by: "siwe",
        }),
      AccountAuthorityError,
    );
  });

  test("one account has exactly one primary EVM wallet", async () => {
    const account = await store.createAccount({ by: "siwe" });
    const bind = (address: string) =>
      store.linkWallet({
        accountId: account.accountId,
        chainKind: "evm",
        address,
        role: "primary",
        proofKind: "siwe",
        proofRef: "n",
        verifiedAt: NOW,
        by: "siwe",
      });
    await bind("0x2222222222222222222222222222222222222222");
    // Two primaries would mean two answers to "who owns this", resolved by whichever query ran.
    await assert.rejects(() => bind("0x3333333333333333333333333333333333333333"));
  });

  test("an address cannot be moved to another account by re-binding it", async () => {
    const first = await store.createAccount({ by: "siwe" });
    const second = await store.createAccount({ by: "siwe" });
    const address = "0x4444444444444444444444444444444444444444";
    await store.linkWallet({
      accountId: first.accountId,
      chainKind: "evm",
      address,
      role: "primary",
      proofKind: "siwe",
      proofRef: "n",
      verifiedAt: NOW,
      by: "siwe",
    });
    // The upsert's WHERE clause refuses it silently rather than throwing; what matters is that the
    // owner did not change. Recovery is a deliberate operation, not an idempotent write.
    await store.linkWallet({
      accountId: second.accountId,
      chainKind: "evm",
      address,
      role: "primary",
      proofKind: "siwe",
      proofRef: "n2",
      verifiedAt: NOW,
      by: "siwe",
    });
    assert.equal((await store.accountForWallet("evm", address))?.accountId, first.accountId);
  });

  test("one account holds many policies, and the default must be one it holds", async () => {
    const account = await store.createAccount({ by: "siwe" });
    await store.linkPolicy({ accountId: account.accountId, policyId: "101", linkedBy: "registered", by: "siwe" });
    await store.linkPolicy({ accountId: account.accountId, policyId: "102", linkedBy: "adopted", by: "siwe" });
    assert.deepEqual([...(await store.policiesFor(account.accountId))].sort(), ["101", "102"]);

    await store.setDefaultPolicy({ accountId: account.accountId, policyId: "102", by: "siwe" });
    assert.equal((await store.getAccount(account.accountId))?.defaultPolicyId, "102");

    await assert.rejects(
      () => store.setDefaultPolicy({ accountId: account.accountId, policyId: "999", by: "siwe" }),
      AccountAuthorityError,
    );
  });

  test("using a policy is a fact and does not become the default", async () => {
    const account = await store.createAccount({ by: "siwe" });
    await store.linkPolicy({ accountId: account.accountId, policyId: "201", linkedBy: "registered", by: "siwe" });
    await store.linkPolicy({ accountId: account.accountId, policyId: "202", linkedBy: "registered", by: "siwe" });
    await store.setDefaultPolicy({ accountId: account.accountId, policyId: "201", by: "siwe" });

    await store.recordPolicyUse({ accountId: account.accountId, policyId: "202", by: "preflight" });
    const read = await store.getAccount(account.accountId);
    assert.equal(read?.lastUsedPolicyId, "202");
    assert.equal(read?.defaultPolicyId, "201", "an experiment must not silently become a default");
  });

  test("a marketplace identity is audit context until a wallet proves it", async () => {
    const account = await store.createAccount({ by: "siwe" });
    await store.linkMarketplace({
      accountId: account.accountId,
      marketplace: "okx",
      agentId: "6047",
      buyerId: "buyer-1",
      provenBy: "unproven",
      verifiedAt: null,
      by: "request-header",
    });
    const [binding] = await store.marketplaceBindingsFor(account.accountId);
    assert.equal(binding?.provenBy, "unproven", "an agent id in a header is a claim, not an authority");

    await assert.rejects(
      () =>
        store.linkMarketplace({
          accountId: account.accountId,
          marketplace: "okx",
          agentId: "6048",
          buyerId: null,
          provenBy: "wallet-signature",
          verifiedAt: null,
          by: "siwe",
        }),
      AccountAuthorityError,
    );
  });

  test("a marketplace job reconciles to an account and, later, to an intent", async () => {
    const account = await store.createAccount({ by: "siwe" });
    await store.recordJob({ marketplace: "okx", jobId: "job-1", accountId: account.accountId, by: "webhook" });
    await store.recordJob({
      marketplace: "okx",
      jobId: "job-1",
      accountId: account.accountId,
      intentId: "ci_abc",
      status: "COMPLETED",
      by: "orchestrator",
    });
    const { rows } = await pool.query<{ intent_id: string; status: string }>(
      "SELECT intent_id, status FROM untch_marketplace_jobs WHERE marketplace = 'okx' AND job_id = 'job-1'",
    );
    assert.deepEqual(rows[0], { intent_id: "ci_abc", status: "COMPLETED" });
  });
});

describe("policy drafts", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgAccountStore;
  let accountId: string;

  before(async () => {
    pool = createPool(TEST_DB as string);
    // Its own schema reset: node:test may run this file's suites in either order, and a draft suite
    // that inherited half a schema from a neighbour would fail for a reason that is not about drafts.
    await applyWholeRepository(pool);
    store = new PgAccountStore(pool);
    accountId = (await store.createAccount({ by: "siwe" })).accountId;
  });

  after(async () => {
    await pool.end();
  });

  async function draft(): Promise<string> {
    const draftId = newDraftId();
    await store.createDraft({
      draftId,
      accountId,
      rules: { dailyCap: "50.00", categories: ["api"] },
      policyHash: `0x${"aa".repeat(32)}`,
      agentId: "6047",
      chainId: 196,
      by: "siwe",
    });
    return draftId;
  }

  test("a draft starts as a draft and names no policy, because none exists yet", async () => {
    const id = await draft();
    const read = await store.getDraft(id);
    assert.equal(read?.status, "DRAFT");
    assert.equal(read?.policyId, null);
    assert.equal(read?.registerTx, null);
  });

  test("the lifecycle only moves forward, and only through a broadcast transaction", async () => {
    const id = await draft();

    // A draft with no transaction cannot become confirmed by asserting a policy id at it.
    await assert.rejects(
      () => store.markDraftConfirmed({ draftId: id, policyId: "301", by: "sync" }),
      AccountAuthorityError,
    );

    await store.markDraftSubmitted({ draftId: id, registerTx: `0x${"bb".repeat(32)}`, by: "wallet" });
    await store.markDraftConfirmed({ draftId: id, policyId: "301", by: "sync" });

    const read = await store.getDraft(id);
    assert.equal(read?.status, "CONFIRMED");
    assert.equal(read?.policyId, "301");

    // A second submission must not overwrite the transaction that actually produced the policy.
    await assert.rejects(
      () => store.markDraftSubmitted({ draftId: id, registerTx: `0x${"cc".repeat(32)}`, by: "wallet" }),
      AccountAuthorityError,
    );
  });

  test("two drafts cannot both claim the same registered policy", async () => {
    const first = await draft();
    const second = await draft();
    await store.markDraftSubmitted({ draftId: first, registerTx: `0x${"dd".repeat(32)}`, by: "wallet" });
    await store.markDraftConfirmed({ draftId: first, policyId: "302", by: "sync" });
    await store.markDraftSubmitted({ draftId: second, registerTx: `0x${"ee".repeat(32)}`, by: "wallet" });
    await assert.rejects(() => store.markDraftConfirmed({ draftId: second, policyId: "302", by: "sync" }));
  });

  test("an account id that does not exist cannot own a draft", async () => {
    await assert.rejects(() =>
      store.createDraft({
        draftId: newDraftId(),
        accountId: newAccountId(),
        rules: {},
        policyHash: `0x${"ff".repeat(32)}`,
        agentId: "1",
        chainId: 196,
        by: "siwe",
      }),
    );
  });
});
