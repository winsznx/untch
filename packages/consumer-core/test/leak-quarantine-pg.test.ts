import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "../src/db";

/**
 * A leaked artifact cannot be read as work that happened.
 *
 * WHAT THIS IS PROVING
 *
 * On 2026-08-02 a validation route that always rolls back left ten rows behind, because the escalation
 * gateway and the receipt enqueuer act on the connection pool rather than on the caller's transaction.
 * #61 removed those dependencies. This suite is about the rows that already exist: they stay, they are
 * never rewritten, and no business or public surface may count them.
 *
 * WHY THE ASSERTIONS ARE COUNTS AND REFUSALS RATHER THAN A FLAG CHECK
 *
 * "The query excludes it" is only true if the query is the one production runs. So every assertion
 * below reads the SAME view the shipped SQL reads, and every guard is exercised by attempting the
 * forbidden write and requiring it to throw. A test that asserted `annotation.eligible === false`
 * would pass while a report still summed the row.
 *
 * A CLEAN CONTROL RUNS THROUGHOUT
 *
 * Every count is asserted against both the leaked rows and one clean receipt in its own batch. A
 * quarantine that also hides real work is a worse bug than the one it fixes, and a suite that only
 * checked the leaked rows would not notice.
 *
 * WHY IT CREATES ITS OWN DATABASE
 *
 * Node runs test FILES in parallel, and every pg suite here drops and recreates `public` to get a
 * known schema. Sharing one database means whichever file drops last deletes the others' tables
 * mid-run — a failure that reads as a flake and is a fixture collision. The two-process controller
 * suite already hit this class and solved it the same way. Isolation fixes the class; renaming a
 * fixture would only fix the case.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE
 * against its OWN database, which it creates and never shares.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();

/** Reused rather than randomised: the migrations are idempotent and the suite rebuilds its schema. */
const OWN_DATABASE = "untch_test_leak_quarantine";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}
const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGES = join(HERE, "..", "..");

const LEAKED = [
  "0x5306d6231b9e9343415e0fd2b4b48a218937a87192dc0f2ab2e60eed88bd898c",
  "0xbb9b292b6eef8377e5e2a3a44050d9299ade74e6222972980bb7bb1a0289b061",
  "0x0d1ffa05b4ba585b274296d5c463760c911bf44acc4cf59f761bb482c486d44c",
] as const;

/** The control. A real receipt, in its own batch, that must keep behaving normally. */
const CLEAN = "0xc1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1eac1ea";

const POLICY = "6005881688159874338903650523776790675151043356117181716643196935468657631674";
const POLICY_HASH = "0x8b634b5e16ee3632ef4ffce126bc8c2253c67efb7c7d167bbd1eb42e28c79f82";
const AGENT = "0x000000000000000000000000000000000000000000000000000000000000179f";
const VENDOR = "0x94a4435027d49f3202eea0eb58dc73a1c4a2485627f4ba3753fd3d9d41f83294";
const TOKEN = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736";

/** Every migration in the repository, across all packages, in global filename order — as boot runs them. */
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
 * The leak is seeded BEFORE the migrations that classify it, exactly as production experienced it.
 *
 * Seeding afterwards would test a database that never existed: in production the rows were already
 * there when 022 and 023 arrived, and "does the migration find the rows" is most of what can go wrong.
 */
const QUARANTINE_MIGRATIONS = ["022_artifact_audit_annotation.sql", "023_validation_leak_quarantine.sql"];

async function applyBeforeQuarantine(pool: Pool): Promise<void> {
  for (const m of allMigrations()) {
    if (QUARANTINE_MIGRATIONS.includes(m.name)) continue;
    await pool.query(m.sql);
  }
}

async function applyQuarantine(pool: Pool): Promise<void> {
  for (const m of allMigrations()) {
    if (QUARANTINE_MIGRATIONS.includes(m.name)) await pool.query(m.sql);
  }
}

