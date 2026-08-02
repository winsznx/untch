import { randomBytes } from "node:crypto";
import type { Pool } from "./db";

/**
 * The case-first activity index: ingest, reorg handling, reconciliation, and the money split.
 *
 * WHY NOT A BLOCK EXPLORER
 *
 * An explorer is organised by the chain. That is right when the chain is the subject and wrong here,
 * because what a person needs to see is one DECISION and everything that happened because of it — a
 * marketplace payment on one rail, a policy decision that touched no chain, an escalation answered in
 * a browser, a provider settlement on a second rail, a receipt anchor on a third. Organised per chain,
 * that is five unrelated rows. Organised per case, it is one timeline.
 *
 * WHAT THE HARD PARTS ACTUALLY ARE
 *
 *   • IDEMPOTENT BACKFILL. Re-running must converge, not accumulate. Every write below is an upsert
 *     keyed by something the chain itself determines — (network, txHash, logIndex) — never by an id
 *     this process generated, because a generated id is different on the second run by construction.
 *
 *   • REORG. A block hash that changes at a height already read means the events read there may never
 *     have happened. They are marked ORPHANED rather than deleted: a receipt built on one has to be
 *     able to say what occurred, and a missing row explains nothing.
 *
 *   • DECODER VERSIONS. The raw log is stored before any decoder sees it, because decoders have bugs
 *     and fixing one means re-running it. A schema that kept only the decoded result would make every
 *     decoder bug permanent.
 *
 *   • THE UNCOMFORTABLE STATES. A transaction touching a watched address that no case claims is
 *     UNRECONCILED, and one shaped like an execution that reconciles to no intent is
 *     SHADOW_EXECUTION. Both exist so "something moved money and we cannot say why" is a query rather
 *     than a suspicion.
 */

export type CaseKind = "spend" | "marketplace-order" | "governance" | "treasury" | "unreconciled";
export type CaseState = "OPEN" | "SETTLED" | "REFUSED" | "ABANDONED";
export type EventSource = "outbox" | "chain" | "operator";
export type Reconciliation = "RECONCILED" | "UNRECONCILED" | "SHADOW_EXECUTION" | "IGNORED";
export type AllocationStatus = "PROVISIONAL" | "RECOGNIZED" | "UNSETTLED";

export interface RawChainEvent {
  readonly network: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTime: string | null;
  readonly address: string;
  readonly topics: readonly string[];
  readonly data: string | null;
}

export interface IndexedTransaction {
  readonly network: string;
  readonly txHash: string;
  readonly blockNumber: number;
  readonly blockHash: string;
  readonly blockTime: string | null;
  readonly fromAddress: string | null;
  readonly toAddress: string | null;
  readonly valueWei: string | null;
  readonly gasUsed: string | null;
  readonly gasPriceWei: string | null;
  readonly success: boolean | null;
}

export interface ActivityCase {
  readonly caseId: string;
  readonly network: string;
  readonly accountId: string | null;
  readonly intentId: string | null;
  readonly policyId: string | null;
  readonly approvalRequestId: string | null;
  readonly serviceOrderRef: string | null;
  readonly marketplaceTaskRef: string | null;
  readonly receiptId: string | null;
  readonly kind: CaseKind;
  readonly state: CaseState;
  readonly title: string;
  readonly openedAt: string;
  readonly closedAt: string | null;
}

export interface ActivityEvent {
  readonly eventId: string;
  readonly caseId: string;
  readonly network: string;
  readonly kind: string;
  readonly source: EventSource;
  readonly occurredAt: string;
  readonly summary: string;
  readonly txHash: string | null;
  readonly logIndex: number | null;
  readonly publicDetail: Record<string, unknown>;
  readonly privateDetail: Record<string, unknown>;
}

/**
 * The money split, as components rather than a total.
 *
 * 105 arrived, 100 belongs to a provider, 5 is the fee, and only the fee less gas is revenue.
 * Reporting the 105 — or the 100 — as income is the easiest and most damaging number here to get
 * wrong, so there is no single field that could be mistaken for it.
 */
