import { loadPolicy } from "../../../../lib/account/views";
import { Back, Card, KV, NotLinked, Panel, Refusal } from "../../../../components/account/shell";

export const dynamic = "force-dynamic";

type Dict = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export default async function PolicyDetail({ params }: { params: Promise<{ policyId: string }> }) {
  const { policyId } = await params;
  const view = await loadPolicy(policyId);
  if (!view.authenticated) {
    return <Panel title="Policy"><NotLinked /></Panel>;
  }
  if (view.refusal || !view.policy) {
    return (
      <Panel title="Policy">
        <Back href="/policies" label="All policies" />
        <Refusal code={view.refusal?.code ?? "POLICY_NOT_FOUND"} message={view.refusal?.message ?? "no policy"} />
      </Panel>
    );
  }
  const p = view.policy;
  const rules = (typeof p.rules === "object" && p.rules !== null ? p.rules : {}) as Dict;
  const readable = Array.isArray(p.readable) ? (p.readable as string[]) : [];

  return (
    <Panel title={`Policy ${s(p.policyId) ?? s(p.id) ?? policyId}`}>
      <Back href="/policies" label="All policies" />
      <Card>
        <KV k="Owner" v={s(p.owner) ?? "—"} />
        <KV k="Governed agent" v={s(p.agentId) ?? s(p.agent) ?? "—"} />
        <KV k="Status" v={s(p.status) ?? "—"} />
        <KV k="Version" v={String(p.version ?? "—")} />
        {/* Published because it was an unobtainable predecessor: preflight needs it and nothing returned it. */}
        <KV k="Policy hash" v={s(p.policyHash) ?? "—"} />
        <KV k="Expiry" v={s(p.expiry) ?? String(p.expiry ?? "—")} />
      </Card>
      {readable.length > 0 ? (
        <Panel title="What it allows">
          <Card>
            {readable.map((line) => (
              <div key={line} className="py-1 text-caption" style={{ color: "var(--color-text)" }}>{line}</div>
            ))}
          </Card>
        </Panel>
      ) : null}
      <Panel title="Canonical rules" sub="The exact bytes the hash above commits to.">
        <Card>
          <pre className="overflow-x-auto text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            {JSON.stringify(rules, null, 2)}
          </pre>
        </Card>
      </Panel>
    </Panel>
  );
}
