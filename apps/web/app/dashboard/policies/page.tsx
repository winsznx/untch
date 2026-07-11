import { DashCard, SectionTitle, Mono, StandInBanner } from "../../../components/dashboard/ui";
import { getPolicy } from "../../../lib/dashboard/data";
import { addressUrl, txUrl } from "../../../lib/onchain";

const REGISTRY = "0xe1d74c90801db0fa806c72eb818b7671b8233532";
const ANCHORED_POLICY_ID = "76029468409583827837911952142544939415519701741486856172509180373326388092012";
const ANCHORED_POLICY_HASH = "0x308ec9d3a4059f28305277eaf33d45d35422cd8542d762fe3727c5cfed5aad3b";
const REGISTER_TX = "0x6a70b3063c5bce091408940692cecf84764428c8dff343d642fc5f3acde00c6c";

export default function Policies() {
  const p = getPolicy();
  const r = p.rules;
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Policy builder" title="Spend policy" />

      <StandInBanner>
        Reading and hashing are real (@untch/policy-store validation + @untch/canon canonical hash). Create,
        update, and pause broadcast to the on-chain PolicyRegistry and need the connected operator wallet, which
        the demo stand-in does not hold. The buttons below are shown disabled.
      </StandInBanner>

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
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Raw JSON</span>
              <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>version {p.version} · {p.status}</span>
            </div>
            <pre className="overflow-x-auto rounded-inputs p-4 text-caption-lg" style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)", color: "var(--color-inverse-canvas)", fontFamily: "ui-monospace, monospace" }}>
{p.rulesJson}
            </pre>
            <div className="flex flex-wrap gap-3">
              <DisabledAction label="Update policy" />
              <DisabledAction label="Pause policy" />
            </div>
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-4">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>On-chain status</span>
          <KV k="Policy hash (this ruleset)" v={<Mono color="var(--color-data)">{p.policyHash}</Mono>} />
          <KV k="Version" v={`${p.version} (monotonic; no diff view — version is an integer, not a diff)`} />
          <div style={{ borderTop: "1px solid var(--color-border-soft)" }} className="pt-4">
            <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>Real anchored demo policy on X Layer testnet</span>
          </div>
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

function DisabledAction({ label }: { label: string }) {
  return (
    <span
      aria-disabled="true"
      className="rounded-buttons px-6 py-3 text-body-sm"
      style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-muted)", opacity: 0.6 }}
    >
      {label} · needs wallet
    </span>
  );
}

function Link({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
      {children}
    </a>
  );
}
