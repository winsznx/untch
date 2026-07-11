import { DashCard, SectionTitle, Mono } from "../../../components/dashboard/ui";
import { PolicyActions } from "../../../components/dashboard/policy-actions";
import { getPolicy } from "../../../lib/dashboard/data";
import { addressUrl, txUrl } from "../../../lib/onchain";

const REGISTRY = "0xe1d74c90801db0fa806c72eb818b7671b8233532";
const ANCHORED_POLICY_ID = "76029468409583827837911952142544939415519701741486856172509180373326388092012";
const ANCHORED_POLICY_HASH = "0x308ec9d3a4059f28305277eaf33d45d35422cd8542d762fe3727c5cfed5aad3b";
const REGISTER_TX = "0x7f71579cabe5cabca30701bb46d58812170bcd38a0fe627c77437d8483998e6f";

export default function Policies() {
  const p = getPolicy();
  const r = p.rules;
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Policy builder" title="Spend policy" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Create, update, and pause are real transactions signed by your connected wallet against the deployed
        PolicyRegistry on X Layer testnet. Reading and canonical hashing are the same @untch/policy-store and
        @untch/canon surfaces the MCP preflight uses, so the ruleset you commit here is the ruleset your agent
        is checked against.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Guided rules</span>
            <KV k="Daily budget" v={`${r.budgets.daily} ${r.budgets.token}`} />
            <KV k="Per-call cap" v={`${r.perCallCap} · on exceed ${r.onPerCallCapExceeded}`} />
            <KV k="Escalate above" v={`${r.escalateAbove}`} />
            <KV k="Categories" v={r.categories.allow.join(", ")} />
            <KV k="Duplicate window" v={`${r.duplicates.ttlMin} min`} />
            <KV k="Cooldown" v={`${r.cooldowns.sameServiceMin} min same service`} />
            <KV k="Rate limit" v={`${r.rateLimit.callsPerHour}/hour`} />
            <KV k="Expiry" v={r.expiry} />
          </div>
        </DashCard>

        <DashCard>
          <PolicyActions initialRules={r} />
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-4">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>A committed policy on-chain</span>
          <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            The anchored demo policy already registered on X Layer testnet, for reference. Your own Create
            above commits a new one owned by your wallet.
          </p>
          <KV k="PolicyRegistry" v={<Link href={addressUrl("testnet", REGISTRY)}>{REGISTRY}</Link>} />
          <KV k="Anchored policyId" v={<Mono>{ANCHORED_POLICY_ID.slice(0, 20)}…</Mono>} />
          <KV k="Anchored policyHash" v={<Mono color="var(--color-data)">{ANCHORED_POLICY_HASH.slice(0, 22)}…</Mono>} />
          <KV k="registerPolicy tx" v={<Link href={txUrl("testnet", REGISTER_TX)}>{REGISTER_TX.slice(0, 22)}…</Link>} />
        </div>
      </DashCard>
    </div>
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
