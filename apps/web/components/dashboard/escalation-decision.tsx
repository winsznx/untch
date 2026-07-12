import type { EscalationView } from "../../lib/dashboard/live";

/**
 * Read-only resolution status for a real escalation, from the shared @untch/escalation store. It shows how
 * the escalation was (or will be) resolved via the bound control channels.
 *
 * Dashboard-native approve/deny — the dashboard acting as a §27 control channel — is deliberately NOT wired
 * here: a seller-created escalation's single-use code lives only in the sent message (only its hash is in
 * Postgres) and its approvals config authorizes the configured channels, not "dashboard". Making the
 * dashboard an authorized channel is a WRITE-side change (register the channel + carry session-authority at
 * creation), tracked as the next item in apps/web/README.md — not faked over local state here.
 */

const TERMINAL = new Set(["APPROVED", "DENIED", "EXPIRED"]);

export function EscalationResolution({
  status,
  resolvedBy,
  approvedChannels,
}: {
  status: EscalationView["status"];
  resolvedBy: EscalationView["resolvedBy"];
  approvedChannels: EscalationView["approvedChannels"];
}) {
  if (TERMINAL.has(status)) {
    const label =
      status === "APPROVED" ? "Approved" : status === "DENIED" ? "Denied" : "Expired (default deny)";
    const via = resolvedBy?.channel
      ? ` via ${resolvedBy.channel}${resolvedBy.handle ? ` (${resolvedBy.handle})` : ""}`
      : "";
    return (
      <span className="text-body-sm" style={{ color: status === "APPROVED" ? "var(--color-positive)" : "var(--color-inverse-muted)" }}>
        {label}{via}
        {approvedChannels.length ? ` · confirmed by ${approvedChannels.join(", ")}` : ""}
      </span>
    );
  }
  return (
    <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
      Awaiting approval through the bound control channels. Dashboard-native approve/deny is the next
      write-side item (see README).
    </span>
  );
}