async function seedLeak(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO batches (id, status, receipt_count, attempts, created_at) VALUES
       ('28', 'DEGRADED_UNANCHORED', 3, 10, '2026-08-02T15:27:45.135Z'),
       ('29', 'PENDING', 1, 0, '2026-08-02T16:00:00Z')`,
  );

  const receipt = (id: string, amount: number, decision: number, batch: string, status: string, at: string) =>
    pool.query(
      `INSERT INTO receipts
         (receipt_id, kind, status, intent_hash, policy_id, policy_hash, agent_id, vendor_id, amount,
          token, category, pay_type, task_hash, decision, metadata_hash, batch_id, created_at)
       VALUES ($1,'DECISION',$2,$3,$4,$5,$6,$7,$8,$9,'0x00',0,'0x00',$10,'0x00',$11,$12)`,
      [id, status, `0xfeed${id.slice(2, 62)}`, POLICY, POLICY_HASH, AGENT, VENDOR, amount, TOKEN, decision, batch, at],
    );

  await receipt(LEAKED[0], 4_000_000, 1, "28", "DEGRADED_UNANCHORED", "2026-08-02T15:27:37.159Z");
  await receipt(LEAKED[1], 6_000_000, 14, "28", "DEGRADED_UNANCHORED", "2026-08-02T15:27:40.022Z");
  await receipt(LEAKED[2], 9_000_000, 10, "28", "DEGRADED_UNANCHORED", "2026-08-02T15:27:42.274Z");
  await receipt(CLEAN, 50_000, 1, "29", "QUEUED", "2026-08-02T16:00:00Z");

  for (const [id, type, amount] of [
    [LEAKED[0], "SPEND", 4_000_000],
    [LEAKED[1], "BLOCK_SAVED", 6_000_000],
    [LEAKED[2], "BLOCK_SAVED", 9_000_000],
    [CLEAN, "SPEND", 50_000],
  ] as const) {
    await pool.query(
      `INSERT INTO ledger_entries
         (receipt_id, agent_id, type, amount, token, counterparty, day_key, category_key, vendor_key)
       VALUES ($1,$2,$3,$4,$5,'0xd9ed4d474b0d01031d10d637546450f39ed6a5ba','2026-08-02','owned_work.demo',$6)`,
      [id, AGENT, type, amount, TOKEN, VENDOR],
    );
  }

  await pool.query(
    `INSERT INTO escalations
       (id, intent_id, poll_ref, status, reason, policy_id, amount, token, approvals,
        approval_code_hash, code_expires_at, created_at)
     VALUES ('esc_44c567b949fe','0x3d8db0898939276b04d93b4a4240ddc59f558e4806d5e7a602a7f25b8b6f403c',
             'poll_leak','APPROVED','ESCALATED_THRESHOLD',$1,6,'USDT0','{}'::jsonb,'seed','2026-08-02T15:57:40.057Z',
             '2026-08-02T15:27:40.060Z')`,
    [POLICY],
  );
  await pool.query(
    `INSERT INTO escalation_operators (id, label) VALUES ('op:0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64','leaked')`,
  );
  await pool.query(
    `INSERT INTO escalation_operator_bindings (operator_id, channel, handle)
     VALUES ('op:0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64','dashboard','0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64')`,
  );
}

const count = async (pool: Pool, sql: string): Promise<number> =>
  Number((await pool.query<{ n: string }>(sql)).rows[0]!.n);

async function refuses(pool: Pool, sql: string, expect: RegExp): Promise<void> {
  await assert.rejects(() => pool.query(sql), (err: Error) => {
    assert.match(err.message, expect);
    return true;
  });
}

describe(
  "a leaked artifact cannot be read as work that happened",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;

    before(async () => {
      const admin = createPool(TEST_DB!);
      try {
        // CREATE DATABASE cannot run inside a transaction, and a duplicate is not worth failing on.
        await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
          if ((err as { code?: string }).code !== "42P04") throw err;
        });
      } finally {
        await admin.end();
      }

      pool = createPool(ownDatabaseUrl());
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await applyBeforeQuarantine(pool);
      await seedLeak(pool);
      await applyQuarantine(pool);
    });

    after(async () => {
      await pool.end();
    });

    test("the migration finds every leaked artifact, and annotates nothing else", async () => {
      const rows = await pool.query<{ artifact_kind: string; artifact_ref: string }>(
        "SELECT artifact_kind, artifact_ref FROM untch_artifact_annotations ORDER BY artifact_kind, artifact_ref",
      );
      assert.equal(rows.rowCount, 10, "3 receipts + 1 batch + 3 ledger entries + escalation + operator + binding");

      const kinds = rows.rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.artifact_kind] = (acc[r.artifact_kind] ?? 0) + 1;
        return acc;
      }, {});
      assert.deepEqual(kinds, {
        RECEIPT: 3,
        RECEIPT_BATCH: 1,
        LEDGER_ENTRY: 3,
        ESCALATION: 1,
        ESCALATION_OPERATOR: 1,
        ESCALATION_OPERATOR_BINDING: 1,
      });

      // The control is untouched. A quarantine that catches real work is the worse bug.
      assert.ok(
        !rows.rows.some((r) => r.artifact_ref === CLEAN),
        "the clean receipt must not be annotated",
      );
    });

    test("every leaked artifact is classified with all six answers false", async () => {
      const bad = await pool.query(
        `SELECT artifact_kind, artifact_ref FROM untch_artifact_annotations
          WHERE classification <> 'VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK'
             OR source <> 'internal preflight validation'
             OR paid OR provider_executed OR eligible_for_anchoring OR eligible_for_accounting
             OR eligible_for_public_proof OR eligible_for_business_metrics`,
      );
      assert.equal(bad.rowCount, 0, "no leaked artifact may claim payment, execution or eligibility");
    });

    test("the annotation itself cannot be edited or removed", async () => {
      await refuses(pool, "UPDATE untch_artifact_annotations SET eligible_for_anchoring = true", /append-only/);
      await refuses(pool, "DELETE FROM untch_artifact_annotations", /append-only/);
    });

    test("a LEAK annotation cannot claim eligibility for anything, one flag at a time", async () => {
      // Each flag separately, because a single combined case would pass if only one of the six were
      // actually enforced.
      const flags = [
        "paid",
        "provider_executed",
        "eligible_for_anchoring",
        "eligible_for_accounting",
        "eligible_for_public_proof",
        "eligible_for_business_metrics",
      ] as const;

      for (const flag of flags) {
        const cols = flags.map((f) => (f === flag ? "true" : "false")).join(",");
        await refuses(
          pool,
          `INSERT INTO untch_artifact_annotations
             (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
              eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
              eligible_for_business_metrics, note)
           VALUES ('RECEIPT','0xleak_${flag}','VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK','t',${cols},'n')`,
          /untch_artifact_annotation_leak_is_inert/,
        );
      }
    });

    /**
     * The rule this suite originally got wrong.
     *
     * The first constraint said, for every row, that unpaid and unexecuted implies eligible for
     * nothing. That is a fact about leaks stated as a fact about the world. Each artifact below is
     * unpaid, ran no provider, and is legitimately publishable — a security proof nobody paid for is
     * still a proof, and a BLOCKED decision is evidence that the policy worked. The global rule would
     * have refused all five.
     */
    test("a legitimate unpaid, unexecuted artifact is still publishable", async () => {
      const legitimate = [
        ["free dry-run evidence", "DECISION_EVIDENCE", "dryrun-1"],
        ["a BLOCKED policy decision", "DECISION_EVIDENCE", "blocked-1"],
        ["a rejected request", "APPROVAL_REQUEST", "rejected-1"],
        ["an unpaid audit record", "ACTIVITY_CASE", "audit-1"],
        ["a public security proof", "DECISION_EVIDENCE", "secproof-1"],
      ] as const;

      for (const [what, kind, ref] of legitimate) {
        await pool.query(
          `INSERT INTO untch_artifact_annotations
             (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
              eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
              eligible_for_business_metrics, note)
           VALUES ($1,$2,'IMPORTED',$3,false,false,false,false,true,false,$4)`,
          [kind, ref, what, `${what} — unpaid, unexecuted, and publishable`],
        );
      }

      const published = await count(
        pool,
        "SELECT count(*) n FROM untch_artifact_annotations WHERE eligible_for_public_proof = true",
      );
      assert.equal(published, legitimate.length, "all five are publishable and none was refused");
    });

    test("a TEST_PROBE_ORPHAN can never be read as truth, but says nothing about payment", async () => {
      await refuses(
        pool,
        `INSERT INTO untch_artifact_annotations
           (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
            eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
            eligible_for_business_metrics, note)
         VALUES ('RECEIPT','0xprobe_bad','TEST_PROBE_ORPHAN','t',false,false,false,false,true,false,'n')`,
        /untch_artifact_annotation_probe_is_not_truth/,
      );

      // paid/provider_executed are NOT forced for a probe: the classification is about readability,
      // not about money, and forcing them would be the same over-reach in a smaller place.
      await pool.query(
        `INSERT INTO untch_artifact_annotations
           (artifact_kind, artifact_ref, classification, source, paid, provider_executed,
            eligible_for_anchoring, eligible_for_accounting, eligible_for_public_proof,
            eligible_for_business_metrics, note)
         VALUES ('RECEIPT','0xprobe_ok','TEST_PROBE_ORPHAN','t',true,true,false,false,false,false,'n')`,
      );
    });

    // ── The eight surfaces ────────────────────────────────────────────────────────────────────────

    test("SURFACE 1+2: they are not paid service calls and not provider executions", async () => {
      // Structural, not filtered: the leak never reached these tables at all, because it never paid
      // for anything and never called a provider. Asserted so a future change that DID route a
      // validation run through them would fail here rather than in a revenue report.
      assert.equal(await count(pool, "SELECT count(*) n FROM consumer_provider_executions"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM consumer_quotes"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM consumer_funding_receipts"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM consumer_intents"), 0);
    });

    test("SURFACE 3: they are not normal receipts", async () => {
      assert.equal(await count(pool, "SELECT count(*) n FROM receipts"), 4, "all four rows still exist");
      assert.equal(await count(pool, "SELECT count(*) n FROM receipts_business"), 1, "only the clean one counts");

      const kept = await pool.query<{ receipt_id: string }>("SELECT receipt_id FROM receipts_business");
      assert.deepEqual(kept.rows.map((r) => r.receipt_id), [CLEAN]);
    });

    test("SURFACE 4: they are not settled work", async () => {
      assert.equal(await count(pool, "SELECT count(*) n FROM service_orders"), 0);
      assert.equal(
        await count(pool, "SELECT count(*) n FROM receipts_business WHERE status = 'CONFIRMED'"),
        0,
        "nothing leaked is settled",
      );
    });

    test("SURFACE 5: they are not account-owned channel bindings", async () => {
      // The leaked operator lives in the LEGACY escalation tables. The account-scoped binding model is
      // a different table, and it is still empty — which is the point: no channel has proven control
      // of this account, and the leak must not be mistaken for evidence that one has.
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_channel_bindings"), 0);
      assert.equal(
        await count(
          pool,
          `SELECT count(*) n FROM untch_artifact_annotations
            WHERE artifact_kind IN ('ESCALATION_OPERATOR','ESCALATION_OPERATOR_BINDING')`,
        ),
        2,
        "both legacy rows are classified so neither can be presented as an account binding",
      );
    });

    test("SURFACE 6: they are not marketplace activity", async () => {
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_marketplace_bindings"), 0);
    });

    test("SURFACE 7: they are not revenue", async () => {
      // The sharpest one. The leak wrote a 4.00 SPEND; the only real spend is the clean 0.05.
      const business = await count(
        pool,
        "SELECT coalesce(sum(amount),0) n FROM ledger_entries_business WHERE type = 'SPEND'",
      );
      const raw = await count(pool, "SELECT coalesce(sum(amount),0) n FROM ledger_entries WHERE type = 'SPEND'");
      assert.equal(business, 50_000, "business spend is the clean receipt alone");
      assert.equal(raw, 4_050_000, "the raw row is still there — it was not deleted");
      assert.equal(await count(pool, "SELECT count(*) n FROM ledger_entries_business"), 1);
      assert.equal(await count(pool, "SELECT count(*) n FROM revenue_allocations"), 0);
    });

    test("SURFACE 7b: no leaked BLOCK_SAVED reaches a report", async () => {
      // BLOCK_SAVED is the "we stopped you spending this" line. Two of the three leaked entries are
      // that type, totalling 15.00 USDT0 of savings that were never saved from anything. Counted, they
      // would make the policy engine look like it prevented five times the spend it actually saw.
      const businessSaved = await count(
        pool,
        "SELECT coalesce(sum(amount),0) n FROM ledger_entries_business WHERE type = 'BLOCK_SAVED'",
      );
      const rawSaved = await count(
        pool,
        "SELECT coalesce(sum(amount),0) n FROM ledger_entries WHERE type = 'BLOCK_SAVED'",
      );
      assert.equal(businessSaved, 0, "no savings are claimed from the leak");
      assert.equal(rawSaved, 15_000_000, "6.00 + 9.00 still on disk, still not a report");

      assert.equal(
        await count(pool, "SELECT count(*) n FROM ledger_entries_business WHERE type = 'BLOCK_SAVED'"),
        0,
      );
    });

    test("SURFACE 7c: no leaked receipt reaches a trust score", async () => {
      // The trust bureau scores a party by its DECISION and VERIFY receipts. All four seeded rows are
      // DECISION receipts against the same agent, so an unfiltered scorer would read four; the shipped
      // query reads receipts_business and must see one.
      const scored = await pool.query<{ receipt_id: string; decision: number }>(
        `SELECT r.receipt_id, r.decision FROM receipts_business r
           LEFT JOIN ledger_entries_business l ON l.receipt_id = r.receipt_id
          WHERE r.kind = 'DECISION' AND r.agent_id = $1
          ORDER BY r.created_at`,
        [AGENT],
      );
      assert.equal(scored.rowCount, 1, "one scoreable decision, not four");
      assert.equal(scored.rows[0]!.receipt_id, CLEAN);

      // Decision 14 is the ESCALATED outcome and 10 is BLOCKED. Neither may reach a score: they would
      // describe how a real party behaves using a decision nobody requested.
      assert.ok(
        !scored.rows.some((r) => r.decision === 14 || r.decision === 10),
        "no leaked escalation or block enters the score",
      );
    });

    test("SURFACE 5b: the leaked escalation cannot read as a legitimate account approval", async () => {
      // An account approval means: this account's owner authorised this payment. The leaked row has
      // none of that. It is absent from the account-scoped approval model entirely, and excluded from
      // the business escalation view, so neither surface can present it as one.
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_approval_requests"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_approval_decisions"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_approval_deliveries"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM escalations_business"), 0);

      // It also carries no account id of its own, so no join can attach it to one.
      const cols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema='public' AND table_name='escalations' AND column_name = 'account_id'`,
      );
      assert.equal(cols.rowCount, 0, "the legacy escalation model has no account_id to be mistaken for one");
    });

    test("SURFACE 5c: the leaked operator and dashboard binding cannot satisfy account authority", async () => {
      // Account authority is an ACTIVE row in untch_wallet_bindings with a policy-authority scope.
      // The leaked rows live in the legacy escalation_operator tables, which have no account_id, no
      // scopes and no proof — they cannot satisfy that predicate because they cannot even express it.
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_wallet_bindings"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM untch_channel_bindings"), 0);

      for (const table of ["escalation_operators", "escalation_operator_bindings"]) {
        const cols = await pool.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns
            WHERE table_schema='public' AND table_name=$1 AND column_name IN ('account_id','scopes','proof_kind')`,
          [table],
        );
        assert.equal(cols.rowCount, 0, `${table} carries no account, scope or proof column`);
      }

      // And both are classified, so an operator surface that does join them shows the warning.
      const annotated = await count(
        pool,
        `SELECT count(*) n FROM untch_artifact_annotations
          WHERE artifact_kind IN ('ESCALATION_OPERATOR','ESCALATION_OPERATOR_BINDING')
            AND eligible_for_public_proof = false`,
      );
      assert.equal(annotated, 2);
    });

    test("SURFACE 8: they are not public Explorer success cases", async () => {
      assert.equal(await count(pool, "SELECT count(*) n FROM receipts_public"), 1);
      assert.equal(await count(pool, "SELECT count(*) n FROM activity_cases"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM indexed_transactions"), 0);
      assert.equal(await count(pool, "SELECT count(*) n FROM escalations_business"), 0, "the escalation is excluded");
      assert.equal(await count(pool, "SELECT count(*) n FROM escalations"), 1, "and still present in the raw table");
    });

    // ── Anchoring ─────────────────────────────────────────────────────────────────────────────────

    test("a leaked receipt cannot be anchored, by any route", async () => {
      for (const id of LEAKED) {
        await refuses(
          pool,
          `UPDATE receipts SET tx_hash='0xdead', block_number=1, status='CONFIRMED' WHERE receipt_id='${id}'`,
          /ineligible for anchoring/,
        );
        // Setting CONFIRMED alone, with no transaction, is the same false claim by a shorter path.
        await refuses(pool, `UPDATE receipts SET status='CONFIRMED' WHERE receipt_id='${id}'`, /ineligible for anchoring/);
      }
    });

    test("the batch holding them cannot be submitted", async () => {
      await refuses(pool, "UPDATE batches SET status='SUBMITTED' WHERE id='28'", /cannot be submitted/);
      await refuses(pool, "UPDATE batches SET status='CONFIRMED' WHERE id='28'", /cannot be submitted/);
    });

    test("a leaked receipt is never claimed into a new batch", async () => {
      // The anchorer's own claim query, with the same predicate the shipped SQL uses.
      const claimable = await pool.query(
        `SELECT receipt_id FROM receipts r
          WHERE status = 'QUEUED'
            AND NOT EXISTS (SELECT 1 FROM untch_artifact_annotations a
                             WHERE a.artifact_kind='RECEIPT' AND a.artifact_ref=r.receipt_id
                               AND a.eligible_for_anchoring = false)`,
      );
      assert.deepEqual(claimable.rows.map((r) => (r as { receipt_id: string }).receipt_id), [CLEAN]);
    });

    // ── The control, and the operator's view ──────────────────────────────────────────────────────

    test("real work is unaffected: the clean receipt still anchors and its batch still submits", async () => {
      await pool.query(
        `UPDATE receipts SET tx_hash='0xc0ffee', block_number=99, status='CONFIRMED' WHERE receipt_id='${CLEAN}'`,
      );
      await pool.query("UPDATE batches SET status='SUBMITTED' WHERE id='29'");

      const r = await pool.query<{ status: string; tx_hash: string }>(
        `SELECT status, tx_hash FROM receipts WHERE receipt_id='${CLEAN}'`,
      );
      assert.equal(r.rows[0]!.status, "CONFIRMED");
      assert.equal(r.rows[0]!.tx_hash, "0xc0ffee");
    });

    test("an operator audit view still shows every row, with the warning attached", async () => {
      const rows = await pool.query<{ receipt_id: string; quarantined: boolean; quarantine_classification: string | null }>(
        "SELECT receipt_id, quarantined, quarantine_classification FROM receipts_audit ORDER BY receipt_id",
      );
      assert.equal(rows.rowCount, 4, "the audit view hides nothing");

      for (const row of rows.rows) {
        if (row.receipt_id === CLEAN) {
          assert.equal(row.quarantined, false);
          assert.equal(row.quarantine_classification, null);
        } else {
          assert.equal(row.quarantined, true, `${row.receipt_id} must be flagged`);
          assert.equal(row.quarantine_classification, "VALIDATION_EXTERNAL_SIDE_EFFECT_LEAK");
        }
      }

      const esc = await pool.query<{ quarantined: boolean; quarantine_note: string }>(
        "SELECT quarantined, quarantine_note FROM escalations_audit",
      );
      assert.equal(esc.rows[0]!.quarantined, true);
      assert.match(esc.rows[0]!.quarantine_note, /rolled back/);
    });

    test("the historical contents are preserved exactly, not rewritten", async () => {
      const r = await pool.query<{ status: string; amount: string; decision: number }>(
        `SELECT status, amount, decision FROM receipts WHERE receipt_id='${LEAKED[1]}'`,
      );
      assert.equal(r.rows[0]!.status, "DEGRADED_UNANCHORED", "status untouched");
      assert.equal(r.rows[0]!.amount, "6000000", "amount untouched");
      assert.equal(r.rows[0]!.decision, 14, "decision untouched");

      const e = await pool.query<{ status: string; resolved_by: unknown }>(
        "SELECT status FROM escalations WHERE id='esc_44c567b949fe'",
      );
      assert.equal(e.rows[0]!.status, "APPROVED", "the approval really happened and still reads that way");
    });
  },
);
