import Link from "next/link";
import { DashCard, SectionTitle, StatTile, Meter, DecisionChip } from "../../components/dashboard/ui";
import { NoHistory } from "../../components/dashboard/no-history";
import { getProofTiers } from "../../lib/dashboard/data";
import { liveSavings, liveIntentStream } from "../../lib/dashboard/live";
import { getScope } from "../../lib/dashboard/scope";

const usd = (n: number) => n.toFixed(2);

/** Reads the operator's real spend summary + intent stream from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function Overview() {
  const scope = await getScope();
  if (!scope.authenticated) {
    return (
      <div className="flex flex-col gap-10">
        <SectionTitle kicker="Overview" title="Proof surface" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile label="Waste blocked" value="0.00 USDT" sub="0 payments stopped" accent="signal" />
          <StatTile label="Spent" value="0.00 USDT" sub="0 approved" accent="text" />
          <StatTile label="Escalated" value="0.00 USDT" sub="0 held for approval" accent="data" />
          <StatTile label="Verified deliveries" value="0" sub="T0 schema proof" accent="positive" />
        </div>
        <NoHistory
          authenticated={scope.authenticated}
          address={scope.address}
          what="activity"
          cta={
            <Link href="/dashboard/policies" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
              Create your first policy →
            </Link>
          }
        />
      </div>
    );
  }

  const s = await liveSavings(scope.address);
  const proof = getProofTiers();
  const stream = await liveIntentStream(scope.address);
  const outcomes = stream.reduce<Record<string, number>>((acc, i) => {
    acc[i.decisionCategory] = (acc[i.decisionCategory] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle kicker="Overview" title="Proof surface" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Waste blocked" value={`${usd(s.blockedWaste)} ${s.token}`} sub={`${s.blockedCount} payments stopped`} accent="signal" />
        <StatTile label="Spent" value={`${usd(s.spent)} ${s.token}`} sub={`${s.approvedCount} approved`} accent="text" />
        <StatTile label="Escalated" value={`${usd(s.escalatedExposure)} ${s.token}`} sub={`${s.escalatedCount} held for approval`} accent="data" />
        <StatTile label="Verified deliveries" value={`${proof.finals.find((f) => f.label === "Passed")?.count ?? 0}`} sub="T0 schema proof" accent="positive" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DashCard className="lg:col-span-2">
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Daily budget</span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{usd(s.spent)} / {usd(s.dailyBudget)} {s.token}</span>
            </div>
            <Meter value={s.spent} max={s.dailyBudget} color="var(--color-data)" />
            <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              Spend counts only approved payments. Blocked and escalated amounts never left the budget.
            </p>
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Decisions</span>
            <div className="flex flex-col gap-3">
              {(["APPROVED", "BLOCKED", "ESCALATED"] as const).map((c) => (
                <div key={c} className="flex items-center justify-between">
                  <DecisionChip category={c} label={c[0] + c.slice(1).toLowerCase()} />
                  <span className="text-body" style={{ color: "var(--color-text)" }}>{outcomes[c] ?? 0}</span>
                </div>
              ))}
            </div>
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Proof-tier distribution</span>
            <Link href="/dashboard/intents" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
              View intent stream →
            </Link>
          </div>
          <div className="flex flex-wrap gap-3">
            {proof.finals.map((f) => (
              <span key={f.label} className="rounded-tags px-4 py-2 text-body-sm" style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-canvas)" }}>
                {f.label}: <strong style={{ color: "var(--color-text)" }}>{f.count}</strong>
              </span>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            {proof.ladder.map((t) => (
              <span
                key={t.tier}
                title={t.note}
                className="rounded-tags px-3 py-1 text-caption-lg"
                style={{ border: `1px solid ${t.implemented ? "var(--color-positive)" : "var(--color-border-soft)"}`, color: t.implemented ? "var(--color-positive)" : "var(--color-inverse-muted)" }}
              >
                {t.tier} {t.implemented ? "live" : "not implemented"}
              </span>
            ))}
          </div>
        </div>
      </DashCard>
    </div>
  );
}
