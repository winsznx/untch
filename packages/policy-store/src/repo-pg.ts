import type { PolicyRules } from "@untch/policy-engine";
import type { Address, Hex } from "viem";
import type { Pool } from "./db";
import type { PolicyRepo } from "./repo";
import type { OnchainRef, StoredPolicy, StoredPolicyStatus } from "./types";

/**
 * Postgres-backed `PolicyRepo`. `id` is stored as NUMERIC(78,0) (a uint256 policyId) and read back as
 * the decimal string the rest of the system carries. Every mutator bumps `updated_at`.
 */
interface PolicyDbRow {
  id: string;
  owner: string;
  agent_id: string;
  version: number;
  status: string;
  policy_hash: string;
  expiry: string;
  onchain_ref: OnchainRef;
  rules: PolicyRules;
  created_at: Date;
  updated_at: Date;
}

function rowToStored(r: PolicyDbRow): StoredPolicy {
  return {
    id: r.id,
    owner: r.owner as Address,
    agentId: r.agent_id as Address,
    version: r.version,
    status: r.status as StoredPolicyStatus,
    policyHash: r.policy_hash as Hex,
    expiry: Number(r.expiry),
    onchainRef: r.onchain_ref,
    rules: r.rules,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

export class PgPolicyRepo implements PolicyRepo {
  constructor(private readonly pool: Pool) {}

  async insert(policy: StoredPolicy): Promise<void> {
    await this.pool.query(
      `INSERT INTO policies (
         id, owner, agent_id, version, status, policy_hash, expiry, onchain_ref, rules
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO NOTHING`,
      [
        policy.id,
        policy.owner,
        policy.agentId,
        policy.version,
        policy.status,
        policy.policyHash,
        policy.expiry,
        JSON.stringify(policy.onchainRef),
        JSON.stringify(policy.rules),
      ],
    );
  }

  async getById(policyId: string): Promise<StoredPolicy | null> {
    const res = await this.pool.query<PolicyDbRow>(
      `SELECT id::text, owner, agent_id, version, status, policy_hash, expiry::text,
              onchain_ref, rules, created_at, updated_at
         FROM policies WHERE id = $1`,
      [policyId],
    );
    const row = res.rows[0];
    return row ? rowToStored(row) : null;
  }

  async updateRuleset(args: {
    policyId: string;
    policyHash: string;
    rules: StoredPolicy["rules"];
    version: number;
    expiry: number;
    onchainRef: OnchainRef;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE policies
          SET policy_hash = $2, rules = $3, version = $4, expiry = $5, onchain_ref = $6,
              updated_at = now()
        WHERE id = $1`,
      [
        args.policyId,
        args.policyHash,
        JSON.stringify(args.rules),
        args.version,
        args.expiry,
        JSON.stringify(args.onchainRef),
      ],
    );
  }

  async setStatus(args: {
    policyId: string;
    status: StoredPolicyStatus;
    version: number;
    onchainRef: OnchainRef;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE policies
          SET status = $2, version = $3, onchain_ref = $4, updated_at = now()
        WHERE id = $1`,
      [args.policyId, args.status, args.version, JSON.stringify(args.onchainRef)],
    );
  }

  async listByAgent(agentId: string): Promise<StoredPolicy[]> {
    const res = await this.pool.query<PolicyDbRow>(
      `SELECT id::text, owner, agent_id, version, status, policy_hash, expiry::text,
              onchain_ref, rules, created_at, updated_at
         FROM policies WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return res.rows.map(rowToStored);
  }

  async listByOwner(owner: string): Promise<StoredPolicy[]> {
    // Case-insensitive: session/checksummed addresses must match however the registrant wallet was stored.
    const res = await this.pool.query<PolicyDbRow>(
      `SELECT id::text, owner, agent_id, version, status, policy_hash, expiry::text,
              onchain_ref, rules, created_at, updated_at
         FROM policies WHERE LOWER(owner) = LOWER($1) ORDER BY created_at DESC`,
      [owner],
    );
    return res.rows.map(rowToStored);
  }
}