export interface RevenueAllocation {
  readonly network: string;
  readonly caseId: string;
  readonly asset: string;
  readonly marketplaceGross: string;
  readonly providerPrincipal: string;
  readonly untchServiceFee: string;
  readonly providerFee: string;
  readonly networkGas: string;
  readonly refund: string;
  readonly treasuryFunding: string;
  readonly bondMovement: string;
  readonly status: AllocationStatus;
}

const ZERO = "0";

/** Decimal arithmetic on strings, scaled to 18 places. A float would drift where money reconciles. */
const SCALE = 18;

function scaled(value: string): bigint {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  const padded = frac.padEnd(SCALE, "0").slice(0, SCALE);
  const n = BigInt(`${whole}${padded}`);
  return negative ? -n : n;
}

function unscaled(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** BigInt(SCALE);
  const frac = (abs % 10n ** BigInt(SCALE)).toString().padStart(SCALE, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}

/**
 * Net revenue, derived rather than stored.
 *
 * Derived on purpose: a stored total is a second thing that can disagree with its own components,
 * and the disagreement would surface as a number nobody can reproduce from the parts.
 */
export function netRevenue(a: RevenueAllocation): string {
  return unscaled(scaled(a.untchServiceFee) - scaled(a.networkGas) - scaled(a.refund));
}

/**
 * What actually belongs to somebody else. Held out of every revenue figure by construction.
 *
 * Provider principal is money passing THROUGH. Counting it as income would inflate revenue by the
 * ratio of the purchase to the fee — here, twentyfold.
 */
export function passThrough(a: RevenueAllocation): string {
  return unscaled(scaled(a.providerPrincipal) + scaled(a.providerFee));
}

export function newCaseId(): string {
  return `case_${randomBytes(12).toString("hex")}`;
}

export function newEventId(): string {
  return `aevt_${randomBytes(12).toString("hex")}`;
}

export class PgActivityIndex {
  constructor(private readonly pool: Pool) {}

  // ── sources and cursors ───────────────────────────────────────────────────

  async registerSource(args: {
    readonly sourceId: string;
    readonly network: string;
    readonly kind: "contract" | "treasury" | "provider-settlement" | "writer";
    readonly address: string;
    readonly label: string;
    readonly startBlock?: number;
    readonly enabled?: boolean;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO chain_sources (source_id, network, kind, address, label, start_block, enabled)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (source_id) DO UPDATE
         SET label = EXCLUDED.label, enabled = EXCLUDED.enabled, updated_at = now()`,
      [
        args.sourceId,
        args.network,
        args.kind,
        args.address.toLowerCase(),
        args.label,
        args.startBlock ?? 0,
        args.enabled ?? true,
      ],
    );
    await this.pool.query(
      `INSERT INTO chain_cursors (source_id, network, last_read_block, finalized_block)
       VALUES ($1,$2,$3,$3) ON CONFLICT (source_id) DO NOTHING`,
      [args.sourceId, args.network, args.startBlock ?? 0],
    );
  }

  async cursor(sourceId: string): Promise<{
    readonly lastReadBlock: number;
    readonly finalizedBlock: number;
    readonly lastReadHash: string | null;
    readonly consecutiveErrors: number;
  } | null> {
    const { rows } = await this.pool.query<{
      last_read_block: string;
      finalized_block: string;
      last_read_hash: string | null;
      consecutive_errors: number;
    }>("SELECT * FROM chain_cursors WHERE source_id = $1", [sourceId]);
    const r = rows[0];
    return r
      ? {
          lastReadBlock: Number(r.last_read_block),
          finalizedBlock: Number(r.finalized_block),
          lastReadHash: r.last_read_hash,
          consecutiveErrors: r.consecutive_errors,
        }
      : null;
  }

  /**
   * Advance a cursor.
   *
   * `finalizedBlock` never exceeds `lastReadBlock` — the constraint enforces it, and the reason is
   * that "finalised" is a claim about data we have; claiming finality for a height nobody has read is
   * how a reorg goes unnoticed.
   */
  async advanceCursor(args: {
    readonly sourceId: string;
    readonly lastReadBlock: number;
    readonly finalizedBlock: number;
    readonly lastReadHash: string | null;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE chain_cursors
          SET last_read_block = $2::bigint,
              -- Clamped in SQL rather than in the caller, so a caller that forgot still cannot claim
              -- finality for a height nobody has read.
              finalized_block = LEAST($3::bigint, $2::bigint),
              last_read_hash = $4,
              last_read_at = now(), consecutive_errors = 0, updated_at = now()
        WHERE source_id = $1`,
      [args.sourceId, args.lastReadBlock, args.finalizedBlock, args.lastReadHash],
    );
  }

  async recordSourceError(sourceId: string): Promise<void> {
    await this.pool.query(
      "UPDATE chain_cursors SET consecutive_errors = consecutive_errors + 1, updated_at = now() WHERE source_id = $1",
      [sourceId],
    );
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  /**
   * Ingest logs idempotently.
   *
   * Keyed by (network, txHash, logIndex) — values the CHAIN determines. Keying by anything this
   * process generated would make the second run insert duplicates by construction, which is the whole
   * difference between a backfill that converges and one that accumulates.
   *
   * A re-read that reports a DIFFERENT block hash for a log already stored is a reorg at that height,
   * and the stored row is replaced rather than merged: the old one described a block that no longer
   * exists.
   */
  async ingestEvents(events: readonly RawChainEvent[]): Promise<{ readonly inserted: number; readonly updated: number }> {
    let inserted = 0;
    let updated = 0;
    for (const e of events) {
      const { rows } = await this.pool.query<{ inserted: boolean }>(
        `INSERT INTO raw_chain_events
           (network, tx_hash, log_index, block_number, block_hash, block_time, address, topics, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (network, tx_hash, log_index) DO UPDATE
           SET block_number = EXCLUDED.block_number,
               block_hash = EXCLUDED.block_hash,
               block_time = EXCLUDED.block_time,
               status = 'LIVE',
               orphaned_at = NULL
           WHERE raw_chain_events.block_hash <> EXCLUDED.block_hash
              OR raw_chain_events.status = 'ORPHANED'
         RETURNING (xmax = 0) AS inserted`,
        [
          e.network,
          e.txHash.toLowerCase(),
          e.logIndex,
          e.blockNumber,
          e.blockHash.toLowerCase(),
          e.blockTime,
          e.address.toLowerCase(),
          [...e.topics],
          e.data,
        ],
      );
      if (rows[0]?.inserted) inserted += 1;
      else if (rows.length > 0) updated += 1;
    }
    return { inserted, updated };
  }

  async ingestTransaction(tx: IndexedTransaction): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexed_transactions
         (network, tx_hash, block_number, block_hash, block_time, from_address, to_address,
          value_wei, gas_used, gas_price_wei, success)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (network, tx_hash) DO UPDATE
         SET block_number = EXCLUDED.block_number,
             block_hash = EXCLUDED.block_hash,
             block_time = EXCLUDED.block_time,
             gas_used = EXCLUDED.gas_used,
             gas_price_wei = EXCLUDED.gas_price_wei,
             success = EXCLUDED.success,
             status = 'LIVE',
             orphaned_at = NULL,
             updated_at = now()`,
      [
        tx.network,
        tx.txHash.toLowerCase(),
        tx.blockNumber,
        tx.blockHash.toLowerCase(),
        tx.blockTime,
        tx.fromAddress?.toLowerCase() ?? null,
        tx.toAddress?.toLowerCase() ?? null,
        tx.valueWei,
        tx.gasUsed,
        tx.gasPriceWei,
        tx.success,
      ],
    );
  }

  /**
   * A reorg: everything above `survivingBlock` on this network becomes ORPHANED.
   *
   * Marked, never deleted. A receipt built on an event that later reorged has to be able to say what
   * happened, and a row that is simply gone explains nothing to whoever is holding that receipt.
   * Re-ingesting the replacement blocks brings the still-valid rows back to LIVE, because the upsert
   * above clears `orphaned_at` when it sees the same log again.
   */
  async markReorg(args: {
    readonly network: string;
    readonly survivingBlock: number;
  }): Promise<{ readonly events: number; readonly transactions: number }> {
    const events = await this.pool.query(
      `UPDATE raw_chain_events SET status = 'ORPHANED', orphaned_at = now()
        WHERE network = $1 AND block_number > $2 AND status = 'LIVE'`,
      [args.network, args.survivingBlock],
    );
    const transactions = await this.pool.query(
      `UPDATE indexed_transactions SET status = 'ORPHANED', orphaned_at = now(), updated_at = now()
        WHERE network = $1 AND block_number > $2 AND status = 'LIVE'`,
      [args.network, args.survivingBlock],
    );
    return { events: events.rowCount ?? 0, transactions: transactions.rowCount ?? 0 };
  }

  /** Attach a decoder's interpretation, stamped with the version that produced it. */
  async recordDecoded(args: {
    readonly network: string;
    readonly txHash: string;
    readonly logIndex: number;
    readonly decoderVersion: string;
    readonly decoded: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `UPDATE raw_chain_events SET decoder_version = $4, decoded = $5
        WHERE network = $1 AND tx_hash = $2 AND log_index = $3`,
      [args.network, args.txHash.toLowerCase(), args.logIndex, args.decoderVersion, JSON.stringify(args.decoded)],
    );
  }

  // ── cases ─────────────────────────────────────────────────────────────────

  /**
   * Open a case, or return the one that already covers this intent.
   *
   * Idempotent by (network, intentId), because a re-run of any projection must converge on one case.
   * An intent with two cases would report its money twice, and the second report would look exactly
   * as legitimate as the first.
   */
  async openCase(args: {
    readonly network: string;
    readonly kind: CaseKind;
    readonly title: string;
    readonly accountId?: string | null;
    readonly intentId?: string | null;
    readonly policyId?: string | null;
    readonly approvalRequestId?: string | null;
    readonly serviceOrderRef?: string | null;
    readonly marketplaceTaskRef?: string | null;
    readonly receiptId?: string | null;
  }): Promise<ActivityCase> {
    if (args.intentId) {
      const existing = await this.caseForIntent(args.network, args.intentId);
      if (existing) return existing;
    }
    const caseId = newCaseId();
    const { rows } = await this.pool.query<CaseRow>(
      `INSERT INTO activity_cases
         (case_id, network, account_id, intent_id, policy_id, approval_request_id, service_order_ref,
          marketplace_task_ref, receipt_id, kind, title)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        caseId,
        args.network,
        args.accountId ?? null,
        args.intentId ?? null,
        args.policyId ?? null,
        args.approvalRequestId ?? null,
        args.serviceOrderRef ?? null,
        args.marketplaceTaskRef ?? null,
        args.receiptId ?? null,
        args.kind,
        args.title,
      ],
    );
    return toCase(rows[0] as CaseRow);
  }

  async caseForIntent(network: string, intentId: string): Promise<ActivityCase | null> {
    const { rows } = await this.pool.query<CaseRow>(
      "SELECT * FROM activity_cases WHERE network = $1 AND intent_id = $2",
      [network, intentId],
    );
    return rows[0] ? toCase(rows[0]) : null;
  }

  async getCase(caseId: string): Promise<ActivityCase | null> {
    const { rows } = await this.pool.query<CaseRow>("SELECT * FROM activity_cases WHERE case_id = $1", [caseId]);
    return rows[0] ? toCase(rows[0]) : null;
  }

  async closeCase(args: { readonly caseId: string; readonly state: Exclude<CaseState, "OPEN"> }): Promise<void> {
    await this.pool.query(
      "UPDATE activity_cases SET state = $2, closed_at = now(), updated_at = now() WHERE case_id = $1",
      [args.caseId, args.state],
    );
  }

  /**
   * Append an event to a case's timeline.
   *
   * When the event names a chain log, the write is idempotent on (network, txHash, logIndex, caseId) —
   * so re-running a backfill does not append a duplicate to every timeline it touched. That is what
   * "idempotent backfill" has to mean at the projection layer, not only at the ingest layer.
   */
  async appendEvent(args: {
    readonly caseId: string;
    readonly network: string;
    readonly kind: string;
    readonly source: EventSource;
    readonly occurredAt: string;
    readonly summary: string;
    readonly txHash?: string | null;
    readonly logIndex?: number | null;
    readonly publicDetail?: Record<string, unknown>;
    readonly privateDetail?: Record<string, unknown>;
  }): Promise<{ readonly appended: boolean }> {
    const { rowCount } = await this.pool.query(
      `INSERT INTO activity_events
         (event_id, case_id, network, kind, source, occurred_at, summary, tx_hash, log_index,
          public_detail, private_detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT DO NOTHING`,
      [
        newEventId(),
        args.caseId,
        args.network,
        args.kind,
        args.source,
        args.occurredAt,
        args.summary,
        args.txHash?.toLowerCase() ?? null,
        args.logIndex ?? null,
        JSON.stringify(args.publicDetail ?? {}),
        JSON.stringify(args.privateDetail ?? {}),
      ],
    );
    return { appended: (rowCount ?? 0) === 1 };
  }

  async timeline(caseId: string): Promise<readonly ActivityEvent[]> {
    const { rows } = await this.pool.query<EventRow>(
      "SELECT * FROM activity_events WHERE case_id = $1 ORDER BY occurred_at, event_id",
      [caseId],
    );
    return rows.map(toEvent);
  }

  // ── reconciliation ────────────────────────────────────────────────────────

  async link(args: {
    readonly network: string;
    readonly txHash: string;
    readonly caseId: string;
    readonly method: string;
    readonly confidence?: "exact" | "heuristic";
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO reconciliation_links (link_id, network, tx_hash, case_id, method, confidence)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (network, tx_hash, case_id) DO NOTHING`,
      [
        `rlnk_${randomBytes(12).toString("hex")}`,
        args.network,
        args.txHash.toLowerCase(),
        args.caseId,
        args.method,
        args.confidence ?? "exact",
      ],
    );
    await this.pool.query(
      `UPDATE indexed_transactions SET reconciliation = 'RECONCILED', updated_at = now()
        WHERE network = $1 AND tx_hash = $2`,
      [args.network, args.txHash.toLowerCase()],
    );
  }

  /**
   * Classify an unclaimed transaction.
   *
   * SHADOW_EXECUTION is the loud one. UNRECONCILED means "something moved money and we cannot say
   * why"; SHADOW_EXECUTION means "and it is shaped like something this system is supposed to be the
   * only source of". IGNORED requires a note, so a decision to look away is distinguishable from
   * nobody having looked.
   */
  async classify(args: {
    readonly network: string;
    readonly txHash: string;
    readonly reconciliation: Reconciliation;
    readonly note?: string | null;
  }): Promise<void> {
    if (args.reconciliation === "IGNORED" && !args.note) {
      throw new Error("an IGNORED transaction must carry the reason it was ignored");
    }
    await this.pool.query(
      `UPDATE indexed_transactions SET reconciliation = $3, classification_note = $4, updated_at = now()
        WHERE network = $1 AND tx_hash = $2`,
      [args.network, args.txHash.toLowerCase(), args.reconciliation, args.note ?? null],
    );
  }

  async unreconciled(network: string, limit = 50): Promise<readonly { readonly txHash: string; readonly reconciliation: Reconciliation; readonly blockNumber: number }[]> {
    const { rows } = await this.pool.query<{ tx_hash: string; reconciliation: Reconciliation; block_number: string }>(
      `SELECT tx_hash, reconciliation, block_number FROM indexed_transactions
        WHERE network = $1 AND status = 'LIVE' AND reconciliation IN ('UNRECONCILED','SHADOW_EXECUTION')
        ORDER BY block_number DESC LIMIT $2`,
      [network, limit],
    );
    return rows.map((r) => ({
      txHash: r.tx_hash,
      reconciliation: r.reconciliation,
      blockNumber: Number(r.block_number),
    }));
  }

  // ── money ─────────────────────────────────────────────────────────────────

  async allocate(a: RevenueAllocation): Promise<void> {
    await this.pool.query(
      `INSERT INTO revenue_allocations
         (allocation_id, network, case_id, asset, marketplace_gross, provider_principal,
          untch_service_fee, provider_fee, network_gas, refund, treasury_funding, bond_movement, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (network, case_id, asset) DO UPDATE
         SET marketplace_gross = EXCLUDED.marketplace_gross,
             provider_principal = EXCLUDED.provider_principal,
             untch_service_fee = EXCLUDED.untch_service_fee,
             provider_fee = EXCLUDED.provider_fee,
             network_gas = EXCLUDED.network_gas,
             refund = EXCLUDED.refund,
             treasury_funding = EXCLUDED.treasury_funding,
             bond_movement = EXCLUDED.bond_movement,
             status = EXCLUDED.status,
             updated_at = now()`,
      [
        `ralc_${randomBytes(12).toString("hex")}`,
        a.network,
        a.caseId,
        a.asset,
        a.marketplaceGross,
        a.providerPrincipal,
        a.untchServiceFee,
        a.providerFee,
        a.networkGas,
        a.refund,
        a.treasuryFunding,
        a.bondMovement,
        a.status,
      ],
    );
  }

  async allocationFor(network: string, caseId: string, asset: string): Promise<RevenueAllocation | null> {
    const { rows } = await this.pool.query<AllocationRow>(
      "SELECT * FROM revenue_allocations WHERE network = $1 AND case_id = $2 AND asset = $3",
      [network, caseId, asset],
    );
    return rows[0] ? toAllocation(rows[0]) : null;
  }

  /**
   * Totals for a network, with pass-through held out by construction.
   *
   * `recognisedRevenue` counts only RECOGNIZED rows. A PROVISIONAL split is computed from a quote and
   * may still change; counting it would mean reporting income for money that has not moved.
   */
  async totals(network: string, asset: string): Promise<{
    readonly marketplaceGross: string;
    readonly providerPrincipal: string;
    readonly recognisedRevenue: string;
    readonly provisionalRevenue: string;
    readonly unsettledLiability: string;
  }> {
    const { rows } = await this.pool.query<AllocationRow>(
      "SELECT * FROM revenue_allocations WHERE network = $1 AND asset = $2",
      [network, asset],
    );
    let gross = 0n;
    let principal = 0n;
    let recognised = 0n;
    let provisional = 0n;
    let unsettled = 0n;
    for (const row of rows) {
      const a = toAllocation(row);
      gross += scaled(a.marketplaceGross);
      principal += scaled(a.providerPrincipal);
      const net = scaled(netRevenue(a));
      if (a.status === "RECOGNIZED") recognised += net;
      else if (a.status === "PROVISIONAL") provisional += net;
      else unsettled += scaled(a.providerPrincipal) + scaled(a.providerFee);
    }
    return {
      marketplaceGross: unscaled(gross),
      providerPrincipal: unscaled(principal),
      recognisedRevenue: unscaled(recognised),
      provisionalRevenue: unscaled(provisional),
      unsettledLiability: unscaled(unsettled),
    };
  }

  // ── failures ──────────────────────────────────────────────────────────────

  async recordFailure(args: {
    readonly network: string;
    readonly sourceId?: string | null;
    readonly stage: "fetch" | "decode" | "reconcile" | "project";
    readonly blockNumber?: number | null;
    readonly txHash?: string | null;
    readonly message: string;
    readonly detail?: Record<string, unknown>;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO indexer_failures
         (failure_id, network, source_id, stage, block_number, tx_hash, message, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        `ifai_${randomBytes(12).toString("hex")}`,
        args.network,
        args.sourceId ?? null,
        args.stage,
        args.blockNumber ?? null,
        args.txHash?.toLowerCase() ?? null,
        args.message,
        JSON.stringify(args.detail ?? {}),
      ],
    );
  }

  async openFailures(network: string): Promise<number> {
    const { rows } = await this.pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM indexer_failures WHERE network = $1 AND resolved_at IS NULL",
      [network],
    );
    return Number(rows[0]?.count ?? 0);
  }
}

interface CaseRow {
  case_id: string;
  network: string;
  account_id: string | null;
  intent_id: string | null;
  policy_id: string | null;
  approval_request_id: string | null;
  service_order_ref: string | null;
  marketplace_task_ref: string | null;
  receipt_id: string | null;
  kind: CaseKind;
  state: CaseState;
  title: string;
  opened_at: Date;
  closed_at: Date | null;
}

function toCase(row: CaseRow): ActivityCase {
  return {
    caseId: row.case_id,
    network: row.network,
    accountId: row.account_id,
    intentId: row.intent_id,
    policyId: row.policy_id,
    approvalRequestId: row.approval_request_id,
    serviceOrderRef: row.service_order_ref,
    marketplaceTaskRef: row.marketplace_task_ref,
    receiptId: row.receipt_id,
    kind: row.kind,
    state: row.state,
    title: row.title,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at ? row.closed_at.toISOString() : null,
  };
}

interface EventRow {
  event_id: string;
  case_id: string;
  network: string;
  kind: string;
  source: EventSource;
  occurred_at: Date;
  summary: string;
  tx_hash: string | null;
  log_index: number | null;
  public_detail: Record<string, unknown>;
  private_detail: Record<string, unknown>;
}

function toEvent(row: EventRow): ActivityEvent {
  return {
    eventId: row.event_id,
    caseId: row.case_id,
    network: row.network,
    kind: row.kind,
    source: row.source,
    occurredAt: row.occurred_at.toISOString(),
    summary: row.summary,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    publicDetail: row.public_detail ?? {},
    privateDetail: row.private_detail ?? {},
  };
}

interface AllocationRow {
  network: string;
  case_id: string;
  asset: string;
  marketplace_gross: string;
  provider_principal: string;
  untch_service_fee: string;
  provider_fee: string;
  network_gas: string;
  refund: string;
  treasury_funding: string;
  bond_movement: string;
  status: AllocationStatus;
}

function toAllocation(row: AllocationRow): RevenueAllocation {
  return {
    network: row.network,
    caseId: row.case_id,
    asset: row.asset,
    marketplaceGross: row.marketplace_gross,
    providerPrincipal: row.provider_principal,
    untchServiceFee: row.untch_service_fee,
    providerFee: row.provider_fee,
    networkGas: row.network_gas,
    refund: row.refund,
    treasuryFunding: row.treasury_funding,
    bondMovement: row.bond_movement,
    status: row.status,
  };
}

/**
 * The public projection of a timeline.
 *
 * `private_detail` is dropped rather than filtered. A redaction function applied at read time means
 * every new caller is one forgotten call away from publishing an address; splitting the columns means
 * the public view cannot reach the private half at all.
 */
export function publicTimeline(events: readonly ActivityEvent[]): readonly Record<string, unknown>[] {
  return events.map((e) => ({
    kind: e.kind,
    source: e.source,
    occurredAt: e.occurredAt,
    summary: e.summary,
    txHash: e.txHash,
    detail: e.publicDetail,
  }));
}

export const ZERO_ALLOCATION = Object.freeze({
  marketplaceGross: ZERO,
  providerPrincipal: ZERO,
  untchServiceFee: ZERO,
  providerFee: ZERO,
  networkGas: ZERO,
  refund: ZERO,
  treasuryFunding: ZERO,
  bondMovement: ZERO,
});
