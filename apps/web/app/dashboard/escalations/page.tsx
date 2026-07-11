import { DashCard, SectionTitle, Mono } from "../../../components/dashboard/ui";
import { EscalationDecision } from "../../../components/dashboard/escalation-decision";
import { listDashboardEscalations, type DashboardEscalationView } from "../../../lib/dashboard/escalation-runtime";
import { getScope } from "../../../lib/dashboard/scope";

/** The in-process escalation state changes on approve/deny, so this reads live per request. */
export const dynamic = "force-dynamic";

export default async function Escalations() {
  const scope = await getScope();
  // The seeded escalation belongs to the demo operator; any other signed-in wallet has none of its own.
  const escalations = scope.isDemoOperator ? await listDashboardEscalations() : [];
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Approvals" title="Escalation inbox" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Dashboard is a real fourth control channel alongside Telegram, Discord, and Slack. Approve or deny
        runs through the same @untch/escalation §27 authority-boundary check, authorized by your signed-in
        session identity. There is no separate signature per click: proving you control the wallet is what
        authorizes the approval, exactly as a bound Telegram handle does.
      </p>

      {escalations.length === 0 ? (
        <DashCard>
          <span className="text-body" style={{ color: "var(--color-inverse-muted)" }}>No pending escalations.</span>
        </DashCard>
      ) : (
        escalations.map((e) => <EscalationCard key={e.id} e={e} />)
      )}
    </div>
  );
}

function EscalationCard({ e }: { e: DashboardEscalationView }) {
  return (
    <DashCard>
      <div className="flex flex-col gap-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{e.amount.toFixed(2)} {e.token} · {e.vendor}</span>
            <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>{e.reason} · <Mono>{e.id}</Mono></span>
          </div>
          <span className="rounded-tags px-3 py-1 text-caption-lg" style={{ border: "1px solid var(--color-signal)", color: "var(--color-signal)" }}>
            {e.status}
          </span>
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Field label="Channels" value={e.channels.join(", ")} />
          <Field label="Dual-channel above" value={e.dualChannelAbove !== null ? `${e.dualChannelAbove} ${e.token}` : "not required"} />
          <Field label="Per-channel caps" value={Object.entries(e.channelCaps).map(([c, v]) => `${c} ${v}`).join(", ") || "none"} />
        </div>

        <EscalationDecision escalationId={e.id} status={e.status} />
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
