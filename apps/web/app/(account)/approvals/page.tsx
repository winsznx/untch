import Link from "next/link";
import { loadApprovals } from "../../../lib/account/views";
import { Card, Empty, NotLinked, Panel, Refusal } from "../../../components/account/shell";

export const dynamic = "force-dynamic";

/** Every state an approval can be in, in the order a person cares about them. */
const STATES = ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "SUPERSEDED", "EXECUTED"] as const;

export default async function Approvals({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;
  const view = await loadApprovals(state);

  if (!view.authenticated) {
    return (
      <Panel title="Approvals" sub="Decisions made with the wallet that owns the account.">
        <NotLinked />
      </Panel>
    );
  }
  if (view.refusal) {
    return (
      <Panel title="Approvals">
        <Refusal code={view.refusal.code} message={view.refusal.message} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Approvals"
      /* Stated once, at the top. With execution disabled an APPROVED request is APPROVED_AWAITING_
         EXECUTION, and burying that in a per-row label is how a demo comes to imply a payment. */
      sub={view.executionNote ?? undefined}
    >
      <div className="flex flex-wrap gap-3">
        <Link href="/approvals" className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          All
        </Link>
        {STATES.map((s) => (
          <Link key={s} href={`/approvals?state=${s}`} className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            {s.toLowerCase()} ({view.counts[s] ?? 0})
          </Link>
        ))}
      </div>

      {view.approvals.length === 0 ? (
        <Empty
          what={state ? `No approvals in ${state}.` : "No approval requests on this account."}
          note="An approval appears here when a policy escalates rather than deciding on its own. Nothing is pre-seeded."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {view.approvals.map((a) => (
            <Card key={a.approvalRequestId}>
              <Link href={`/approvals/${a.approvalRequestId}`} className="flex flex-col gap-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-body" style={{ color: "var(--color-text)" }}>
                    {a.amount ?? "?"} {a.asset ?? ""} · {a.provider ?? "?"}/{a.capability ?? "?"}
                  </span>
                  <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                    {a.displayLabel || a.displayState || a.state}
                  </span>
                </div>
                <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                  {a.reason ?? "no reason recorded"} · expires {a.expiresAt}
                  {a.supersededBy ? ` · superseded by ${a.supersededBy}` : ""}
                </span>
              </Link>
            </Card>
          ))}
        </div>
      )}
    </Panel>
  );
}
