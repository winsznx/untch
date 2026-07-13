import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ChannelRegistry,
  EscalationService,
  PgEscalationsRepo,
  TelegramChannel,
  createPool as createEscalationPool,
  createRedis,
  createTimeoutQueue,
  interimTelegramBinding,
  loadStorageConfig,
  loadTelegramConfig,
  makeEscalationResolver,
  makeTimeoutScheduler,
  readApprovalsConfig,
  runMigrations as runEscalationMigrations,
  type FailedControlEvent,
} from "@untch/escalation";
import { PgPolicyRepo, PolicyProvider, createPool as createPolicyPool } from "@untch/policy-store";
import type { ChallengeBinding, GuardOutcome, PollHandle } from "@untch/x402-guard";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import { buyerAddress, readSettlementBalance } from "./buyer";
import { NETWORK, SETTLEMENT_TOKEN } from "./config";
import { loadDemoPolicyRef } from "./demo-policy";
import { guardedBuyerCall, type PreflightCallResult } from "./guard-buyer";

/**
 * §7.2 / §27 ESCALATION SERVICE — REAL END-TO-END PROOF (task 6).
 *
 * One real cycle, no mocks:
 *   1. A real, over-threshold intent runs through a REAL paid `preflight_payment` ($0.05) against the
 *      live seller reading the real stored policy → ESCALATED_THRESHOLD (the engine, not a channel,
 *      escalated). The guard returns a non-blocking poll handle; the money is held, never signed.
 *   2. The REAL EscalationService (real shared Postgres, real BullMQ timeout on the shared Redis) creates
 *      the escalation and fans it out over a REAL Telegram bot — an inline APPROVE/DENY message carrying
 *      the single-use code lands in the bound operator chat.
 *   3. The operator taps APPROVE in Telegram. The callback is run through the FULL §27 authority-boundary
 *      check (intent active, bound sender, valid unexpired unredeemed code, caps, dual-channel) before it
 *      counts.
 *   4. The guard's poll() — wired to this real service — now reflects APPROVED for real. Not a stub.
 *
 * PASS = the guard's poll() transitions PENDING → APPROVED off a real operator Telegram tap that passed
 * the authority boundary. The $0.05 preflight settlement is verifiable on X Layer; ESCALATE never signs
 * the held call, so no second settlement is expected (that is the whole point — the model never touched
 * the money; the operator authorized it out-of-band).
 *
 * Requires (all real, none faked): BUYER_PRIVATE_KEY, PAY_TO_ADDRESS, DEMO_POLICY_ID/HASH, DATABASE_URL,
 * REDIS_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID. Missing any ⇒ a precise PREREQ report + non-zero exit
 * (never a fabricated PASS). TELEGRAM_* is the D0.7 gate; until it runs, this is the ready harness.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://untch-asp-production.up.railway.app";
const PING_PRICE_ATOMIC = "10000"; // $0.01 USDT0 — the live ping price the guard binds/holds
const NEEDED_ATOMIC = parseUnits("0.10", SETTLEMENT_TOKEN.decimals); // covers the $0.05 preflight + margin

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return path;
}

function prereqReport(missing: string[]): never {
  console.error("\nRESULT: PREREQ MISSING — the live escalation e2e needs real secrets it does not have.");
  console.error("Missing / invalid:");
  for (const m of missing) console.error(`  • ${m}`);
  console.error(
    "\nThis is NOT a failure of the service — the offline test battery (packages/escalation) proves the\n" +
      "state machine and the §27 authority-boundary check adversarially. This driver is the ready harness\n" +
      "for the one live-tap proof; it needs the operator's Telegram bot (the D0.7 gate) plus the shared\n" +
      "Postgres/Redis URLs. Provide them and re-run: pnpm --filter @untch/asp escalation:e2e.",
  );
  process.exit(2);
}

function fail(code: number, message: string): never {
  console.error(`\nRESULT: FAIL — ${message}`);
  process.exit(code);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  // ── Gather + validate every real secret up front; refuse to fake anything ──────────────────────
  const missing: string[] = [];
  const buyerKeyRaw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!buyerKeyRaw || !/^0x[0-9a-fA-F]{64}$/.test(buyerKeyRaw)) missing.push("BUYER_PRIVATE_KEY (run gen-buyer-wallet)");
  const payToRaw = process.env.PAY_TO_ADDRESS?.trim();
  if (!payToRaw || !/^0x[0-9a-fA-F]{40}$/.test(payToRaw)) missing.push("PAY_TO_ADDRESS (the seller payout wallet)");
  if (!process.env.DATABASE_URL?.trim()) missing.push("DATABASE_URL (shared Railway Postgres)");
  if (!process.env.REDIS_URL?.trim()) missing.push("REDIS_URL (shared Railway Redis)");
  if (!process.env.TELEGRAM_BOT_TOKEN?.trim()) missing.push("TELEGRAM_BOT_TOKEN (D0.7 — @BotFather)");
  if (!process.env.TELEGRAM_CHAT_ID?.trim()) missing.push("TELEGRAM_CHAT_ID (the bound operator chat)");
  if (!process.env.DEMO_POLICY_ID?.trim()) missing.push("DEMO_POLICY_ID (a real stored policy)");
  if (!process.env.DEMO_POLICY_HASH?.trim()) missing.push("DEMO_POLICY_HASH");
  if (missing.length > 0) prereqReport(missing);

  const buyerKey = buyerKeyRaw as `0x${string}`;
  const payTo = payToRaw as `0x${string}`;
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  const waitSec = Number(process.env.ESCALATION_WAIT_SEC ?? 300);
  const demoPolicy = loadDemoPolicyRef();
  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());

  // ── Stand up the REAL escalation service (shared Postgres + shared Redis + real Telegram) ──────
  const storage = loadStorageConfig();
  const telegramCfg = loadTelegramConfig();
  const escPool = createEscalationPool(storage.databaseUrl);
  await runEscalationMigrations(escPool);

  const registry = new ChannelRegistry();
  registry.register(new TelegramChannel({ config: telegramCfg }));

  const redis = createRedis(storage.redisUrl);
  const timeoutQueue = createTimeoutQueue(redis);

  const failedEvents: FailedControlEvent[] = [];
  const service = new EscalationService({
    repo: new PgEscalationsRepo(escPool),
    registry,
    binding: interimTelegramBinding(telegramCfg.chatId),
    scheduleTimeout: makeTimeoutScheduler(timeoutQueue),
    defaultTimeoutMin: storage.defaultTimeoutMin,
    maxTimeoutMin: storage.maxTimeoutMin,
    onFailedControlEvent: (e) => {
      failedEvents.push(e);
      console.warn(`[esc-e2e] FAILED CONTROL EVENT ${e.outcome} — ${e.channel}/${e.senderHandle}: ${e.detail}`);
    },
  });

  // The Telegram receiver: every inbound operator response → the §27 authority boundary. Thin by design.
  const receiver = await registry.get("telegram")!.startReceiving(async (r) => {
    const res = await service.handleInbound(r);
    console.log(`[esc-e2e] inbound ${res.outcome} — escalation=${res.escalationId ?? "?"} status=${res.status ?? "-"}`);
  });

  const cleanup = async (): Promise<void> => {
    await receiver.stop().catch(() => {});
    await timeoutQueue.close().catch(() => {});
    await redis.quit().catch(() => {});
    await escPool.end().catch(() => {});
  };

  try {
    // ── Read the real stored policy → pick an amount that genuinely exceeds escalateAbove ─────────
    const policyPool = createPolicyPool(storage.databaseUrl);
    const stored = await new PolicyProvider(new PgPolicyRepo(policyPool)).loadStored(demoPolicy.policyId);
    await policyPool.end();
    if (!stored) fail(3, `stored policy ${demoPolicy.policyId} not found in Postgres`);

    const escalateAbove = stored.rules.escalateAbove;
    const escalatingAmount = Math.round((escalateAbove + 3) * 100) / 100; // strictly above the threshold
    const category = stored.rules.categories.allow[0] ?? "market-data";
    const token = stored.rules.budgets.token;
    const approvals = readApprovalsConfig(stored);

    console.log(`[esc-e2e] buyer/owner : ${owner}`);
    console.log(`[esc-e2e] seller      : ${sellerUrl}`);
    console.log(`[esc-e2e] policy      : ${demoPolicy.policyId} (escalateAbove ${escalateAbove} ${token})`);
    console.log(`[esc-e2e] intent      : ${escalatingAmount} ${token} in '${category}' → should ESCALATE`);
    console.log(`[esc-e2e] telegram    : bot ✓, bound chat ${telegramCfg.chatId}`);

    const balance = await readSettlementBalance(owner);
    console.log(`[esc-e2e] balance     : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} (need >= ${formatUnits(NEEDED_ATOMIC, SETTLEMENT_TOKEN.decimals)} for the $0.05 preflight)`);
    if (balance < NEEDED_ATOMIC) fail(2, "buyer wallet unfunded for the $0.05 preflight");

    // The intent the agent wants approved — over-threshold. maxAmount covers it; the CBC still binds the
    // real ping challenge ($0.01), which ESCALATE will hold (never sign).
    const maxAmountAtomic = parseUnits(String(escalatingAmount), SETTLEMENT_TOKEN.decimals).toString();
    const advertisedResource = "http://untch-asp-production.up.railway.app/ping_untch";
    const invokedEndpoint = `${sellerUrl}/ping_untch`;
    const intent: Record<string, unknown> = {
      owner,
      buyerAgentId: "1",
      workerAgentId: "0",
      token: SETTLEMENT_TOKEN.address,
      maxAmount: maxAmountAtomic,
      taskHash: keccak256(toHex(`untch-escalation-e2e-task:${runSalt}`)),
      acceptanceHash: keccak256(toHex(`untch-escalation-e2e-acceptance:${category}.v1`)),
      schemaHash: keccak256(toHex(`untch-escalation-e2e-schema:${category}.v1`)),
      policyHash: demoPolicy.policyHash,
      deadline: "9999999999",
      nonce: runSalt,
      endpoint: advertisedResource,
      paramsHash: keccak256(toHex(`untch-escalation-e2e-params:${runSalt}`)),
      recipientAddress: payTo,
      category,
      amount: escalatingAmount,
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

    // ── Guarded call with the guard's poll() wired to the REAL escalation service ─────────────────
    let preflight: PreflightCallResult | null = null;
    const outcome: GuardOutcome = await guardedBuyerCall({
      buyerKey,
      sellerUrl,
      resourceUrl: invokedEndpoint,
      method: "GET",
      expectedBinding,
      intent,
      policyId: demoPolicy.policyId,
      escalationResolver: makeEscalationResolver(service),
      onPreflight: (r) => {
        preflight = r;
        console.log(`[esc-e2e] preflight   : decision ${r.decision} (settled tx ${r.settlementTx ?? "none"})`);
      },
    });

    if (outcome.status !== "ESCALATED") {
      const detail = outcome.status === "BLOCKED" ? `${outcome.code}: ${outcome.detail}` : outcome.status;
      fail(3, `expected ESCALATED from preflight, got ${outcome.status} (${detail}) — check escalateAbove vs amount`);
    }
    const pollHandle: PollHandle = outcome.status === "ESCALATED" ? outcome.pollHandle : fail(3, "unreachable");
    const preflightResult = preflight as PreflightCallResult | null;
    console.log(`[esc-e2e] ESCALATED   : ${pollHandle.reason} — held, pollable, NOT signed (pollRef ${pollHandle.id})`);

    // ── Create the escalation for exactly this poll ref, fan out to real Telegram ─────────────────
    const intentId = (outcome.decision.intentHash as string | undefined) ?? pollHandle.id;
    const created = await service.createEscalation({
      pollRef: pollHandle.id,
      intentId,
      reason: pollHandle.reason,
      policyId: demoPolicy.policyId,
      amount: escalatingAmount,
      token,
      approvals,
    });
    const fanoutOk = created.record.channelLog.some((e) => e.kind === "FANOUT");
    console.log(`[esc-e2e] escalation  : ${created.record.id} status=${created.record.status} (telegram fanout ${fanoutOk ? "sent ✓" : "FAILED"})`);
    if (!fanoutOk) fail(3, "Telegram fan-out failed — no message delivered to the operator");

    // The guard poll() should be PENDING right now (before the tap).
    const before = await pollHandle.poll();
    console.log(`[esc-e2e] poll()#0    : ${before.status} (awaiting the operator's Telegram tap)`);

    console.log(`\n>>> Tap APPROVE in Telegram now. Waiting up to ${waitSec}s for the operator response...\n`);

    // ── Poll the guard handle until the operator's tap flips it (or timeout defaults it to DENY) ──
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
    console.log(`[esc-e2e] poll()#${polls}    : ${final.status} after ${elapsedSec}s`);

    const record = await service.getByPollRef(pollHandle.id);
    const proof: Record<string, unknown> = {
      meta: {
        proof: "§7.2 / §27 escalation service — real preflight→Telegram→resolve→guard poll() e2e",
        buyer: owner,
        seller: sellerUrl,
        network: NETWORK,
        policyId: demoPolicy.policyId,
        escalateAbove,
        escalatingAmount,
        token,
        capturedAt: new Date().toISOString(),
      },
      preflightDecision: preflightResult?.decision,
      preflightSettlementTx: preflightResult?.settlementTx,
      pollRef: pollHandle.id,
      escalationId: created.record.id,
      telegramFanout: fanoutOk,
      guardPollBefore: before.status,
      guardPollAfter: final.status,
      resolvedBy: record?.resolvedBy ?? null,
      channelLog: record?.channelLog ?? [],
      failedControlEvents: failedEvents,
    };
    const proofPath = save("escalation-e2e-proof.json", proof);

    if (final.status === "APPROVED") {
      console.log("\nRESULT: PASS — real escalation approved via real Telegram, guard poll() reflects APPROVED for real.");
      console.log(`Preflight settlement tx : ${preflightResult?.settlementTx ?? "none"}`);
      console.log(`Escalation              : ${created.record.id}`);
      console.log(`Resolved by             : ${JSON.stringify(record?.resolvedBy ?? null)}`);
      console.log(`Guard poll()            : ${before.status} → ${final.status}`);
      console.log(`Evidence                : ${proofPath}`);
      await cleanup();
      process.exit(0);
    }

    if (final.status === "DENIED") {
      console.log("\nRESULT: (resolved DENIED) — the operator denied, or the timeout defaulted to DENY (I2).");
      console.log(`This is a correct terminal outcome, but not the APPROVED proof. Evidence: ${proofPath}`);
      await cleanup();
      process.exit(4);
    }

    console.log(`\nRESULT: PENDING after ${elapsedSec}s — no operator tap arrived within the window.`);
    console.log(`The escalation is live and will default to DENY at its timeout. Evidence: ${proofPath}`);
    await cleanup();
    process.exit(5);
  } catch (err) {
    await cleanup();
    fail(1, `unexpected error: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
