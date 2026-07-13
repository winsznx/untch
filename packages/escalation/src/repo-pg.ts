import type { Pool } from "./db";
import type { CreateEscalationRow, EscalationsRepo, StatusTransition } from "./repo";
import type {
  ApprovalsConfig,
  ChannelLogEntry,
  EscalationRecord,
  EscalationStatus,
  ResolvedBy,
} from "./types";

/**
 * Postgres-backed `EscalationsRepo`. Every status change is a single conditional UPDATE guarded by
 * `WHERE status = ANY($fromStatuses)` with `RETURNING` — so two concurrent inbound approvals (or an
 * inbound racing the timeout worker) can never both win: whichever UPDATE runs first flips the status
 * out of the guard set, the second matches zero rows and returns null ("already resolved"). No advisory
 * locks, no read-modify-write race. `channel_log` and `approved_channels` are appended in-SQL so an
 * audit entry is never lost to a lost-update.
 */

interface EscalationDbRow {
  id: string;
  intent_id: string;
  poll_ref: string;
  status: EscalationStatus;
  reason: string;
  policy_id: string;
  amount: string;
  token: string;
  approvals: ApprovalsConfig;
  approval_code_hash: string;
  code_expires_at: Date;
  channel_log: ChannelLogEntry[];
  approved_channels: string[];
  resolved_by: ResolvedBy | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function rowToRecord(r: EscalationDbRow): EscalationRecord {
  return {
    id: r.id,
    intentId: r.intent_id,
    pollRef: r.poll_ref,
    status: r.status,
    reason: r.reason,
    policyId: r.policy_id,
    amount: Number(r.amount),
    token: r.token,
    approvals: r.approvals,
    approvalCodeHash: r.approval_code_hash,
    codeExpiresAt: r.code_expires_at.toISOString(),
    channelLog: r.channel_log ?? [],
    approvedChannels: r.approved_channels ?? [],
    resolvedBy: r.resolved_by,
    resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

const SELECT_COLS = `id, intent_id, poll_ref, status, reason, policy_id, amount, token, approvals,
  approval_code_hash, code_expires_at, channel_log, approved_channels, resolved_by, resolved_at,
  created_at, updated_at`;

export class PgEscalationsRepo implements EscalationsRepo {
  constructor(private readonly pool: Pool) {}

  async create(row: CreateEscalationRow): Promise<EscalationRecord> {
    const res = await this.pool.query<EscalationDbRow>(
      `INSERT INTO escalations (
         id, intent_id, poll_ref, status, reason, policy_id, amount, token, approvals,
         approval_code_hash, code_expires_at, channel_log
       ) VALUES ($1,$2,$3,'PENDING',$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb)
       ON CONFLICT (poll_ref) DO UPDATE SET updated_at = now()
       RETURNING ${SELECT_COLS}`,
      [
        row.id,
        row.intentId,
        row.pollRef,
        row.reason,
        row.policyId,
        row.amount,
        row.token,
        JSON.stringify(row.approvals),
        row.approvalCodeHash,
        row.codeExpiresAt,
        JSON.stringify(row.initialLog),
      ],
    );
    return rowToRecord(res.rows[0]!);
  }

  async getByPollRef(pollRef: string): Promise<EscalationRecord | null> {
    const res = await this.pool.query<EscalationDbRow>(
      `SELECT ${SELECT_COLS} FROM escalations WHERE poll_ref = $1`,
      [pollRef],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async getById(id: string): Promise<EscalationRecord | null> {
    const res = await this.pool.query<EscalationDbRow>(
      `SELECT ${SELECT_COLS} FROM escalations WHERE id = $1`,
      [id],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async getByCodeHash(codeHash: string): Promise<EscalationRecord | null> {
    const res = await this.pool.query<EscalationDbRow>(
      `SELECT ${SELECT_COLS} FROM escalations WHERE approval_code_hash = $1
        ORDER BY created_at DESC LIMIT 1`,
      [codeHash],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async appendLog(id: string, entry: ChannelLogEntry): Promise<void> {
    await this.pool.query(
      `UPDATE escalations SET channel_log = channel_log || $2::jsonb, updated_at = now()
        WHERE id = $1`,
      [id, JSON.stringify([entry])],
    );
  }

  async transition(id: string, t: StatusTransition): Promise<EscalationRecord | null> {
    const res = await this.pool.query<EscalationDbRow>(
      `UPDATE escalations
          SET status            = $2,
              channel_log       = CASE WHEN $4::jsonb IS NULL THEN channel_log
                                       ELSE channel_log || $4::jsonb END,
              approved_channels = CASE
                WHEN $5::text IS NULL THEN approved_channels
                WHEN approved_channels @> to_jsonb(ARRAY[$5::text]) THEN approved_channels
                ELSE approved_channels || to_jsonb(ARRAY[$5::text]) END,
              resolved_by       = COALESCE($6::jsonb, resolved_by),
              resolved_at       = COALESCE($7::timestamptz, resolved_at),
              updated_at        = now()
        WHERE id = $1 AND status = ANY($3::text[])
      RETURNING ${SELECT_COLS}`,
      [
        id,
        t.toStatus,
        t.fromStatuses,
        t.appendLog ? JSON.stringify([t.appendLog]) : null,
        t.addApprovedChannel ?? null,
        t.resolvedBy ? JSON.stringify(t.resolvedBy) : null,
        t.resolvedAtMs ? new Date(t.resolvedAtMs).toISOString() : null,
      ],
    );
    return res.rows[0] ? rowToRecord(res.rows[0]) : null;
  }

  async findExpirable(nowMs: number, limit: number): Promise<EscalationRecord[]> {
    const res = await this.pool.query<EscalationDbRow>(
      `SELECT ${SELECT_COLS} FROM escalations
        WHERE status IN ('PENDING','AWAITING_SECOND_CHANNEL','NOTIFY_FAILED')
          AND code_expires_at <= $1
        ORDER BY code_expires_at
        LIMIT $2`,
      [new Date(nowMs).toISOString(), limit],
    );
    return res.rows.map(rowToRecord);
  }

  async listByIntentIds(intentIds: readonly string[]): Promise<EscalationRecord[]> {
    if (intentIds.length === 0) return [];
    const res = await this.pool.query<EscalationDbRow>(
      `SELECT ${SELECT_COLS} FROM escalations
        WHERE intent_id = ANY($1::text[]) ORDER BY created_at DESC`,
      [intentIds.map((i) => i.toLowerCase())],
    );
    return res.rows.map(rowToRecord);
  }
}
