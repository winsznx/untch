import { DashCard, SectionTitle, Mono, DecisionChip } from "../../../components/dashboard/ui";
import { getDispute } from "../../../lib/dashboard/data";
import { txUrl } from "../../../lib/onchain";

const DISPUTE_ANCHOR = "0xcb577c8e55f7f7a4777d2d0eb04d84b2422dcd2016f7e0291c12872caefcb699";

export default function Disputes() {
  const d = getDispute();
  const cat = d.decision.category ?? "ESCALATED";
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Disputes" title="Dispute packet" />
      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        An evidence bundle for a held payment: the terminal decision, verification results, escalation history,
        receipts, and a timeline. Assembled live by @untch/reports and anchored on X Layer (AuditAnchored).
      </p>

      <DashCard>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>Intent</span>
            <Mono color="var(--color-data)">{d.intentHash}</Mono>
          </div>
          <DecisionChip category={cat} label={(d.decision.outcome ?? "").replace(/_/g, " ")} />
        </div>
      </DashCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Timeline</span>
          <div className="mt-3 flex flex-col gap-3">
            {d.timeline.length === 0 ? (
              <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>No timeline events recorded.</span>
            ) : (
              d.timeline.map((t, i) => (
                <div key={i} className="flex flex-col gap-1" style={{ borderLeft: "2px solid var(--color-border)", paddingLeft: 12 }}>
                  <span className="text-body-sm" style={{ color: "var(--color-text)" }}>{t.event}</span>
                  <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{t.ts}</span>
                </div>
              ))
            )}
          </div>
        </DashCard>

        <DashCard>
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Receipts</span>
          <div className="mt-3 flex flex-col gap-3">
            {d.receipts.map((r) => (
              <div key={r.receiptId} className="flex items-center justify-between">
                <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{r.kind}</span>
                <div className="flex items-center gap-3">
                  <span className="text-caption-lg" style={{ color: r.anchored ? "var(--color-positive)" : "var(--color-inverse-muted)" }}>{r.status}</span>
                  {r.txHash ? (
                    <a href={txUrl("testnet", r.txHash)} target="_blank" rel="noopener noreferrer" className="text-caption-lg underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
                      {r.txHash.slice(0, 10)}…
                    </a>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Completeness</span>
            <a href={txUrl("testnet", DISPUTE_ANCHOR)} target="_blank" rel="noopener noreferrer" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
              View anchored packet on OKLink →
            </a>
          </div>
          {d.completeness.notes.map((n, i) => (
            <p key={i} className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>· {n}</p>
          ))}
        </div>
      </DashCard>
    </div>
  );
}
