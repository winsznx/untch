import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  PgAccountStore,
  completeScopeDowngrade,
  createPool,
  startScopeDowngrade,
  type Pool,
} from "../src/index";

/**
 * Proving you hold a wallet must never be able to take authority away from it.
 *
 * THE DEFECT
 *
 * `linkWallet` upserted `scopes = EXCLUDED.scopes`. On 2026-08-05 a relink that asked for
 * `["identity"]` — because the caller wrote `scopes` where the route reads `requestedScopes`, and the
 * server defaulted — silently stripped `policy-authority` from an ACTIVE binding. The account kept its
 * wallet and quietly lost the ability to approve a payment. Nothing recorded it, because from the
 * schema's point of view nothing unusual had happened.
 *
 * The rule now: a relink UNIONS. Omitting a scope means "I did not mention it", never "remove it".
 * Removing authority is a separate operation with its own signed challenge and its own audit row, and
 * these tests are mostly about keeping those two things apart.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_wallet_scope";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "migrations");

const ADDRESS = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const OTHER_ADDRESS = "0x9999999999999999999999999999999999999999";

describe("a relink adds authority and never removes it", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let accounts: PgAccountStore;
  let accountId: string;
  let otherAccountId: string;
  let bindingId: string;
  let seq = 0;

  before(async () => {
    const admin = createPool(TEST_DB!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = new URL(TEST_DB!);
    url.pathname = `/${OWN_DATABASE}`;
    pool = createPool(url.toString());
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    accounts = new PgAccountStore(pool);
    accountId = (await accounts.createAccount({ by: "test" })).accountId;
    otherAccountId = (await accounts.createAccount({ by: "test" })).accountId;
  });

  after(async () => {
    await pool?.end();
  });

  const link = async (scopes: readonly string[], address = ADDRESS): Promise<string> => {
    seq += 1;
    const id = `wbnd_scope_${String(seq).padStart(6, "0")}`;
    await accounts.linkWallet({
      bindingId: id,
      accountId,
      chainKind: "evm",
      address,
      role: "primary",
      proofKind: "siwe",
      proofRef: `proof_${seq}`,
      verifiedAt: new Date().toISOString(),
      walletProvider: "okx-agentic-wallet",
      scopes: scopes as never,
      by: "siwe",
    });
    const { rows } = await pool.query<{ binding_id: string }>(
      `SELECT binding_id FROM untch_wallet_bindings WHERE chain_kind='evm' AND address=$1`,
      [address],
    );
    return rows[0]!.binding_id;
  };

  const scopesOf = async (id: string): Promise<string[]> => {
    const { rows } = await pool.query<{ scopes: string[] | null }>(
      `SELECT scopes FROM untch_wallet_bindings WHERE binding_id = $1`,
      [id],
    );
    return [...(rows[0]?.scopes ?? [])].sort();
  };

  test("a first link records exactly what it asked for", async () => {
    bindingId = await link(["identity", "policy-authority"]);
    assert.deepEqual(await scopesOf(bindingId), ["identity", "policy-authority"]);
  });

  /** The exact sequence that lost authority in production. */
  test("a narrower relink preserves the scopes it did not mention", async () => {
    await link(["identity"]);
    assert.deepEqual(
      await scopesOf(bindingId),
      ["identity", "policy-authority"],
      "omitting a scope is not a request to remove it",
    );
  });

  test("a relink that mentions nothing at all cannot narrow authority", async () => {
    await link([]);
    assert.deepEqual(await scopesOf(bindingId), ["identity", "policy-authority"]);
  });

  test("an additive relink adds what it asks for", async () => {
    await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity'] WHERE binding_id = $1`, [bindingId]);
    await link(["identity", "policy-authority"]);
    assert.deepEqual(await scopesOf(bindingId), ["identity", "policy-authority"]);
  });

  test("the stored order is canonical rather than whichever side was written first", async () => {
    await link(["policy-authority", "identity"]);
    const { rows } = await pool.query<{ scopes: string[] }>(
      `SELECT scopes FROM untch_wallet_bindings WHERE binding_id = $1`,
      [bindingId],
    );
    assert.deepEqual(rows[0]!.scopes, ["identity", "policy-authority"]);
  });

  // ── the explicit downgrade ─────────────────────────────────────────────────

  describe("removing authority is asked for, signed, and recorded", () => {
    test("a downgrade removes only what it names, and keeps identity", async () => {
      const started = await startScopeDowngrade(pool, {
        accountId,
        bindingId,
        removeScopes: ["policy-authority"],
      });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      assert.deepEqual([...started.challenge.scopesRemoved], ["policy-authority"]);
      assert.deepEqual([...started.challenge.scopesAfter], ["identity"]);
      /** The sentence a person reads in a wallet popup is the only thing that can stop a mistake. */
      assert.match(started.challenge.message, /NO LONGER be able to approve payments/);
      assert.match(started.challenge.message, /does not detach the wallet/);

      const done = await completeScopeDowngrade(pool, {
        accountId,
        bindingId,
        challengeNonce: started.challenge.challengeNonce,
        proofRef: "sig_downgrade_1",
        by: "owner",
      });
      assert.equal(done.ok, true);
      assert.deepEqual(await scopesOf(bindingId), ["identity"], "identity survives; authority does not");
    });

    test("the reduction is recorded immutably, with what was held and what remains", async () => {
      const { rows } = await pool.query<{
        scopes_before: string[];
        scopes_after: string[];
        scopes_removed: string[];
        proof_ref: string;
        challenge_digest: string;
      }>(`SELECT scopes_before, scopes_after, scopes_removed, proof_ref, challenge_digest
            FROM untch_wallet_scope_downgrades WHERE binding_id = $1`, [bindingId]);
      const a = rows[0]!;
      assert.deepEqual([...a.scopes_before].sort(), ["identity", "policy-authority"]);
      assert.deepEqual(a.scopes_after, ["identity"]);
      assert.deepEqual(a.scopes_removed, ["policy-authority"]);
      assert.equal(a.proof_ref, "sig_downgrade_1");
      assert.match(a.challenge_digest, /^sha256:[0-9a-f]{64}$/);

      await assert.rejects(
        () => pool.query(`UPDATE untch_wallet_scope_downgrades SET scopes_removed = ARRAY['identity']`),
        /cannot be update/i,
        "the only record that authority was deliberately reduced must not be editable",
      );
      await assert.rejects(
        () => pool.query(`DELETE FROM untch_wallet_scope_downgrades`),
        /cannot be delete/i,
      );
    });

    /** The whole point of the union rule: a relink after a downgrade does not undo it. */
    test("a relink after a downgrade does not restore removed authority", async () => {
      await link(["identity"]);
      assert.deepEqual(await scopesOf(bindingId), ["identity"], "the reduction stands");
    });

    test("and an explicit request restores it", async () => {
      await link(["identity", "policy-authority"]);
      assert.deepEqual(await scopesOf(bindingId), ["identity", "policy-authority"]);
    });

    test("reducing authority requires holding it", async () => {
      await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity'] WHERE binding_id = $1`, [bindingId]);
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, false);
      assert.equal(started.ok === false ? started.refusal : null, "AUTHORITY_NOT_HELD");
      await pool.query(
        `UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority'] WHERE binding_id = $1`,
        [bindingId],
      );
    });

    test("identity cannot be removed, because that would be detaching the wallet", async () => {
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["identity"] });
      assert.equal(started.ok, false);
      assert.equal(started.ok === false ? started.refusal : null, "IDENTITY_NOT_REMOVABLE");
    });

    test("a scope the binding does not hold is refused rather than silently succeeding", async () => {
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["not-a-scope"] });
      assert.equal(started.ok, false);
      assert.equal(started.ok === false ? started.refusal : null, "NOTHING_TO_REMOVE");
    });

    test("another account cannot reduce this binding", async () => {
      const started = await startScopeDowngrade(pool, {
        accountId: otherAccountId,
        bindingId,
        removeScopes: ["policy-authority"],
      });
      assert.equal(started.ok, false);
      assert.equal(started.ok === false ? started.refusal : null, "WRONG_ACCOUNT");
    });

    test("an unknown binding is refused by name", async () => {
      const started = await startScopeDowngrade(pool, {
        accountId,
        bindingId: "wbnd_nope",
        removeScopes: ["policy-authority"],
      });
      assert.equal(started.ok, false);
      assert.equal(started.ok === false ? started.refusal : null, "BINDING_NOT_FOUND");
    });

    test("a challenge issued for one binding cannot complete another", async () => {
      const otherBinding = await (async (): Promise<string> => {
        await accounts.linkWallet({
          bindingId: "wbnd_scope_other",
          accountId: otherAccountId,
          chainKind: "evm",
          address: OTHER_ADDRESS,
          role: "primary",
          proofKind: "siwe",
          proofRef: "proof_other",
          verifiedAt: new Date().toISOString(),
          walletProvider: "okx-agentic-wallet",
          scopes: ["identity", "policy-authority"] as never,
          by: "siwe",
        });
        const { rows } = await pool.query<{ binding_id: string }>(
          `SELECT binding_id FROM untch_wallet_bindings WHERE address = $1`,
          [OTHER_ADDRESS],
        );
        return rows[0]!.binding_id;
      })();

      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      const wrong = await completeScopeDowngrade(pool, {
        accountId: otherAccountId,
        bindingId: otherBinding,
        challengeNonce: started.challenge.challengeNonce,
        proofRef: "sig_wrong",
        by: "owner",
      });
      assert.equal(wrong.ok, false);
      assert.equal(wrong.ok === false ? wrong.refusal : null, "CHALLENGE_BINDING_MISMATCH");
    });

    test("a replayed challenge refuses, and reduces nothing a second time", async () => {
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      const first = await completeScopeDowngrade(pool, {
        accountId, bindingId, challengeNonce: started.challenge.challengeNonce, proofRef: "sig_a", by: "owner",
      });
      assert.equal(first.ok, true);
      const again = await completeScopeDowngrade(pool, {
        accountId, bindingId, challengeNonce: started.challenge.challengeNonce, proofRef: "sig_a", by: "owner",
      });
      assert.equal(again.ok, false);
      assert.equal(again.ok === false ? again.refusal : null, "CHALLENGE_REPLAYED");
      await link(["identity", "policy-authority"]);
    });

    test("an expired challenge refuses", async () => {
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      await pool.query(
        /** Both moved, because the schema refuses a challenge that expired before it was issued. */
        `UPDATE untch_wallet_scope_challenges
            SET issued_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
          WHERE challenge_nonce = $1`,
        [started.challenge.challengeNonce],
      );
      const done = await completeScopeDowngrade(pool, {
        accountId, bindingId, challengeNonce: started.challenge.challengeNonce, proofRef: "sig_b", by: "owner",
      });
      assert.equal(done.ok, false);
      assert.equal(done.ok === false ? done.refusal : null, "CHALLENGE_EXPIRED");
      assert.deepEqual(await scopesOf(bindingId), ["identity", "policy-authority"], "and nothing was reduced");
    });

    /**
     * The interleaving that would produce a scope set nobody asked for: a challenge describes removing
     * policy-authority, a relink then adds something else, and applying the stored set would silently
     * take the new thing away too.
     */
    test("a challenge whose binding gained authority in the meantime refuses", async () => {
      await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority'] WHERE binding_id=$1`, [bindingId]);
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      await pool.query(
        `UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority','notify'] WHERE binding_id=$1`,
        [bindingId],
      );
      const done = await completeScopeDowngrade(pool, {
        accountId, bindingId, challengeNonce: started.challenge.challengeNonce, proofRef: "sig_c", by: "owner",
      });
      /** `identity` alone is still a subset, so it applies — and the removal set is recomputed live. */
      if (done.ok) {
        assert.deepEqual([...done.scopesRemoved].sort(), ["notify", "policy-authority"]);
        assert.deepEqual([...done.scopesAfter], ["identity"]);
      } else {
        assert.equal(done.refusal, "SCOPES_MOVED");
      }
      await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority'] WHERE binding_id=$1`, [bindingId]);
    });

    test("two concurrent completions of one challenge produce exactly one reduction", async () => {
      const started = await startScopeDowngrade(pool, { accountId, bindingId, removeScopes: ["policy-authority"] });
      assert.equal(started.ok, true);
      if (!started.ok) return;
      const nonce = started.challenge.challengeNonce;
      const results = await Promise.all([
        completeScopeDowngrade(pool, { accountId, bindingId, challengeNonce: nonce, proofRef: "sig_x", by: "owner" }),
        completeScopeDowngrade(pool, { accountId, bindingId, challengeNonce: nonce, proofRef: "sig_x", by: "owner" }),
      ]);
      assert.equal(results.filter((r) => r.ok).length, 1, "exactly one wins");
      assert.equal(results.filter((r) => !r.ok).length, 1);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM untch_wallet_scope_downgrades WHERE challenge_nonce = $1`,
        [nonce],
      );
      assert.equal(rows[0]!.n, "1", "one challenge, one audit record");
      await link(["identity", "policy-authority"]);
    });
  });
});
