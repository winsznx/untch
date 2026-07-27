import { DashCard, MastheadLink, Mono, SectionTitle, StatTile } from "../../../../components/dashboard/ui";
import { MaturityChip } from "../../../../components/dashboard/consumer-ui";
import { providerRegistry } from "../../../../lib/dashboard/consumer";

export const dynamic = "force-dynamic";

export default async function ConsumerProviders() {
  const providers = await providerRegistry();
  const counts = {
    verified: providers.filter((p) => p.maturity === "verified").length,
    sandbox: providers.filter((p) => p.maturity === "sandbox").length,
    experimental: providers.filter((p) => p.maturity === "experimental").length,
    disabled: providers.filter((p) => p.maturity === "disabled").length,
  };

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle
        kicker="Consumer Pack"
        title="Provider registry"
        subtitle="What each integration actually is, and what has actually been proven about it. Only a verified provider can move money."
        action={<MastheadLink href="/dashboard/consumer">← Consumer Pack</MastheadLink>}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Verified"
          value={String(counts.verified)}
          sub="settlement observed"
          accent={counts.verified > 0 ? "positive" : "muted"}
        />
        <StatTile label="Sandbox" value={String(counts.sandbox)} sub="implemented, never settled" accent="data" />
        <StatTile label="Experimental" value={String(counts.experimental)} sub="a leg is unverified" accent="signal" />
        <StatTile label="Disabled" value={String(counts.disabled)} sub="not integrated" accent="muted" />
      </div>

      <DashCard>
        <div className="flex flex-col gap-3">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            What the maturity ladder means
          </span>
          <dl className="flex flex-col gap-2 text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            <div className="flex gap-3">
              <dt style={{ color: "var(--color-positive)", minWidth: 110 }}>verified</dt>
              <dd>
                A real settled payment from an Untch treasury wallet has been observed, and its delivery
                was verified. Only these execute on a production route.
              </dd>
            </div>
            <div className="flex gap-3">
              <dt style={{ color: "var(--color-data)", minWidth: 110 }}>sandbox</dt>
              <dd>
                Adapter implemented, schemas validated against the live spec, protocol shape read from a
                real 402. No settlement has ever been made.
              </dd>
            </div>
            <div className="flex gap-3">
              <dt style={{ color: "var(--color-signal)", minWidth: 110 }}>experimental</dt>
              <dd>
                Reachable, but a required leg is unverified — an identity we do not hold, or a rail we
                cannot settle. Cannot execute under any configuration.
              </dd>
            </div>
            <div className="flex gap-3">
              <dt style={{ color: "var(--color-inverse-muted)", minWidth: 110 }}>disabled</dt>
              <dd>Not integrated. Cannot be selected at all.</dd>
            </div>
          </dl>
        </div>
      </DashCard>

      <div className="flex flex-col gap-4">
        {providers.length === 0 ? (
          <DashCard>
            <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              No provider is registered on this instance.
            </p>
          </DashCard>
        ) : (
          providers.map((p) => (
            <DashCard key={p.providerId}>
              <div className="flex flex-col gap-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
                      {p.displayName}
                    </span>
                    <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                      {p.protocol} · {p.chains.join(", ") || "no chain recorded"}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    {p.healthy === null ? null : (
                      <span
                        className="text-caption"
                        style={{ color: p.healthy ? "var(--color-positive)" : "var(--color-signal)" }}
                      >
                        {p.healthy ? "reachable" : "unreachable"}
                        {p.latencyMs === null ? "" : ` · ${p.latencyMs}ms`}
                      </span>
                    )}
                    {p.breaker && p.breaker !== "CLOSED" ? (
                      <span className="text-caption" style={{ color: "var(--color-signal)" }}>
                        breaker {p.breaker.toLowerCase()}
                      </span>
                    ) : null}
                    <MaturityChip maturity={p.maturity} />
                  </div>
                </div>

                <div className="flex flex-col gap-2">
                  <span
                    className="text-caption uppercase"
                    style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}
                  >
                    Capabilities
                  </span>
                  <div className="flex flex-col gap-2">
                    {p.capabilities.map((c) => (
                      <div key={c.capability} className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <Mono color="var(--color-text)">{c.capability}</Mono>
                          {c.notes ? (
                            <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                              {c.notes}
                            </span>
                          ) : null}
                        </div>
                        <MaturityChip maturity={c.maturity} />
                      </div>
                    ))}
                  </div>
                </div>

                {/*
                  The provenance string is the whole point of this screen: it is a factual record of
                  what was actually observed, when, and from where — not a marketing description.
                */}
                <div className="flex flex-col gap-2 border-t pt-4" style={{ borderColor: "var(--color-border)" }}>
                  <span
                    className="text-caption uppercase"
                    style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}
                  >
                    Provenance
                  </span>
                  <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                    {p.provenance || "No provenance recorded."}
                  </p>
                </div>
              </div>
            </DashCard>
          ))
        )}
      </div>
    </div>
  );
}
