import { DashCard, SectionTitle, Meter, StandInBanner, Mono } from "../../../components/dashboard/ui";
import { getVault } from "../../../lib/dashboard/data";
import { addressUrl } from "../../../lib/onchain";

export default function Vault() {
  const v = getVault();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Mode C" title="Vault" />

      <StandInBanner>
        The vault, factory, and oracle addresses below are the real UntchVault deployed on X Layer testnet
        (its spend and withdraw transactions are on its address page). The epoch gauge and caps are seeded, and
        deploy, deposit, withdraw, and pause need the connected owner wallet.
      </StandInBanner>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Epoch budget</span>
            <div className="flex items-end justify-between">
              <span className="text-heading-lg" style={{ color: "var(--color-data)" }}>{v.epochSpent.toFixed(2)}</span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>of {v.epochBudget} · {v.epochLenHours}h epoch</span>
            </div>
            <Meter value={v.epochSpent} max={v.epochBudget} color="var(--color-data)" />
            <div className="flex flex-wrap gap-6 pt-2">
              <Stat label="Per-tx cap" value={`${v.perTxCap}`} />
              <Stat label="Oracle" value={v.paused ? "paused" : "live"} color={v.paused ? "var(--color-inverse-muted)" : "var(--color-positive)"} />
            </div>
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Deployed contracts</span>
            <Addr label="Vault" addr={v.address} />
            <Addr label="Factory" addr={v.factory} />
            <Addr label="Token" addr={v.token} />
            <Addr label="Oracle key" addr={v.oracle} />
          </div>
        </DashCard>
      </div>

      <DashCard>
        <div className="flex flex-col gap-4">
          <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Actions</span>
          <div className="flex flex-wrap gap-3">
            {["Deploy", "Deposit", "Withdraw", v.paused ? "Unpause" : "Pause"].map((a) => (
              <span key={a} aria-disabled="true" className="rounded-buttons px-6 py-3 text-body-sm" style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-muted)", opacity: 0.6 }}>
                {a} · needs owner wallet
              </span>
            ))}
          </div>
          <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            The oracle key cannot withdraw or transfer funds. Owner withdraw is unconditional and needs nothing
            from Untch (invariant I4).
          </p>
        </div>
      </DashCard>
    </div>
  );
}

function Stat({ label, value, color = "var(--color-text)" }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>{label}</span>
      <span className="text-body" style={{ color }}>{value}</span>
    </div>
  );
}

function Addr({ label, addr }: { label: string; addr: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>{label}</span>
      <a href={addressUrl("testnet", addr)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        <Mono color="var(--color-data)">{addr.slice(0, 10)}…{addr.slice(-6)}</Mono>
      </a>
    </div>
  );
}
