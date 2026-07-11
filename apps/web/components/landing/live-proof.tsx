import { DecisionChip } from "../hero";
import { txUrl } from "../../lib/onchain";

/**
 * Live proof — "Same intent. One variable." (dark canvas). Untch's answer to the classic
 * same-op-one-variable demo: the identical intent approved, then repeated and blocked as a duplicate,
 * with the difference living entirely in the receipts. Grounded in the PRD judge demo (§20).
 * NEW DECISION (confirm): the framing + copy. The blocked receipt links to a real on-chain block receipt.
 */

const BLOCK_RECEIPT = "0x84f1eded3f2b9e7ac5c003b60c87f505b146d2aaf9366b8b9c1d84b848c05700";

export function LiveProof() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-24 lg:py-32">
        <div className="flex flex-col gap-4">
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            Live proof
          </span>
          <h2 className="max-w-3xl text-heading-lg" style={{ color: "var(--color-text)" }}>
            Same intent. One variable.
          </h2>
          <p className="max-w-2xl text-body" style={{ color: "var(--color-inverse-canvas)" }}>
            The same market-data call, sent twice. The first is approved and receipted. The second is the
            identical task inside the duplicate window, so it is blocked and nothing moves. The difference
            lives entirely in the receipts.
          </p>
        </div>

        <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[1fr_auto_1fr]">
          <ProofColumn
            outcome="APPROVED"
            label="Approved"
            amount="0.05 USDT"
            rows={[
              ["Rule", "duplicate check passed"],
              ["Result", "payment authorized"],
              ["Receipt", "written on X Layer"],
            ]}
          />
          <div className="flex items-center justify-center">
            <span className="rounded-tags px-3 py-1 text-caption-lg" style={{ border: "1px solid var(--color-border)", color: "var(--color-inverse-muted)" }}>
              vs
            </span>
          </div>
          <ProofColumn
            outcome="BLOCKED"
            label="Blocked as duplicate"
            amount="0.05 USDT"
            rows={[
              ["Rule", "duplicate in TTL window"],
              ["Result", "nothing moved"],
              ["Receipt", "block anchored on X Layer"],
            ]}
            receiptHref={txUrl("testnet", BLOCK_RECEIPT)}
          />
        </div>
      </div>
    </section>
  );
}

function ProofColumn({
  outcome,
  label,
  amount,
  rows,
  receiptHref,
}: {
  outcome: "APPROVED" | "BLOCKED" | "ESCALATED";
  label: string;
  amount: string;
  rows: [string, string][];
  receiptHref?: string;
}) {
  return (
    <div className="flex flex-col gap-5 rounded-cards p-6" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
      <div className="flex items-center justify-between">
        <DecisionChip outcome={outcome} label={label} />
        <span className="text-body" style={{ color: "var(--color-text)" }}>{amount}</span>
      </div>
      <div className="flex flex-col gap-3">
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between gap-3" style={{ borderTop: "1px solid var(--color-border-soft)", paddingTop: 10 }}>
            <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>{k}</span>
            <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{v}</span>
          </div>
        ))}
      </div>
      {receiptHref ? (
        <a href={receiptHref} target="_blank" rel="noopener noreferrer" className="text-caption-lg underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
          View the real block receipt on OKLink →
        </a>
      ) : null}
    </div>
  );
}
