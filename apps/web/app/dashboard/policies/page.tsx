import { DashCard, SectionTitle, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { PolicyActions } from "../../../components/dashboard/policy-actions";
import { DEFAULT_POLICY_RULES } from "../../../lib/dashboard/data";
import { livePolicies, type PolicyView } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";
import { addressUrl, txUrl } from "../../../lib/onchain";

const REGISTRY = "0xe1d74c90801db0fa806c72eb818b7671b8233532";

/** Reads the operator's real registered policies from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function Policies() {
  const scope = await getScope();
  const policies = scope.authenticated ? await livePolicies(scope.address) : [];
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Policy builder" title="Spend policy" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Create, update, and pause are real transactions signed by your connected wallet against the deployed
        PolicyRegistry on X Layer testnet. The list below is read live from the same @untch/policy-store the
        MCP preflight enforces against — so a policy your agent was created with (via the seller's
        create_spend_policy) and one you register here are the same rows, shown here.
      </p>

      {!scope.authenticated ? (
        <NoHistory authenticated={false} address={scope.address} what="policies" />
      ) : policies.length === 0 ? (
        <DashCard>
          <span className="text-body" style={{ color: "var(--color-inverse-muted)" }}>
            No policies registered to this wallet yet. Create one below, or have the seller register one for
            your agent — either way it appears here.
          </span>
        </DashCard>
      ) : (
        <div className="flex flex-col gap-4">
          {policies.map((p) => <PolicyCard key={p.id} p={p} />)}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Starting template</span>
            <KV k="Daily budget" v={`${DEFAULT_POLICY_RULES.budgets.daily} ${DEFAULT_POLICY_RULES.budgets.token}`} />
            <KV k="Per-call cap" v={`${DEFAULT_POLICY_RULES.perCallCap} · on exceed ${DEFAULT_POLICY_RULES.onPerCallCapExceeded}`} />
            <KV k="Escalate above" v={`${DEFAULT_POLICY_RULES.escalateAbove}`} />
            <KV k="Categories" v={DEFAULT_POLICY_RULES.categories.allow.join(", ")} />
            <KV k="Rate limit" v={`${DEFAULT_POLICY_RULES.rateLimit.callsPerHour}/hour`} />
            <KV k="Expiry" v={DEFAULT_POLICY_RULES.expiry} />
          </div>
        </DashCard>

        <DashCard>
          <PolicyActions initialRules={DEFAULT_POLICY_RULES} />
        </DashCard>
      </div>

      <DashCard>
        <KV k="PolicyRegistry (X Layer testnet)" v={<Link href={addressUrl("testnet", REGISTRY)}>{REGISTRY}</Link>} />
      </DashCard>
    </div>
  );
}

function PolicyCard({ p }: { p: PolicyView }) {
  const r = p.rules;
  const statusColor = p.status === "ACTIVE" ? "var(--color-positive)" : "var(--color-inverse-muted)";
  return (
    <DashCard>
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Policy <Mono>{p.id.slice(0, 12)}…</Mono></span>
            <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
              agent <Mono>{p.agentId.slice(0, 10)}…</Mono> · v{p.version}
            </span>
          </div>
          <span className="rounded-tags px-3 py-1 text-caption-lg" style={{ border: `1px solid ${statusColor}`, color: statusColor }}>
            {p.status}
          </span>
        </div>
        <KV k="Daily budget" v={`${r.budgets.daily} ${r.budgets.token}`} />
        <KV k="Per-call cap" v={`${r.perCallCap} · on exceed ${r.onPerCallCapExceeded}`} />
        <KV k="Escalate above" v={`${r.escalateAbove}`} />
        <KV k="Categories" v={r.categories.allow.join(", ") || "—"} />
        <KV k="policyHash" v={<Mono color="var(--color-data)">{p.policyHash.slice(0, 22)}…</Mono>} />
        <KV k="registerPolicy tx" v={<Link href={txUrl("testnet", p.registerTx)}>{p.registerTx.slice(0, 22)}…</Link>} />
      </div>
    </DashCard>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>{k}</span>
      <span className="text-body-sm" style={{ color: "var(--color-text)" }}>{v}</span>
    </div>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
      {children}
    </a>
  );
}
