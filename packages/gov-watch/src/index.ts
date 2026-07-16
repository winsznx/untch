/**
 * @untch/gov-watch — the governance watcher (§10.3 timelock defense).
 *
 * Public surface:
 *   • GovernanceWatcher — the poller: scan a block range in RPC-legal chunks, decode governance events
 *     against the real deployed ABIs, fan out through the escalation channels' `notify` seam.
 *   • WATCHED_EVENTS — which events are governance events per contract, and (just as importantly)
 *     which contracts have none.
 *   • FileCursor / MemoryCursor — the one piece of durable state.
 *   • loadTargets — build watch targets from the phase-1 deployment artifact.
 */

export {
  GovernanceWatcher,
  type WatchTarget,
  type WatcherOptions,
  type CursorStore,
  type ScanResult,
} from "./watcher";
export { WATCHED_EVENTS, severityOf, OP_KIND_NAMES } from "./events";
export { FileCursor, MemoryCursor } from "./cursor";
export { loadTargets, loadArtifactTargets, type DeploymentArtifact } from "./targets";
