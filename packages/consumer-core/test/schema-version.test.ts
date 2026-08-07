import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { verifySchemaVersion, type SchemaVersionQuery } from "../src/schema-version";

/**
 * The runtime's only question about the schema, and the shape of each answer.
 *
 * Stubbed at the query boundary rather than run against Postgres, because what is under test is the
 * VERDICT logic — which of behind, ahead, absent and equal refuses, and which does not. The real
 * database behaviour that backs it (`schema_migrations` contents) is already covered by the migration
 * suites; duplicating it here would test Postgres rather than this decision.
 */

const db = (names: string[] | Error): SchemaVersionQuery => ({
  async query<T>(): Promise<{ rows: T[] }> {
    if (names instanceof Error) throw names;
    return { rows: names.map((name) => ({ name })) as T[] };
  },
});

const EXPECTED = ["001_init.sql", "002_policies.sql", "035_wallet_scope_downgrade.sql"];

describe("the runtime verifies the schema and never changes it", () => {
  test("an exactly-matching database is ready", async () => {
    const v = await verifySchemaVersion(db([...EXPECTED]), EXPECTED);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.applied, 3);
    assert.equal(v.ok && v.head, "035_wallet_scope_downgrade.sql");
  });

  test("a database missing a migration this bundle needs is refused, and names what is missing", async () => {
    const v = await verifySchemaVersion(db(["001_init.sql", "002_policies.sql"]), EXPECTED);
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.reason, "SCHEMA_BEHIND_BUNDLE");
    assert.deepEqual(!v.ok && v.missing, ["035_wallet_scope_downgrade.sql"]);
    assert.match(!v.ok ? v.detail : "", /035_wallet_scope_downgrade\.sql/);
  });

  /**
   * The case a head-only comparison cannot see. After a partial restore the newest migration can be
   * present while an earlier one is not, and comparing heads would call that healthy.
   */
  test("a gap in the middle is caught even though the head matches", async () => {
    const v = await verifySchemaVersion(db(["001_init.sql", "035_wallet_scope_downgrade.sql"]), EXPECTED);
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.reason, "SCHEMA_BEHIND_BUNDLE");
    assert.deepEqual(!v.ok && v.missing, ["002_policies.sql"]);
    assert.equal(!v.ok && v.head, "035_wallet_scope_downgrade.sql", "the head alone looked fine");
  });

  /**
   * A newer database is the ordinary middle of a rolling deploy: the migration has landed and the old
   * bundle is still draining. Migrations here are additive, so the old bundle reads and writes the
   * columns it knows about. Refusing would turn every deployment into an outage.
   */
  test("a database ahead of the bundle is allowed, because that is a rolling deploy", async () => {
    const v = await verifySchemaVersion(db([...EXPECTED, "036_later.sql"]), EXPECTED);
    assert.equal(v.ok, true);
    assert.equal(v.ok && v.applied, 4);
    assert.equal(v.ok && v.head, "036_later.sql");
  });

  test("a database that was never migrated is refused with the fix in the message", async () => {
    const v = await verifySchemaVersion(db(new Error('relation "schema_migrations" does not exist')), EXPECTED);
    assert.equal(v.ok, false);
    assert.equal(!v.ok && v.reason, "SCHEMA_ABSENT");
    assert.match(!v.ok ? v.detail : "", /migrate:all/);
    assert.deepEqual(!v.ok && v.missing, EXPECTED);
  });

  test("verification issues no DDL — it only ever SELECTs", async () => {
    const statements: string[] = [];
    const spy: SchemaVersionQuery = {
      async query<T>(sql: string): Promise<{ rows: T[] }> {
        statements.push(sql);
        return { rows: EXPECTED.map((name) => ({ name })) as T[] };
      },
    };
    await verifySchemaVersion(spy, EXPECTED);

    assert.equal(statements.length, 1);
    assert.match(statements[0]!, /^SELECT /i);
    for (const forbidden of ["CREATE", "ALTER", "DROP", "INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      assert.ok(
        !new RegExp(`\\b${forbidden}\\b`, "i").test(statements[0]!),
        `the runtime path must never issue ${forbidden}`,
      );
    }
  });
});
