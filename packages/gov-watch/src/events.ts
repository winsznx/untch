import type { GovernanceEventKind } from "@untch/escalation";

/**
 * WHICH events are governance events, per contract.
 *
 * Derived from reading each contract's source, not guessed. The point of the list is what is ABSENT as
 * much as what is present:
 *
 *   • PolicyRegistry (§10.1) has NO role events and no admin/writer/owner at all — it is permissionless,
 *     and its only gate (`onlyPolicyOwner`) is per-policy, not governance. There is nothing here to
 *     watch. It is deliberately not in this map.
 *   • UntchVaultFactory (§10.4) likewise has NO roles: no admin, no owner, one immutable
 *     `intentRegistry` set at construction. `VaultDeployed` is activity, not governance. Also absent.
 *   • UntchVault (§10.4) is per-instance and none exist yet. Its role events ARE listed so a vault is
 *     watchable the moment one is deployed through the Factory — but nothing watches it today.
 *
 * So on day one, exactly TWO contracts have anything governance-shaped to watch: UntchReceipts and
 * SpendIntentRegistry. Both derive from `AuthorizedWriters`, which is where the writer/admin events live.
 */
export const WATCHED_EVENTS: Readonly<Record<string, readonly GovernanceEventKind[]>> = {
  /**
   * The timelocked one (§10.3). `OpProposed` is the event this whole watcher exists for: it opens the
   * cancel window, and it is the ONLY signal that a writer-set or admin change is coming before it
   * lands. Miss it and the timelock protected nothing.
   */
  UntchReceipts: [
    "OpProposed",
    "OpExecuted",
    "OpCancelled",
    "WriterAdded",
    "WriterRemoved",
    "AdminTransferred",
  ],
  /**
   * The un-timelocked one (§10.2). Its admin is IMMEDIATE by deliberate design, so there is no propose
   * step and no cancel window — a `WriterAdded` here is already done when you read it. That makes
   * alerting more important, not less: detection is the only defense this contract has.
   */
  SpendIntentRegistry: ["WriterAdded", "WriterRemoved", "AdminTransferred"],
  /** Per-instance, none deployed yet. `owner` moves funds; `oracle` signs spend authorizations. */
  UntchVault: [
    "OracleChanged",
    "OwnershipTransferStarted",
    "OwnershipTransferred",
    "Paused",
    "Unpaused",
  ],
} as const;

/**
 * `OpCancelled` is the one piece of GOOD news here — a pending change was withdrawn, which is the
 * system working. Everything else is either a live change to who holds power or a proposal to change
 * it. Severity drives presentation only; the watcher suppresses nothing at any severity.
 */
export function severityOf(kind: GovernanceEventKind): "critical" | "info" {
  return kind === "OpCancelled" ? "info" : "critical";
}

/** The `OpKind` enum in UntchReceipts, for rendering `kind` as a word rather than a bare `1`. */
export const OP_KIND_NAMES: Readonly<Record<number, string>> = {
  0: "NONE",
  1: "ADD_WRITER",
  2: "REMOVE_WRITER",
  3: "TRANSFER_ADMIN",
} as const;
