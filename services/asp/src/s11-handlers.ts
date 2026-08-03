/**
 * Remaining §11 tools: detect_duplicate, redact_payment_metadata, get_ledger (thin),
 * log_receipt (status façade). Pure-ish handlers — no LLM.
 */

import { hashCanonicalJson } from "@untch/canon";
import type { HandlerResult } from "./handlers";
import type { InMemoryLedger } from "./ledger-state";
import type { ReceiptWiring } from "./receipts";

function errorEnvelope(code: string, message: string, retryable = false): HandlerResult["body"] {
  return { code, message, retryable, docsUrl: null };
}

const STRIP_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: "phone", re: /\+?\d[\d\s().-]{7,}\d/g },
  { name: "apiKey", re: /\b(sk|pk|api)[_-][a-zA-Z0-9]{16,}\b/gi },
  { name: "bearer", re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi },
];

function walkRedact(value: unknown): unknown {
  if (typeof value === "string") {
    let s = value;
    for (const { re } of STRIP_PATTERNS) s = s.replace(re, "[REDACTED]");
    return s;
  }
  if (Array.isArray(value)) return value.map(walkRedact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkRedact(v);
    }
    return out;
  }
  return value;
}

/** POST /detect_duplicate — check ledger window for a matching task/endpoint/params tuple. */
export function handleDetectDuplicate(
  body: unknown,
  ledger: InMemoryLedger,
  ttlMin = 60,
): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const policyId = typeof b.policyId === "string" ? b.policyId.trim() : null;
  const taskHash = typeof b.taskHash === "string" ? b.taskHash : null;
  const endpoint = typeof b.endpoint === "string" ? b.endpoint : null;
  const paramsHash = typeof b.paramsHash === "string" ? b.paramsHash : null;
  if (!policyId || !taskHash || !endpoint || !paramsHash) {
    return {
      status: 400,
      body: errorEnvelope(
        "FIELDS_REQUIRED",
        "policyId, taskHash, endpoint, paramsHash are required",
      ),
    };
  }
  const partitionKey = `policy:${policyId}`;
  const state = ledger.read(partitionKey);
  const nowMs = Date.now();
  const ttlMs = ttlMin * 60_000;
  for (const prior of state.recentIntents) {
    const ageMs = nowMs - prior.createdAtMs;
    if (ageMs < 0 || ageMs >= ttlMs) continue;
    if (
      prior.taskHash.toLowerCase() === taskHash.toLowerCase() &&
      prior.endpoint === endpoint &&
      prior.paramsHash.toLowerCase() === paramsHash.toLowerCase()
    ) {
      return {
        status: 200,
        body: {
          duplicate: true,
          priorIntentId: prior.intentId,
          ttlRemainingSec: Math.max(0, Math.ceil((prior.createdAtMs + ttlMs - nowMs) / 1000)),
        },
      };
    }
  }
  return { status: 200, body: { duplicate: false, priorIntentId: null, ttlRemainingSec: null } };
}

/** POST /redact_payment_metadata — strip PII patterns, return redacted + hash. */
export function handleRedactPaymentMetadata(body: unknown): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const metadata = b.metadata;
  if (!metadata || typeof metadata !== "object") {
    return { status: 400, body: errorEnvelope("METADATA_REQUIRED", "provide `metadata` object") };
  }
  const redacted = walkRedact(metadata);
  const metadataHash = hashCanonicalJson(redacted);
  return {
    status: 200,
    body: {
      redacted,
      metadataHash,
      note: "Deterministic strip of email/phone/apiKey/bearer. No durable storage of raw metadata.",
    },
  };
}

/** GET /get_ledger — thin slice: recent intents for a policy partition from the in-memory ledger. */
export function handleGetLedger(body: unknown, ledger: InMemoryLedger): HandlerResult {
  const b = (body ?? {}) as Record<string, unknown>;
  const policyId = typeof b.policyId === "string" ? b.policyId.trim() : null;
  if (!policyId) {
    return { status: 400, body: errorEnvelope("POLICY_ID_REQUIRED", "policyId required") };
  }
  const state = ledger.read(`policy:${policyId}`);
  return {
    status: 200,
    body: {
      policyId,
      // Authority reserved, not money spent. The route is decision-only.
      reservedAuthorityToday: state.budgetUsage.reservedActiveToday,
      settledSpendToday: state.budgetUsage.settledToday,
      effectiveBudgetUsageToday: state.budgetUsage.effectiveToday,
      callsInLastHour: state.callsInLastHour,
      recentIntents: state.recentIntents.slice(0, 50),
      note: "Ephemeral process-local ledger window. Durable get_ledger over Postgres receipts is the full §11 path when DATABASE_URL + receipt-writer are wired.",
    },
  };
}

/** POST /log_receipt — status façade for an existing receiptId (no double-write). */
export async function handleLogReceipt(
  body: unknown,
  receiptWiring: ReceiptWiring | null,
): Promise<HandlerResult> {
  const b = (body ?? {}) as Record<string, unknown>;
  const receiptId = typeof b.receiptId === "string" ? b.receiptId : null;
  if (!receiptId) {
    return {
      status: 400,
      body: errorEnvelope("RECEIPT_ID_REQUIRED", "provide receiptId from a prior preflight/verify"),
    };
  }
  if (!receiptWiring) {
    return {
      status: 503,
      body: errorEnvelope("RECEIPT_WRITER_UNWIRED", "receipt status store not configured", true),
    };
  }
  try {
    const status = await receiptWiring.status(receiptId);
    if (status === "invalid") {
      return { status: 400, body: errorEnvelope("RECEIPT_ID_INVALID", "receiptId is not a valid hex id") };
    }
    if (status === null) {
      return { status: 404, body: errorEnvelope("RECEIPT_NOT_FOUND", "no receipt with that id") };
    }
    return { status: 200, body: { receiptId, status } };
  } catch (err) {
    return {
      status: 404,
      body: errorEnvelope(
        "RECEIPT_NOT_FOUND",
        err instanceof Error ? err.message : "receipt not found",
      ),
    };
  }
}
