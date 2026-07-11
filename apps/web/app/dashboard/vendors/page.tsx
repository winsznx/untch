import { DashCard, SectionTitle, BandChip, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { getVendors, type VendorView } from "../../../lib/dashboard/data";
import { getScope } from "../../../lib/dashboard/scope";

export default async function Vendors() {
  const scope = await getScope();
  if (!scope.isDemoOperator) {
    return (
      <div className="flex flex-col gap-8">
        <SectionTitle kicker="Trust Bureau" title="Vendor directory" />
        <NoHistory authenticated={scope.authenticated} address={scope.address} what="vendor history" />
      </div>
    );
  }
  const vendors = await getVendors();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Trust Bureau" title="Vendor directory" />
      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Scores are computed live by @untch/trust-bureau. Enforcement uses the lower-confidence bound (LCB),
        never the raw score. Each feature is marked observed (receipt-backed) or cold-start prior, exactly as
        the Bureau reports it. Scores are operational signals, not legal or financial determinations.
      </p>
      <div className="flex flex-col gap-4">
        {vendors.map((v) => (
          <VendorCard key={v.name} v={v} />
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
