import Link from "next/link";
import { loadCases } from "../../../lib/account/views";
import { Card, Empty, KV, NotLinked, Panel } from "../../../components/account/shell";

export const dynamic = "force-dynamic";

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export default async function Activity() {
  const view = await loadCases();
  if (!view.authenticated) {
    return (
      <Panel title="Activity" sub="Every case: what was asked, what decided it, what moved.">
        <NotLinked />
      </Panel>
    );
  }

  if (!view.available) {
    return (
      <Panel title="Activity">
        {/*
          The honest state. Migration 018 created the tables; the indexer that fills them and the route
          that serves them are the next slice. A table rendered from nothing would look complete and be
          empty, which reads as "you have no activity" rather than "this is not built".
        */}
        <Empty what="The case projection is not served yet." note={view.unavailableReason ?? undefined} />
      </Panel>
    );
  }

  return (
    <Panel title="Activity" sub="A case answers what was requested, which policy governed it, what was decided, and what moved.">
      {view.cases.length === 0 ? (
        <Empty what="No cases on this account yet." />
      ) : (
        view.cases.map((c) => {
          const id = s(c.caseId) ?? "";
          return (
            <Card key={id}>
              <Link href={`/cases/${encodeURIComponent(id)}`} className="flex flex-col">
                <KV k="Case" v={id} />
                <KV k="What" v={s(c.summary) ?? s(c.task) ?? "—"} />
                <KV k="State" v={s(c.state) ?? "—"} />
                <KV k="Opened" v={s(c.createdAt) ?? "—"} />
              </Link>
            </Card>
          );
        })
      )}
    </Panel>
  );
}
