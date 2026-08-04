import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createPool } from "@untch/consumer-core";

/**
 * The guard that stops roughly 150 Postgres tests from silently not existing.
 *
 * WHAT WENT WRONG, AND WHY NOTHING CAUGHT IT
 *
 * Every Postgres suite in this repo gates itself with `describe(..., { skip: TEST_DB ? false : ... })`.
 * When `TEST_DATABASE_URL` is unset, node:test does not register the children of a skipped describe at
 * all. They are not reported as skipped, because a test that never registered cannot be skipped. The
 * totals simply drop, from 567 to 416, and every remaining test passes.
 *
 * So "0 skipped, all green" was true and told you nothing. A reviewer reading that line had no way to
 * see that the database-backed third of the suite had not run.
 *
 * WHAT THIS FILE DOES
 *
 * It never skips, so it always registers, which is the property the suites it protects lack. It checks
 * two different things for two different failure modes:
 *
 *   1. A DRIFT CHECK that runs everywhere. Every `*-pg.test.ts` file must gate on `TEST_DATABASE_URL`
 *      and nothing else. A file that invents its own variable would be silently omitted on a machine
 *      that set the standard one, which is the same bug wearing a different name.
 *   2. A PRESENCE CHECK that runs only when `REQUIRE_POSTGRES_TESTS` is set, which CI sets and a
 *      laptop does not. There, an absent or unreachable `TEST_DATABASE_URL` is a hard failure rather
 *      than a quieter test run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It does not assert a total test count. A pinned total fails every time somebody adds a valid test,
 * which trains people to update the number without reading why it moved, and that is worse than no
 * check. It counts and reports the size of the Postgres GROUP instead, because that number changes
 * only when a database suite is added or removed, and both of those deserve a second look.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");

/** Every directory that holds database-backed suites. Add one here when a package grows them. */
const SUITE_DIRS = [
  join(REPO, "services", "asp", "test"),
  join(REPO, "packages", "consumer-core", "test"),
];

/** The ONE variable a Postgres suite may gate on. */
const REQUIRED_ENV = "TEST_DATABASE_URL";

function postgresSuiteFiles(): readonly string[] {
  const found: string[] = [];
  for (const dir of SUITE_DIRS) {
    let entries: readonly string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.endsWith("-pg.test.ts")) found.push(join(dir, name));
    }
  }
  return found.sort();
}

describe("the Postgres group cannot silently fail to register", () => {
  const files = postgresSuiteFiles();

  test("there are Postgres suites to protect", () => {
    assert.ok(
      files.length > 0,
      "found no *-pg.test.ts files at all, which means either the suites moved or this guard is looking in the wrong place",
    );
    console.log(`  postgres suite files: ${files.length}`);
    for (const f of files) console.log(`    ${f.slice(REPO.length + 1)}`);
  });

  test(`every Postgres suite gates on ${REQUIRED_ENV} and nothing else`, () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      if (!source.includes(`process.env.${REQUIRED_ENV}`)) offenders.push(file.slice(REPO.length + 1));
    }
    assert.deepEqual(
      offenders,
      [],
      `these suites do not read ${REQUIRED_ENV}, so a run that sets it would still omit them`,
    );
  });

  /**
   * The check that would have caught the original defect. CI sets REQUIRE_POSTGRES_TESTS, so a
   * workflow that loses its database service or its environment variable fails loudly here instead of
   * reporting a smaller green run.
   */
  test("a run that claims to cover Postgres actually has a database", { skip: process.env.REQUIRE_POSTGRES_TESTS ? false : "REQUIRE_POSTGRES_TESTS is unset, so this is a local run" }, async () => {
    const url = process.env[REQUIRED_ENV]?.trim();
    assert.ok(
      url,
      `REQUIRE_POSTGRES_TESTS is set but ${REQUIRED_ENV} is not. ${files.length} database suites would not have registered, and the run would still have reported every remaining test as passing.`,
    );

    const pool = createPool(url);
    try {
      const { rows } = await pool.query<{ one: number }>("SELECT 1 AS one");
      assert.equal(rows[0]?.one, 1, "the configured database answered, but not with what was asked");
    } finally {
      await pool.end();
    }
  });
});
