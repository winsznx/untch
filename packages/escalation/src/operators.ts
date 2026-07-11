import type { Pool } from "./db";

/**
 * §27 operator-identity readiness store (see migration 004). This is SCHEMA-READINESS, not the live
 * authority path: the §27 binding check still runs through the env-derived `combineBindings` today. These
 * methods only provision + read the readiness tables so today's single operator is represented as data,
 * and a second approver later is an INSERT rather than a migration. Every write is idempotent.
 */

/** The one interim demo operator id, seeded by migration 004. */
export const DEMO_OPERATOR_ID = "op_demo";

export interface OperatorBinding {
  readonly operatorId: string;
  readonly channel: string;
  readonly handle: string;
}

export interface OperatorsRepo {
  /** Idempotently bind (channel, handle) → operator. Safe to call every boot. */
  ensureBinding(operatorId: string, channel: string, handle: string): Promise<void>;
  /** Idempotently record that `operatorId` may approve `policyId`'s escalations. */
  ensurePolicyApprover(policyId: string, operatorId: string): Promise<void>;
  /** The operator a (channel, handle) is bound to, or null. (Read side — nothing calls it for authority yet.) */
  operatorForBinding(channel: string, handle: string): Promise<string | null>;
  /** The operator ids that may approve a policy. */
  approversFor(policyId: string): Promise<string[]>;
}

export class PgOperatorsRepo implements OperatorsRepo {
  constructor(private readonly pool: Pool) {}

  async ensureBinding(operatorId: string, channel: string, handle: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO escalation_operator_bindings (operator_id, channel, handle)
       VALUES ($1, $2, $3)
       ON CONFLICT (channel, handle) DO NOTHING`,
      [operatorId, channel, handle],
    );
  }

  async ensurePolicyApprover(policyId: string, operatorId: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO policy_approvers (policy_id, operator_id)
       VALUES ($1, $2)
       ON CONFLICT (policy_id, operator_id) DO NOTHING`,
      [policyId, operatorId],
    );
  }

  async operatorForBinding(channel: string, handle: string): Promise<string | null> {
    const res = await this.pool.query<{ operator_id: string }>(
      `SELECT operator_id FROM escalation_operator_bindings WHERE channel = $1 AND handle = $2`,
      [channel, handle],
    );
    return res.rows[0]?.operator_id ?? null;
  }

  async approversFor(policyId: string): Promise<string[]> {
    const res = await this.pool.query<{ operator_id: string }>(
      `SELECT operator_id FROM policy_approvers WHERE policy_id = $1 ORDER BY created_at`,
      [policyId],
    );
    return res.rows.map((r) => r.operator_id);
  }
}

/** In-memory mirror — same idempotent semantics, for tests without Postgres. */
export class InMemoryOperatorsRepo implements OperatorsRepo {
  private readonly bindings = new Map<string, string>(); // `${channel}:${handle}` → operatorId
  private readonly approvers = new Map<string, Set<string>>(); // policyId → operatorIds

  async ensureBinding(operatorId: string, channel: string, handle: string): Promise<void> {
    const key = `${channel}:${handle}`;
    if (!this.bindings.has(key)) this.bindings.set(key, operatorId);
  }

  async ensurePolicyApprover(policyId: string, operatorId: string): Promise<void> {
    const set = this.approvers.get(policyId) ?? new Set<string>();
    set.add(operatorId);
    this.approvers.set(policyId, set);
  }

  async operatorForBinding(channel: string, handle: string): Promise<string | null> {
    return this.bindings.get(`${channel}:${handle}`) ?? null;
  }

  async approversFor(policyId: string): Promise<string[]> {
    return [...(this.approvers.get(policyId) ?? [])];
  }
}
