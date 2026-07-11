import {
  ChannelRegistry,
  DiscordChannel,
  EscalationService,
  PgEscalationsRepo,
  SlackChannel,
  TelegramChannel,
  combineBindings,
  createPool,
  createRedis,
  createTimeoutQueue,
  createTimeoutWorker,
  DEMO_OPERATOR_ID,
  PgOperatorsRepo,
  hasDiscordEnv,
  hasSlackEnv,
  hasTelegramEnv,
  interimDiscordBinding,
  interimSlackBinding,
  interimTelegramBinding,
  loadDiscordConfig,
  loadSlackConfig,
  loadStorageConfig,
  loadTelegramConfig,
  makeTimeoutScheduler,
  readApprovalsConfig,
  runMigrations,
  type BindingVerifier,
  type Channel,
  type ChannelReceiver,
  type EscalationRecord,
  type FailedControlEvent,
} from "@untch/escalation";
import type { EscalationState } from "@untch/x402-guard";
import type { EscalationGateway } from "./handlers";

/**
 * §7.2 / §27 escalation wiring for the seller — the SERVER-SIDE half of the control plane.
 *
 * When DATABASE_URL + REDIS_URL are present AND at least one control channel is configured (Telegram,
 * Discord, and/or Slack), the seller:
 *   • creates the escalation record on every ESCALATED_* preflight decision (the `gateway`),
 *   • fans it out over EVERY configured channel (the policy's `approvals.channels` ∩ the registered ones),
 *   • runs each channel's inbound operator response through the §27 authority boundary,
 *   • fires §7.2 timeouts (BullMQ on the shared Redis) → EXPIRED → default DENY,
 *   • and serves the resolved state at GET /escalation_status/:pollRef.
 *
 * All three channels bind to the SAME demo operator via `combineBindings` — one person reachable on three
 * surfaces, not three approvers. Any bound channel can approve; an amount above `dualChannelAbove` needs
 * two DISTINCT ones. When no channel is configured this stays null and the gateway is simply not wired —
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
    readonly approvedChannels: readonly string[];
    readonly channelLog: EscalationRecord["channelLog"];
  } | null;
}

export interface EscalationWiring {
  readonly gateway: EscalationGateway;
  readonly channels: readonly string[];
  status(pollRef: string): Promise<EscalationStatusView>;
  close(): Promise<void>;
}

interface RegisteredChannel {
  readonly channel: Channel;
  readonly binding: BindingVerifier;
  /** The bound operator handle on this channel — provisioned into the operator-identity readiness table. */
  readonly handle: string;
  readonly label: string;
}

/** Build the set of real channels the env configures. Each binds the SAME operator on its own surface. */
function configuredChannels(): RegisteredChannel[] {
  const out: RegisteredChannel[] = [];
  if (hasTelegramEnv()) {
    const cfg = loadTelegramConfig();
    out.push({
      channel: new TelegramChannel({ config: cfg }),
      binding: interimTelegramBinding(cfg.chatId),
      handle: cfg.chatId,
      label: `telegram (chat ${cfg.chatId})`,
    });
  }
  if (hasDiscordEnv()) {
    const cfg = loadDiscordConfig();
    out.push({
      channel: new DiscordChannel({ config: cfg }),
      binding: interimDiscordBinding(cfg.userId),
      handle: cfg.userId,
      label: `discord (user ${cfg.userId})`,
    });
  }
  if (hasSlackEnv()) {
    const cfg = loadSlackConfig();
    out.push({
      channel: new SlackChannel({ config: cfg }),
      binding: interimSlackBinding(cfg.userId),
      handle: cfg.userId,
      label: `slack (user ${cfg.userId})`,
    });
  }
  return out;
}

export async function initEscalationWiring(): Promise<EscalationWiring | null> {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  const redisUrl = process.env.REDIS_URL?.trim();
  const channelsCfg = configuredChannels();
  if (!databaseUrl || !redisUrl || channelsCfg.length === 0) {
    console.log(
      "[asp] escalation service NOT wired (needs DATABASE_URL + REDIS_URL + at least one of " +
        "TELEGRAM_* / DISCORD_* / SLACK_*) — ESCALATED decisions will not create a server-side escalation.",
    );
    return null;
  }

  const storage = loadStorageConfig();

  const pool = createPool(storage.databaseUrl);
  const applied = await runMigrations(pool);
  if (applied.length > 0) console.log(`[asp] escalation migrations applied: ${applied.join(", ")}`);

  const registry = new ChannelRegistry();
  for (const c of channelsCfg) registry.register(c.channel);
  const binding = combineBindings(...channelsCfg.map((c) => c.binding));

  // Operator-identity readiness (migration 004): mirror today's single operator + its channel handles into
  // the (channel, handle) → operator table. This is provisioning only — the live §27 check above still uses
  // `binding`; nothing reads these tables for authority yet. A second approver later is an INSERT, not a
  // migration. See @untch/escalation operators.ts.
  const operators = new PgOperatorsRepo(pool);
  for (const c of channelsCfg) {
    await operators.ensureBinding(DEMO_OPERATOR_ID, c.channel.name, c.handle);
  }

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
    binding,
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

  // Start every channel's inbound receiver; each inbound runs through the §27 authority boundary.
  const receivers: ChannelReceiver[] = [];
  for (const c of channelsCfg) {
    const receiver = await c.channel.startReceiving(async (r) => {
      const res = await service.handleInbound(r);
      console.log(`[asp] escalation inbound ${res.outcome} — escalation=${res.escalationId ?? "?"} status=${res.status ?? "-"} via ${r.channel}`);
    });
    receivers.push(receiver);
  }

  console.log(
    `[asp] escalation service wired — channels: ${channelsCfg.map((c) => c.label).join(", ")}; ` +
      "timeouts on shared Redis.",
  );

  const gateway: EscalationGateway = {
    async onEscalated({ input, decision, stored, pollRef }) {
      // Readiness: ensure this policy has its (single, today) approver row. v1 = one row per policy.
      await operators.ensurePolicyApprover(decision.policyId, DEMO_OPERATOR_ID).catch((err) =>
        console.warn(`[asp] policy_approvers ensure failed (readiness only, non-fatal): ${(err as Error).message}`),
      );
      const created = await service.createEscalation({
        pollRef,
        intentId: decision.intentHash,
        reason: decision.decision,
        policyId: decision.policyId,
        amount: input.amount,
        token: stored.rules.budgets.token,
        approvals: readApprovalsConfig(stored),
      });
      const fanouts = created.record.channelLog.filter((e) => e.kind === "FANOUT").map((e) => e.channel);
      const failed = created.record.channelLog.filter((e) => e.kind === "FANOUT_FAILED").map((e) => e.channel);
      console.log(
        `[asp] escalation created ${created.record.id} (pollRef ${pollRef}) reason=${decision.decision} ` +
          `amount=${input.amount} — sent [${fanouts.join(", ") || "none"}]` +
          (failed.length ? ` failed [${failed.join(", ")}]` : ""),
      );
    },
  };

  return {
    gateway,
    channels: registry.names(),
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
              approvedChannels: rec.approvedChannels,
              channelLog: rec.channelLog,
            }
          : null,
      };
    },
    async close() {
      for (const r of receivers) await r.stop();
      await timeoutWorker.close();
      await timeoutQueue.close();
      await queueRedis.quit();
      await workerRedis.quit();
      await pool.end();
    },
  };
}
