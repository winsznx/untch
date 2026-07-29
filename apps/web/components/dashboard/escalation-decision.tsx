"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { EscalationView } from "../../lib/dashboard/live";

/**
 * The dashboard's escalation approve/deny, the fourth control channel's operator action. It POSTs to
 * /api/escalations/decision, which runs the decision through the SAME §27 authority-boundary check in
 * @untch/escalation, against the SAME shared Postgres record the other channels resolve. Authority is the
 * SIWE session (the signed-in wallet is the sender handle): NO per-click wallet signature, exactly as a
 * bound Telegram handle needs none. A terminal escalation shows its resolution instead of buttons.
 */

const TERMINAL = new Set(["APPROVED", "DENIED", "EXPIRED"]);

export function EscalationDecision({
  escalationId,
  status,
  resolvedBy,
  approvedChannels,
}: {
  escalationId: string;
  status: EscalationView["status"];
  resolvedBy: EscalationView["resolvedBy"];
  approvedChannels: EscalationView["approvedChannels"];
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

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

  async function decide(action: "APPROVE" | "DENY") {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/escalations/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ escalationId, action }),
      });
      const json = (await res.json().catch(() => ({}))) as { outcome?: string; detail?: string; error?: string };
      setOutcome(json.outcome ?? json.error ?? (res.ok ? "OK" : "failed"));
      if (res.ok) router.refresh();
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void decide("APPROVE")} disabled={busy} style={btn("primary", busy)}>
          {busy ? "Submitting…" : "Approve"}
        </button>
        <button type="button" onClick={() => void decide("DENY")} disabled={busy} style={btn("signal", busy)}>
          Deny
        </button>
      </div>
      <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
        Your signed-in session authorizes this — no separate signature. Resolves the same escalation record
        the control channels do.
      </span>
      {outcome ? (
        <span className="text-caption-lg" style={{ color: outcome === "APPROVED" ? "var(--color-positive)" : "var(--color-signal)" }}>
          Result: {outcome}
        </span>
      ) : null}
    </div>
  );
}

function btn(variant: "primary" | "signal", disabled: boolean) {
  const base = { borderRadius: "9999px", padding: "12px 24px", fontSize: 14, fontWeight: 500, cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 };
  if (variant === "signal") return { ...base, background: "transparent", color: "var(--color-signal)", border: "1px solid var(--color-signal)" };
  return { ...base, background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)" };
}
