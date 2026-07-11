import { DashCard, SectionTitle, DecisionChip, Mono } from "../../../components/dashboard/ui";
import { getIntentStream, type IntentRow } from "../../../lib/dashboard/data";

const OUTCOME_LABEL = (o: string) => o.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

export default function IntentStream() {
  const stream = getIntentStream();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Live" title="Intent stream" />
      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Every payment attempt, bounded by an intent and evaluated by the deterministic policy engine. Expand a
        row for its full rule trace. Decisions and traces are computed live by @untch/policy-engine.
      </p>
      <div className="flex flex-col gap-3">
        {stream.map((row) => (
          <IntentCard key={row.intentHash} row={row} />
        ))}
      </div>
    </div>
  );
}

function IntentCard({ row }: { row: IntentRow }) {
  return (
    <DashCard>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-body" style={{ color: "var(--color-text)" }}>{row.endpoint}</span>
          <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
            {row.vendor} · {row.category} · <Mono>{row.id}</Mono>
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-body" style={{ color: "var(--color-text)" }}>{row.amount.toFixed(2)} {row.token}</span>
          <DecisionChip category={row.decisionCategory} label={OUTCOME_LABEL(row.outcome)} />
        </div>
      </div>

      <details className="mt-4">
        <summary className="cursor-pointer text-body-sm" style={{ color: "var(--color-data)" }}>
          Rule trace ({row.rules.length})
        </summary>
        <div className="mt-3 overflow-x-auto">
          <table className="w-full border-collapse text-caption-lg">
            <tbody>
              {row.rules.map((r, i) => {
                const fail = r.result === "FAIL";
                const stub = r.implemented === false;
                const color = fail ? "var(--color-signal)" : stub ? "var(--color-inverse-muted)" : "var(--color-positive)";
                return (
                  <tr key={i} style={{ borderTop: "1px solid var(--color-border-soft)" }}>
                    <td className="py-2 pr-4" style={{ color: "var(--color-inverse-canvas)", fontFamily: "ui-monospace, monospace" }}>
                      {r.rule}{stub ? " (stub)" : ""}
                    </td>
                    <td className="py-2 pr-4" style={{ color }}>{r.result}</td>
                    <td className="py-2" style={{ color: "var(--color-inverse-muted)" }}>
                      {r.observed !== undefined ? `observed ${r.observed}` : ""}
                      {r.limit !== undefined ? ` · limit ${r.limit}` : ""}
                      {r.ttlRemainingSec !== undefined ? ` · ttl ${r.ttlRemainingSec}s` : ""}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </DashCard>
  );
}
