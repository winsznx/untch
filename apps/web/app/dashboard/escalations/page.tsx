import { DashCard, SectionTitle, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { EscalationResolution } from "../../../components/dashboard/escalation-decision";
import { liveEscalations, type EscalationView } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";

/** Reads the operator's real escalations from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function Escalations() {
  const scope = await getScope();
  if (!scope.authenticated) {
    return (
      <div className="flex flex-col gap-8">
        <SectionTitle kicker="Approvals" title="Escalation inbox" />
        <NoHistory authenticated={false} address={scope.address} what="escalations" />
      </div>
    );
  }
  const escalations = await liveEscalations(scope.address);
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Approvals" title="Escalation inbox" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Every escalation the policy engine raised for your agents, read live from the same @untch/escalation
        store the control channels resolve against. Resolution happens through the bound channels (Telegram,
        Discord, Slack); each row shows its real status and how it was resolved.
      </p>

      {escalations.length === 0 ? (
        <DashCard>
          <span className="text-body" style={{ color: "var(--color-inverse-muted)" }}>No escalations for this wallet.</span>
        </DashCard>
      ) : (
        escalations.map((e) => <EscalationCard key={e.id} e={e} />)
      )}
    </div>
  );
}

function EscalationCard({ e }: { e: EscalationView }) {
  return (
    <DashCard>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{e.amount.toFixed(2)} {e.token}</span>
            <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>{e.reason} · <Mono>{e.id}</Mono></span>
          </div>
          <span className="rounded-tags px-3 py-1 text-caption-lg" style={{ border: "1px solid var(--color-signal)", color: "var(--color-signal)" }}>
            {e.status}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Intent" value={`${e.intentHash.slice(0, 14)}…`} />
          <Field label="Channels" value={e.channels.length ? e.channels.join(", ") : "caller's live channels"} />
          <Field label="Dual-channel above" value={e.dualChannelAbove !== null ? `${e.dualChannelAbove} ${e.token}` : "not required"} />
        </div>

        <EscalationResolution status={e.status} resolvedBy={e.resolvedBy} approvedChannels={e.approvedChannels} />
      </div>
    </DashCard>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>{label}</span>
      <span className="text-body-sm" style={{ color: "var(--color-text)" }}>{value}</span>
    </div>
  );
}
