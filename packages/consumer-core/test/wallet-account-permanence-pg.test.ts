import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../src/db";
import { PgAccountStore } from "../src/accounts";
import { AccountAuthorityError, WALLET_PERMANENTLY_BOUND_TO_DIFFERENT_ACCOUNT, newWalletBindingId } from "../src/accounts";

/**
 * One EVM address belongs to one UntchAccount, for its lifetime.
 *
 * WHY THIS SUITE IS ABOUT THE MONEY PATH AND NOT ABOUT TIDINESS
 *
 * The deployed EIP-712 `SpendIntent` has eleven fields and none of them names an account. For a
 * direct Untch-account request the only field that can identify a requester is `owner`, set to the
 * policy's on-chain owner address. That address identifies an ACCOUNT only because an address belongs
 * to exactly one account — so this invariant is the last link in the chain that makes a direct
 * request attributable, and `buyerAgentId = 0` admissible at all.
 *
 * If an address could move, a receipt anchored under `owner = 0xA…` would name whichever account held
 * 0xA… at the time, and one intent hash would describe two payers at two moments. Nothing on chain
 * would show the difference. That is why every assertion here attempts the forbidden write against a
 * real database and requires it to throw, rather than checking that some code path declines to try.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_wallet_permanence";
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

const EVM_A = "0x1111111111111111111111111111111111111111";
const EVM_B = "0x2222222222222222222222222222222222222222";
const NOW = "2026-08-03T00:00:00.000Z";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

/** Every migration across all packages, in the global filename order boot applies them in. */
function allMigrations(): { name: string; sql: string }[] {
  const files: { name: string; sql: string }[] = [];
  for (const entry of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(PACKAGES, entry.name, "migrations");
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const f of names) {
      if (f.endsWith(".sql")) files.push({ name: f, sql: readFileSync(join(dir, f), "utf8") });
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function refuses(fn: () => Promise<unknown>, expect: RegExp): Promise<Error> {
  let caught: Error | null = null;
  try {
    await fn();
  } catch (err) {
    caught = err as Error;
  }
  assert.ok(caught, "the write must be refused, not silently accepted");
  assert.match(caught.message, expect);
  return caught;
}

describe(
  "one wallet address belongs to one account, for its lifetime",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;
    let store: PgAccountStore;

    before(async () => {
      const admin = createPool(TEST_DB!);
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
      for (const m of allMigrations()) await pool.query(m.sql);
      store = new PgAccountStore(pool);
    });

    after(async () => {
      await pool.end();
    });

    const link = (accountId: string, address: string, bindingId: string, verifiedAt = NOW) =>
      store.linkWallet({
        bindingId,
        accountId,
        chainKind: "evm",
        address,
        role: "primary",
        proofKind: "siwe",
        proofRef: `nonce-${bindingId}`,
        verifiedAt,
        walletProvider: "okx-agentic-wallet",
        by: "siwe",
      });

    test("the first valid proof creates one account, and the address resolves to it", async () => {
      const a = await store.createAccount({ by: "test" });
      const { bound } = await link(a.accountId, EVM_A, newWalletBindingId());
      assert.equal(bound, true);
      assert.equal((await store.accountForWallet("evm", EVM_A))?.accountId, a.accountId);
    });

    test("re-linking the same address always resolves the SAME account", async () => {
      const before = await store.accountForWallet("evm", EVM_A);
      await link(before!.accountId, EVM_A, newWalletBindingId(), "2026-08-03T01:00:00.000Z");
      const after = await store.accountForWallet("evm", EVM_A);
      assert.equal(after?.accountId, before?.accountId, "a second proof does not mint a second account");
    });

    test("another account cannot claim the address, and is refused by name", async () => {
      const other = await store.createAccount({ by: "test" });
      const err = await refuses(
        () => link(other.accountId, EVM_A, newWalletBindingId()),
        /permanently bound to a different Untch account/,
      );
      assert.ok(err instanceof AccountAuthorityError);
      assert.equal((err as AccountAuthorityError).code, WALLET_PERMANENTLY_BOUND_TO_DIFFERENT_ACCOUNT);

      // And the attempt changed nothing.
      const owner = await store.accountForWallet("evm", EVM_A);
      assert.notEqual(owner?.accountId, other.accountId);
    });

    test("revocation ends authority and does NOT free the address", async () => {
      const owner = (await store.accountForWallet("evm", EVM_A))!;
      const bindings = await store.walletsFor(owner.accountId);
      const active = bindings.find((b) => b.address === EVM_A && b.status === "ACTIVE")!;

      assert.equal(await store.revokeWallet({ bindingId: active.bindingId, by: "owner" }), true);
      assert.equal(await store.accountForWallet("evm", EVM_A), null, "a revoked binding authenticates nobody");

      // The row is still there, still owned, still claiming the address.
      const { rows } = await pool.query<{ account_id: string; status: string }>(
        "SELECT account_id, status FROM untch_wallet_bindings WHERE chain_kind = 'evm' AND address = $1",
        [EVM_A],
      );
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.status, "REVOKED");
      assert.equal(rows[0]!.account_id, owner.accountId);

      // The whole point: a DIFFERENT account still cannot take it.
      const other = await store.createAccount({ by: "test" });
      await refuses(
        () => link(other.accountId, EVM_A, newWalletBindingId()),
        /permanently bound to a different Untch account/,
      );
    });

    test("reactivation restores authority to the SAME account", async () => {
      const { rows } = await pool.query<{ account_id: string }>(
        "SELECT account_id FROM untch_wallet_bindings WHERE chain_kind = 'evm' AND address = $1",
        [EVM_A],
      );
      const owner = rows[0]!.account_id;

      const { bound } = await link(owner, EVM_A, newWalletBindingId(), "2026-08-03T02:00:00.000Z");
      assert.equal(bound, true, "the documented path back from a revocation must exist");

      const resolved = await store.accountForWallet("evm", EVM_A);
      assert.equal(resolved?.accountId, owner, "it comes back to the account that always held it");
    });

    // ── The guards migration 024 added, each attempted directly ───────────────────────────────────

    test("account_id on a binding cannot be UPDATEd", async () => {
      const other = await store.createAccount({ by: "test" });
      await refuses(
        () =>
          pool.query("UPDATE untch_wallet_bindings SET account_id = $1 WHERE address = $2", [
            other.accountId,
            EVM_A,
          ]),
        /permanently bound to account .* and cannot be moved/,
      );
    });

    test("a binding cannot be DELETEd, because deleting it WOULD free the address", async () => {
      await refuses(
        () => pool.query("DELETE FROM untch_wallet_bindings WHERE address = $1", [EVM_A]),
        /rows are permanent/,
      );
      // No cleanup script can erase the historical ownership proof either.
      await refuses(() => pool.query("DELETE FROM untch_wallet_bindings"), /rows are permanent/);
    });

    test("the address itself cannot be rewritten to release the claim", async () => {
      await refuses(
        () => pool.query("UPDATE untch_wallet_bindings SET address = $1 WHERE address = $2", [EVM_B, EVM_A]),
        /cannot be rewritten/,
      );
    });

    test("a proof that happened cannot be unset", async () => {
      await refuses(
        () => pool.query("UPDATE untch_wallet_bindings SET verified_at = NULL WHERE address = $1", [EVM_A]),
        /cannot be unset/,
      );
    });

    test("Postgres enforces the uniqueness, not the application", async () => {
      // The application layer could be bypassed by any script with a connection string. This is the
      // assertion that the property survives that.
      const other = await store.createAccount({ by: "test" });
      await refuses(
        () =>
          pool.query(
            `INSERT INTO untch_wallet_bindings
               (binding_id, account_id, chain_kind, address, role, proof_kind, verified_at, scopes,
                status, created_by, updated_by)
             VALUES ($1,$2,'evm',$3,'primary','siwe',now(),ARRAY['identity']::TEXT[],'ACTIVE','x','x')`,
            [newWalletBindingId(), other.accountId, EVM_A],
          ),
        /duplicate key value|untch_wallet_bindings_pkey/,
      );

      const { rows } = await pool.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE tablename = 'untch_wallet_bindings' AND indexname = 'untch_wallet_bindings_pkey'`,
      );
      assert.match(rows[0]!.indexdef, /UNIQUE INDEX .* \(chain_kind, address\)/);
    });

    test("the substitution the whole invariant exists to prevent is impossible", async () => {
      // Stated as one assertion because this is the property the direct-account proof depends on:
      // resolve an address, and there is exactly one account it can ever have meant.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(DISTINCT account_id)::text AS n FROM untch_wallet_bindings
          WHERE chain_kind = 'evm' AND address = $1`,
        [EVM_A],
      );
      assert.equal(rows[0]!.n, "1", "one address has resolved to exactly one account across its whole history");
    });
  },
);
