import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChallengeBinding, GuardOutcome, PollHandle } from "@untch/x402-guard";
import { formatUnits, getAddress, keccak256, parseUnits, toHex } from "viem";
import { buyerAddress, readSettlementBalance } from "./buyer";
import { MissingEnvError, NETWORK, SETTLEMENT_TOKEN } from "./config";
import { guardedBuyerCall, makeHttpEscalationResolver, type PreflightCallResult } from "./guard-buyer";

/**
 * §7.2 / §27 ESCALATION SERVICE — REAL LIVE PROOF THROUGH THE ACTUAL PUBLIC ENDPOINT (task 6, D0.7).
 *
 * This drives NOTHING in-process — the whole escalation lifecycle lives on the deployed seller:
 *   1. Create an escalate-friendly policy via the live `POST /create_spend_policy` (real on-chain
 *      register + durable store), so a modest call genuinely trips escalateAbove.
 *   2. A real paid `POST /preflight_payment` ($0.05) with an over-threshold intent → the SELLER's engine
 *      returns ESCALATED_THRESHOLD AND the SELLER's gateway creates the escalation + fans it out over its
 *      OWN Telegram bot. The guard returns a poll handle; the held call is never signed.
 *   3. The operator taps APPROVE in Telegram. The SELLER's receiver runs it through the FULL §27
 *      authority-boundary check.
 *   4. The guard's poll() — wired to the live `GET /escalation_status/:pollRef` — flips PENDING → APPROVED.
 *      Confirmed independently against the escalation record's own final state served by that endpoint.
 *
 * PASS = the guard's poll() reflects APPROVED for real, off a real Telegram tap, resolved by the live
 * public endpoint (not a local service). Writes D0.7 evidence to escalation-e2e-proof.json.
 *
 * The buyer needs only BUYER_PRIVATE_KEY + PAY_TO_ADDRESS (funds for the $0.05 preflight). Everything
 * escalation-related — Postgres, Redis, Telegram, the §27 check — is the seller's, reached over HTTP.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://untch-asp-production.up.railway.app";
const DEMO_AGENT = getAddress("0x000000000000000000000000000000000000A9E7");
const PING_PRICE_ATOMIC = "10000"; // $0.01 USDT0 — the ping challenge the guard binds + holds
const NEEDED_ATOMIC = parseUnits("0.10", SETTLEMENT_TOKEN.decimals); // covers the $0.05 preflight + margin
const ESCALATE_ABOVE = 5;
const CALL_AMOUNT = 8; // > escalateAbove(5), < perCallCap(500) ⇒ ESCALATED_THRESHOLD (not blocked)

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return path;
}

function fail(code: number, message: string): never {
  console.error(`\nRESULT: FAIL — ${message}`);
  process.exit(code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** An escalate-friendly ruleset: a modest call trips escalateAbove BEFORE any BLOCK rule, and the
 *  approvals block authorizes Telegram so the server-side gateway fans out there. */
