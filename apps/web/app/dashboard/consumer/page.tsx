import Link from "next/link";
import { DashCard, DecisionChip, Mono, SectionTitle, StatTile, MastheadLink } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { getScope } from "../../../lib/dashboard/scope";
import { getPool, policyRepo } from "../../../lib/dashboard/db";
import { consumerOverview, tenantsForPolicies, type ProviderSummary } from "../../../lib/dashboard/consumer";
import { MaturityChip, StateChip } from "../../../components/dashboard/consumer-ui";

/** Reads the operator's real consumer activity from the shared Postgres per request. */
export const dynamic = "force-dynamic";

async function ownedTenants(address: string | null): Promise<readonly string[]> {
  if (!address) return [];
  const pool = getPool();
  if (!pool) return [];
  const policies = await policyRepo(pool).listByOwner(address);
  return tenantsForPolicies(policies.map((p) => p.id));
}

export default async function ConsumerPack() {
  const scope = await getScope();
  const tenants = await ownedTenants(scope.address);
  const overview = await consumerOverview(tenants);

  const executable = overview.providers.filter((p) => p.maturity === "verified" && p.enabled);
  const railsWithKeys = overview.rails.filter((r) => r.purpose === "SETTLEMENT" && r.enabled);

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle
        kicker="Consumer Pack"
        title="Governed consumer execution"
        subtitle="Shopping, domains, travel, gifts and notifications. Every one is bounded by a policy, funded for an exact approved amount, and closed with a cross-rail receipt."
        action={<MastheadLink href="/dashboard/consumer/providers">Provider registry →</MastheadLink>}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Active intents" value={String(overview.totals.active)} sub="in flight" accent="data" />
        <StatTile label="Completed" value={String(overview.totals.completed)} sub="with a full receipt" accent="positive" />
        <StatTile
          label="Manual review"
          value={String(overview.totals.manualReview)}
          sub={overview.totals.manualReview > 0 ? "needs a human" : "queue clear"}
          accent="signal"
        />
        <StatTile label="Blocked" value={String(overview.totals.blocked)} sub="spend withheld by policy" accent="text" />
      </div>

      {/* The honesty banner. Derived from durable state, not written by hand. */}
      <DashCard>
        <div className="flex flex-col gap-3">
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            Execution readiness
          </span>
          {executable.length === 0 ? (
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              <span style={{ color: "var(--color-signal)" }}>No provider is executable. </span>
              Execution requires maturity <Mono>verified</Mono>, which requires a real settled payment from an
              Untch treasury wallet plus a verified delivery. Discovery and quoting are available now; every
              execute route refuses with a named reason rather than pretending.
            </p>
          ) : (
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              {executable.length} provider{executable.length === 1 ? "" : "s"} verified and executable:{" "}
              <Mono>{executable.map((p) => p.providerId).join(", ")}</Mono>
            </p>
          )}
          <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            Settlement rails funded and enabled:{" "}
            {railsWithKeys.length === 0 ? (
              <span style={{ color: "var(--color-signal)" }}>none</span>
            ) : (
              <Mono>{railsWithKeys.map((r) => `${r.token}@${r.chain}`).join(", ")}</Mono>
            )}
          </p>
        </div>
      </DashCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DashCard className="lg:col-span-2">
          <div className="flex flex-col gap-5">
            <div className="flex items-center justify-between">
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
                Recent consumer intents
              </span>
              <Link
                href="/dashboard/consumer/review"
                className="text-body-sm underline-offset-4 hover:underline"
                style={{ color: "var(--color-data)" }}
              >
                Manual review →
              </Link>
            </div>

            {overview.recent.length === 0 ? (
              <NoHistory
                authenticated={scope.authenticated}
                address={scope.address}
                what="consumer activity"
                cta={
                  <Link
                    href="/dashboard/policies"
                    className="text-body-sm underline-offset-4 hover:underline"
                    style={{ color: "var(--color-data)" }}
                  >
                    Create a policy to govern consumer spend →
                  </Link>
                }
              />
            ) : (
              <div className="flex flex-col gap-3">
                {overview.recent.map((i) => (
                  <Link
                    key={i.intentId}
                    href={`/dashboard/consumer/${i.intentId}`}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-inputs px-4 py-3 transition-opacity hover:opacity-90"
                    style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border)" }}
                  >
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                        {i.action}
                      </span>
                      <Mono>{i.intentId}</Mono>
                    </div>
                    <div className="flex items-center gap-3">
                      {i.total ? (
                        <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                          {i.total}
                        </span>
                      ) : null}
                      <StateChip state={i.state} />
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Providers
            </span>
            <div className="flex flex-col gap-3">
              {overview.providers.map((p) => (
                <ProviderRow key={p.providerId} provider={p} />
              ))}
            </div>
            <Link
              href="/dashboard/consumer/treasury"
              className="text-body-sm underline-offset-4 hover:underline"
              style={{ color: "var(--color-data)" }}
            >
              Treasury operations →
            </Link>
          </div>
        </DashCard>
      </div>
    </div>
  );
}

function ProviderRow({ provider }: { provider: ProviderSummary }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
          {provider.displayName}
        </span>
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          {provider.capabilities.length} capabilit{provider.capabilities.length === 1 ? "y" : "ies"}
        </span>
      </div>
      <MaturityChip maturity={provider.maturity} />
    </div>
  );
}

export { DecisionChip };
