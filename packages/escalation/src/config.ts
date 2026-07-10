/**
 * Escalation-service configuration.
 *
 * Split by role, like receipt-writer:
 *   • `StorageConfig` — Postgres + Redis, needed by everything (the SAME shared instances the receipt
 *     writer and policy store use — no new database, no second Redis).
 *   • `TelegramConfig` — the one real channel: bot token + the interim operator binding.
 *
 * The escalation state machine itself needs only storage. A channel is layered on top; the core never
 * imports a channel's config (that is the whole point of the channel-agnostic seam — Photon later
 * brings its own config without touching this).
 */

export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(`Missing required environment variable: ${varName}`);
    this.name = "MissingEnvError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new MissingEnvError(name);
  return v.trim();
}

function optInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(v)}`);
  }
  return n;
}

/** Storage shared by the state machine, the timeout worker, and the channel receiver. */
export interface StorageConfig {
  readonly databaseUrl: string;
  readonly redisUrl: string;
  /**
   * Hard ceiling on an escalation's timeout, minutes. The per-policy `escalationTimeoutMin` (§8) is
   * authoritative; this only bounds a pathological policy value so a code can never live "forever".
   */
  readonly maxTimeoutMin: number;
  /** Fallback timeout when a policy omits `escalationTimeoutMin` (§7.2 default 30). */
  readonly defaultTimeoutMin: number;
}

export function loadStorageConfig(): StorageConfig {
  return {
    databaseUrl: requireEnv("DATABASE_URL"),
    redisUrl: requireEnv("REDIS_URL"),
    maxTimeoutMin: optInt("ESCALATION_MAX_TIMEOUT_MIN", 1440),
    defaultTimeoutMin: optInt("ESCALATION_DEFAULT_TIMEOUT_MIN", 30),
  };
}

/**
 * Telegram channel config.
 *
 * `chatId` is the INTERIM handle binding (see README → "Handle-binding interim"): a single configured
 * chat bound to the one demo operator this whole build has used (the Step-5 demo wallet). It is a
 * clearly-labeled temporary stand-in for a real onboarding/binding flow (a code roundtrip driven from
 * the eventual dashboard, §15) — NOT the intended architecture. Until that exists, an inbound approval
 * is bound iff its chat id equals this configured value.
 */
export interface TelegramConfig {
  readonly botToken: string;
  readonly chatId: string;
  /** Telegram Bot API base; overridable for a mock server in tests. */
  readonly apiBase: string;
}

export function loadTelegramConfig(): TelegramConfig {
  return {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
    chatId: requireEnv("TELEGRAM_CHAT_ID"),
    apiBase: process.env.TELEGRAM_API_BASE?.trim() || "https://api.telegram.org",
  };
}
