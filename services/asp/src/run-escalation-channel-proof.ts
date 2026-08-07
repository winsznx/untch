import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChallengeBinding, GuardOutcome, PollHandle } from "@untch/x402-guard";
import { formatUnits, getAddress, keccak256, parseUnits, toHex } from "viem";
import { buyerAddress, readSettlementBalance } from "./buyer";
import { createPolicyViaEndpoint } from "./caller-policy";
import { MissingEnvError, NETWORK, SETTLEMENT_TOKEN } from "./config";
import { guardedBuyerCall, makeHttpEscalationResolver, type PreflightCallResult } from "./guard-buyer";

/**
 * §7.2 / §27 ESCALATION — REAL LIVE PROOF PER CHANNEL, THROUGH THE ACTUAL PUBLIC ENDPOINT.
 *
 *   pnpm --filter @untch/asp escalation:proof discord   → one escalation resolved via a real Discord tap
 *   pnpm --filter @untch/asp escalation:proof slack     → one escalation resolved via a real Slack tap
 *   pnpm --filter @untch/asp escalation:proof photon    → one escalation resolved via a real iMessage reply
 *                                                          ("APPROVE <code>") through Photon Spectrum Cloud
 *   pnpm --filter @untch/asp escalation:proof dual       → an above-threshold escalation resolved by TWO
 *                                                          DISTINCT real channels together
 *
 * Nothing runs in-process — the whole escalation lifecycle lives on the deployed seller. The buyer only
 * calls public HTTP: create a policy, pay a real $0.05 preflight that ESCALATES, then poll
 * GET /escalation_status/:pollRef until the operator's real tap(s) flip it. It is confirmed INDEPENDENTLY
 * by reading the escalation record's OWN final state + channel_log + approved_channels off that endpoint —
 * never by trusting this script's success message.
 *
 * The buyer needs only BUYER_PRIVATE_KEY + PAY_TO_ADDRESS. Everything channel-side (the bot tokens, the
 * bound operator ids, Postgres, Redis, the §27 check) is the SELLER's. If the deployed seller has not
 * fanned out to the target channel, this prints a precise PREREQ report and exits non-zero — it never
 * fabricates a PASS. That is the same honest boundary the Telegram e2e held before its token was live.
 */

type Mode = "discord" | "slack" | "photon" | "dual";

/** The channel NAME each single-channel mode fans out to (Photon's operator-facing surface is `imessage`). */
const MODE_CHANNEL: Record<Exclude<Mode, "dual">, string> = {
  discord: "discord",
  slack: "slack",
  photon: "imessage",
};

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://asp.untch.xyz";
const DEMO_AGENT = getAddress("0x000000000000000000000000000000000000A9E7");
const PING_PRICE_ATOMIC = "10000"; // $0.01 USDT0 — the ping challenge the guard binds + holds
const NEEDED_ATOMIC = parseUnits("0.10", SETTLEMENT_TOKEN.decimals); // covers the $0.05 preflight + margin

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

