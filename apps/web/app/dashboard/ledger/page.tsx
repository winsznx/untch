import { DashCard, SectionTitle } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { LedgerExport } from "../../../components/dashboard/ledger-export";
import { liveLedger } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";
import { productTxUrl } from "../../../lib/onchain";

const TYPE_COLOR: Record<string, string> = {
  SPEND: "var(--color-text)",
  BLOCK_SAVED: "var(--color-signal)",
  FEE_UNTCH: "var(--color-data)",
  REFUND: "var(--color-positive)",
};

/** Reads the operator's real ledger entries from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function Ledger() {
  const scope = await getScope();
  const entries = scope.authenticated ? await liveLedger(scope.address) : [];
  if (!scope.authenticated || entries.length === 0) {
    return (
      <div className="flex flex-col gap-8">
        <SectionTitle
          kicker="Ledger"
          title="Ledger explorer"
          subtitle="Append-only money record. SPEND moved, BLOCK_SAVED was prevented. Anchored rows link to their on-chain receipt."
        />
        <NoHistory authenticated={scope.authenticated} address={scope.address} what="ledger entries" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle
        kicker="Ledger"
        title="Ledger explorer"
        subtitle="Append-only money record. SPEND moved, BLOCK_SAVED was prevented. Anchored rows link to their on-chain receipt, and export downloads the exact rows shown."
      />

      <LedgerExport
        rows={entries.map((e) => ({
          type: e.type,
          amount: e.amount,
          token: e.token,
          vendor: e.vendor,
          category: e.category,
          createdAt: e.createdAt,
          txHash: e.txHash,
          receiptId: e.receiptId,
        }))}
      />

      <DashCard pad={false}>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--color-border)" }}>
                {["Type", "Amount", "Vendor", "Category", "Time", "Receipt"].map((h) => (
                  <th key={h} className="px-5 py-3 text-left text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px", fontWeight: 500 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.receiptId} style={{ borderTop: "1px solid var(--color-border-soft)" }}>
                  <td className="px-5 py-3 text-body-sm" style={{ color: TYPE_COLOR[e.type] ?? "var(--color-text)", fontFamily: "ui-monospace, monospace" }}>{e.type}</td>
                  <td className="px-5 py-3 text-body-sm" style={{ color: "var(--color-text)" }}>{e.amount.toFixed(2)} {e.token}</td>
                  <td className="px-5 py-3 text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{e.vendor}</td>
                  <td className="px-5 py-3 text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{e.category}</td>
                  <td className="px-5 py-3 text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>{e.createdAt.slice(11, 16)}</td>
                  <td className="px-5 py-3 text-caption-lg">
                    {e.txHash ? (
                      <a href={productTxUrl(e.txHash)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
                        {e.txHash.slice(0, 10)}…
                      </a>
                    ) : (
                      <span style={{ color: "var(--color-inverse-muted)" }}>queued</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DashCard>
    </div>
  );
}
