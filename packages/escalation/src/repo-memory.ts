import type { CreateEscalationRow, EscalationsRepo, StatusTransition } from "./repo";
import type { ChannelLogEntry, EscalationRecord } from "./types";

/**
 * In-memory `EscalationsRepo` for unit tests. Deliberately mirrors the pg repo's transition semantics
 * exactly: `transition` only applies when the row is in one of `fromStatuses`, so the "first valid
 * decision wins, the rest are already-resolved" property is enforced here too and the adversarial +
 * state-machine tests exercise the SAME guard the database enforces.
 */
export class InMemoryEscalationsRepo implements EscalationsRepo {
  private readonly byId = new Map<string, EscalationRecord>();
  private readonly pollRefToId = new Map<string, string>();

  async create(row: CreateEscalationRow): Promise<EscalationRecord> {
    if (this.pollRefToId.has(row.pollRef)) {
      const existing = this.byId.get(this.pollRefToId.get(row.pollRef)!);
      if (existing) return existing;
    }
    const now = new Date().toISOString();
    const record: EscalationRecord = {
      id: row.id,
      intentId: row.intentId,
      pollRef: row.pollRef,
      status: "PENDING",
      reason: row.reason,
      policyId: row.policyId,
      amount: row.amount,
      token: row.token,
      approvals: row.approvals,
      approvalCodeHash: row.approvalCodeHash,
      codeExpiresAt: row.codeExpiresAt,
      channelLog: [...row.initialLog],
      approvedChannels: [],
      resolvedBy: null,
      resolvedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(record.id, record);
    this.pollRefToId.set(record.pollRef, record.id);
    return record;
  }

  async getByPollRef(pollRef: string): Promise<EscalationRecord | null> {
    const id = this.pollRefToId.get(pollRef);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async getById(id: string): Promise<EscalationRecord | null> {
    return this.byId.get(id) ?? null;
  }

  async getByCodeHash(codeHash: string): Promise<EscalationRecord | null> {
    for (const rec of this.byId.values()) {
      if (rec.approvalCodeHash === codeHash) return rec;
    }
    return null;
  }

  async appendLog(id: string, entry: ChannelLogEntry): Promise<void> {
    const rec = this.byId.get(id);
    if (!rec) return;
    this.byId.set(id, {
      ...rec,
      channelLog: [...rec.channelLog, entry],
      updatedAt: new Date().toISOString(),
    });
  }

  async transition(id: string, t: StatusTransition): Promise<EscalationRecord | null> {
    const rec = this.byId.get(id);
    if (!rec) return null;
    if (!t.fromStatuses.includes(rec.status)) return null;

    const approvedChannels =
      t.addApprovedChannel && !rec.approvedChannels.includes(t.addApprovedChannel)
        ? [...rec.approvedChannels, t.addApprovedChannel]
        : rec.approvedChannels;

    const updated: EscalationRecord = {
      ...rec,
      status: t.toStatus,
      channelLog: t.appendLog ? [...rec.channelLog, t.appendLog] : rec.channelLog,
      approvedChannels,
      resolvedBy: t.resolvedBy ?? rec.resolvedBy,
      resolvedAt: t.resolvedAtMs ? new Date(t.resolvedAtMs).toISOString() : rec.resolvedAt,
      updatedAt: new Date().toISOString(),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async findExpirable(nowMs: number, limit: number): Promise<EscalationRecord[]> {
    const open = new Set(["PENDING", "AWAITING_SECOND_CHANNEL", "NOTIFY_FAILED"]);
    return [...this.byId.values()]
      .filter((r) => open.has(r.status) && Date.parse(r.codeExpiresAt) <= nowMs)
      .slice(0, limit);
  }

  async listByIntentIds(intentIds: readonly string[]): Promise<EscalationRecord[]> {
    const wanted = new Set(intentIds.map((i) => i.toLowerCase()));
    return [...this.byId.values()]
      .filter((r) => wanted.has(r.intentId.toLowerCase()))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
