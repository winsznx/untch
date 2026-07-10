import type {
  ApprovalsConfig,
  ChannelLogEntry,
  EscalationRecord,
  EscalationStatus,
  ResolvedBy,
} from "./types";

/**
 * The escalation store. Kept behind an interface so the state machine is testable against an in-memory
 * repo with a fake clock (the adversarial authority-boundary cases need no database) and runs against
 * Postgres in production. All state-changing methods are expressed as compare-and-set style transitions
 * so a concurrent second inbound (or the timeout worker firing at the same instant) can never
 * double-resolve an escalation — the first valid decision wins; the rest see it already resolved.
 */

export interface CreateEscalationRow {
  readonly id: string;
  readonly intentId: string;
  readonly pollRef: string;
  readonly reason: string;
  readonly policyId: string;
  readonly amount: number;
  readonly token: string;
  readonly approvals: ApprovalsConfig;
  readonly approvalCodeHash: string;
  readonly codeExpiresAt: string;
  readonly initialLog: readonly ChannelLogEntry[];
}

/** A conditional status transition: only applies if the row is currently in one of `fromStatuses`. */
export interface StatusTransition {
  readonly toStatus: EscalationStatus;
  readonly fromStatuses: readonly EscalationStatus[];
  readonly appendLog?: ChannelLogEntry;
  readonly addApprovedChannel?: string;
  readonly resolvedBy?: ResolvedBy;
  readonly resolvedAtMs?: number;
}

export interface EscalationsRepo {
  create(row: CreateEscalationRow): Promise<EscalationRecord>;
  getByPollRef(pollRef: string): Promise<EscalationRecord | null>;
  getById(id: string): Promise<EscalationRecord | null>;
  /** Resolve by the code's sha256 hash — the "APPROVE <code>" text baseline path, which carries no id. */
  getByCodeHash(codeHash: string): Promise<EscalationRecord | null>;
  /** Append an audit-trail entry without changing status (used for IGNORED_* failed control events). */
  appendLog(id: string, entry: ChannelLogEntry): Promise<void>;
  /**
   * Apply a conditional transition. Returns the updated record if the guard matched, or null if the row
   * was not in an expected `fromStatuses` (someone else resolved it first) — the caller treats null as
   * "already resolved". Atomic per row.
   */
  transition(id: string, t: StatusTransition): Promise<EscalationRecord | null>;
  /** Rows still open past their code expiry — the timeout worker's safety sweep. */
  findExpirable(nowMs: number, limit: number): Promise<EscalationRecord[]>;
}
