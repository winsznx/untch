import {
  assembleDisputePacket,
  assembleReconcileReport,
  hashDisputePacket,
  hashReconcileReport,
  parsePeriod,
  PeriodParseError,
  type ReportAnchorer,
  type ReportDataSource,
} from "@untch/reports";
import { toHex, type Hex } from "viem";
import type { HandlerResult } from "./handlers";

/**
 * §11 report tool handlers — `generate_dispute_packet` ($0.50) and `reconcile_agent_spend`
 * ($0.25/day · $1.00/wk). Framework-agnostic: each returns `{ status, body }` so it is unit-testable
 * with the REAL assembly + an in-memory data source, no network.
 *
 * NO LLM anywhere in this path (I1) — the handler validates input, resolves ids/period, reads the
 * durable receipt/ledger/escalation history, forwards to the deterministic `@untch/reports` assembly,
 * hashes the artifact, and — when an anchorer is wired — anchors the hash on `UntchReceipts.anchorAudit`
 * (§10.3 AuditAnchored). Sparse history yields a sparse, honestly-labeled artifact; nothing is faked.
 */

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

const HEX32 = /^0x[0-9a-fA-F]{64}$/;

/** Parse an `agentId` request field: a uint256 (decimal string / number) or a 0x 32-byte hex id. */
function parseAgentId(raw: unknown): Hex | null {
  if (typeof raw === "string" && HEX32.test(raw.trim())) return raw.trim().toLowerCase() as Hex;
  if (typeof raw === "string" && /^[0-9]+$/.test(raw.trim())) return toHex(BigInt(raw.trim()), { size: 32 });
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return toHex(BigInt(raw), { size: 32 });
  return null;
}

/** Day-bucket unix seconds (00:00Z of the day) of an ISO timestamp — the dispute packet's on-chain
 *  `period` (the day the disputed activity occurred). */
function dayBucketSeconds(iso: string): bigint {
  const ms = Date.parse(iso);
  const dayMs = Math.floor(ms / 86_400_000) * 86_400_000;
  return BigInt(Math.floor(dayMs / 1000));
}

export interface ReportDeps {
  readonly dataSource: ReportDataSource;
  /** When present, the assembled artifact's hash is anchored on-chain via `anchorAudit` and a real
   *  {txHash, blockNumber} is returned. When absent (default seller posture — the seller does not hold
   *  the writer key), `anchor` is null with an honest note; the anchor is produced by the prove scripts
   *  / an anchor job that DOES hold the writer key. Never a fabricated tx. */
  readonly anchorer?: ReportAnchorer | null;
  /** Injectable clock for deterministic tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

const ANCHOR_UNAVAILABLE_NOTE =
  "This instance is not wired with a writer key (the seller does not hold it by default), so the artifact was assembled and hashed but not anchored here. Its reportHash is anchored via UntchReceipts.anchorAudit by the anchor job / the prove scripts, which hold the writer key. The reportHash is the exact value that gets anchored — recompute it from the returned artifact to verify.";

async function tryAnchor(
  anchorer: ReportAnchorer | null | undefined,
  reportHash: Hex,
  agentId: Hex,
  period: bigint,
): Promise<Record<string, unknown>> {
  if (!anchorer) {
    return { anchored: false, txHash: null, blockNumber: null, note: ANCHOR_UNAVAILABLE_NOTE };
  }
  try {
    const res = await anchorer.anchor(reportHash, agentId, period);
    return {
      anchored: true,
      event: "AuditAnchored",
      reportHash: res.reportHash,
      agentId: res.agentId,
      period: res.period.toString(),
      txHash: res.txHash,
      blockNumber: res.blockNumber,
    };
  } catch (err) {
    console.error("[asp] anchorAudit failed — returning anchor: null", err);
    return {
      anchored: false,
      txHash: null,
      blockNumber: null,
      note: `anchoring failed (${(err as Error).message}); the assembled artifact + reportHash are still returned and durable.`,
    };
  }
}

/**
 * `generate_dispute_packet` ($0.50, per `intentRef`). Assembles the intent's DECISION receipt, VERIFY
 * result(s), escalation history, receipts (with their on-chain anchors), ledger effects, and a timeline
 * into one evidence bundle; hashes it; anchors the hash via AuditAnchored (when a writer is wired).
 *
 * On-chain `period` for a dispute packet = the UTC day of the intent's earliest receipt (the day the
 * disputed activity occurred). `agentId` = the intent's own agent. An intent with NO history yields an
 * honest empty packet (agentId falls back to a caller-supplied `agentId` or bytes32(0), period 0).
 */
export async function handleGenerateDisputePacket(body: unknown, deps: ReportDeps): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const rawIntent = b.intentRef ?? b.intentHash;
  if (typeof rawIntent !== "string" || !HEX32.test(rawIntent.trim())) {
    return {
      status: 400,
      body: errorEnvelope("INTENT_REF_REQUIRED", "an `intentRef` (0x 32-byte intentHash) is required"),
    };
  }
  const intentHash = rawIntent.trim().toLowerCase() as Hex;
  const fallbackAgentId = parseAgentId(b.agentId);

