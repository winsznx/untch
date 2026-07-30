/**
 * Postgres ConsumerStore.
 *
 * The shape mirrors `InMemoryConsumerStore` method for method, and the two are written from the same
 * list of invariants — the difference is only WHERE each is enforced. Where the in-memory store
 * checks a Map, this one leans on a unique index or a `WHERE` clause, so the guarantee survives two
 * workers running at once:
 *
 *   transition            → UPDATE … WHERE intent_id = $1 AND state = $2  (compare-and-set)
 *   recordFunding         → ON CONFLICT DO NOTHING on both unique indexes
 *   prepareExecution      → unique (provider_id, idempotency_key)
 *   consumeCapability     → SELECT … FOR UPDATE then UPDATE … WHERE consumed_at IS NULL
 *   appendLedgerGroup     → unique (intent_id, kind) for non-ADJUSTMENT groups
 *   outbox seq            → assigned from consumer_intents.event_seq inside the same transaction
 *
 * Money is stored as (NUMERIC(78,0) atomic, token, contract, chain, decimals) so a row is
 * self-describing: a reader that assumes the wrong decimals cannot silently misread it.
 */

import type { Pool } from "./db";
import type { AssetRef, CaipChainId } from "./assets";
import {
  solanaProofScopeHash,
  type SolanaProofGateRecord,
  type SolanaProofGateState,
  type SolanaProofProgress,
  type SolanaProofScope,
} from "./solana-proof-claim";
import { assetKey } from "./assets";
import type { ConsumerEvent, ConsumerEventName, OutboxRecord } from "./events";
import { assertGroupBalanced, type LedgerGroup, type LedgerGroupKind } from "./ledger";
import { money, type Money } from "./money";
import {
  assertTransition,
  StaleIntentStateError,
  type ConsumerIntentState,
} from "./state";
import type {
  ConsumerApproval,
  ConsumerIntent,
  ConsumerIntentPatch,
  ConsumerQuote,
  DeliveryEvidence,
  FundingReceipt,
  ProviderExecutionRecord,
} from "./types";
import type {
  CapabilityAccessBlocker,
  CapabilityRecord,
  ConsumerStore,
  CreateIntentInput,
  PauseFlag,
  PauseScope,
  ProviderCapabilityRecord,
  ProviderHealthRecord,
  ProviderLimitRecord,
  ProviderMaturity,
  ProviderRecord,
  TransitionEvent,
  TransitionResult,
  SettlementAccountAttestation,
  TreasuryAccountRecord,
  TreasuryBalanceObservation,
} from "./repo";
import { randomBytes } from "node:crypto";

type Row = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v : String(v ?? "");
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number(v ?? 0);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function bool(v: unknown): boolean {
  return v === true || v === "t" || v === "true";
}

function iso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return str(v);
}

function isoOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return iso(v);
}

function jsonObj(v: unknown): Readonly<Record<string, unknown>> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through — an unparseable JSONB column reads as empty rather than throwing mid-query
    }
  }
  return {};
}

function jsonArr(v: unknown): readonly unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // as above
    }
  }
  return [];
}

/** Rebuild an AssetRef from its five self-describing columns. */
function assetFromRow(row: Row, prefix: string): AssetRef | null {
  const token = strOrNull(row[`${prefix}_token`]);
  const chain = strOrNull(row[`${prefix}_chain`]);
  const decimals = numOrNull(row[`${prefix}_decimals`]);
  if (token === null || chain === null || decimals === null) return null;
  return {
    symbol: token,
    chain: chain as CaipChainId,
    address: strOrNull(row[`${prefix}_contract`]),
    decimals,
  };
}

function moneyFromRow(row: Row, amountCol: string, asset: AssetRef | null): Money | null {
  const raw = row[amountCol];
  if (raw === null || raw === undefined || asset === null) return null;
  return money(BigInt(str(raw)), asset);
}

export class PgConsumerStore implements ConsumerStore {
  constructor(
    private readonly pool: Pool,
    private readonly clock: () => number = Date.now,
  ) {}

  private nowIso(): string {
    return new Date(this.clock()).toISOString();
  }

  private newEventId(): string {
    return `evt_${randomBytes(10).toString("hex")}`;
  }

  // ── intents ────────────────────────────────────────────────────────────────

