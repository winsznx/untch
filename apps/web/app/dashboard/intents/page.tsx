import { DashCard, SectionTitle, DecisionChip, Mono } from "../../../components/dashboard/ui";
import { NoHistory } from "../../../components/dashboard/no-history";
import { liveIntentStream, type IntentRow } from "../../../lib/dashboard/live";
import { getScope } from "../../../lib/dashboard/scope";
import { txUrl } from "../../../lib/onchain";

const OUTCOME_LABEL = (o: string) => o.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/** Reads the operator's real DECISION receipts from the shared Postgres per request. */
export const dynamic = "force-dynamic";

export default async function IntentStream() {
  const scope = await getScope();
  const stream = scope.authenticated ? await liveIntentStream(scope.address) : [];
  return (
    <div className="flex flex-col gap-8">
      <SectionTitle kicker="Live" title="Intent stream" />
      <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
        Every payment attempt your agents made, as the deterministic policy engine decided it — read live from
        the shared receipts store. The durable receipt records the anchored outcome (decision, amount, vendor,
        tx); the full preflight rule trace is computed at decision time and not persisted, so it is not shown.
      </p>
      {!scope.authenticated ? (
        <NoHistory authenticated={false} address={scope.address} what="intents" />
      ) : stream.length === 0 ? (
        <DashCard>
          <span className="text-body" style={{ color: "var(--color-inverse-muted)" }}>No intents for this wallet yet.</span>
        </DashCard>
      ) : (
        <div className="flex flex-col gap-3">
          {stream.map((row) => <IntentCard key={row.intentHash} row={row} />)}
        </div>
      )}
    </div>
  );
}

function IntentCard({ row }: { row: IntentRow }) {
  return (
    <DashCard>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-body" style={{ color: "var(--color-text)", fontFamily: "ui-monospace, monospace" }}>{row.intentHash.slice(0, 18)}…</span>
          <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>
            vendor <Mono>{row.vendorId.slice(0, 10)}…</Mono> · {new Date(row.createdAt).toISOString().slice(0, 16).replace("T", " ")}
          </span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-body" style={{ color: "var(--color-text)" }}>{row.amount.toFixed(2)} {row.token}</span>
          <DecisionChip category={row.decisionCategory} label={OUTCOME_LABEL(row.outcome)} />
        </div>
      </div>
      {row.anchored && row.txHash ? (
        <div className="mt-3">
          <a href={txUrl("testnet", row.txHash)} target="_blank" rel="noopener noreferrer" className="text-caption-lg underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
            Anchored · {row.txHash.slice(0, 12)}…
          </a>
        </div>
      ) : (
        <span className="mt-3 block text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>Decision durable in Postgres · anchor {row.anchored ? "confirmed" : "pending"}</span>
      )}
    </DashCard>
  );
}
