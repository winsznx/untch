/**
 * Escalation-service configuration.
 *
 * Split by role, like receipt-writer:
 *   • `StorageConfig` — Postgres + Redis, needed by everything (the SAME shared instances the receipt
 *     writer and policy store use — no new database, no second Redis).
 *   • one config per channel (`TelegramConfig`, `DiscordConfig`, `SlackConfig`, `DashboardConfig`,
 *     `PhotonConfig`) — each a credential/token plus the interim operator binding for that surface.
 *
 * The escalation state machine itself needs only storage. A channel is layered on top; the core never
 * imports a channel's config (that is the whole point of the channel-agnostic seam — each channel, most
 * recently Photon/iMessage, brought its own config without touching the core).
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

/**
 * Discord channel config.
 *
 * `userId` is the SAME interim handle binding pattern as Telegram's `chatId`: a single configured Discord
 * user id bound to the one demo operator this whole build has used (the Step-5 demo wallet). It is one
 * person reachable on another surface, NOT a second approver — the real onboarding/binding flow (§15) is a
 * named future step. Until it exists, an inbound Discord approval is bound iff its sender id equals this
 * value. `gatewayUrl` is overridable for a mock gateway in tests.
 */
export interface DiscordConfig {
  readonly botToken: string;
  readonly userId: string;
  readonly apiBase: string;
  readonly gatewayUrl: string;
}

export function loadDiscordConfig(): DiscordConfig {
  return {
    botToken: requireEnv("DISCORD_BOT_TOKEN"),
    userId: requireEnv("DISCORD_USER_ID"),
    apiBase: process.env.DISCORD_API_BASE?.trim() || "https://discord.com/api/v10",
    gatewayUrl: process.env.DISCORD_GATEWAY_URL?.trim() || "wss://gateway.discord.gg/",
  };
}

/** True iff all Discord env is present — lets the wiring register Discord only when configured. */
export function hasDiscordEnv(): boolean {
  return !!process.env.DISCORD_BOT_TOKEN?.trim() && !!process.env.DISCORD_USER_ID?.trim();
}

/**
 * Slack channel config.
 *
 * `botToken` (xoxb-) sends DMs; `appToken` (xapp-) opens the Socket Mode connection. `userId` is the SAME
 * interim handle binding as the other two channels: a single configured Slack user id bound to the one
 * demo operator (one person, another surface, not a second approver). `apiBase` is overridable for tests.
 */
export interface SlackConfig {
  readonly botToken: string;
  readonly appToken: string;
  readonly userId: string;
  readonly apiBase: string;
}

export function loadSlackConfig(): SlackConfig {
  return {
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    appToken: requireEnv("SLACK_APP_TOKEN"),
    userId: requireEnv("SLACK_USER_ID"),
    apiBase: process.env.SLACK_API_BASE?.trim() || "https://slack.com/api",
  };
}

/** True iff all Slack env is present — lets the wiring register Slack only when configured. */
export function hasSlackEnv(): boolean {
  return (
    !!process.env.SLACK_BOT_TOKEN?.trim() &&
    !!process.env.SLACK_APP_TOKEN?.trim() &&
    !!process.env.SLACK_USER_ID?.trim()
  );
}

/** True iff all Telegram env is present. */
export function hasTelegramEnv(): boolean {
  return !!process.env.TELEGRAM_BOT_TOKEN?.trim() && !!process.env.TELEGRAM_CHAT_ID?.trim();
}

/**
 * Dashboard channel config.
 *
 * `operatorWallet` is the SAME interim single-operator binding as the other channels, one surface further
 * in: the operator's SIWE-verified wallet, bound to the one demo operator this whole build has used. It is
 * the same person authenticated in their own dashboard session, NOT a second approver; the real self-serve
 * binding flow (§15) is a named future step. There is no token or endpoint here because the dashboard is a
 * PULL surface (it reads escalation records from the shared repo), so the wallet is the only thing to bind.
 */
export interface DashboardConfig {
  readonly operatorWallet: string;
}

export function loadDashboardConfig(): DashboardConfig {
  return {
    operatorWallet: requireEnv("DASHBOARD_OPERATOR_WALLET"),
  };
}

/** True iff the dashboard operator wallet is set — lets the wiring register the dashboard only when bound. */
export function hasDashboardEnv(): boolean {
  return !!process.env.DASHBOARD_OPERATOR_WALLET?.trim();
}

/**
 * Photon (Spectrum Cloud) channel config — the fifth surface, iMessage.
 *
 * `projectId` + `projectSecret` are the Photon project credentials (from app.photon.codes); they are the
 * SELLER's, set locally in the environment exactly like every other channel's tokens — never pasted into
 * chat. `operatorHandle` is the SAME interim single-operator binding as the other channels, one surface
 * further: the bound operator's iMessage handle (E.164 phone, e.g. `+15551234567`, or an email), which is
 * both the send target and the handle inbound senders are matched against. On the shared-pool (Free/Pro)
 * plan this handle MUST be a pre-registered user of the Photon project or sends are rejected with
 * "Target not allowed for this project". The real §15 onboarding/binding flow is the named future step;
 * until then it is the one configured operator handle, the same person reached on a fifth surface.
 */
export interface PhotonConfig {
  readonly projectId: string;
  readonly projectSecret: string;
  readonly operatorHandle: string;
}

export function loadPhotonConfig(): PhotonConfig {
  return {
    projectId: requireEnv("PHOTON_PROJECT_ID"),
    projectSecret: requireEnv("PHOTON_PROJECT_SECRET"),
    operatorHandle: requireEnv("PHOTON_OPERATOR_HANDLE"),
  };
}

/** True iff all Photon env is present — lets the wiring register Photon only when configured. */
export function hasPhotonEnv(): boolean {
  return (
    !!process.env.PHOTON_PROJECT_ID?.trim() &&
    !!process.env.PHOTON_PROJECT_SECRET?.trim() &&
    !!process.env.PHOTON_OPERATOR_HANDLE?.trim()
  );
}
