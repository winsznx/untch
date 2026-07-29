import { DashCard, SectionTitle, BandChip, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { liveVendors, liveBuyerScores, type VendorView, type BuyerScoreView } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";

/** Scores the operator's real counterparties + agents live from the shared receipts store per request. */
export const dynamic = "force-dynamic";

export default async function Vendors() {
  const scope = await getScope();
  const [vendors, buyers] = scope.authenticated
    ? await Promise.all([liveVendors(scope.address), liveBuyerScores(scope.address)])
    : [[] as VendorView[], [] as BuyerScoreView[]];
  if (!scope.authenticated || (vendors.length === 0 && buyers.length === 0)) {
    return (
      <div className="flex flex-col gap-8">
        <SectionTitle
          kicker="Trust Bureau"
          title="Vendor directory"
          subtitle="Counterparty reliability, scored live by the Trust Bureau from your real receipts. Enforcement reads the lower-confidence bound, never the raw score."
        />
        <NoHistory authenticated={scope.authenticated} address={scope.address} what="vendor history" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Trust Bureau"
        title="Vendor directory"
        subtitle="Counterparty reliability, scored live by the Trust Bureau from your real receipts. Enforcement reads the lower-confidence bound, never the raw score. Each feature is marked observed or cold-start prior."
      />

      {buyers.length > 0 ? (
        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Your agents: buyer reliability</span>
            {buyers.map((b) => (
              <div key={b.agentId} className="flex items-center justify-between">
                <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)", fontFamily: "ui-monospace, monospace" }}>{b.agentId.slice(0, 12)}…</span>
                <div className="flex items-center gap-4">
                  <BandChip band={b.score.band} />
                  <span className="text-caption-lg" style={{ color: "var(--color-inverse-canvas)" }}>LCB {Math.round(b.score.lcb)} · score {Math.round(b.score.score)}</span>
                </div>
              </div>
            ))}
          </div>
        </DashCard>
      ) : null}

      <div className="flex flex-col gap-4">
        {vendors.map((v) => (
          <VendorCard key={v.vendorId} v={v} />
        ))}
      </div>
    </div>
  );
}

function VendorCard({ v }: { v: VendorView }) {
  const s = v.score;
  return (
    <DashCard>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{v.name}</span>
          <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>{v.category}</span>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex flex-col items-end">
            <span className="text-heading" style={{ color: "var(--color-data)" }}>{Math.round(s.lcb)}</span>
            <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>LCB (enforced)</span>
          </div>
          <div className="flex flex-col items-end gap-2">
            <BandChip band={s.band} />
            <span className="text-caption-lg" style={{ color: "var(--color-inverse-canvas)" }}>
              score {Math.round(s.score)} · σ {s.sigma.toFixed(1)}
            </span>
          </div>
        </div>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-body-sm" style={{ color: "var(--color-data)" }}>
          Why this score ({s.features.length} features)
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-caption-lg">
            <tbody>
              {s.features.map((f) => {
                const observed = f.source === "observed";
                return (
                  <tr key={f.key} style={{ borderTop: "1px solid var(--color-border-soft)" }}>
                    <td className="py-2 pr-4" style={{ color: "var(--color-inverse-canvas)" }}>{f.key}</td>
                    <td className="py-2 pr-4" style={{ color: "var(--color-text)" }}>{Math.round(f.value)}</td>
                    <td className="py-2 pr-4">
                      <span style={{ color: observed ? "var(--color-positive)" : "var(--color-inverse-muted)" }}>
                        {observed ? "observed" : "cold-start prior"}
                      </span>
                    </td>
                    <td className="py-2" style={{ color: "var(--color-inverse-muted)" }}>weight {f.weightApplied.toFixed(2)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
          Cold-start priors (marketplace review data unavailable): {s.coldStartFeatures.join(", ") || "none"}. Their
          weight is renormalized away, which widens σ and lowers the LCB. <Mono>epoch {s.epoch}</Mono>
        </p>
      </details>
    </DashCard>
  );
}
