/**
 * The spend-intent store, backed by Postgres because a Worker forgets everything between requests.
 *
 * `InMemoryIntentStore` is correct for a long-lived Node process: `create_spend_intent` puts an intent
 * in a map and a later `preflight_payment` finds it there. A Worker has no such continuity — the second
 * request may land in a different isolate in a different colo, holding an empty map. The same code
 * would then work or fail depending on which machine answered, which is the worst failure shape
 * available: intermittent, unreproducible, and invisible in the error message.
 *
 * Same two methods as the in-memory store, so the handlers cannot tell the difference and nothing in
 * the canonical business logic had to change to accept it.
 */

import type { Pool } from "@untch/consumer-core";

export class PgIntentStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert rather than insert. Re-creating an intent with the same hash is not an error — the hash is
   * derived from the content, so an identical hash means an identical intent, and refusing the second
   * one would make a harmless retry look like a conflict.
   */
  async put(intentHash: string, intent: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO untch_spend_intents (intent_hash, intent)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (intent_hash) DO UPDATE
         SET intent = EXCLUDED.intent, created_at = now(),
             expires_at = now() + interval '24 hours'`,
      [intentHash.toLowerCase(), JSON.stringify(intent)],
    );
  }

  /**
   * Expiry is enforced by the DATABASE clock in the query, not by comparing against the isolate's
   * `Date.now()`. A Worker's clock is not the clock these rows were written against, and an intent is
   * a time-bounded quote — deciding it is still valid using the wrong clock is how a stale quote gets
   * spent.
   */
  async get(intentHash: string): Promise<unknown | undefined> {
    const { rows } = await this.pool.query<{ intent: unknown }>(
      `SELECT intent FROM untch_spend_intents
        WHERE intent_hash = $1 AND expires_at > now()`,
      [intentHash.toLowerCase()],
    );
    return rows[0]?.intent ?? undefined;
  }

  /** Drop what nobody spent in time. Returns the count so the scheduled job can report it. */
  async expire(): Promise<number> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM untch_spend_intents WHERE expires_at <= now()`,
    );
    return rowCount ?? 0;
  }
}