function prereq(mode: Mode, targets: string[], got: string[]): never {
  console.error(`\nRESULT: PREREQ MISSING — the deployed seller did not fan out to [${targets.join(", ")}].`);
  console.error(`It fanned out to: [${got.join(", ") || "none"}].`);
  console.error(
    `\nThis proof needs the ${mode} path configured ON THE SELLER (its own credentials + the bound\n` +
      `operator id: DISCORD_BOT_TOKEN/DISCORD_USER_ID, SLACK_BOT_TOKEN/SLACK_APP_TOKEN/SLACK_USER_ID,\n` +
      `and/or PHOTON_PROJECT_ID/PHOTON_PROJECT_SECRET/PHOTON_OPERATOR_HANDLE), plus a policy whose\n` +
      `approvals.channels authorizes them. The offline test battery (packages/escalation) proves every\n` +
      `channel's §27 authority boundary and the dual-channel rule adversarially; this driver is the ready\n` +
      `live harness for the one real tap. Configure the seller and re-run. It never fabricates a PASS.`,
  );
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const ESCALATE_ABOVE = 5;
const CALL_AMOUNT = 8; // > escalateAbove(5), < perCallCap(500) ⇒ ESCALATED_THRESHOLD (not blocked)

/** For `dual`, which two (or more) DISTINCT channels must confirm. Override with a 2nd CLI arg, e.g.
 *  `escalation:proof dual telegram,slack`. Defaults to the two channels that reliably DM one operator. */
const DUAL_CHANNELS = (process.argv[3]?.trim() || "telegram,slack")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

/** Rules that (a) escalate a modest call before any BLOCK rule and (b) authorize the target channels. */
function escalateRules(mode: Mode): Record<string, unknown> {
  const channels = mode === "dual" ? DUAL_CHANNELS : [MODE_CHANNEL[mode]];
  const channelCaps: Record<string, number> = {};
  for (const c of channels) channelCaps[c] = 100;
  return {
    budgets: { daily: 1000, token: "USDT" },
    perCallCap: 500,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: ESCALATE_ABOVE,
    escalationTimeoutMin: 30,
    approvals: {
      channels,
      // For solo proofs, never require a second channel. For the dual proof, require it below the amount.
      dualChannelAbove: mode === "dual" ? ESCALATE_ABOVE : 1000,
      channelCaps,
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

async function createPolicy(sellerUrl: string, mode: Mode, buyerKey: `0x${string}`): Promise<CreatedPolicy> {
  // Per-caller create (Part 1): the seller builds UNSIGNED calldata, the BUYER's own wallet signs+submits
  // it (buyer becomes the on-chain owner), then the seller syncs. Needs testnet OKB in the buyer wallet.
  console.log(`[esc-${mode}] creating an escalate-friendly policy the BUYER owns (build → buyer signs → sync) …`);
  try {
    const created = await createPolicyViaEndpoint({ sellerUrl, callerKey: buyerKey, agent: DEMO_AGENT, rules: escalateRules(mode) });
    console.log(`[esc-${mode}] policy ${created.policyId} created (owner ${created.owner}, registerTx ${created.registerTx})`);
    return { policyId: created.policyId, policyHash: created.policyHash, tx: created.registerTx };
  } catch (err) {
    fail(3, (err as Error).message);
  }
}

interface StatusView {
  state?: { status?: string; reason?: string };
  record?: {
    id?: string;
    status?: string;
    resolvedBy?: { channel: string; handle: string } | null;
    resolvedAt?: string | null;
    approvedChannels?: string[];
    channelLog?: Array<{ channel: string; kind: string }>;
  } | null;
}

async function fetchStatus(sellerUrl: string, pollRef: string): Promise<StatusView> {
  const res = await fetch(`${sellerUrl}/escalation_status/${encodeURIComponent(pollRef)}`);
  return (await res.json()) as StatusView;
}

function fanoutChannels(view: StatusView): string[] {
  return (view.record?.channelLog ?? []).filter((e) => e.kind === "FANOUT").map((e) => e.channel);
}

async function main(): Promise<void> {
  const mode = (process.argv[2] ?? process.env.CHANNEL_PROOF ?? "").toLowerCase() as Mode;
  if (mode !== "discord" && mode !== "slack" && mode !== "photon" && mode !== "dual") {
    fail(2, `usage: escalation:proof <discord|slack|photon|dual> (got ${JSON.stringify(process.argv[2] ?? "")})`);
  }
  const targets = mode === "dual" ? DUAL_CHANNELS : [MODE_CHANNEL[mode]];

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
  console.log(`[esc-${mode}] buyer/owner : ${owner}`);
  console.log(`[esc-${mode}] seller      : ${sellerUrl} (LIVE public endpoint)`);
  console.log(`[esc-${mode}] proving     : ${mode === "dual" ? "TWO distinct channels resolve one above-threshold escalation" : `a real ${mode} tap resolves an escalation`}`);

  const balance = await readSettlementBalance(owner);
  console.log(`[esc-${mode}] balance     : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} (need >= ${formatUnits(NEEDED_ATOMIC, SETTLEMENT_TOKEN.decimals)})`);
  if (balance < NEEDED_ATOMIC) fail(2, "buyer wallet unfunded for the $0.05 preflight");

  const policy = await createPolicy(sellerUrl, mode, buyerKey);

  const advertisedResource = "http://untch-asp-production.up.railway.app/ping_untch";
  const invokedEndpoint = `${sellerUrl}/ping_untch`;
  const intent: Record<string, unknown> = {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: SETTLEMENT_TOKEN.address,
    maxAmount: parseUnits("100", SETTLEMENT_TOKEN.decimals).toString(),
    taskHash: keccak256(toHex(`untch-esc-${mode}-task:${runSalt}`)),
    acceptanceHash: keccak256(toHex(`untch-esc-${mode}-acceptance:${runSalt}`)),
    schemaHash: keccak256(toHex(`untch-esc-${mode}-schema:${runSalt}`)),
    policyHash: policy.policyHash,
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: advertisedResource,
    paramsHash: keccak256(toHex(`untch-esc-${mode}-params:${runSalt}`)),
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

  let preflight: PreflightCallResult | null = null;
  const outcome: GuardOutcome = await guardedBuyerCall({
    buyerKey,
    sellerUrl,
    resourceUrl: invokedEndpoint,
    method: "GET",
    expectedBinding,
    intent,
    policyId: policy.policyId,
    escalationResolver: makeHttpEscalationResolver(sellerUrl),
    onPreflight: (r) => {
      preflight = r;
      console.log(`[esc-${mode}] preflight   : ${r.decision} (settled tx ${r.settlementTx ?? "none"})`);
    },
  });

  if (outcome.status !== "ESCALATED") {
    const detail = outcome.status === "BLOCKED" ? `${outcome.code}: ${outcome.detail}` : outcome.status;
    fail(3, `expected ESCALATED from the live preflight, got ${outcome.status} (${detail})`);
  }
  const pollHandle: PollHandle = outcome.status === "ESCALATED" ? outcome.pollHandle : fail(3, "unreachable");
  const preflightResult = preflight as PreflightCallResult | null;
  console.log(`[esc-${mode}] ESCALATED   : ${pollHandle.reason} — held, NOT signed (pollRef ${pollHandle.id})`);

  // Confirm the seller created + fanned out to the target channel(s). If not, the seller isn't configured
  // for this channel — an honest PREREQ, not a failure of the code.
  await sleep(1500);
  const initial = await fetchStatus(sellerUrl, pollHandle.id);
  if (!initial.record) fail(3, "the live seller did not create an escalation for this preflight (escalation service not wired?)");
  const fanned = fanoutChannels(initial);
  console.log(`[esc-${mode}] server esc  : ${initial.record.id} status=${initial.record.status} fanned out to [${fanned.join(", ") || "none"}]`);
  const missing = targets.filter((t) => !fanned.includes(t));
  if (missing.length > 0) prereq(mode, missing, fanned);

  const before = await pollHandle.poll();
  console.log(`[esc-${mode}] poll()#0    : ${before.status}`);

  const ask = mode === "dual"
    ? `>>> Approve in TWO of [${targets.join(", ")}] now (two DISTINCT surfaces). Waiting up to ${waitSec}s...`
    : mode === "photon"
      ? `>>> Reply "APPROVE <code>" in iMessage now (the code is in the message). Waiting up to ${waitSec}s...`
      : `>>> Tap Approve in ${mode} now. Waiting up to ${waitSec}s...`;
  console.log(`\n${ask}\n`);

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

  const finalStatus = await fetchStatus(sellerUrl, pollHandle.id);
  const rec = finalStatus.record;
  const approvedChannels = rec?.approvedChannels ?? [];
  console.log(`[esc-${mode}] poll()#${polls}    : ${final.status} after ${elapsedSec}s`);
  console.log(`[esc-${mode}] record      : status=${rec?.status} approvedChannels=[${approvedChannels.join(", ")}] resolvedBy=${JSON.stringify(rec?.resolvedBy ?? null)}`);

  const distinctOk = mode === "dual" ? new Set(approvedChannels).size >= 2 : true;
  const pass = final.status === "APPROVED" && rec?.status === "APPROVED" && distinctOk;

  const proof: Record<string, unknown> = {
    meta: {
      proof: `§7.2 / §27 escalation — LIVE ${mode.toUpperCase()} proof through the public endpoint`,
      mode,
      buyer: owner,
      seller: sellerUrl,
      network: NETWORK,
      capturedAt: new Date().toISOString(),
      note: "The whole escalation lifecycle (create, fan-out, §27 authority boundary, resolve) ran on the deployed seller. The buyer only called public HTTP and polled.",
    },
    policy: { policyId: policy.policyId, policyHash: policy.policyHash, ...(policy.tx ? { registerTx: policy.tx } : {}) },
    intentAmount: CALL_AMOUNT,
    preflightDecision: preflightResult?.decision,
    preflightSettlementTx: preflightResult?.settlementTx,
    pollRef: pollHandle.id,
    fannedOutTo: fanned,
    guardPollBefore: before.status,
    guardPollAfter: final.status,
    recordFinalStatus: rec?.status ?? null,
    approvedChannels,
    resolvedBy: rec?.resolvedBy ?? null,
    channelLog: rec?.channelLog ?? [],
    dualDistinctChannels: mode === "dual" ? new Set(approvedChannels).size : undefined,
    independentlyConfirmed: pass,
  };
  const proofPath = save(`escalation-${mode}-proof.json`, proof);

  if (pass) {
    console.log(`\nRESULT: PASS — real ${mode} escalation approved via the live seller; guard poll() reflects APPROVED through the public endpoint.`);
    if (mode === "dual") console.log(`Two DISTINCT channels confirmed : [${approvedChannels.join(", ")}]`);
    console.log(`Policy                  : ${policy.policyId}${policy.tx ? ` (tx ${policy.tx})` : ""}`);
    console.log(`Preflight settlement tx : ${preflightResult?.settlementTx ?? "none"}`);
    console.log(`pollRef                 : ${pollHandle.id}`);
    console.log(`Record final            : status=${rec?.status} resolvedBy=${JSON.stringify(rec?.resolvedBy)} at=${rec?.resolvedAt}`);
    console.log(`Evidence                : ${proofPath}`);
    process.exit(0);
  }
  if (final.status === "DENIED") {
    console.log(`\nRESULT: (resolved DENIED) — operator denied, or the timeout defaulted to DENY (I2). Correct terminal, not the APPROVED proof. Evidence: ${proofPath}`);
    process.exit(4);
  }
  console.log(`\nRESULT: PENDING after ${elapsedSec}s — no completing tap arrived in the window (dual needs two distinct). Evidence: ${proofPath}`);
  process.exit(5);
}

/**
 * STOPPED: this proof pays for `/ping_untch`, and `ping_untch` is now free.
 *
 * It was the cheapest priced route, so every guard proof used it as the thing to buy. Charging for a
 * health check is what the relisting pass removed, and a driver that keeps pointing at it would get a
 * 200 with no challenge, hand the guard nothing to bind, and print a pass it did not earn — which is
 * worse than not running at all.
 *
 * To restore it, repoint the binding at `PROOF_OF_RAIL_ROUTE` (POST /redact_payment_metadata, $0.02):
 * the method becomes POST and the call needs a `{ metadata }` body. That change is deliberately not
 * made blind, because it moves real money and cannot be verified without a funded wallet.
 *
 * The stop lives beside the entry point rather than inside `main`, so the body below stays ordinary
 * reachable code that the type checker still reads.
 */
console.error(
  "[stopped] this proof buys /ping_untch, which is now free — repoint it at PROOF_OF_RAIL_ROUTE " +
    "(POST /redact_payment_metadata, $0.02) and re-verify with a funded wallet before running",
);
process.exit(2);

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
