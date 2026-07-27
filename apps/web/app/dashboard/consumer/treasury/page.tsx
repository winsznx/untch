import { DashCard, MastheadLink, Mono, SectionTitle, StatTile } from "../../../../components/dashboard/ui";
import { Field } from "../../../../components/dashboard/consumer-ui";
import { shortAddress, treasuryView } from "../../../../lib/dashboard/consumer";

export const dynamic = "force-dynamic";

export default async function ConsumerTreasury() {
  const view = await treasuryView();
  const settlement = view.rails.filter((r) => r.purpose === "SETTLEMENT");
  const funding = view.rails.filter((r) => r.purpose === "FUNDING");
  const engaged = view.pauses.filter((p) => p.paused);
  const lowBalance = settlement.filter((r) => r.belowFloor);
  const drifting = view.rails.filter((r) => r.drift !== null && r.drift !== "0.000000" && !r.drift.startsWith("0.0000"));

  return (
    <div className="flex flex-col gap-10">
      <SectionTitle
        kicker="Consumer Pack"
        title="Treasury operations"
        subtitle="Pre-funded operational floats, one per settlement rail. There is no bridge and no swap on the request path — replenishment is a documented manual step."
        action={<MastheadLink href="/dashboard/consumer">← Consumer Pack</MastheadLink>}
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatTile label="Settlement rails" value={String(settlement.length)} sub="pre-funded floats" accent="data" />
        <StatTile
          label="Enabled"
          value={String(settlement.filter((r) => r.enabled).length)}
          sub="able to pay a provider"
          accent={settlement.some((r) => r.enabled) ? "positive" : "muted"}
        />
        <StatTile
          label="Below floor"
          value={String(lowBalance.length)}
          sub={lowBalance.length > 0 ? "replenish now" : "all above minimum"}
          accent={lowBalance.length > 0 ? "signal" : "positive"}
        />
        <StatTile
          label="Kill switches"
          value={String(engaged.length)}
          sub={engaged.length > 0 ? "engaged" : "none engaged"}
          accent={engaged.length > 0 ? "signal" : "muted"}
        />
      </div>

      {!view.configured ? (
        <DashCard>
          <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            No database is configured for this instance, so there is no treasury state to show.
          </p>
        </DashCard>
      ) : null}

      <DashCard>
        <div className="flex flex-col gap-5">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Settlement floats
          </span>
          {settlement.length === 0 ? (
            <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              No settlement account is registered. A rail appears here once its signing key is configured
              (<Mono>CONSUMER_TREASURY_*_PRIVATE_KEY</Mono>); it becomes spendable once an operator funds it
              and enables it.
            </p>
          ) : (
            <div className="flex flex-col gap-4">
              {settlement.map((r) => (
                <div
                  key={r.treasuryRef}
                  className="rounded-inputs p-4"
                  style={{
                    background: "var(--color-canvas)",
                    border: `1px solid ${r.belowFloor ? "var(--color-signal)" : "var(--color-border)"}`,
                  }}
                >
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    <Field label="Rail">
                      {r.token} · {r.chain}
                    </Field>
                    <Field label="Address">
                      <Mono>{shortAddress(r.address)}</Mono>
                    </Field>
                    <Field label="On-chain balance">{r.onchain ?? "not yet observed"}</Field>
                    <Field label="Ledger position">{r.ledger ?? "—"}</Field>
                    <Field label="Minimum floor">{r.minBalance}</Field>
                    <Field label="Daily limit">{r.dailyLimit === "0.000000" ? "unlimited" : r.dailyLimit}</Field>
                    <Field label="Drift">
                      <span style={{ color: r.drift && r.drift !== "0.000000" ? "var(--color-signal)" : "var(--color-text)" }}>
                        {r.drift ?? "—"}
                      </span>
                    </Field>
                    <Field label="Enabled">
                      <span style={{ color: r.enabled ? "var(--color-positive)" : "var(--color-inverse-muted)" }}>
                        {r.enabled ? "yes" : "no"}
                      </span>
                    </Field>
                  </div>
                  {r.belowFloor ? (
                    <p className="mt-3 text-body-sm" style={{ color: "var(--color-signal)" }}>
                      Below its minimum floor. New capabilities on this rail are refused until it is
                      replenished — see docs/consumer-pack-runbook.md → &ldquo;Low provider wallet balance&rdquo;.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>
      </DashCard>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              User funding rail
            </span>
            {funding.length === 0 ? (
              <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                No funding account registered.
              </span>
            ) : (
              funding.map((r) => (
                <div key={r.treasuryRef} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <Field label="Rail">
                    {r.token} · {r.chain}
                  </Field>
                  <Field label="payTo">
                    <Mono>{shortAddress(r.address)}</Mono>
                  </Field>
                </div>
              ))
            )}
            <p className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
              Users fund one intent at a time, for its exact authorised amount, through x402 dynamic
              pricing at <Mono>POST /consumer/fund/:intentId</Mono>. This is separate from the fixed
              marketplace call fee.
            </p>
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-5">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              Kill switches
            </span>
            {engaged.length === 0 ? (
              <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                No pause is engaged. Execution is governed by policy and provider maturity alone.
              </span>
            ) : (
              <div className="flex flex-col gap-3">
                {engaged.map((p) => (
                  <div key={`${p.scope}:${p.target}`} className="flex flex-col gap-1">
                    <span className="text-body-sm" style={{ color: "var(--color-signal)" }}>
                      {p.scope}
                      {p.target === "*" ? "" : ` · ${p.target}`}
                    </span>
                    <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
                      {p.reason || "no reason recorded"} · set by {p.setBy || "unknown"}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
              Scopes: GLOBAL, PROVIDER, CHAIN, ASSET, TREASURY_ACCOUNT. Any engaged pause refuses a
              payment capability before it is minted, so nothing reaches a rail.
            </p>
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-3">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Reconciliation
          </span>
          {drifting.length === 0 ? (
            <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
              No drift recorded between the chain and the ledger.
            </p>
          ) : (
            <p className="text-body-sm" style={{ color: "var(--color-signal)" }}>
              {drifting.length} account{drifting.length === 1 ? "" : "s"} show drift between the on-chain
              balance and the internal ledger position.
            </p>
          )}
          <p className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            Drift is recorded and never auto-corrected. An automatic correction would make the ledger
            agree with the chain by construction and destroy its value as an independent record.
          </p>
        </div>
      </DashCard>
    </div>
  );
}
