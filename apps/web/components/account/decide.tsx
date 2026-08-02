"use client";

import { useState } from "react";

/**
 * The approve and reject buttons.
 *
 * They post the DIGEST they were rendered with, not a boolean. If the quote moved between this page
 * being served and the button being pressed, the digest no longer matches and the ASP refuses with a
 * reason — which is the entire point. A button that posted `{approve:true}` would agree to whatever
 * the server thought was current at the moment it read the row.
 */
export function Decide({
  approvalRequestId,
  approvalDigest,
  amount,
  asset,
}: {
  approvalRequestId: string;
  approvalDigest: string;
  amount: string | null;
  asset: string | null;
}) {
  const [busy, setBusy] = useState<"APPROVE" | "REJECT" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; code?: string; message?: string; outcome?: string; paidNote?: string } | null>(null);

  async function decide(decision: "APPROVE" | "REJECT") {
    setBusy(decision);
    setResult(null);
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(approvalRequestId)}/decide`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, approvalDigest }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      setResult({
        ok: res.ok,
        code: typeof body.code === "string" ? body.code : undefined,
        message: typeof body.message === "string" ? body.message : undefined,
        outcome: typeof body.outcome === "string" ? body.outcome : undefined,
        paidNote: typeof body.paidNote === "string" ? body.paidNote : undefined,
      });
      if (res.ok) setTimeout(() => window.location.reload(), 900);
    } catch (err) {
      setResult({ ok: false, message: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => decide("APPROVE")}
          disabled={busy !== null}
          className="rounded-md px-4 py-2 text-body disabled:opacity-50"
          style={{ background: "var(--color-text)", color: "var(--color-canvas)" }}
        >
          {busy === "APPROVE" ? "Approving…" : `Approve exactly ${amount ?? "?"} ${asset ?? ""}`}
        </button>
        <button
          type="button"
          onClick={() => decide("REJECT")}
          disabled={busy !== null}
          className="rounded-md border px-4 py-2 text-body disabled:opacity-50"
          style={{ borderColor: "var(--color-hairline, #ddd)", color: "var(--color-text)" }}
        >
          {busy === "REJECT" ? "Rejecting…" : "Reject"}
        </button>
      </div>
      {/* The digest is shown, not hidden. It is what is being agreed to, and a user comparing it to
          the one on the request is the check no server-side assertion can replace. */}
      <span className="text-caption break-all" style={{ color: "var(--color-inverse-muted)" }}>
        Binding digest {approvalDigest}
      </span>
      {result ? (
        <span
          className="text-caption"
          style={{ color: result.ok ? "var(--color-inverse-muted)" : "var(--color-negative, #b23)" }}
        >
          {result.ok
            ? `${result.outcome ?? "Recorded"}. ${result.paidNote ?? ""}`
            : `${result.code ?? "REFUSED"}: ${result.message ?? ""}`}
        </span>
      ) : null}
    </div>
  );
}
