import type { Hex } from "viem";
import type {
  EscalationView,
  OrderRecord,
  ScoreDataSource,
  VerifyRecord,
} from "./datasource";
import type { ScoreSnapshotRow, SubjectKind } from "./types";

/**
 * In-memory `ScoreDataSource` for hermetic tests and the anchor proof. It is seeded with REAL records —
 * the anchor proof drives the actual proof-engine / policy-engine outputs into it, so the score it
 * computes is genuinely derived, not fabricated. No database; not for production (no durability).
 */
export class MemoryScoreDataSource implements ScoreDataSource {
  private readonly orders: OrderRecord[] = [];
  private readonly verifies: VerifyRecord[] = [];
  private readonly escalations: EscalationView[] = [];
  /** intent_id → {vendorId, agentId}, so an escalation can be attributed to a subject like the SQL join. */
  private readonly intentSubject = new Map<string, { vendorId: Hex; agentId: Hex }>();
  private readonly snapshots = new Map<string, ScoreSnapshotRow>();

  addOrder(r: OrderRecord): this {
    this.orders.push(r);
    this.intentSubject.set(r.intentHash.toLowerCase(), { vendorId: r.vendorId, agentId: r.agentId });
    return this;
  }
  addVerify(r: VerifyRecord): this {
    this.verifies.push(r);
    this.intentSubject.set(r.intentHash.toLowerCase(), { vendorId: r.vendorId, agentId: r.agentId });
    return this;
  }
  /** Add an escalation bound to an intent that must already have an order/verify (for attribution). */
  addEscalation(e: EscalationView): this {
    this.escalations.push(e);
    return this;
  }

  async vendorOrders(vendorId: Hex): Promise<readonly OrderRecord[]> {
    return this.orders.filter((o) => eq(o.vendorId, vendorId));
  }
  async vendorVerifies(vendorId: Hex): Promise<readonly VerifyRecord[]> {
    return this.verifies.filter((v) => eq(v.vendorId, vendorId));
  }
  async vendorEscalations(vendorId: Hex): Promise<readonly EscalationView[]> {
    return this.escalations.filter((e) => {
      const s = this.intentSubject.get(e.intentId.toLowerCase());
      return s !== undefined && eq(s.vendorId, vendorId);
    });
  }
  async buyerOrders(agentId: Hex): Promise<readonly OrderRecord[]> {
    return this.orders.filter((o) => eq(o.agentId, agentId));
  }
  async buyerVerifies(agentId: Hex): Promise<readonly VerifyRecord[]> {
    return this.verifies.filter((v) => eq(v.agentId, agentId));
  }
  async buyerEscalations(agentId: Hex): Promise<readonly EscalationView[]> {
    return this.escalations.filter((e) => {
      const s = this.intentSubject.get(e.intentId.toLowerCase());
      return s !== undefined && eq(s.agentId, agentId);
    });
  }

  async saveSnapshot(row: ScoreSnapshotRow): Promise<void> {
    this.snapshots.set(keyOf(row.subject, row.subjectId, row.epoch), row);
  }
  async setAnchoredRoot(kind: SubjectKind, epoch: number, root: Hex): Promise<void> {
    for (const [k, row] of this.snapshots) {
      if (row.subject === kind && row.epoch === epoch) {
        this.snapshots.set(k, { ...row, anchoredRoot: root });
      }
    }
  }
  async snapshotsForEpoch(kind: SubjectKind, epoch: number): Promise<readonly ScoreSnapshotRow[]> {
    return [...this.snapshots.values()]
      .filter((r) => r.subject === kind && r.epoch === epoch)
      .sort((a, b) => a.subjectId.localeCompare(b.subjectId));
  }

  async latestSnapshot(kind: SubjectKind, subjectId: Hex): Promise<ScoreSnapshotRow | null> {
    const rows = [...this.snapshots.values()]
      .filter((r) => r.subject === kind && r.subjectId.toLowerCase() === subjectId.toLowerCase())
      .sort((a, b) => Date.parse(b.computedAt) - Date.parse(a.computedAt));
    return rows[0] ?? null;
  }
}

function eq(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}
function keyOf(kind: SubjectKind, subjectId: string, epoch: number): string {
  return `${kind}:${subjectId.toLowerCase()}:${epoch}`;
}