  const [receipts, ledger, escalations] = await Promise.all([
    deps.dataSource.receiptsForIntent(intentHash),
    deps.dataSource.ledgerForIntent(intentHash),
    deps.dataSource.escalationsForIntent(intentHash),
  ]);

  const assembledAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const packet = assembleDisputePacket(intentHash, receipts, ledger, escalations, { assembledAt });
  const reportHash = hashDisputePacket(packet);

  const agentId: Hex = packet.subject.agentId ?? fallbackAgentId ?? toHex(0n, { size: 32 });
  const earliest = receipts[0]?.createdAt;
  const period = earliest ? dayBucketSeconds(earliest) : 0n;

  const anchor = await tryAnchor(deps.anchorer, reportHash, agentId, period);

  return {
    status: 200,
    body: {
      tool: "generate_dispute_packet",
      intentHash,
      reportHash,
      packet,
      anchor,
    },
  };
}

/**
 * `reconcile_agent_spend` ($0.25/day · $1.00/wk, per `agentId` + `period`). Assembles the agent's spend
 * totals (moved money), blocked-waste totals (BLOCKED_* attempts), escalated exposure, decision
 * breakdown, escalation resolution history, verification outcomes, and receipt anchoring status over
 * the period; hashes it; anchors the hash via AuditAnchored (period = the window start, as §10.3
 * already parameterizes AuditAnchored by `period`).
 */
export async function handleReconcileAgentSpend(body: unknown, deps: ReportDeps): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;

  const agentId = parseAgentId(b.agentId);
  if (!agentId) {
    return {
      status: 400,
      body: errorEnvelope("AGENT_ID_REQUIRED", "provide `agentId` as a uint256 (decimal) or a 0x 32-byte hex id"),
    };
  }

  let period;
  try {
    period = parsePeriod(b.period);
  } catch (err) {
    if (err instanceof PeriodParseError) {
      return { status: 400, body: errorEnvelope(err.code, err.message) };
    }
    throw err;
  }

  const [receipts, ledger, escalations] = await Promise.all([
    deps.dataSource.receiptsForAgentPeriod(agentId, period.fromIso, period.toIso),
    deps.dataSource.ledgerForAgentPeriod(agentId, period.fromIso, period.toIso),
    deps.dataSource.escalationsForAgentPeriod(agentId, period.fromIso, period.toIso),
  ]);

  const assembledAt = new Date(deps.now ? deps.now() : Date.now()).toISOString();
  const report = assembleReconcileReport(agentId, period, receipts, ledger, escalations, { assembledAt });
  const reportHash = hashReconcileReport(report);

  const anchor = await tryAnchor(deps.anchorer, reportHash, agentId, period.periodCode);

  return {
    status: 200,
    body: {
      tool: "reconcile_agent_spend",
      agentId,
      period: report.period,
      reportHash,
      report,
      anchor,
    },
  };
}
