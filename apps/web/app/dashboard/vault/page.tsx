import { DashCard, SectionTitle, Meter, Mono } from "../../../components/dashboard/ui";
import { VaultActions } from "../../../components/dashboard/vault-actions";
import { getVault } from "../../../lib/dashboard/data";
import { getScope } from "../../../lib/dashboard/scope";
import { productAddressUrl, productExplorerNet, addressUrl } from "../../../lib/onchain";

export default async function Vault() {
  const v = getVault();
  const scope = await getScope();
  const net = productExplorerNet();
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Mode C"
        title="Vault"
        subtitle={
          v.isDemo
            ? "Reference UntchVault on X Layer testnet. Deploy your own via the factory on the product chain."
            : "Deploy, fund, withdraw and pause a vault you own on the product chain. Each is a transaction signed by your owner wallet. Mainnet has no fixed demo vault."
        }
      />

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
            <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
              {v.isDemo ? "Reference deployment (testnet demo vault)" : "Product contracts"}
            </span>
            {v.address ? <Addr label="Vault" addr={v.address} net={v.isDemo ? "testnet" : net} /> : (
              <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                No fixed demo vault on mainnet — deploy via factory below.
              </p>
            )}
            <Addr label="Factory" addr={v.factory} net={net} />
            <Addr label="Token" addr={v.token} net={net} />
            {v.oracle ? <Addr label="Oracle key" addr={v.oracle} net={v.isDemo ? "testnet" : net} /> : null}
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

function Addr({ label, addr, net }: { label: string; addr: string; net: "mainnet" | "testnet" }) {
  const href = net === productExplorerNet() ? productAddressUrl(addr) : addressUrl(net, addr);
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3">
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>{label}</span>
      <a href={href} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline">
        <Mono color="var(--color-data)">{addr.slice(0, 10)}…{addr.slice(-6)}</Mono>
      </a>
    </div>
  );
}
