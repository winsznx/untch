import { loadAccount } from "../../../lib/account/views";
import { Card, KV, NotLinked, Panel, Refusal } from "../../../components/account/shell";

export const dynamic = "force-dynamic";

type Dict = Record<string, unknown>;
const arr = (v: unknown): Dict[] => (Array.isArray(v) ? (v as Dict[]) : []);
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);

export default async function AccountPage() {
  const view = await loadAccount();
  if (!view.authenticated) {
    return (
      <Panel title="Account" sub="A wallet, and everything that wallet has proven.">
        <NotLinked />
      </Panel>
    );
  }
  if (view.refusal || !view.account) {
    return (
      <Panel title="Account">
        <Refusal code={view.refusal?.code ?? "ACCOUNT_UNAVAILABLE"} message={view.refusal?.message ?? "no account"} />
      </Panel>
    );
  }

  const a = view.account;
  const wallets = arr(a.wallets);
  const marketplaces = arr(a.marketplaceBindings ?? a.marketplaces);
  const channels = arr(a.channels);

  return (
    <Panel title="Account">
      <Card>
        <KV k="Account" v={s(a.accountId) ?? "—"} />
        <KV k="Status" v={s(a.status) ?? "—"} />
        <KV k="Default policy" v={s(a.defaultPolicyId) ?? "none chosen"} />
        <KV k="Last used policy" v={s(a.lastUsedPolicyId) ?? "—"} />
      </Card>

      <Panel
        title="Wallets"
        sub="A wallet proven by signature is the only thing that carries authority here. A declared binding is a note."
      >
        {wallets.length === 0 ? (
          <Card><span className="text-caption">No wallet bindings.</span></Card>
        ) : (
          wallets.map((w) => (
            <Card key={String(w.bindingId)}>
              <KV k="Address" v={s(w.address) ?? "—"} />
              <KV k="Role" v={`${s(w.role) ?? "?"} · proven by ${s(w.proofKind) ?? "?"}`} />
              <KV k="Scopes" v={Array.isArray(w.scopes) ? (w.scopes as string[]).join(", ") : "—"} />
              <KV k="Status" v={s(w.status) ?? "—"} />
            </Card>
          ))
        )}
      </Panel>

      <Panel
        title="Marketplace"
        /* `unproven` is shown as itself. It is the schema saying an agent id arrived in a header, and
           a reader deciding how far to trust a decision needs that word rather than a green tick. */
        sub="An agent id is a claim until this account's own wallet has signed for it."
      >
        {marketplaces.length === 0 ? (
          <Card><span className="text-caption">No marketplace binding.</span></Card>
        ) : (
          marketplaces.map((m) => (
            <Card key={String(m.bindingId)}>
              <KV k={s(m.marketplace) ?? "marketplace"} v={s(m.agentId) ?? "—"} />
              <KV k="Proven by" v={s(m.provenBy) ?? "—"} />
              <KV k="Status" v={s(m.status) ?? "—"} />
            </Card>
          ))
        )}
      </Panel>

      <Panel title="Channels" sub="A channel delivers a request. No channel proves control. Only a signature does.">
        {channels.length === 0 ? (
          <Card><span className="text-caption">No channel bindings. The web is the channel.</span></Card>
        ) : (
          channels.map((c) => (
            <Card key={String(c.bindingId)}>
              <KV k={s(c.channel) ?? "channel"} v={s(c.status) ?? "—"} />
            </Card>
          ))
        )}
      </Panel>
    </Panel>
  );
}
