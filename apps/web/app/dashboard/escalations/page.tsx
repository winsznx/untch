import { DashCard, SectionTitle, StandInBanner, Mono } from "../../../components/dashboard/ui";
import { getEscalations, type EscalationView } from "../../../lib/dashboard/data";

export default function Escalations() {
  const escalations = getEscalations();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Approvals" title="Escalation inbox" />

      <StandInBanner>
        The live escalation service (@untch/escalation) runs on BullMQ + Redis with a timeout worker, which the
        dashboard has no running instance of. The records below use the package's real status and approvals
        shapes but are seeded; approve and deny are shown disabled.
      </StandInBanner>

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

function EscalationCard({ e }: { e: EscalationView }) {
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
          <Field label="Dual-channel above" value={`${e.dualChannelAbove} ${e.token}`} />
          <Field label="Per-channel caps" value={Object.entries(e.channelCaps).map(([c, v]) => `${c} ${v}`).join(", ")} />
        </div>

        <div className="flex flex-wrap gap-3">
          <Disabled label="Approve" />
          <Disabled label="Deny" />
        </div>
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

function Disabled({ label }: { label: string }) {
  return (
    <span aria-disabled="true" className="rounded-buttons px-6 py-3 text-body-sm" style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-muted)", opacity: 0.6 }}>
      {label} · needs live service
    </span>
  );
}
