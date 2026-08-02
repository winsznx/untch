import type { Hex } from "viem";
import type { Pool } from "./db";
import type {
  EscalationView,
  OrderRecord,
  ScoreDataSource,
  VerifyRecord,
} from "./datasource";
import type { Band, FeatureResult, ScoreSnapshotRow, SubjectKind } from "./types";

/**
 * Postgres-backed `ScoreDataSource` reading the SHARED instance's `receipts` / `ledger_entries` /
 * `escalations` tables (owned by receipt-writer + escalation) and reading/writing its own
 * `score_snapshots`. All reads are plain SELECTs — the Bureau never re-runs the policy or proof engine,
 * it reads their durable, already-anchored outputs (§8.2 trace history). Escalation → subject
 * attribution is the SQL join escalations.intent_id = receipts.intent_hash.
 */
export class PgScoreDataSource implements ScoreDataSource {
  constructor(private readonly pool: Pool) {}

  async vendorOrders(vendorId: Hex): Promise<readonly OrderRecord[]> {
    return this.orders("vendor_id", vendorId);
  }
  async buyerOrders(agentId: Hex): Promise<readonly OrderRecord[]> {
    return this.orders("agent_id", agentId);
  }
  private async orders(col: "vendor_id" | "agent_id", id: Hex): Promise<OrderRecord[]> {
    const res = await this.pool.query<{
      intent_hash: string;
      vendor_id: string;
      agent_id: string;
      decision: number;
      counterparty: string | null;
      created_at: Date;
    }>(
      /*
       * `receipts_business`, not `receipts`. A score is a claim about how a party behaves, and the
       * three receipts a rolled-back validation left behind on 2026-08-02 describe behaviour by
       * nobody: no quote was paid and no provider ran. Counting them would move a real party's score
       * on the strength of a defect. Migration 022 annotates them; this view applies it.
       */
      `SELECT r.intent_hash, r.vendor_id, r.agent_id, r.decision, l.counterparty, r.created_at
         FROM receipts_business r
         LEFT JOIN ledger_entries_business l ON l.receipt_id = r.receipt_id
        WHERE r.kind = 'DECISION' AND r.${col} = $1
        ORDER BY r.created_at`,
      [id],
    );
    return res.rows.map((r) => ({
      intentHash: r.intent_hash as Hex,
      vendorId: r.vendor_id as Hex,
      agentId: r.agent_id as Hex,
      decision: r.decision,
      counterparty: r.counterparty,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async vendorVerifies(vendorId: Hex): Promise<readonly VerifyRecord[]> {
    return this.verifies("vendor_id", vendorId);
  }
  async buyerVerifies(agentId: Hex): Promise<readonly VerifyRecord[]> {
    return this.verifies("agent_id", agentId);
  }
  private async verifies(col: "vendor_id" | "agent_id", id: Hex): Promise<VerifyRecord[]> {
    const res = await this.pool.query<{
      intent_hash: string;
      vendor_id: string;
      agent_id: string;
      verify_result: number;
      provenance: string | null;
      created_at: Date;
    }>(
      `SELECT intent_hash, vendor_id, agent_id, verify_result, provenance, created_at
         FROM receipts_business
        WHERE kind = 'VERIFY' AND ${col} = $1
        ORDER BY created_at`,
      [id],
    );
    return res.rows.map((r) => ({
      intentHash: r.intent_hash as Hex,
      vendorId: r.vendor_id as Hex,
      agentId: r.agent_id as Hex,
      verifyResult: r.verify_result,
      provenance:
        r.provenance === "store-committed" || r.provenance === "caller-supplied"
          ? r.provenance
          : null,
      createdAt: r.created_at.toISOString(),
    }));
  }

  async vendorEscalations(vendorId: Hex): Promise<readonly EscalationView[]> {
    return this.escalations("vendor_id", vendorId);
  }
  async buyerEscalations(agentId: Hex): Promise<readonly EscalationView[]> {
    return this.escalations("agent_id", agentId);
  }
  private async escalations(col: "vendor_id" | "agent_id", id: Hex): Promise<EscalationView[]> {
    const res = await this.pool.query<{
      intent_id: string;
      status: string;
      created_at: Date;
      resolved_at: Date | null;
      code_expires_at: Date;
    }>(
      `SELECT e.intent_id, e.status, e.created_at, e.resolved_at, e.code_expires_at
         FROM escalations_business e
        WHERE EXISTS (
          SELECT 1 FROM receipts_business r WHERE r.intent_hash = e.intent_id AND r.${col} = $1
        )
        ORDER BY e.created_at`,
      [id],
    );
    return res.rows.map((r) => ({
      intentId: r.intent_id,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
      codeExpiresAt: r.code_expires_at.toISOString(),
    }));
  }

  async saveSnapshot(row: ScoreSnapshotRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO score_snapshots
         (subject, subject_id, epoch, score, sigma, lcb, band, features, anchored_root, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       ON CONFLICT (subject, subject_id, epoch) DO UPDATE SET
         score = EXCLUDED.score, sigma = EXCLUDED.sigma, lcb = EXCLUDED.lcb, band = EXCLUDED.band,
         features = EXCLUDED.features, computed_at = EXCLUDED.computed_at`,
      [
        row.subject,
        row.subjectId,
        row.epoch,
        row.score,
        row.sigma,
        row.lcb,
        row.band,
        JSON.stringify(row.features),
        row.anchoredRoot,
        row.computedAt,
      ],
    );
  }

  async setAnchoredRoot(kind: SubjectKind, epoch: number, root: Hex): Promise<void> {
    await this.pool.query(
      `UPDATE score_snapshots SET anchored_root = $3 WHERE subject = $1 AND epoch = $2`,
      [kind, epoch, root],
    );
  }

  async snapshotsForEpoch(kind: SubjectKind, epoch: number): Promise<readonly ScoreSnapshotRow[]> {
    const res = await this.pool.query<{
      subject: string;
      subject_id: string;
      epoch: string;
      score: number;
      sigma: number;
      lcb: number;
      band: string;
      features: FeatureResult[];
      anchored_root: string | null;
      computed_at: Date;
    }>(
      `SELECT subject, subject_id, epoch, score, sigma, lcb, band, features, anchored_root, computed_at
         FROM score_snapshots WHERE subject = $1 AND epoch = $2 ORDER BY subject_id`,
      [kind, epoch],
    );
    return res.rows.map((r) => this.mapSnapshot(r));
  }

  async latestSnapshot(kind: SubjectKind, subjectId: Hex): Promise<ScoreSnapshotRow | null> {
    const res = await this.pool.query<{
      subject: string;
      subject_id: string;
      epoch: string;
      score: number;
      sigma: number;
      lcb: number;
      band: string;
      features: FeatureResult[];
      anchored_root: string | null;
      computed_at: Date;
    }>(
      `SELECT subject, subject_id, epoch, score, sigma, lcb, band, features, anchored_root, computed_at
         FROM score_snapshots
        WHERE subject = $1 AND subject_id = $2
        ORDER BY computed_at DESC
        LIMIT 1`,
      [kind, subjectId],
    );
    const row = res.rows[0];
    return row ? this.mapSnapshot(row) : null;
  }

  private mapSnapshot(r: {
    subject: string;
    subject_id: string;
    epoch: string;
    score: number;
    sigma: number;
    lcb: number;
    band: string;
    features: FeatureResult[];
    anchored_root: string | null;
    computed_at: Date;
  }): ScoreSnapshotRow {
    return {
      subject: r.subject as SubjectKind,
      subjectId: r.subject_id,
      epoch: Number(r.epoch),
      score: r.score,
      sigma: r.sigma,
      lcb: r.lcb,
      band: r.band as Band,
      features: r.features,
      anchoredRoot: (r.anchored_root as Hex | null) ?? null,
      computedAt: r.computed_at.toISOString(),
    };
  }
}
