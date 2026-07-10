import type { PolicyRepo } from "./repo";
import type { OnchainRef, StoredPolicy, StoredPolicyStatus } from "./types";

/**
 * In-memory `PolicyRepo` for unit tests — same semantics as the Postgres one, no database. Used by
 * the service/provider/handler tests so they exercise real logic (canon hashing, id derivation,
 * status transitions) with a fake chain + fake store and zero I/O.
 */
export class InMemoryPolicyRepo implements PolicyRepo {
  private readonly byId = new Map<string, StoredPolicy>();

  async insert(policy: StoredPolicy): Promise<void> {
    if (!this.byId.has(policy.id)) this.byId.set(policy.id, policy);
  }

  async getById(policyId: string): Promise<StoredPolicy | null> {
    return this.byId.get(policyId) ?? null;
  }

  async updateRuleset(args: {
    policyId: string;
    policyHash: string;
    rules: StoredPolicy["rules"];
    version: number;
    expiry: number;
    onchainRef: OnchainRef;
  }): Promise<void> {
    const cur = this.byId.get(args.policyId);
    if (!cur) return;
    this.byId.set(args.policyId, {
      ...cur,
      policyHash: args.policyHash as StoredPolicy["policyHash"],
      rules: args.rules,
      version: args.version,
      expiry: args.expiry,
      onchainRef: args.onchainRef,
      updatedAt: cur.updatedAt,
    });
  }

  async setStatus(args: {
    policyId: string;
    status: StoredPolicyStatus;
    version: number;
    onchainRef: OnchainRef;
  }): Promise<void> {
    const cur = this.byId.get(args.policyId);
    if (!cur) return;
    this.byId.set(args.policyId, {
      ...cur,
      status: args.status,
      version: args.version,
      onchainRef: args.onchainRef,
    });
  }

  async listByAgent(agentId: string): Promise<StoredPolicy[]> {
    return [...this.byId.values()].filter((p) => p.agentId.toLowerCase() === agentId.toLowerCase());
  }
}
