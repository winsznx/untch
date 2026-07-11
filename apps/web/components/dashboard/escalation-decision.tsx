"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "../wallet/wallet-context";

/**
 * The real approve/deny control for a dashboard escalation. It posts the decision to the server, which
 * runs it through the §27 authority-boundary check authorized by the operator's session. The outcome the
 * check returned is shown verbatim (APPROVED, DENIED, or an IGNORED_* reason), then the server-rendered
 * status refreshes. A terminal escalation shows its resolution instead of buttons.
 */

const TERMINAL = new Set(["APPROVED", "DENIED", "EXPIRED"]);

export function EscalationDecision({ escalationId, status }: { escalationId: string; status: string }) {
  const w = useWallet();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  if (TERMINAL.has(status)) {
    return (
      <span className="text-body-sm" style={{ color: status === "APPROVED" ? "var(--color-positive)" : "var(--color-inverse-muted)" }}>
        {status === "APPROVED" ? "Approved" : status === "DENIED" ? "Denied" : "Expired (default deny)"} from the dashboard.
      </span>
    );
  }

  const authed = w.status === "authenticated";

  async function decide(action: "APPROVE" | "DENY") {
    setBusy(true);
    setOutcome(null);
    try {
      const res = await fetch("/api/escalations/decision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ escalationId, action }),
      });
      const json = (await res.json()) as { outcome?: string; detail?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? "decision failed");
      setOutcome(json.outcome ?? null);
      router.refresh();
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={() => void decide("APPROVE")} disabled={!authed || busy} style={btn("primary", !authed || busy)}>
          {busy ? "Submitting…" : "Approve"}
        </button>
        <button type="button" onClick={() => void decide("DENY")} disabled={!authed || busy} style={btn("signal", !authed || busy)}>
          Deny
        </button>
      </div>
      {!authed ? (
        <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
          Sign in above to approve. Your session identity authorizes this, no separate signature needed.
        </span>
      ) : null}
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
