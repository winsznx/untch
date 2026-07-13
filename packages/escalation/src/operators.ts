import type { Pool } from "./db";

/**
 * §27 operator-identity store (see migration 004). These tables are now GENUINELY LOAD-BEARING — no
 * longer just seeded placeholders. Two authority paths read them:
 *   • escalation ROUTING — an escalating policy is routed to its REAL owner's operator (resolved via the
 *     owner's `dashboard` binding, `operatorForOwner`) and fanned out to that operator's bound channels
 *     (`channelsForOperator`), not a hardcoded operator regardless of owner.
 *   • the §27 dashboard authority boundary — `verifyOwnership` checks the session wallet's operator is an
 *     approver of the escalation's policy (`operatorForOwner` + `approversFor`).
 * Every write is idempotent. A second approver / a real §15 onboarding is INSERTs, never a migration.
 */

/**
 * The interim single demo operator id (seeded by migration 004). It is the DEFAULT an escalation routes
 * to only when the policy's owner is not yet bound to its OWN operator — the interim single-operator
 * reality. A bound owner routes to its own operator instead; this is no longer used "regardless of owner".
 */
export const DEMO_OPERATOR_ID = "op_demo";

/** The channel an operator's OWNER WALLET is bound on — the SIWE-verified dashboard wallet. Owner→operator
 *  resolution keys on this (an EVM address, matched case-insensitively). */
export const OWNER_BINDING_CHANNEL = "dashboard";

export interface OperatorBinding {
  readonly operatorId: string;
  readonly channel: string;
  readonly handle: string;
}

export interface OperatorsRepo {
  /** Idempotently ensure an operator row exists (must precede its bindings — bindings FK to it). */
  ensureOperator(operatorId: string, label: string): Promise<void>;
  /** Idempotently bind (channel, handle) → operator. Safe to call every boot. */
  ensureBinding(operatorId: string, channel: string, handle: string): Promise<void>;
  /** Idempotently record that `operatorId` may approve `policyId`'s escalations. */
  ensurePolicyApprover(policyId: string, operatorId: string): Promise<void>;
  /** The operator a (channel, handle) is bound to, or null. */
  operatorForBinding(channel: string, handle: string): Promise<string | null>;
  /** The operator whose OWNER wallet is `ownerWallet` (the dashboard binding), case-insensitive, or null. */
  operatorForOwner(ownerWallet: string): Promise<string | null>;
  /** Every (channel, handle) binding for an operator — the surfaces it is reachable on (routing target). */
  channelsForOperator(operatorId: string): Promise<OperatorBinding[]>;
  /** The operator ids that may approve a policy. */
  approversFor(policyId: string): Promise<string[]>;
}

export class PgOperatorsRepo implements OperatorsRepo {
  constructor(private readonly pool: Pool) {}

  async ensureOperator(operatorId: string, label: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO escalation_operators (id, label) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
      [operatorId, label],
    );
  }

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

  async operatorForOwner(ownerWallet: string): Promise<string | null> {
    // Case-insensitive: an EVM address is the same address regardless of EIP-55 casing (mirrors
    // interimDashboardBinding), so a checksummed on-chain owner matches a lowercased bound handle.
    const res = await this.pool.query<{ operator_id: string }>(
      `SELECT operator_id FROM escalation_operator_bindings
        WHERE channel = $1 AND LOWER(handle) = LOWER($2) LIMIT 1`,
      [OWNER_BINDING_CHANNEL, ownerWallet],
    );
    return res.rows[0]?.operator_id ?? null;
  }

  async channelsForOperator(operatorId: string): Promise<OperatorBinding[]> {
    const res = await this.pool.query<{ operator_id: string; channel: string; handle: string }>(
      `SELECT operator_id, channel, handle FROM escalation_operator_bindings
        WHERE operator_id = $1 ORDER BY channel`,
      [operatorId],
    );
    return res.rows.map((r) => ({ operatorId: r.operator_id, channel: r.channel, handle: r.handle }));
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
  private readonly operators = new Set<string>();
  private readonly bindings: OperatorBinding[] = [];
  private readonly approvers = new Map<string, Set<string>>(); // policyId → operatorIds

  async ensureOperator(operatorId: string, _label: string): Promise<void> {
    this.operators.add(operatorId);
  }

  async ensureBinding(operatorId: string, channel: string, handle: string): Promise<void> {
    // Unique on (channel, handle) — the first binding wins, exactly like the Postgres PK conflict.
    if (this.bindings.some((b) => b.channel === channel && b.handle === handle)) return;
    this.bindings.push({ operatorId, channel, handle });
  }

  async ensurePolicyApprover(policyId: string, operatorId: string): Promise<void> {
    const set = this.approvers.get(policyId) ?? new Set<string>();
    set.add(operatorId);
    this.approvers.set(policyId, set);
  }

  async operatorForBinding(channel: string, handle: string): Promise<string | null> {
    return this.bindings.find((b) => b.channel === channel && b.handle === handle)?.operatorId ?? null;
  }

  async operatorForOwner(ownerWallet: string): Promise<string | null> {
    const wallet = ownerWallet.trim().toLowerCase();
    return (
      this.bindings.find(
        (b) => b.channel === OWNER_BINDING_CHANNEL && b.handle.trim().toLowerCase() === wallet,
      )?.operatorId ?? null
    );
  }

  async channelsForOperator(operatorId: string): Promise<OperatorBinding[]> {
    return this.bindings.filter((b) => b.operatorId === operatorId);
  }

  async approversFor(policyId: string): Promise<string[]> {
    return [...(this.approvers.get(policyId) ?? [])];
  }
}
