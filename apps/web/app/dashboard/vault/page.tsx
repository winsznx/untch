import { DashCard, SectionTitle, Meter, Mono } from "../../../components/dashboard/ui";
import { VaultActions } from "../../../components/dashboard/vault-actions";
import { getVault } from "../../../lib/dashboard/data";
import { getScope } from "../../../lib/dashboard/scope";
import { addressUrl } from "../../../lib/onchain";

export default async function Vault() {
  const v = getVault();
  const scope = await getScope();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Mode C" title="Vault" />

      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        The factory, token, and reference vault below are the real UntchVault deployment on X Layer testnet.
        Deploy, deposit, withdraw, and pause are real transactions signed by your connected owner wallet, and
        act on a vault you deploy and own. Automated day-to-day spend signing (Mode C oracle service) is a
        separate later piece and is not part of these direct owner actions.
      </p>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <DashCard>
          <div className="flex flex-col gap-4">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Epoch budget</span>
            {scope.isDemoOperator ? (
              <>
                <div className="flex items-end justify-between">
                  <span className="text-heading-lg" style={{ color: "var(--color-data)" }}>{v.epochSpent.toFixed(2)}</span>
                  <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>of {v.epochBudget} · {v.epochLenHours}h epoch</span>
                </div>
                <Meter value={v.epochSpent} max={v.epochBudget} color="var(--color-data)" />
                <div className="flex flex-wrap gap-6 pt-2">
                  <Stat label="Per-tx cap" value={`${v.perTxCap}`} />
                  <Stat label="Oracle" value={v.paused ? "paused" : "live"} color={v.paused ? "var(--color-inverse-muted)" : "var(--color-positive)"} />
                </div>
              </>
            ) : (
              <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                No vault deployed for this wallet yet. Deploy one below to see its epoch usage, per-tx cap, and
                oracle status here.
              </p>
            )}
          </div>
        </DashCard>

        <DashCard>
          <div className="flex flex-col gap-3">
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>Reference deployment (demo vault)</span>
            <Addr label="Vault" addr={v.address} />
            <Addr label="Factory" addr={v.factory} />
            <Addr label="Token" addr={v.token} />
            <Addr label="Oracle key" addr={v.oracle} />
          </div>
        </DashCard>
      </div>

      <DashCard>
        <VaultActions />
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
