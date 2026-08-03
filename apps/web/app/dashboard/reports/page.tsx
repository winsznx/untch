import { DashCard, SectionTitle, StatTile, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { liveReconcile } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";
import { txUrl } from "../../../lib/onchain";

const RECONCILE_ANCHOR = "0x23b356d5621f94adcb74b66a7beef45ce37e4b7628b83a5fea9dab73bae86494";

/** Assembles the operator's reconcile report live from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function Reports() {
  const scope = await getScope();
  const r = scope.authenticated ? await liveReconcile(scope.address) : null;
  if (!r) {
    return (
      <div className="flex flex-col gap-8">
        <SectionTitle
          kicker="Reports"
          title="Reconciliation"
          subtitle="A deterministic view over your durable receipts, ledger and escalations, hashed and anchored on X Layer."
        />
        <NoHistory authenticated={scope.authenticated} address={scope.address} what="reports" />
      </div>
    );
  }
  const total = (t: readonly { totalDisplay: string; token: string }[]) => t.map((x) => `${x.totalDisplay} ${x.token}`).join(", ") || "0";
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Reports"
        title="Reconciliation"
        subtitle={`Period ${r.period.label}. A deterministic view over your receipts, ledger, and escalations — hashed and anchored on X Layer (AuditAnchored).`}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Settled spend" value={total(r.spend.totals)} sub={`${r.spend.settledCount} settled`} accent="text" />
        <StatTile label="Reserved authority" value={total(r.reservedAuthority.totals)} sub={`${r.reservedAuthority.approvedCount} approved · not spent`} accent="text" />
        <StatTile label="Waste blocked" value={total(r.blockedWaste.totals)} sub={`${r.blockedWaste.blockedCount} blocked`} accent="signal" />
        <StatTile label="Escalated exposure" value={total(r.escalatedExposure.totals)} sub={`${r.escalatedExposure.escalatedCount} held`} accent="data" />
        <StatTile label="Receipts" value={`${r.receipts.anchored}/${r.receipts.total}`} sub="anchored on-chain" accent="positive" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Decision breakdown</span>
            {r.decisionBreakdown.map((d) => (
              <div key={d.outcome} className="flex items-center justify-between">
                <Mono color="var(--color-inverse-canvas)">{d.outcome}</Mono>
                <span className="text-body" style={{ color: "var(--color-text)" }}>{d.count}</span>
              </div>
            ))}
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Verifications</span>
            <Row k="Passed" v={r.verifications.passed} />
            <Row k="Failed" v={r.verifications.failed} />
            <Row k="Skipped (no criteria)" v={r.verifications.skipped} />
            <Row k="Not implemented" v={r.verifications.notImplemented} />
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Report notes</span>
            <a href={txUrl("testnet", RECONCILE_ANCHOR)} target="_blank" rel="noopener noreferrer" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
              View anchored report on OKLink →
            </a>
          </div>
          {r.completeness.notes.map((n, i) => (
            <p key={i} className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>· {n}</p>
          ))}
          <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>assembled {r.assembledAt}</span>
        </div>
      </DashCard>
    </div>
  );
}

function Row({ k, v }: { k: string; v: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{k}</span>
      <span className="text-body" style={{ color: "var(--color-text)" }}>{v}</span>
    </div>
  );
}
