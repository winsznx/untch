/**
 * @untch/escalation — PRD §7.2 / §27 escalation service.
 *
 * Public surface:
 *   • State machine: EscalationService (create → fan-out → authority-boundary check → resolve/expire).
 *   • Channel seam: Channel, ChannelRegistry, EscalationMessage — implement these once for a new channel.
 *   • The one real channel: TelegramChannel.
 *   • Guard bridge: makeEscalationResolver — wires x402-guard's poll() to resolve against this for real.
 *   • Storage: EscalationsRepo (+ Pg / InMemory), createPool, runMigrations.
 *   • Timeout: the BullMQ queue/worker helpers (shared Redis) + the fail-closed derived-expiry in getState.
 *   • Binding: interimTelegramBinding (the documented interim handle-binding), combineBindings.
 *   • Policy read: readApprovalsConfig — the §27 approvals config out of a stored policy.
 */

export * from "./types";
export {
  EscalationService,
  type EscalationServiceDeps,
  type CreatedEscalation,
  type BindingVerifier,
  type TimeoutScheduler,
  type FailedControlEvent,
} from "./service";
export {
  type Channel,
  ChannelRegistry,
  type ChannelReceiver,
  type ChannelSendResult,
  type EscalationMessage,
} from "./channel";
export { TelegramChannel, parseCallbackData, parseTextCommand } from "./telegram";
export { DiscordChannel, type DiscordChannelOptions } from "./discord";
export { SlackChannel, type SlackChannelOptions } from "./slack";
export {
  DashboardChannel,
  type DashboardChannelOptions,
  type DashboardApprovalInput,
} from "./dashboard";
export {
  PhotonChannel,
  renderPhotonMessage,
  type PhotonChannelOptions,
  type SpectrumPort,
  type SpectrumInbound,
  type SpectrumSendResult,
} from "./photon";
export { createSpectrumPort } from "./photon-spectrum";
export {
  parseButtonPayload,
  approvePayload,
  denyPayload,
  renderApprovalText,
  type ParsedCommand,
} from "./wire-format";
export {
  type WebSocketLike,
  type WebSocketFactory,
  defaultWebSocketFactory,
  frameToString,
} from "./ws";
export { makeEscalationResolver } from "./resolver";
export { readApprovalsConfig } from "./approvals";
export {
  interimTelegramBinding,
  interimDiscordBinding,
  interimSlackBinding,
  interimDashboardBinding,
  interimPhotonBinding,
  combineBindings,
} from "./binding";
export { generateCode, hashCode, codeMatchesHash } from "./codes";
export {
  type EscalationsRepo,
  type CreateEscalationRow,
  type StatusTransition,
} from "./repo";
export { PgEscalationsRepo } from "./repo-pg";
export { InMemoryEscalationsRepo } from "./repo-memory";
export {
  type OperatorsRepo,
  type OperatorBinding,
  PgOperatorsRepo,
  InMemoryOperatorsRepo,
  DEMO_OPERATOR_ID,
  OWNER_BINDING_CHANNEL,
} from "./operators";
export { createPool, runMigrations, type Pool } from "./db";
export {
  loadStorageConfig,
  loadTelegramConfig,
  loadDiscordConfig,
  loadSlackConfig,
  loadDashboardConfig,
  loadPhotonConfig,
  hasTelegramEnv,
  hasDiscordEnv,
  hasSlackEnv,
  hasDashboardEnv,
  hasPhotonEnv,
  MissingEnvError,
  type StorageConfig,
  type TelegramConfig,
  type DiscordConfig,
  type SlackConfig,
  type DashboardConfig,
  type PhotonConfig,
} from "./config";
export {
  createRedis,
  createTimeoutQueue,
  createTimeoutWorker,
  makeTimeoutScheduler,
  TIMEOUT_QUEUE,
  type TimeoutJob,
} from "./queue";
