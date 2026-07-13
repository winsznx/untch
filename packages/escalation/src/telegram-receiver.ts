import { interimTelegramBinding } from "./binding";
import { ChannelRegistry } from "./channel";
import { loadStorageConfig, loadTelegramConfig } from "./config";
import { createPool, runMigrations } from "./db";
import { PgEscalationsRepo } from "./repo-pg";
import { EscalationService, type FailedControlEvent } from "./service";
import { TelegramChannel } from "./telegram";

/**
 * The Telegram inbound receiver: `pnpm --filter @untch/escalation telegram-receiver`.
 *
 * Long-polls the bot and runs every inbound operator response through the service's §27 authority
 * boundary. It is deliberately thin: the channel only normalizes events; the service decides. Failed
 * control events (IGNORED_*) are logged loudly — they are never dropped.
 */
async function main(): Promise<void> {
  const storage = loadStorageConfig();
  const telegram = loadTelegramConfig();

  const pool = createPool(storage.databaseUrl);
  await runMigrations(pool);

  const registry = new ChannelRegistry();
  registry.register(new TelegramChannel({ config: telegram }));

  const onFailedControlEvent = (evt: FailedControlEvent): void => {
    console.warn(
      `[escalation] FAILED CONTROL EVENT ${evt.outcome} — escalation=${evt.escalationId ?? "?"} ` +
        `channel=${evt.channel} handle=${evt.senderHandle}: ${evt.detail}`,
    );
  };

  const service = new EscalationService({
    repo: new PgEscalationsRepo(pool),
    registry,
    binding: interimTelegramBinding(telegram.chatId),
    defaultTimeoutMin: storage.defaultTimeoutMin,
    maxTimeoutMin: storage.maxTimeoutMin,
    onFailedControlEvent,
  });

  const channel = registry.get("telegram")!;
  const receiver = await channel.startReceiving(async (r) => {
    const res = await service.handleInbound(r);
    console.log(`[escalation] inbound ${res.outcome} — escalation=${res.escalationId ?? "?"} status=${res.status ?? "-"}`);
  });

  console.log(`[escalation] telegram receiver started (bound chat ${telegram.chatId})`);

  const shutdown = async (): Promise<void> => {
    await receiver.stop();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[escalation] telegram receiver failed: ${(err as Error).message}`);
  process.exit(1);
});