  async createIntent(input: CreateIntentInput, event: TransitionEvent): Promise<TransitionResult> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO consumer_intents
           (intent_id, tenant_id, requesting_agent_id, principal_id, action, category, request,
            policy_id, correlation_id, idempotency_key, expires_at, state, event_seq)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,'CREATED',1)
         RETURNING *`,
        [
          input.intentId,
          input.tenantId,
          input.requestingAgentId,
          input.principalId,
          input.action,
          input.category,
          JSON.stringify(input.request),
          input.policyId,
          input.correlationId,
          input.idempotencyKey,
          input.expiresAt,
        ],
      );
      const row = inserted.rows[0] as Row | undefined;
      if (!row) throw new Error("insert of consumer_intents returned no row");

      const evt = await this.insertOutbox(client, {
        intentId: input.intentId,
        tenantId: input.tenantId,
        seq: 1,
        name: event.name,
        state: "CREATED",
        correlationId: input.correlationId,
        data: event.data,
      });
      await client.query("COMMIT");
      return { intent: rowToIntent(row), event: evt };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getIntent(intentId: string): Promise<ConsumerIntent | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_intents WHERE intent_id = $1", [
      intentId,
    ]);
    const row = rows[0] as Row | undefined;
    return row ? rowToIntent(row) : null;
  }

  async getIntentForTenant(tenantId: string, intentId: string): Promise<ConsumerIntent | null> {
    // Tenant isolation is a WHERE clause, not a post-read comparison a caller might forget.
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_intents WHERE intent_id = $1 AND tenant_id = $2",
      [intentId, tenantId],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToIntent(row) : null;
  }

  async findByIdempotencyKey(tenantId: string, key: string): Promise<ConsumerIntent | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_intents WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, key],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToIntent(row) : null;
  }

  async listIntents(filter: {
    readonly tenantId?: string;
    readonly state?: ConsumerIntentState;
    readonly limit: number;
  }): Promise<readonly ConsumerIntent[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    if (filter.tenantId !== undefined) {
      params.push(filter.tenantId);
      conds.push(`tenant_id = $${params.length}`);
    }
    if (filter.state !== undefined) {
      params.push(filter.state);
      conds.push(`state = $${params.length}`);
    }
    params.push(filter.limit);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await this.pool.query(
      `SELECT * FROM consumer_intents ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return (rows as Row[]).map(rowToIntent);
  }

  async transition(
    intentId: string,
    expectedFrom: ConsumerIntentState,
    to: ConsumerIntentState,
    patch: ConsumerIntentPatch,
    event: TransitionEvent,
  ): Promise<TransitionResult> {
    assertTransition(expectedFrom, to);

    const sets: string[] = ["state = $3", "updated_at = now()", "event_seq = event_seq + 1"];
    const params: unknown[] = [intentId, expectedFrom, to];
    const push = (col: string, value: unknown): void => {
      params.push(value);
      sets.push(`${col} = $${params.length}`);
    };

    if (patch.providerId !== undefined) push("provider_id", patch.providerId);
    if (patch.policyVersion !== undefined) push("policy_version", patch.policyVersion);
    if (patch.policyHash !== undefined) push("policy_hash", patch.policyHash);
    if (patch.policyDecision !== undefined) {
      params.push(JSON.stringify(patch.policyDecision));
      sets.push(`policy_decision = $${params.length}::jsonb`);
    }
    if (patch.quoteId !== undefined) push("quote_id", patch.quoteId);
    if (patch.quoteHash !== undefined) push("quote_hash", patch.quoteHash);
    if (patch.quoteExpiresAt !== undefined) push("quote_expires_at", patch.quoteExpiresAt);
    if (patch.fundingAmount !== undefined) {
      push("funding_amount", patch.fundingAmount.amount.toString());
      push("funding_token", patch.fundingAmount.asset.symbol);
      push("funding_contract", patch.fundingAmount.asset.address);
      push("funding_chain", patch.fundingAmount.asset.chain);
      push("funding_decimals", patch.fundingAmount.asset.decimals);
    }
    if (patch.settlementAmount !== undefined) {
      push("settlement_amount", patch.settlementAmount.amount.toString());
      push("settlement_token", patch.settlementAmount.asset.symbol);
      push("settlement_contract", patch.settlementAmount.asset.address);
      push("settlement_chain", patch.settlementAmount.asset.chain);
      push("settlement_decimals", patch.settlementAmount.asset.decimals);
    }
    if (patch.untchFee !== undefined) push("untch_fee_amount", patch.untchFee.amount.toString());
    if (patch.spread !== undefined) push("spread_amount", patch.spread.amount.toString());
    if (patch.maxAuthorisedAmount !== undefined) {
      push("max_authorised", patch.maxAuthorisedAmount.amount.toString());
    }
    if (patch.approvalRequired !== undefined) push("approval_required", patch.approvalRequired);
    if (patch.approvalOutcome !== undefined) push("approval_outcome", patch.approvalOutcome);
    if (patch.failureCode !== undefined) push("failure_code", patch.failureCode);
    if (patch.failureDetail !== undefined) push("failure_detail", patch.failureDetail);
    if (patch.spendIntentHash !== undefined) push("spend_intent_hash", patch.spendIntentHash);
    if (patch.receiptId !== undefined) push("receipt_id", patch.receiptId);
    if (patch.expiresAt !== undefined) push("expires_at", patch.expiresAt);

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE consumer_intents SET ${sets.join(", ")}
         WHERE intent_id = $1 AND state = $2
         RETURNING *`,
        params,
      );
      const row = updated.rows[0] as Row | undefined;
      if (!row) {
        await client.query("ROLLBACK");
        throw new StaleIntentStateError(intentId, expectedFrom);
      }
      const intent = rowToIntent(row);
      const evt = await this.insertOutbox(client, {
        intentId,
        tenantId: intent.tenantId,
        seq: num(row.event_seq),
        name: event.name,
        state: to,
        correlationId: intent.correlationId,
        data: event.data,
      });
      await client.query("COMMIT");
      return { intent, event: evt };
    } catch (err) {
      if (!(err instanceof StaleIntentStateError)) await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async insertOutbox(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> },
    evt: {
      intentId: string;
      tenantId: string;
      seq: number;
      name: ConsumerEventName;
      state: ConsumerIntentState;
      correlationId: string;
      data: Readonly<Record<string, unknown>>;
    },
  ): Promise<ConsumerEvent> {
    const eventId = this.newEventId();
    const occurredAt = this.nowIso();
    await client.query(
      `INSERT INTO consumer_outbox
         (event_id, intent_id, tenant_id, seq, name, state, correlation_id, data, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        eventId,
        evt.intentId,
        evt.tenantId,
        evt.seq,
        evt.name,
        evt.state,
        evt.correlationId,
        JSON.stringify(evt.data),
        occurredAt,
      ],
    );
    return { eventId, ...evt, occurredAt };
  }

  async findExpirable(nowIso: string, limit: number): Promise<readonly ConsumerIntent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM consumer_intents
        WHERE expires_at IS NOT NULL AND expires_at <= $1
          AND state IN ('CREATED','DISCOVERING','QUOTED','POLICY_CHECKING','AWAITING_APPROVAL',
                        'APPROVED','AWAITING_FUNDING')
        ORDER BY expires_at ASC LIMIT $2`,
      [nowIso, limit],
    );
    return (rows as Row[]).map(rowToIntent);
  }

  // ── quotes ─────────────────────────────────────────────────────────────────

  async insertQuote(q: ConsumerQuote): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_quotes
        (quote_id, intent_id, provider_id, provider_ref, provider_cost, settlement_token,
         settlement_contract, settlement_chain, settlement_decimals, settlement_recipient,
         untch_fee, spread, total_user_amount, max_authorised, funding_token, funding_contract,
         funding_chain, funding_decimals, summary, terms, quote_hash, created_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23)`,
      [
        q.quoteId,
        q.intentId,
        q.providerId,
        q.providerRef,
        q.providerCost.amount.toString(),
        q.settlementAsset.symbol,
        q.settlementAsset.address,
        q.settlementAsset.chain,
        q.settlementAsset.decimals,
        q.settlementRecipient,
        q.untchFee.amount.toString(),
        q.spread.amount.toString(),
        q.totalUserAmount.amount.toString(),
        q.maxAuthorisedAmount.amount.toString(),
        q.totalUserAmount.asset.symbol,
        q.totalUserAmount.asset.address,
        q.totalUserAmount.asset.chain,
        q.totalUserAmount.asset.decimals,
        q.summary,
        JSON.stringify(q.terms),
        q.quoteHash,
        q.createdAt,
        q.expiresAt,
      ],
    );
  }

  async getQuote(quoteId: string): Promise<ConsumerQuote | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_quotes WHERE quote_id = $1", [quoteId]);
    const row = rows[0] as Row | undefined;
    return row ? rowToQuote(row) : null;
  }

  async getQuoteByHash(quoteHash: string): Promise<ConsumerQuote | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_quotes WHERE quote_hash = $1", [
      quoteHash,
    ]);
    const row = rows[0] as Row | undefined;
    return row ? rowToQuote(row) : null;
  }

  // ── approvals ──────────────────────────────────────────────────────────────

  async upsertApproval(a: ConsumerApproval): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_approvals
        (intent_id, escalation_id, poll_ref, required, outcome, quote_hash, policy_id, policy_version,
         policy_hash, max_amount, max_amount_token, max_amount_chain, max_amount_decimals,
         settlement_recipient, settlement_chain, provider_id, resolved_by, resolved_at, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18,$19)
       ON CONFLICT (intent_id) DO UPDATE SET
         outcome = EXCLUDED.outcome,
         resolved_by = EXCLUDED.resolved_by,
         resolved_at = EXCLUDED.resolved_at`,
      [
        a.intentId,
        a.escalationId,
        a.pollRef,
        a.required,
        a.outcome,
        a.quoteHash,
        a.policyId,
        a.policyVersion,
        a.policyHash,
        a.maxAmount.amount.toString(),
        a.maxAmount.asset.symbol,
        a.maxAmount.asset.chain,
        a.maxAmount.asset.decimals,
        a.settlementRecipient,
        a.settlementChain,
        a.providerId,
        a.resolvedBy === null ? null : JSON.stringify(a.resolvedBy),
        a.resolvedAt,
        a.createdAt,
      ],
    );
  }

  async getApproval(intentId: string): Promise<ConsumerApproval | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_approvals WHERE intent_id = $1", [
      intentId,
    ]);
    const row = rows[0] as Row | undefined;
    return row ? rowToApproval(row) : null;
  }

  async getApprovalByPollRef(pollRef: string): Promise<ConsumerApproval | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_approvals WHERE poll_ref = $1", [
      pollRef,
    ]);
    const row = rows[0] as Row | undefined;
    return row ? rowToApproval(row) : null;
  }

  async resolveApproval(
    intentId: string,
    outcome: ConsumerApproval["outcome"],
    resolvedBy: { readonly channel: string; readonly handle: string } | null,
    resolvedAt: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE consumer_approvals SET outcome = $2, resolved_by = $3::jsonb, resolved_at = $4
        WHERE intent_id = $1`,
      [intentId, outcome, resolvedBy === null ? null : JSON.stringify(resolvedBy), resolvedAt],
    );
  }

  // ── funding ────────────────────────────────────────────────────────────────

  async recordFunding(receipt: FundingReceipt, ledger: LedgerGroup): Promise<boolean> {
    assertGroupBalanced(ledger);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Both unique indexes are given a chance to reject: (intent_id) PK and (chain, lower(tx_hash)).
      const inserted = await client.query(
        `INSERT INTO consumer_funding_receipts
           (intent_id, chain, tx_hash, amount, token, contract, decimals, payer, confirmations,
            finalized, settled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT DO NOTHING
         RETURNING intent_id`,
        [
          receipt.intentId,
          receipt.chain,
          receipt.txHash,
          receipt.amount.amount.toString(),
          receipt.amount.asset.symbol,
          receipt.amount.asset.address,
          receipt.amount.asset.decimals,
          receipt.payer,
          receipt.confirmations,
          receipt.finalized,
          receipt.settledAt,
        ],
      );
      if (inserted.rows.length === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      await this.writeLedgerGroup(client, ledger);
      await client.query("COMMIT");
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async getFunding(intentId: string): Promise<FundingReceipt | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_funding_receipts WHERE intent_id = $1",
      [intentId],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    const asset: AssetRef = {
      symbol: str(row.token),
      chain: str(row.chain) as CaipChainId,
      address: strOrNull(row.contract),
      decimals: num(row.decimals),
    };
    return {
      intentId: str(row.intent_id),
      chain: str(row.chain) as CaipChainId,
      txHash: str(row.tx_hash),
      amount: money(BigInt(str(row.amount)), asset),
      payer: strOrNull(row.payer),
      settledAt: iso(row.settled_at),
      confirmations: num(row.confirmations),
      finalized: bool(row.finalized),
    };
  }

  async markFundingFinalized(intentId: string, confirmations: number): Promise<void> {
    await this.pool.query(
      "UPDATE consumer_funding_receipts SET confirmations = $2, finalized = TRUE WHERE intent_id = $1",
      [intentId, confirmations],
    );
  }

  // ── executions ─────────────────────────────────────────────────────────────

  async prepareExecution(r: ProviderExecutionRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_provider_executions
        (execution_id, intent_id, provider_id, attempt_no, idempotency_key, state,
         provider_reference, settlement_tx_hash, settlement_chain, settled_amount, settled_token,
         settled_decimals, error, started_at, finished_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)`,
      [
        r.executionId,
        r.intentId,
        r.providerId,
        r.attemptNo,
        r.idempotencyKey,
        r.state,
        r.providerReference,
        r.settlementTxHash,
        r.settlementChain,
        r.settledAmount?.amount.toString() ?? null,
        r.settledAmount?.asset.symbol ?? null,
        r.settledAmount?.asset.decimals ?? null,
        r.error === null ? null : JSON.stringify(r.error),
        r.startedAt,
        r.finishedAt,
      ],
    );
  }

  async updateExecution(
    executionId: string,
    patch: Partial<
      Pick<
        ProviderExecutionRecord,
        "state" | "providerReference" | "settlementTxHash" | "settlementChain" | "settledAmount" | "error" | "finishedAt"
      >
    >,
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [executionId];
    const push = (col: string, v: unknown): void => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.state !== undefined) push("state", patch.state);
    if (patch.providerReference !== undefined) push("provider_reference", patch.providerReference);
    if (patch.settlementTxHash !== undefined) push("settlement_tx_hash", patch.settlementTxHash);
    if (patch.settlementChain !== undefined) push("settlement_chain", patch.settlementChain);
    if (patch.settledAmount !== undefined && patch.settledAmount !== null) {
      push("settled_amount", patch.settledAmount.amount.toString());
      push("settled_token", patch.settledAmount.asset.symbol);
      push("settled_decimals", patch.settledAmount.asset.decimals);
    }
    if (patch.error !== undefined) {
      params.push(patch.error === null ? null : JSON.stringify(patch.error));
      sets.push(`error = $${params.length}::jsonb`);
    }
    if (patch.finishedAt !== undefined) push("finished_at", patch.finishedAt);
    if (sets.length === 0) return;
    await this.pool.query(
      `UPDATE consumer_provider_executions SET ${sets.join(", ")} WHERE execution_id = $1`,
      params,
    );
  }

  async getExecution(executionId: string): Promise<ProviderExecutionRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_provider_executions WHERE execution_id = $1",
      [executionId],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToExecution(row) : null;
  }

  async listExecutions(intentId: string): Promise<readonly ProviderExecutionRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_provider_executions WHERE intent_id = $1 ORDER BY attempt_no ASC",
      [intentId],
    );
    return (rows as Row[]).map(rowToExecution);
  }

  async findAmbiguousExecutions(
    olderThanIso: string,
    limit: number,
  ): Promise<readonly ProviderExecutionRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM consumer_provider_executions
        WHERE state IN ('SENT','AMBIGUOUS') AND started_at <= $1
        ORDER BY started_at ASC LIMIT $2`,
      [olderThanIso, limit],
    );
    return (rows as Row[]).map(rowToExecution);
  }

  async recordSettlement(executionId: string, ledger: LedgerGroup): Promise<void> {
    assertGroupBalanced(ledger);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.writeLedgerGroup(client, ledger);
      await client.query(
        "UPDATE consumer_provider_executions SET state = 'PAID' WHERE execution_id = $1",
        [executionId],
      );
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── delivery ───────────────────────────────────────────────────────────────

  async upsertDeliveryEvidence(e: DeliveryEvidence): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_delivery_evidence
        (intent_id, provider_id, provider_attested, untch_verified, verified, method, evidence_hash,
         created_at, updated_at)
       VALUES ($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7, now(), now())
       ON CONFLICT (intent_id) DO UPDATE SET
         provider_attested = EXCLUDED.provider_attested,
         untch_verified = EXCLUDED.untch_verified,
         verified = EXCLUDED.verified,
         method = EXCLUDED.method,
         evidence_hash = EXCLUDED.evidence_hash,
         updated_at = now()`,
      [
        e.intentId,
        e.providerId,
        JSON.stringify(e.providerAttested),
        JSON.stringify(e.untchVerified),
        e.untchVerified.verified,
        e.untchVerified.method,
        e.evidenceHash,
      ],
    );
  }

  async getDeliveryEvidence(intentId: string): Promise<DeliveryEvidence | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_delivery_evidence WHERE intent_id = $1",
      [intentId],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    const attested = jsonObj(row.provider_attested);
    const verified = jsonObj(row.untch_verified);
    return {
      intentId: str(row.intent_id),
      providerId: str(row.provider_id),
      providerAttested: {
        status: str(attested.status),
        reference: str(attested.reference),
        attestedAt: str(attested.attestedAt),
        fields: jsonObj(attested.fields),
      },
      untchVerified: {
        verified: bool(row.verified),
        method: str(row.method) as DeliveryEvidence["untchVerified"]["method"],
        detail: str(verified.detail),
        verifiedAt: verified.verifiedAt === null || verified.verifiedAt === undefined
          ? null
          : str(verified.verifiedAt),
      },
      evidenceHash: str(row.evidence_hash),
    };
  }

  // ── ledger ─────────────────────────────────────────────────────────────────

  async appendLedgerGroup(group: LedgerGroup): Promise<void> {
    assertGroupBalanced(group);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.writeLedgerGroup(client, group);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private async writeLedgerGroup(
    client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount?: number | null }> },
    group: LedgerGroup,
  ): Promise<void> {
    assertGroupBalanced(group);
    await client.query(
      `INSERT INTO consumer_ledger_groups (group_id, kind, intent_id, chain, token, created_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [group.groupId, group.kind, group.intentId, group.asset.chain, group.asset.symbol, group.createdAt],
    );
    for (const e of group.entries) {
      // Ensure the account row exists. Deterministic ids mean this is idempotent.
      const [kind] = e.accountId.split(":", 1);
      await client.query(
        `INSERT INTO consumer_ledger_accounts (account_id, kind, chain, token, contract, decimals, owner_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (account_id) DO NOTHING`,
        [
          e.accountId,
          kind ?? "SUSPENSE",
          e.amount.asset.chain,
          e.amount.asset.symbol,
          e.amount.asset.address,
          e.amount.asset.decimals,
          e.accountId.slice(e.accountId.lastIndexOf(":") + 1),
        ],
      );
      await client.query(
        `INSERT INTO consumer_ledger_entries (group_id, account_id, amount, token, chain, decimals, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          group.groupId,
          e.accountId,
          e.amount.amount.toString(),
          e.amount.asset.symbol,
          e.amount.asset.chain,
          e.amount.asset.decimals,
          e.memo,
        ],
      );
    }
  }

  async appendTreasuryTransfer(groups: readonly [LedgerGroup, LedgerGroup]): Promise<void> {
    for (const g of groups) assertGroupBalanced(g);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      for (const g of groups) await this.writeLedgerGroup(client, g);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  private static readonly LEDGER_SELECT = `
    SELECT g.group_id, g.kind, g.intent_id, g.chain, g.token, g.created_at,
           e.account_id, e.amount, e.decimals, e.contract, e.memo
      FROM consumer_ledger_groups g
      JOIN (SELECT le.group_id, le.account_id, le.amount, le.decimals, a.contract, le.memo, le.id
              FROM consumer_ledger_entries le
              JOIN consumer_ledger_accounts a ON a.account_id = le.account_id) e
        ON e.group_id = g.group_id`;

  async ledgerGroupsForAsset(asset: AssetRef, limit: number): Promise<readonly LedgerGroup[]> {
    // The limit bounds GROUPS, not rows: slicing mid-group would hand the caller an unbalanced
    // group and `assertBookBalanced` would report a phantom imbalance that is really a truncation.
    const { rows } = await this.pool.query(
      `${PgConsumerStore.LEDGER_SELECT}
        WHERE g.group_id IN (
          SELECT group_id FROM consumer_ledger_groups
           WHERE chain = $1 AND token = $2
           ORDER BY created_at DESC, group_id DESC
           LIMIT $3)
        ORDER BY g.created_at ASC, e.id ASC`,
      [asset.chain, asset.symbol, limit],
    );
    return this.mapLedgerRows(rows as Row[]);
  }

  async ledgerGroupsForIntent(intentId: string): Promise<readonly LedgerGroup[]> {
    const { rows } = await this.pool.query(
      `${PgConsumerStore.LEDGER_SELECT}
        WHERE g.intent_id = $1
        ORDER BY g.created_at ASC, e.id ASC`,
      [intentId],
    );
    return this.mapLedgerRows(rows as Row[]);
  }

  private mapLedgerRows(rows: readonly Row[]): readonly LedgerGroup[] {
    const byGroup = new Map<string, { group: Omit<LedgerGroup, "entries">; entries: LedgerGroup["entries"][number][] }>();
    for (const raw of rows) {
      const groupId = str(raw.group_id);
      const asset: AssetRef = {
        symbol: str(raw.token),
        chain: str(raw.chain) as CaipChainId,
        address: strOrNull(raw.contract),
        decimals: num(raw.decimals),
      };
      let bucket = byGroup.get(groupId);
      if (!bucket) {
        bucket = {
          group: {
            groupId,
            kind: str(raw.kind) as LedgerGroupKind,
            intentId: strOrNull(raw.intent_id),
            asset,
            createdAt: iso(raw.created_at),
          },
          entries: [],
        };
        byGroup.set(groupId, bucket);
      }
      bucket.entries.push({
        accountId: str(raw.account_id),
        amount: money(BigInt(str(raw.amount)), asset),
        memo: str(raw.memo),
      });
    }
    return [...byGroup.values()].map((b) => ({ ...b.group, entries: b.entries }));
  }

  async accountBalance(accountId: string, asset: AssetRef): Promise<Money> {
    const { rows } = await this.pool.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM consumer_ledger_entries WHERE account_id = $1",
      [accountId],
    );
    const row = rows[0] as Row | undefined;
    return money(BigInt(str(row?.total ?? "0")), asset);
  }

  async accountDaySpend(accountId: string, asset: AssetRef, dayKeyUtc: string): Promise<Money> {
    const { rows } = await this.pool.query(
      `SELECT COALESCE(SUM(-amount), 0) AS total
         FROM consumer_ledger_entries
        WHERE account_id = $1 AND amount < 0
          AND created_at >= $2::date AND created_at < ($2::date + INTERVAL '1 day')`,
      [accountId, dayKeyUtc],
    );
    const row = rows[0] as Row | undefined;
    return money(BigInt(str(row?.total ?? "0")), asset);
  }

  // ── outbox ─────────────────────────────────────────────────────────────────

  async pendingOutbox(limit: number): Promise<readonly OutboxRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM consumer_outbox WHERE dispatched = FALSE ORDER BY occurred_at ASC LIMIT $1`,
      [limit],
    );
    return (rows as Row[]).map(rowToOutbox);
  }

  async markDispatched(eventId: string): Promise<void> {
    await this.pool.query("UPDATE consumer_outbox SET dispatched = TRUE WHERE event_id = $1", [eventId]);
  }

  async markDispatchFailed(eventId: string, error: string): Promise<void> {
    await this.pool.query(
      "UPDATE consumer_outbox SET attempts = attempts + 1, last_error = $2 WHERE event_id = $1",
      [eventId, error.slice(0, 500)],
    );
  }

  async eventsSince(intentId: string, afterSeq: number, limit: number): Promise<readonly ConsumerEvent[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM consumer_outbox WHERE intent_id = $1 AND seq > $2 ORDER BY seq ASC LIMIT $3`,
      [intentId, afterSeq, limit],
    );
    return (rows as Row[]).map((r) => {
      const { dispatched: _d, attempts: _a, lastError: _e, ...evt } = rowToOutbox(r);
      return evt;
    });
  }

  // ── provider registry ──────────────────────────────────────────────────────

  async upsertProvider(p: ProviderRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_providers
        (provider_id, display_name, maturity, base_url, protocol, chains, provenance, enabled, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8, now())
       ON CONFLICT (provider_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         maturity = EXCLUDED.maturity,
         base_url = EXCLUDED.base_url,
         protocol = EXCLUDED.protocol,
         chains = EXCLUDED.chains,
         provenance = EXCLUDED.provenance,
         enabled = EXCLUDED.enabled,
         updated_at = now()`,
      [
        p.providerId,
        p.displayName,
        p.maturity,
        p.baseUrl,
        p.protocol,
        JSON.stringify(p.chains),
        p.provenance,
        p.enabled,
      ],
    );
  }

  async getProvider(providerId: string): Promise<ProviderRecord | null> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_providers WHERE provider_id = $1", [
      providerId,
    ]);
    const row = rows[0] as Row | undefined;
    return row ? rowToProvider(row) : null;
  }

  async listProviders(): Promise<readonly ProviderRecord[]> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_providers ORDER BY provider_id");
    return (rows as Row[]).map(rowToProvider);
  }

  async upsertCapability(c: ProviderCapabilityRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_provider_capabilities (provider_id, capability, maturity, notes, access_blocker)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider_id, capability) DO UPDATE SET
         maturity = EXCLUDED.maturity,
         notes = EXCLUDED.notes,
         access_blocker = EXCLUDED.access_blocker`,
      [c.providerId, c.capability, c.maturity, c.notes, c.accessBlocker ?? null],
    );
  }

  async listCapabilities(providerId: string): Promise<readonly ProviderCapabilityRecord[]> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_provider_capabilities WHERE provider_id = $1 ORDER BY capability",
      [providerId],
    );
    return (rows as Row[]).map((r) => ({
      providerId: str(r.provider_id),
      capability: str(r.capability),
      maturity: str(r.maturity) as ProviderMaturity,
      notes: str(r.notes),
      accessBlocker: strOrNull(r.access_blocker) as CapabilityAccessBlocker | null,
    }));
  }

  async recordHealth(h: ProviderHealthRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_provider_health
        (provider_id, healthy, latency_ms, http_status, detail, breaker_state, observed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [h.providerId, h.healthy, h.latencyMs, h.httpStatus, h.detail, h.breakerState, h.observedAt],
    );
  }

  async latestHealth(providerId: string): Promise<ProviderHealthRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_provider_health WHERE provider_id = $1 ORDER BY observed_at DESC LIMIT 1",
      [providerId],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    return {
      providerId: str(row.provider_id),
      healthy: bool(row.healthy),
      latencyMs: numOrNull(row.latency_ms),
      httpStatus: numOrNull(row.http_status),
      detail: str(row.detail),
      breakerState: str(row.breaker_state) as ProviderHealthRecord["breakerState"],
      observedAt: iso(row.observed_at),
    };
  }

  // ── pause flags ────────────────────────────────────────────────────────────

  async setPause(f: PauseFlag): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_pause_flags (scope, target, paused, reason, set_by, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (scope, target) DO UPDATE SET
         paused = EXCLUDED.paused, reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, updated_at = now()`,
      [f.scope, f.target, f.paused, f.reason, f.setBy],
    );
  }

  async listPauses(): Promise<readonly PauseFlag[]> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_pause_flags");
    return (rows as Row[]).map((r) => ({
      scope: str(r.scope) as PauseScope,
      target: str(r.target),
      paused: bool(r.paused),
      reason: str(r.reason),
      setBy: str(r.set_by),
      updatedAt: iso(r.updated_at),
    }));
  }

  // ── treasury ───────────────────────────────────────────────────────────────

  async upsertTreasuryAccount(t: TreasuryAccountRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_treasury_accounts
        (treasury_ref, chain, token, contract, decimals, purpose, address, min_balance, daily_limit,
         enabled, attestation, registration_version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
       ON CONFLICT (treasury_ref) DO UPDATE SET
         min_balance = EXCLUDED.min_balance, daily_limit = EXCLUDED.daily_limit,
         address = EXCLUDED.address, enabled = EXCLUDED.enabled,
         -- COALESCE, so a boot-time upsert that carries no attestation cannot erase one a registration
         -- wrote. The rails re-upsert their own rows on every start; without this, restarting the
         -- service would silently strip the on-chain evidence off an account and turn a verified float
         -- back into an unattested one.
         attestation = COALESCE(EXCLUDED.attestation, consumer_treasury_accounts.attestation),
         registration_version =
           COALESCE(EXCLUDED.registration_version, consumer_treasury_accounts.registration_version),
         updated_at = now()`,
      [
        t.treasuryRef,
        t.asset.chain,
        t.asset.symbol,
        t.asset.address,
        t.asset.decimals,
        t.purpose,
        t.address,
        t.minBalance.amount.toString(),
        t.dailyLimit.amount.toString(),
        t.enabled,
        t.attestation ? JSON.stringify(t.attestation) : null,
        t.attestation?.registrationVersion ?? null,
      ],
    );
  }

  async getTreasuryAccount(treasuryRef: string): Promise<TreasuryAccountRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_treasury_accounts WHERE treasury_ref = $1",
      [treasuryRef],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToTreasury(row) : null;
  }

  async findTreasuryAccount(
    chain: CaipChainId,
    token: string,
    purpose: "FUNDING" | "SETTLEMENT",
  ): Promise<TreasuryAccountRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_treasury_accounts WHERE chain = $1 AND token = $2 AND purpose = $3",
      [chain, token, purpose],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToTreasury(row) : null;
  }

  async listTreasuryAccounts(): Promise<readonly TreasuryAccountRecord[]> {
    const { rows } = await this.pool.query("SELECT * FROM consumer_treasury_accounts ORDER BY treasury_ref");
    return (rows as Row[]).map(rowToTreasury);
  }

  async recordBalanceObservation(o: TreasuryBalanceObservation): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_treasury_balances (treasury_ref, onchain, ledger, drift, observed_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        o.treasuryRef,
        o.onchain.amount.toString(),
        o.ledger.amount.toString(),
        o.drift.amount.toString(),
        o.observedAt,
      ],
    );
  }

  async latestBalanceObservation(treasuryRef: string): Promise<TreasuryBalanceObservation | null> {
    const { rows } = await this.pool.query(
      `SELECT b.*, t.chain, t.token, t.contract, t.decimals
         FROM consumer_treasury_balances b
         JOIN consumer_treasury_accounts t ON t.treasury_ref = b.treasury_ref
        WHERE b.treasury_ref = $1 ORDER BY b.observed_at DESC LIMIT 1`,
      [treasuryRef],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    const asset: AssetRef = {
      symbol: str(row.token),
      chain: str(row.chain) as CaipChainId,
      address: strOrNull(row.contract),
      decimals: num(row.decimals),
    };
    return {
      treasuryRef: str(row.treasury_ref),
      onchain: money(BigInt(str(row.onchain)), asset),
      ledger: money(BigInt(str(row.ledger)), asset),
      drift: money(BigInt(str(row.drift)), asset),
      observedAt: iso(row.observed_at),
    };
  }

  async upsertProviderLimit(l: ProviderLimitRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_provider_limits (provider_id, chain, token, per_tx_max, daily_max)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (provider_id, chain, token) DO UPDATE SET
         per_tx_max = EXCLUDED.per_tx_max, daily_max = EXCLUDED.daily_max`,
      [
        l.providerId,
        l.asset.chain,
        l.asset.symbol,
        l.perTxMax.amount.toString(),
        l.dailyMax.amount.toString(),
      ],
    );
  }

  async getProviderLimit(
    providerId: string,
    chain: CaipChainId,
    token: string,
  ): Promise<ProviderLimitRecord | null> {
    const { rows } = await this.pool.query(
      `SELECT l.*, t.contract, t.decimals
         FROM consumer_provider_limits l
         LEFT JOIN consumer_treasury_accounts t
           ON t.chain = l.chain AND t.token = l.token AND t.purpose = 'SETTLEMENT'
        WHERE l.provider_id = $1 AND l.chain = $2 AND l.token = $3`,
      [providerId, chain, token],
    );
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    const asset: AssetRef = {
      symbol: str(row.token),
      chain: str(row.chain) as CaipChainId,
      address: strOrNull(row.contract),
      decimals: num(row.decimals ?? 6),
    };
    return {
      providerId: str(row.provider_id),
      asset,
      perTxMax: money(BigInt(str(row.per_tx_max)), asset),
      dailyMax: money(BigInt(str(row.daily_max)), asset),
    };
  }

  // ── payment capabilities ───────────────────────────────────────────────────

  async issueCapability(c: CapabilityRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO consumer_payment_capabilities
        (capability_id, intent_id, provider_id, treasury_ref, chain, token, contract, decimals,
         max_amount, recipients, issued_at, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        c.capabilityId,
        c.intentId,
        c.providerId,
        c.treasuryRef,
        c.asset.chain,
        c.asset.symbol,
        c.asset.address,
        c.asset.decimals,
        c.maxAmount.amount.toString(),
        JSON.stringify(c.allowedRecipients),
        c.issuedAt,
        c.expiresAt,
      ],
    );
  }

  /**
   * Single-use redemption under a row lock. `FOR UPDATE` serializes two workers racing the same
   * capability; the `WHERE consumed_at IS NULL` makes the second one a no-op rather than a second
   * payment.
   */
  async consumeCapability(
    capabilityId: string,
    spent: Money,
    atIso: string,
  ): Promise<CapabilityRecord | null> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT * FROM consumer_payment_capabilities WHERE capability_id = $1 FOR UPDATE",
        [capabilityId],
      );
      const row = locked.rows[0] as Row | undefined;
      if (!row || row.consumed_at !== null || iso(row.expires_at) <= atIso) {
        await client.query("ROLLBACK");
        return null;
      }
      await client.query(
        `UPDATE consumer_payment_capabilities SET consumed_at = $2, spent_amount = $3
          WHERE capability_id = $1 AND consumed_at IS NULL`,
        [capabilityId, atIso, spent.amount.toString()],
      );
      await client.query("COMMIT");
      return { ...rowToCapability(row), consumedAt: atIso, spentAmount: spent };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  // ── the one-shot Solana proof gate ────────────────────────────────────────

  private proofGateFromRow(row: Row): SolanaProofGateRecord {
    return {
      scopeHash: row.scope_hash as string,
      state: row.state as SolanaProofGateState,
      scope: {
        intentId: row.intent_id as string,
        providerId: row.provider_id as string,
        capability: row.capability as string,
        chain: row.chain as CaipChainId,
        asset: {
          symbol: row.asset_symbol as string,
          chain: row.chain as CaipChainId,
          address: (row.asset_address as string | null) ?? null,
          decimals: 6,
        },
        maxAmount: {
          amount: BigInt(row.max_amount as string),
          asset: {
            symbol: row.asset_symbol as string,
            chain: row.chain as CaipChainId,
            address: (row.asset_address as string | null) ?? null,
            decimals: 6,
          },
        },
        expiresAt: iso(row.expires_at),
      },
      claimedByExecution: (row.claimed_by_execution as string | null) ?? null,
      claimedAt: row.claimed_at ? iso(row.claimed_at) : null,
      signerReachedAt: row.signer_reached_at ? iso(row.signer_reached_at) : null,
      credentialCreatedAt: row.credential_created_at ? iso(row.credential_created_at) : null,
      txSignature: (row.tx_signature as string | null) ?? null,
      txSubmittedAt: row.tx_submitted_at ? iso(row.tx_submitted_at) : null,
      settledAt: row.settled_at ? iso(row.settled_at) : null,
      confirmedSlot: row.confirmed_slot === null || row.confirmed_slot === undefined ? null : Number(row.confirmed_slot),
      txError: (row.tx_error as string | null) ?? null,
      preTokenAmount: (row.pre_token_amount as string | null) ?? null,
      postTokenAmount: (row.post_token_amount as string | null) ?? null,
      tokenDelta: (row.token_delta as string | null) ?? null,
      mint: (row.mint as string | null) ?? null,
      authority: (row.authority as string | null) ?? null,
      feePayer: (row.fee_payer as string | null) ?? null,
      acknowledgedAt: row.acknowledged_at ? iso(row.acknowledged_at) : null,
      providerResultHash: (row.provider_result_hash as string | null) ?? null,
      manualReviewReason: (row.manual_review_reason as string | null) ?? null,
      releasedAt: row.released_at ? iso(row.released_at) : null,
      releasedReason: (row.released_reason as string | null) ?? null,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async armSolanaProofGate(scope: SolanaProofScope, atIso: string): Promise<SolanaProofGateRecord> {
    const scopeHash = solanaProofScopeHash(scope);
    // ON CONFLICT DO NOTHING makes arming idempotent by scope: two workers arming the same proof
    // converge on one row rather than each creating a gate that looks unclaimed.
    await this.pool.query(
      `INSERT INTO consumer_solana_proof_gate
         (scope_hash, state, intent_id, provider_id, capability, chain, asset_symbol,
          asset_address, max_amount, expires_at, created_at, updated_at)
       VALUES ($1, 'ARMED', $2, $3, $4, $5, $6, $7, $8, $9, $10, $10)
       ON CONFLICT (scope_hash) DO NOTHING`,
      [
        scopeHash,
        scope.intentId,
        scope.providerId,
        scope.capability,
        scope.chain,
        scope.asset.symbol,
        scope.asset.address,
        scope.maxAmount.amount.toString(),
        scope.expiresAt,
        atIso,
      ],
    );
    const got = await this.getSolanaProofGate(scopeHash);
    if (!got) throw new Error(`could not read back the proof gate for scope ${scopeHash}`);
    return got;
  }

  /**
   * The compare-and-set that decides who may reach the signer.
   *
   * `WHERE state = 'ARMED'` in the UPDATE is the whole mechanism: Postgres serialises the two writes,
   * the second sees a CLAIMED row and matches nothing, and `rowCount` tells us we lost. No advisory
   * lock and no read-then-write, because a read-then-write is exactly the race this must not have.
   */
  async claimSolanaProofGate(
    scopeHash: string,
    executionId: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const res = await this.pool.query(
      `UPDATE consumer_solana_proof_gate
          SET state = 'CLAIMED', claimed_by_execution = $2, claimed_at = $3, updated_at = $3
        WHERE scope_hash = $1 AND state = 'ARMED'
        RETURNING *`,
      [scopeHash, executionId, atIso],
    );
    const row = res.rows[0] as Row | undefined;
    return row ? this.proofGateFromRow(row) : null;
  }

  async recordSolanaProofProgress(
    scopeHash: string,
    progress: SolanaProofProgress,
    state: SolanaProofGateState | null,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const cols: Record<string, unknown> = {
      signer_reached_at: progress.signerReachedAt,
      credential_created_at: progress.credentialCreatedAt,
      tx_signature: progress.txSignature,
      tx_submitted_at: progress.txSubmittedAt,
      settled_at: progress.settledAt,
      confirmed_slot: progress.confirmedSlot,
      tx_error: progress.txError,
      pre_token_amount: progress.preTokenAmount,
      post_token_amount: progress.postTokenAmount,
      token_delta: progress.tokenDelta,
      mint: progress.mint,
      authority: progress.authority,
      fee_payer: progress.feePayer,
      acknowledged_at: progress.acknowledgedAt,
      provider_result_hash: progress.providerResultHash,
      manual_review_reason: progress.manualReviewReason,
    };
    const sets: string[] = ["updated_at = $2"];
    const params: unknown[] = [scopeHash, atIso];
    for (const [col, val] of Object.entries(cols)) {
      if (val === undefined) continue;
      params.push(val);
      sets.push(`${col} = $${params.length}`);
    }
    if (state !== null) {
      params.push(state);
      sets.push(`state = $${params.length}`);
    }
    const res = await this.pool.query(
      `UPDATE consumer_solana_proof_gate SET ${sets.join(", ")} WHERE scope_hash = $1 RETURNING *`,
      params,
    );
    const row = res.rows[0] as Row | undefined;
    return row ? this.proofGateFromRow(row) : null;
  }

  async getSolanaProofGate(scopeHash: string): Promise<SolanaProofGateRecord | null> {
    const res = await this.pool.query(
      "SELECT * FROM consumer_solana_proof_gate WHERE scope_hash = $1",
      [scopeHash],
    );
    const row = res.rows[0] as Row | undefined;
    return row ? this.proofGateFromRow(row) : null;
  }

  async listSolanaProofGates(limit: number): Promise<readonly SolanaProofGateRecord[]> {
    const res = await this.pool.query(
      "SELECT * FROM consumer_solana_proof_gate ORDER BY created_at DESC LIMIT $1",
      [limit],
    );
    return (res.rows as Row[]).map((r) => this.proofGateFromRow(r));
  }

  /**
   * Release, guarded in SQL as well as in code.
   *
   * The NULL checks in the WHERE clause are the same rule `canReleasePreSign` states, enforced where a
   * buggy caller cannot talk its way past them. This is the one transition that can turn a spent gate
   * back into a spendable one, so it is worth stating twice.
   */
  async releaseSolanaProofGatePreSign(
    scopeHash: string,
    reason: string,
    atIso: string,
  ): Promise<SolanaProofGateRecord | null> {
    const res = await this.pool.query(
      `UPDATE consumer_solana_proof_gate
          SET state = 'RELEASED_PRE_SIGN', released_at = $2, released_reason = $3, updated_at = $2
        WHERE scope_hash = $1
          AND signer_reached_at IS NULL
          AND credential_created_at IS NULL
          AND tx_signature IS NULL
          AND tx_submitted_at IS NULL
          AND settled_at IS NULL
        RETURNING *`,
      [scopeHash, atIso, reason],
    );
    const row = res.rows[0] as Row | undefined;
    return row ? this.proofGateFromRow(row) : null;
  }

  async getCapability(capabilityId: string): Promise<CapabilityRecord | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM consumer_payment_capabilities WHERE capability_id = $1",
      [capabilityId],
    );
    const row = rows[0] as Row | undefined;
    return row ? rowToCapability(row) : null;
  }

  // ── idempotency ────────────────────────────────────────────────────────────

  async claimIdempotency(args: {
    readonly tenantId: string;
    readonly key: string;
    readonly intentId: string;
    readonly action: string;
    readonly requestHash: string;
  }): Promise<string | null> {
    const inserted = await this.pool.query(
      `INSERT INTO consumer_idempotency_records (tenant_id, key, intent_id, action, request_hash)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (tenant_id, key) DO NOTHING
       RETURNING intent_id`,
      [args.tenantId, args.key, args.intentId, args.action, args.requestHash],
    );
    if (inserted.rows.length > 0) return null;
    const { rows } = await this.pool.query(
      "SELECT intent_id FROM consumer_idempotency_records WHERE tenant_id = $1 AND key = $2",
      [args.tenantId, args.key],
    );
    const row = rows[0] as Row | undefined;
    return row ? str(row.intent_id) : null;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

// ── row mappers ──────────────────────────────────────────────────────────────

function rowToIntent(row: Row): ConsumerIntent {
  const fundingAsset = assetFromRow(row, "funding");
  const settlementAsset = assetFromRow(row, "settlement");
  return {
    intentId: str(row.intent_id),
    tenantId: str(row.tenant_id),
    requestingAgentId: str(row.requesting_agent_id),
    principalId: str(row.principal_id),
    action: str(row.action) as ConsumerIntent["action"],
    category: str(row.category) as ConsumerIntent["category"],
    providerId: strOrNull(row.provider_id),
    request: jsonObj(row.request),
    policyId: str(row.policy_id),
    policyVersion: numOrNull(row.policy_version),
    policyHash: strOrNull(row.policy_hash),
    policyDecision: row.policy_decision === null || row.policy_decision === undefined
      ? null
      : jsonObj(row.policy_decision),
    quoteId: strOrNull(row.quote_id),
    quoteHash: strOrNull(row.quote_hash),
    quoteExpiresAt: isoOrNull(row.quote_expires_at),
    fundingAsset,
    fundingAmount: moneyFromRow(row, "funding_amount", fundingAsset),
    settlementAsset,
    settlementAmount: moneyFromRow(row, "settlement_amount", settlementAsset),
    untchFee: moneyFromRow(row, "untch_fee_amount", fundingAsset),
    spread: moneyFromRow(row, "spread_amount", fundingAsset),
    maxAuthorisedAmount: moneyFromRow(row, "max_authorised", fundingAsset),
    approvalRequired: bool(row.approval_required),
    approvalOutcome: (strOrNull(row.approval_outcome) as ConsumerApproval["outcome"] | null) ?? null,
    state: str(row.state) as ConsumerIntentState,
    failureCode: strOrNull(row.failure_code),
    failureDetail: strOrNull(row.failure_detail),
    correlationId: str(row.correlation_id),
    idempotencyKey: str(row.idempotency_key),
    spendIntentHash: strOrNull(row.spend_intent_hash),
    receiptId: strOrNull(row.receipt_id),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    expiresAt: isoOrNull(row.expires_at),
  };
}

function rowToQuote(row: Row): ConsumerQuote {
  const settlementAsset: AssetRef = {
    symbol: str(row.settlement_token),
    chain: str(row.settlement_chain) as CaipChainId,
    address: strOrNull(row.settlement_contract),
    decimals: num(row.settlement_decimals),
  };
  const fundingAsset: AssetRef = {
    symbol: str(row.funding_token),
    chain: str(row.funding_chain) as CaipChainId,
    address: strOrNull(row.funding_contract),
    decimals: num(row.funding_decimals),
  };
  return {
    quoteId: str(row.quote_id),
    intentId: str(row.intent_id),
    providerId: str(row.provider_id),
    providerCost: money(BigInt(str(row.provider_cost)), settlementAsset),
    untchFee: money(BigInt(str(row.untch_fee)), fundingAsset),
    spread: money(BigInt(str(row.spread)), fundingAsset),
    totalUserAmount: money(BigInt(str(row.total_user_amount)), fundingAsset),
    maxAuthorisedAmount: money(BigInt(str(row.max_authorised)), fundingAsset),
    settlementRecipient: str(row.settlement_recipient),
    settlementChain: str(row.settlement_chain) as CaipChainId,
    settlementAsset,
    providerRef: str(row.provider_ref),
    summary: str(row.summary),
    terms: jsonObj(row.terms),
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    quoteHash: str(row.quote_hash),
  };
}

function rowToApproval(row: Row): ConsumerApproval {
  const asset: AssetRef = {
    symbol: str(row.max_amount_token),
    chain: str(row.max_amount_chain) as CaipChainId,
    address: null,
    decimals: num(row.max_amount_decimals),
  };
  const resolvedByRaw = row.resolved_by;
  const resolvedBy =
    resolvedByRaw === null || resolvedByRaw === undefined
      ? null
      : (() => {
          const o = jsonObj(resolvedByRaw);
          return { channel: str(o.channel), handle: str(o.handle) };
        })();
  return {
    intentId: str(row.intent_id),
    escalationId: str(row.escalation_id),
    pollRef: str(row.poll_ref),
    required: bool(row.required),
    outcome: str(row.outcome) as ConsumerApproval["outcome"],
    quoteHash: str(row.quote_hash),
    policyId: str(row.policy_id),
    policyVersion: num(row.policy_version),
    policyHash: str(row.policy_hash),
    maxAmount: money(BigInt(str(row.max_amount)), asset),
    settlementRecipient: str(row.settlement_recipient),
    settlementChain: str(row.settlement_chain) as CaipChainId,
    providerId: str(row.provider_id),
    resolvedBy,
    resolvedAt: isoOrNull(row.resolved_at),
    createdAt: iso(row.created_at),
  };
}

function rowToExecution(row: Row): ProviderExecutionRecord {
  const settledToken = strOrNull(row.settled_token);
  const settledAmount =
    row.settled_amount === null || row.settled_amount === undefined || settledToken === null
      ? null
      : money(BigInt(str(row.settled_amount)), {
          symbol: settledToken,
          chain: str(row.settlement_chain) as CaipChainId,
          address: null,
          decimals: num(row.settled_decimals),
        });
  return {
    executionId: str(row.execution_id),
    intentId: str(row.intent_id),
    providerId: str(row.provider_id),
    attemptNo: num(row.attempt_no),
    idempotencyKey: str(row.idempotency_key),
    state: str(row.state) as ProviderExecutionRecord["state"],
    providerReference: strOrNull(row.provider_reference),
    settlementTxHash: strOrNull(row.settlement_tx_hash),
    settlementChain: (strOrNull(row.settlement_chain) as CaipChainId | null) ?? null,
    settledAmount,
    error:
      row.error === null || row.error === undefined
        ? null
        : (jsonObj(row.error) as unknown as ProviderExecutionRecord["error"]),
    startedAt: iso(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

function rowToOutbox(row: Row): OutboxRecord {
  return {
    eventId: str(row.event_id),
    intentId: str(row.intent_id),
    tenantId: str(row.tenant_id),
    seq: num(row.seq),
    name: str(row.name) as ConsumerEventName,
    state: str(row.state) as ConsumerIntentState,
    correlationId: str(row.correlation_id),
    data: jsonObj(row.data),
    occurredAt: iso(row.occurred_at),
    dispatched: bool(row.dispatched),
    attempts: num(row.attempts),
    lastError: strOrNull(row.last_error),
  };
}

function rowToProvider(row: Row): ProviderRecord {
  return {
    providerId: str(row.provider_id),
    displayName: str(row.display_name),
    maturity: str(row.maturity) as ProviderMaturity,
    baseUrl: str(row.base_url),
    protocol: str(row.protocol) as ProviderRecord["protocol"],
    chains: jsonArr(row.chains).map((c) => str(c) as CaipChainId),
    provenance: str(row.provenance),
    enabled: bool(row.enabled),
  };
}

function rowToTreasury(row: Row): TreasuryAccountRecord {
  const asset: AssetRef = {
    symbol: str(row.token),
    chain: str(row.chain) as CaipChainId,
    address: strOrNull(row.contract),
    decimals: num(row.decimals),
  };
  return {
    treasuryRef: str(row.treasury_ref),
    asset,
    purpose: str(row.purpose) as "FUNDING" | "SETTLEMENT",
    address: str(row.address),
    minBalance: money(BigInt(str(row.min_balance)), asset),
    dailyLimit: money(BigInt(str(row.daily_limit)), asset),
    enabled: bool(row.enabled),
    // `pg` already parses jsonb, so this is an object rather than a string. Absent (a row written
    // before migration 012, or by a boot-time rail upsert) reads as null, which every consumer treats
    // as unattested.
    attestation: (row.attestation as SettlementAccountAttestation | null | undefined) ?? null,
  };
}

function rowToCapability(row: Row): CapabilityRecord {
  const asset: AssetRef = {
    symbol: str(row.token),
    chain: str(row.chain) as CaipChainId,
    address: strOrNull(row.contract),
    decimals: num(row.decimals),
  };
  return {
    capabilityId: str(row.capability_id),
    intentId: str(row.intent_id),
    providerId: str(row.provider_id),
    treasuryRef: str(row.treasury_ref),
    asset,
    maxAmount: money(BigInt(str(row.max_amount)), asset),
    allowedRecipients: jsonArr(row.recipients).map(str),
    issuedAt: iso(row.issued_at),
    expiresAt: iso(row.expires_at),
    consumedAt: isoOrNull(row.consumed_at),
    spentAmount:
      row.spent_amount === null || row.spent_amount === undefined
        ? null
        : money(BigInt(str(row.spent_amount)), asset),
  };
}

/** Re-exported so callers can build the same treasury ledger account id the router uses. */
export function pgTreasuryAccountId(asset: AssetRef, treasuryRef: string): string {
  return `TREASURY:${assetKey(asset)}:${treasuryRef}`;
}
