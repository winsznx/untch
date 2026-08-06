/**
 * What the runtime is allowed to ask about the schema, and what it is not allowed to do about it.
 *
 * THE SPLIT
 *
 * `runMigrations` reads `.sql` files off disk with `readdirSync`, which is why five `db.ts` files
 * import `node:fs`. That is fine in a Node admin process and impossible in a Worker — and the fix is
 * not to bundle the SQL so a Worker can apply it. Applying migrations from request-serving code was
 * already the wrong shape: a cold start is not a deployment, and thirty isolates racing to ALTER the
 * same table is a worse problem than the one it solves.
 *
 * So execution moves to a Node-only CLI (`pnpm migrate:all`), and the runtime keeps exactly one
 * question: IS THE DATABASE THE ONE THIS BUNDLE WAS BUILT AGAINST. That is answerable in pure SQL,
 * with no filesystem and no DDL rights.
 *
 * WHY THE ANSWER IS A REFUSAL AND NOT A WARNING
 *
 * A Worker whose bundle expects migration 036 and finds 035 is running code against a schema that
 * does not have the columns it will write to. The failure would surface later, deeper, and on a
 * money path — a missing column inside a transaction that had already inserted a decision. Refusing
 * at readiness turns that into a deployment that never takes traffic.
 */

import type { Pool } from "./db";

/** The narrow query surface this needs, so it can run on a pool, a client, or inside a transaction. */
export interface SchemaVersionQuery {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export type SchemaVerdict =
  | { readonly ok: true; readonly applied: number; readonly head: string }
  | {
      readonly ok: false;
      readonly reason: "SCHEMA_BEHIND_BUNDLE" | "SCHEMA_AHEAD_OF_BUNDLE" | "SCHEMA_ABSENT";
      readonly detail: string;
      readonly applied: number;
      readonly head: string | null;
      readonly expectedHead: string;
      readonly missing: readonly string[];
    };

/**
 * Compare what the database has applied against what this bundle was built expecting.
 *
 * `expected` is the full ordered list rather than just a head, because a head alone cannot tell
 * "035 applied" from "035 applied but 031 was skipped during a partial restore". The migration names
 * are globally unique across packages by convention, which is what makes one shared list correct.
 */
export async function verifySchemaVersion(
  db: SchemaVersionQuery,
  expected: readonly string[],
): Promise<SchemaVerdict> {
  const expectedHead = expected.length > 0 ? (expected[expected.length - 1] as string) : "";

  let rows: { name: string }[];
  try {
    ({ rows } = await db.query<{ name: string }>("SELECT name FROM schema_migrations ORDER BY name"));
  } catch {
    /**
     * A missing `schema_migrations` is not an error to retry — it means this database has never been
     * migrated, and a Worker must not be the thing that fixes that.
     */
    return {
      ok: false,
      reason: "SCHEMA_ABSENT",
      detail: "schema_migrations does not exist — run `pnpm migrate:all` against this database first",
      applied: 0,
      head: null,
      expectedHead,
      missing: [...expected],
    };
  }

  const appliedNames = new Set(rows.map((r) => r.name));
  const missing = expected.filter((name) => !appliedNames.has(name));

  if (missing.length > 0) {
    return {
      ok: false,
      reason: "SCHEMA_BEHIND_BUNDLE",
      detail:
        `this bundle expects ${expected.length} migrations and the database has ${rows.length}; ` +
        `missing ${missing.length} including ${missing[0]}`,
      applied: rows.length,
      head: rows[rows.length - 1]?.name ?? null,
      expectedHead,
      missing,
    };
  }

  /**
   * The database is AHEAD. Reported, and deliberately NOT refused.
   *
   * This is the ordinary state during a rolling deploy: the migration has been applied and the old
   * bundle is still serving the tail of its traffic. Migrations in this repo are additive, so an old
   * bundle against a newer schema reads and writes the columns it knows about. Refusing here would
   * turn every deployment into an outage, which is a worse failure than the one it would prevent.
   */
  const extra = rows.filter((r) => !expected.includes(r.name));
  if (extra.length > 0) {
    return {
      ok: true,
      applied: rows.length,
      head: rows[rows.length - 1]?.name ?? expectedHead,
    };
  }

  return { ok: true, applied: rows.length, head: expectedHead };
}