function escalateRules(): Record<string, unknown> {
  return {
    budgets: { daily: 1000, token: "USDT" },
    perCallCap: 500,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: ESCALATE_ABOVE,
    escalationTimeoutMin: 30,
    approvals: {
      channels: ["telegram"],
      dualChannelAbove: 1000,
      channelCaps: { telegram: 100 },
      codeTTL: "escalationTimeout",
    },
    categories: { allow: ["market-data"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
  };
}

interface CreatedPolicy {
  policyId: string;
  policyHash: `0x${string}`;
  tx?: string;
}

async function createEscalatePolicy(sellerUrl: string): Promise<CreatedPolicy> {
  const reuseId = process.env.ESCALATION_POLICY_ID?.trim();
  const reuseHash = process.env.ESCALATION_POLICY_HASH?.trim();
  if (reuseId && reuseHash) {
    console.log(`[esc-live] reusing policy ${reuseId} (ESCALATION_POLICY_ID/HASH set)`);
    return { policyId: reuseId, policyHash: reuseHash.toLowerCase() as `0x${string}` };
  }
  console.log("[esc-live] creating an escalate-friendly policy via live POST /create_spend_policy …");
  const res = await fetch(`${sellerUrl}/create_spend_policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent: DEMO_AGENT, rules: escalateRules() }),
  });
  const body = (await res.json()) as { policyId?: string; policyHash?: string; tx?: string; code?: string; message?: string };
  if (!res.ok || !body.policyId || !body.policyHash) {
    fail(3, `create_spend_policy failed (${res.status}): ${body.code ?? ""} ${body.message ?? JSON.stringify(body)}`);
  }
  console.log(`[esc-live] policy ${body.policyId} created (tx ${body.tx ?? "?"}, hash ${body.policyHash})`);
  return { policyId: body.policyId!, policyHash: body.policyHash!.toLowerCase() as `0x${string}`, ...(body.tx ? { tx: body.tx } : {}) };
}

async function fetchStatus(sellerUrl: string, pollRef: string): Promise<Record<string, unknown>> {
  const res = await fetch(`${sellerUrl}/escalation_status/${encodeURIComponent(pollRef)}`);
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  const buyerKeyRaw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!buyerKeyRaw || !/^0x[0-9a-fA-F]{64}$/.test(buyerKeyRaw)) fail(2, new MissingEnvError("BUYER_PRIVATE_KEY").message);
  const buyerKey = buyerKeyRaw as `0x${string}`;
  const payToRaw = process.env.PAY_TO_ADDRESS?.trim();
  if (!payToRaw || !/^0x[0-9a-fA-F]{40}$/.test(payToRaw)) fail(2, "PAY_TO_ADDRESS not set/invalid");
  const payTo = payToRaw as `0x${string}`;
  const waitSec = Number(process.env.ESCALATION_WAIT_SEC ?? 300);

  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());
  console.log(`[esc-live] buyer/owner : ${owner}`);
  console.log(`[esc-live] seller      : ${sellerUrl} (LIVE public endpoint)`);

  const balance = await readSettlementBalance(owner);
  console.log(`[esc-live] balance     : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} (need >= ${formatUnits(NEEDED_ATOMIC, SETTLEMENT_TOKEN.decimals)} for the $0.05 preflight)`);
  if (balance < NEEDED_ATOMIC) fail(2, "buyer wallet unfunded for the $0.05 preflight");

  const policy = await createEscalatePolicy(sellerUrl);

  const advertisedResource = "http://untch-asp-production.up.railway.app/ping_untch";
  const invokedEndpoint = `${sellerUrl}/ping_untch`;
  const intent: Record<string, unknown> = {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: SETTLEMENT_TOKEN.address,
    maxAmount: parseUnits("100", SETTLEMENT_TOKEN.decimals).toString(), // ceiling ≫ the declared call
    taskHash: keccak256(toHex(`untch-escalation-live-task:${runSalt}`)),
    acceptanceHash: keccak256(toHex(`untch-escalation-live-acceptance:${runSalt}`)),
    schemaHash: keccak256(toHex(`untch-escalation-live-schema:${runSalt}`)),
    policyHash: policy.policyHash,
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: advertisedResource,
    paramsHash: keccak256(toHex(`untch-escalation-live-params:${runSalt}`)),
    recipientAddress: payTo,
    category: "market-data",
    amount: CALL_AMOUNT,
  };
  const expectedBinding: ChallengeBinding = {
    recipient: payTo,
    token: SETTLEMENT_TOKEN.address,
    amount: PING_PRICE_ATOMIC,
    resourceUrl: advertisedResource,
    endpoint: invokedEndpoint,
    method: "GET",
    nonce: "",
    expiry: "",
  };
  console.log(`[esc-live] intent      : ${CALL_AMOUNT} USDT in 'market-data' (escalateAbove ${ESCALATE_ABOVE}) → should ESCALATE`);

  let preflight: PreflightCallResult | null = null;
  const outcome: GuardOutcome = await guardedBuyerCall({
    buyerKey,
    sellerUrl,
    resourceUrl: invokedEndpoint,
    method: "GET",
    expectedBinding,
    intent,
    policyId: policy.policyId,
    escalationResolver: makeHttpEscalationResolver(sellerUrl), // poll() resolves via the LIVE endpoint
    onPreflight: (r) => {
      preflight = r;
      console.log(`[esc-live] preflight   : ${r.decision} (settled tx ${r.settlementTx ?? "none"})`);
    },
  });

  if (outcome.status !== "ESCALATED") {
    const detail = outcome.status === "BLOCKED" ? `${outcome.code}: ${outcome.detail}` : outcome.status;
    fail(3, `expected ESCALATED from the live preflight, got ${outcome.status} (${detail})`);
  }
  const pollHandle: PollHandle = outcome.status === "ESCALATED" ? outcome.pollHandle : fail(3, "unreachable");
  const preflightResult = preflight as PreflightCallResult | null;
  console.log(`[esc-live] ESCALATED   : ${pollHandle.reason} — held, NOT signed (pollRef ${pollHandle.id})`);

  // The seller created the escalation server-side. Confirm the record exists + fanned out to Telegram.
  await sleep(1500);
  const initialStatus = await fetchStatus(sellerUrl, pollHandle.id);
  const initialRecord = initialStatus.record as Record<string, unknown> | null;
  console.log(`[esc-live] server esc  : ${initialRecord ? `${initialRecord.id} status=${initialRecord.status}` : "NOT FOUND — gateway did not create it"}`);
  if (!initialRecord) fail(3, "the live seller did not create an escalation for this preflight (gateway not deployed / Telegram unset?)");

  const before = await pollHandle.poll();
  console.log(`[esc-live] poll()#0    : ${before.status} (awaiting the operator's Telegram tap)`);

  console.log(`\n>>> Tap APPROVE in Telegram now. Waiting up to ${waitSec}s...\n`);

  const startMs = Date.now();
  let final = before;
  let polls = 0;
  while (Date.now() - startMs < waitSec * 1000) {
    await sleep(3000);
    final = await pollHandle.poll();
    polls++;
    if (final.status !== "PENDING") break;
  }
  const elapsedSec = Math.round((Date.now() - startMs) / 1000);

  // Independent confirmation: read the escalation record's OWN final state from the live endpoint.
  const finalStatus = await fetchStatus(sellerUrl, pollHandle.id);
  const finalRecord = finalStatus.record as Record<string, unknown> | null;
  console.log(`[esc-live] poll()#${polls}    : ${final.status} after ${elapsedSec}s`);
  console.log(`[esc-live] record      : status=${finalRecord?.status} resolvedBy=${JSON.stringify(finalRecord?.resolvedBy ?? null)}`);

  const proof: Record<string, unknown> = {
    meta: {
      proof: "§7.2 / §27 escalation service — LIVE e2e THROUGH THE PUBLIC ENDPOINT (also D0.7 evidence)",
      buyer: owner,
      seller: sellerUrl,
      network: NETWORK,
      capturedAt: new Date().toISOString(),
      note: "The entire escalation lifecycle (create, Telegram fan-out, §27 authority boundary, resolve) ran on the deployed seller. The buyer only called public HTTP endpoints and polled.",
    },
    policy: { policyId: policy.policyId, policyHash: policy.policyHash, ...(policy.tx ? { registerTx: policy.tx } : {}), escalateAbove: ESCALATE_ABOVE },
    intentAmount: CALL_AMOUNT,
    preflightDecision: preflightResult?.decision,
    preflightSettlementTx: preflightResult?.settlementTx,
    pollRef: pollHandle.id,
    escalationRecordInitial: initialRecord,
    guardPollBefore: before.status,
    guardPollAfter: final.status,
    escalationRecordFinal: finalRecord,
    independentlyConfirmed:
      final.status === "APPROVED" &&
      (finalRecord?.status === "APPROVED") &&
      !!(finalRecord?.resolvedBy),
  };
  const proofPath = save("escalation-e2e-proof.json", proof);

  if (final.status === "APPROVED" && finalRecord?.status === "APPROVED") {
    console.log("\nRESULT: PASS — real escalation approved via the live seller's Telegram, guard poll() reflects APPROVED through the public endpoint.");
    console.log(`Policy (live create)    : ${policy.policyId}${policy.tx ? ` (tx ${policy.tx})` : ""}`);
    console.log(`Preflight settlement tx : ${preflightResult?.settlementTx ?? "none"}`);
    console.log(`pollRef                 : ${pollHandle.id}`);
    console.log(`Guard poll()            : ${before.status} → ${final.status}`);
    console.log(`Record final            : status=${finalRecord.status} resolvedBy=${JSON.stringify(finalRecord.resolvedBy)} at=${finalRecord.resolvedAt}`);
    console.log(`D0.7 evidence           : ${proofPath}`);
    process.exit(0);
  }
  if (final.status === "DENIED") {
    console.log(`\nRESULT: (resolved DENIED) — operator denied, or the timeout defaulted to DENY (I2). Correct terminal, not the APPROVED proof. Evidence: ${proofPath}`);
    process.exit(4);
  }
  console.log(`\nRESULT: PENDING after ${elapsedSec}s — no operator tap arrived in the window. The escalation is live and will default to DENY at timeout. Evidence: ${proofPath}`);
  process.exit(5);
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
