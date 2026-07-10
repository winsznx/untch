import {
  ChannelRegistry,
  EscalationService,
  PgEscalationsRepo,
  TelegramChannel,
  createPool,
  createRedis,
  createTimeoutQueue,
  createTimeoutWorker,
  interimTelegramBinding,
  loadStorageConfig,
  loadTelegramConfig,
  makeTimeoutScheduler,
  readApprovalsConfig,
  runMigrations,
  type EscalationRecord,
  type FailedControlEvent,
} from "@untch/escalation";
import type { EscalationState } from "@untch/x402-guard";
import type { EscalationGateway } from "./handlers";

/**
 * §7.2 / §27 escalation wiring for the seller — the SERVER-SIDE half of the control plane.
 *
 * When all of DATABASE_URL + REDIS_URL + TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are present (the Railway
 * deploy), the seller:
 *   • creates the escalation record on every ESCALATED_* preflight decision (the `gateway`),
 *   • fans it out over the real Telegram bot,
 *   • long-polls the bot and runs each inbound operator response through the §27 authority boundary,
 *   • fires §7.2 timeouts (BullMQ on the shared Redis) → EXPIRED → default DENY,
 *   • and serves the resolved state at GET /escalation_status/:pollRef.
 *
 * So the guard's poll() resolves against a REAL server-side escalation — no operator-side driver needed.
 * When the config is absent (local dev / tests), this stays null and the gateway is simply not wired —
 * an honest capability boundary, never a fabricated approval.
 *
 * Uses the SAME shared Postgres + Redis as the receipt writer and policy store (no new instance).
 */

export interface EscalationStatusView {
  readonly state: EscalationState;
  readonly record: {
    readonly id: string;
    readonly status: EscalationRecord["status"];
    readonly reason: string;
    readonly resolvedBy: EscalationRecord["resolvedBy"];
    readonly resolvedAt: string | null;
  } | null;
}

export interface EscalationWiring {
  readonly gateway: EscalationGateway;
  status(pollRef: string): Promise<EscalationStatusView>;
  close(): Promise<void>;
}

export async function initEscalationWiring(): Promise<EscalationWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  const hasTelegram =
    !!process.env.TELEGRAM_BOT_TOKEN?.trim() && !!process.env.TELEGRAM_CHAT_ID?.trim();
  if (!databaseUrl || !redisUrl || !hasTelegram) {
    console.log(
      "[asp] escalation service NOT wired (needs DATABASE_URL + REDIS_URL + TELEGRAM_BOT_TOKEN + " +
        "TELEGRAM_CHAT_ID) — ESCALATED decisions will not create a server-side escalation.",
    );
    return null;
  }

  const storage = loadStorageConfig();
  const telegram = loadTelegramConfig();

  const pool = createPool(storage.databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`[asp] escalation migrations applied: ${applied.join(", ")}`);

  const registry = new ChannelRegistry();
  registry.register(new TelegramChannel({ config: telegram }));

  // Separate connections for the Queue vs the Worker: a BullMQ Worker holds a blocking command on its
  // connection, so sharing one with the Queue would stall the scheduler's add(). (The receipt writer
  // keeps them apart by running the worker in a different process; here both live in the seller.)
  const queueRedis = createRedis(storage.redisUrl);
  const workerRedis = createRedis(storage.redisUrl);
  const timeoutQueue = createTimeoutQueue(queueRedis);
  const repo = new PgEscalationsRepo(pool);

  const service = new EscalationService({
    repo,
    registry,
    binding: interimTelegramBinding(telegram.chatId),
    scheduleTimeout: makeTimeoutScheduler(timeoutQueue),
    defaultTimeoutMin: storage.defaultTimeoutMin,
    maxTimeoutMin: storage.maxTimeoutMin,
    onFailedControlEvent: (e: FailedControlEvent) =>
      console.warn(
        `[asp] FAILED CONTROL EVENT ${e.outcome} — escalation=${e.escalationId ?? "?"} ` +
          `${e.channel}/${e.senderHandle}: ${e.detail}`,
      ),
  });

  // Fire §7.2 timeouts in-process on the shared Redis (+ the derived-expiry fail-safe in getState).
  const timeoutWorker = createTimeoutWorker(workerRedis, async (job) => {
    const expired = await service.expire(job.data.escalationId);
    if (expired) console.log(`[asp] escalation ${job.data.escalationId} timed out → EXPIRED (default DENY)`);
  });

  // Long-poll Telegram; every inbound runs through the §27 authority boundary in the service.
  const receiver = await registry.get("telegram")!.startReceiving(async (r) => {
    const res = await service.handleInbound(r);
    console.log(`[asp] escalation inbound ${res.outcome} — escalation=${res.escalationId ?? "?"} status=${res.status ?? "-"}`);
  });

  console.log(`[asp] escalation service wired — Telegram bound chat ${telegram.chatId}; timeouts on shared Redis.`);

  const gateway: EscalationGateway = {
    async onEscalated({ input, decision, stored, pollRef }) {
      const created = await service.createEscalation({
        pollRef,
        intentId: decision.intentHash,
        reason: decision.decision,
        policyId: decision.policyId,
        amount: input.amount,
        token: stored.rules.budgets.token,
        approvals: readApprovalsConfig(stored),
      });
      const fanout = created.record.channelLog.find((e) => e.kind === "FANOUT" || e.kind === "FANOUT_FAILED");
      console.log(
        `[asp] escalation created ${created.record.id} (pollRef ${pollRef}) reason=${decision.decision} ` +
          `amount=${input.amount} — telegram ${fanout?.kind === "FANOUT" ? "sent ✓" : "FAILED"}`,
      );
    },
  };

  return {
    gateway,
    async status(pollRef: string): Promise<EscalationStatusView> {
      const state = await service.getState(pollRef);
      const rec = await service.getByPollRef(pollRef);
      return {
        state,
        record: rec
          ? {
              id: rec.id,
              status: rec.status,
              reason: rec.reason,
              resolvedBy: rec.resolvedBy,
              resolvedAt: rec.resolvedAt,
            }
          : null,
      };
    },
    async close() {
      await receiver.stop();
      await timeoutWorker.close();
      await timeoutQueue.close();
      await queueRedis.quit();
      await workerRedis.quit();
      await pool.end();
    },
  };
}
