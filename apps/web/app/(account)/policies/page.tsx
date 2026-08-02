import Link from "next/link";
import { loadPolicies } from "../../../lib/account/views";
import { Card, Empty, KV, NotLinked, Panel, Refusal } from "../../../components/account/shell";

export const dynamic = "force-dynamic";

const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export default async function Policies() {
  const view = await loadPolicies();
  if (!view.authenticated) {
    return (
      <Panel title="Policies" sub="The rules a payment is judged against. Registered from your wallet, owned by your wallet.">
        <NotLinked />
      </Panel>
    );
  }
  if (view.refusal) {
    return (
      <Panel title="Policies">
        <Refusal code={view.refusal.code} message={view.refusal.message} />
      </Panel>
    );
  }

  return (
    <Panel
      title="Policies"
      sub="PolicyRegistry.registerPolicy makes msg.sender the owner. Untch does not relay it and cannot. A relayed policy would be owned by us, not by you."
    >
      {view.policies.length === 0 ? (
        <Empty
          what="No policies on this account."
          note="Draft one at POST /consumer/policies/draft, send the transaction from your own wallet, then sync it. The server builds the calldata and signs nothing."
        />
      ) : (
        view.policies.map((p) => {
          const id = s(p.policyId) ?? s(p.id) ?? "";
          return (
            <Card key={id}>
              <Link href={`/policies/${encodeURIComponent(id)}`} className="flex flex-col">
                <KV k="Policy" v={id} />
                <KV k="Owner" v={s(p.owner) ?? "—"} />
                <KV k="Status" v={`${s(p.status) ?? "?"}${view.defaultPolicyId === id ? " · DEFAULT" : ""}`} />
                <KV k="Hash" v={s(p.policyHash) ?? "—"} />
              </Link>
            </Card>
          );
        })
      )}
    </Panel>
  );
}
