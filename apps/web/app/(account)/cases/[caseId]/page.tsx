import { loadCases } from "../../../../lib/account/views";
import { Back, Card, Empty, KV, NotLinked, Panel } from "../../../../components/account/shell";

export const dynamic = "force-dynamic";

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export default async function CaseTimeline({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const view = await loadCases(caseId);

  if (!view.authenticated) return <Panel title="Case"><NotLinked /></Panel>;

  if (!view.available) {
    return (
      <Panel title={`Case ${caseId}`}>
        <Back href="/activity" label="All activity" />
        <Empty what="The case projection is not served yet." note={view.unavailableReason ?? undefined} />
      </Panel>
    );
  }

  return (
    <Panel title={`Case ${caseId}`}>
      <Back href="/activity" label="All activity" />
      {view.timeline.length === 0 ? (
        <Empty what="No events on this case." />
      ) : (
        <div className="flex flex-col gap-2">
          {view.timeline.map((e, i) => (
            <Card key={`${s(e.eventId) ?? i}`}>
              <KV k={s(e.type) ?? "event"} v={s(e.at) ?? s(e.observedAt) ?? "—"} />
              <KV k="Detail" v={s(e.detail) ?? s(e.summary) ?? "—"} />
              {s(e.transactionHash) ? <KV k="Transaction" v={s(e.transactionHash) as string} /> : null}
              {s(e.status) ? <KV k="Status" v={s(e.status) as string} /> : null}
            </Card>
          ))}
        </div>
      )}
    </Panel>
  );
}
