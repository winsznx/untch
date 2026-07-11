/**
 * @untch/escalation/pure — the in-memory / no-transport surface.
 *
 * The main barrel (index.ts) re-exports the Postgres repo, the BullMQ queue, and the Telegram/Discord/
 * Slack channels, which pull `pg`, `bullmq`, and `ioredis`. The Next.js dashboard runs a REAL
 * `EscalationService` in-process over the in-memory repo (the same posture the rest of the dashboard
 * uses: real engines, seeded input) and must not drag those transports into its bundle. This entrypoint
 * exposes only the pieces that touch none of them — the state machine, the in-memory repos, the channel
 * seam, the DashboardChannel, and the binding/code helpers — so the dashboard imports `@untch/escalation/
 * pure` and stays free of pg/bullmq/ioredis entirely.
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
export { ChannelRegistry, type Channel, type ChannelReceiver, type ChannelSendResult, type EscalationMessage } from "./channel";
export { DashboardChannel, type DashboardChannelOptions, type DashboardApprovalInput } from "./dashboard";
export { interimDashboardBinding, combineBindings } from "./binding";
export { InMemoryEscalationsRepo } from "./repo-memory";
export { type EscalationsRepo, type CreateEscalationRow, type StatusTransition } from "./repo";
export { InMemoryOperatorsRepo, type OperatorsRepo, type OperatorBinding, DEMO_OPERATOR_ID } from "./operators";
export { generateCode, hashCode, codeMatchesHash } from "./codes";
