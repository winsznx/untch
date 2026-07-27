import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteHeader } from "../../../components/site-header";
import { shortHex } from "../../../lib/onchain";

/**
 * The public receipt page. No login, no tenant scope, safe to share.
 *
 * It fetches the ASP's `/consumer/receipt/:intentId` rather than reading Postgres directly, even
 * though every other page in this app reads the database. That is deliberate: the ASP handler is the
 * single definition of WHICH fields may be published. A second field-selection here would be a second
 * place to forget, and the failure mode of forgetting is publishing a user's request payload — the
 * exact domain they searched, the address a gift shipped to — to anyone holding a URL.
 */

export const dynamic = "force-dynamic";

const ASP_BASE = process.env.NEXT_PUBLIC_ASP_BASE_URL?.trim() || "https://asp.untch.xyz";

export const metadata: Metadata = {
  title: "Untch receipt",
  description: "A governed consumer action, from policy decision to settled payment to verified delivery.",
};

type MoneyJson = { readonly amount: string; readonly display?: string; readonly symbol?: string; readonly decimals?: number };

type Anchor =
  | { state: "NOT_RECORDED"; reason: string }
  | { state: "NOT_FOUND"; receiptId: string }
  | { state: "PENDING"; receiptId: string; status: string }
  | { state: "ANCHORED"; receiptId: string; txHash: string | null; blockNumber: number | null; batchId: number | null }
  | { state: "ANCHOR_FAILED"; receiptId: string; status: string };

type PublicReceipt = {
  intentId: string;
  action: string;
  state: string;
  settlement: {
    providerId: string;
    amount: MoneyJson;
    chain: string;
    recipient: string;
    txHash: string | null;
  } | null;
  fee: MoneyJson | null;
  spread: MoneyJson | null;
  policy: { policyId: string; policyVersion: number | null; policyHash: string | null; decision: string | null };
  delivery: {
    providerAttested: string;
    untchVerified: boolean;
    method: string;
    verifiedAt: string | null;
  } | null;
  quoteHash: string | null;
  spendIntentHash: string | null;
  createdAt: string;
  updatedAt: string;
  receipt: Anchor;
  integrity: { digest: string };
  disclosure: string;
};

/** Base and X Layer both have public explorers; a settlement tx should always be clickable. */
function settlementTxUrl(chain: string, hash: string): string | null {
  if (chain === "eip155:8453") return `https://basescan.org/tx/${hash}`;
  if (chain === "eip155:196") return `https://www.oklink.com/x-layer/tx/${hash}`;
  if (chain === "eip155:195") return `https://www.oklink.com/x-layer-testnet/tx/${hash}`;
  return null;
}

function chainName(chain: string): string {
  return chain === "eip155:8453" ? "Base"
    : chain === "eip155:196" ? "X Layer"
    : chain === "eip155:195" ? "X Layer testnet"
    : chain;
}

function amountOf(m: MoneyJson | null): string {
  if (!m) return "—";
  return m.display ?? `${m.amount} (atomic)`;
}

const CARD: React.CSSProperties = {
  background: "var(--color-surface)",
  border: "1px solid var(--color-border)",
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 py-3" style={{ borderBottom: "1px solid var(--color-border)" }}>
      <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
        {label}
      </span>
      <span className="text-body" style={{ color: "var(--color-text)", wordBreak: "break-word" }}>
        {children}
      </span>
    </div>
  );
}

/**
 * The anchor banner.
 *
 * Five states, worded so a reader can tell "still working" from "gave up" without knowing anything
 * about batching. An unanchored receipt is still a true receipt — the durable record exists and the
 * payment is on chain regardless — so ANCHOR_FAILED says what is and is not affected rather than
 * reading as a failure of the purchase.
 */
function AnchorBanner({ anchor }: { anchor: Anchor }) {
  const copy: { tone: string; title: string; detail: string } =
    anchor.state === "ANCHORED"
      ? { tone: "var(--color-data)", title: "Anchored on X Layer", detail: `Receipt ${shortHex(anchor.receiptId)} is committed on chain.` }
      : anchor.state === "PENDING"
        ? { tone: "var(--color-data)", title: "Anchoring in progress", detail: `Receipt ${shortHex(anchor.receiptId)} is durably recorded and queued for the next batch (${anchor.status}).` }
        : anchor.state === "ANCHOR_FAILED"
          ? { tone: "#c2410c", title: "Not anchored", detail: `Receipt ${shortHex(anchor.receiptId)} is durably recorded but anchoring did not complete. The payment and delivery facts below are unaffected — only the on-chain commitment is missing.` }
          : anchor.state === "NOT_FOUND"
            ? { tone: "#c2410c", title: "Receipt record missing", detail: `This intent references receipt ${shortHex(anchor.receiptId)}, but no such receipt exists. This is an inconsistency, not a wait state.` }
            : { tone: "var(--color-inverse-canvas)", title: "No receipt recorded", detail: anchor.reason };

  return (
    <div className="flex flex-col gap-2 rounded-cards p-5" style={CARD}>
      <span className="text-caption uppercase" style={{ color: copy.tone, letterSpacing: "0.24px" }}>
        {copy.title}
      </span>
      <p className="text-body" style={{ color: "var(--color-inverse-canvas)" }}>{copy.detail}</p>
      {anchor.state === "ANCHORED" && anchor.txHash ? (
        <a
          className="text-body underline"
          style={{ color: "var(--color-data)" }}
          href={`https://www.oklink.com/x-layer/tx/${anchor.txHash}`}
          target="_blank"
          rel="noopener noreferrer"
        >
          View the anchoring transaction ↗
        </a>
      ) : null}
    </div>
  );
}

export default async function PublicReceiptPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;

  let data: PublicReceipt;
  try {
    const res = await fetch(`${ASP_BASE}/consumer/receipt/${encodeURIComponent(intentId)}`, {
      cache: "no-store",
      headers: { accept: "application/json" },
    });
    if (res.status === 404) notFound();
    if (!res.ok) throw new Error(`ASP responded ${res.status}`);
    data = (await res.json()) as PublicReceipt;
  } catch (err) {
    // A page that cannot reach the ASP must say so rather than render a receipt with blank fields,
    // which would read as "this purchase had no settlement".
    if (err instanceof Error && err.message === "NEXT_NOT_FOUND") throw err;
    return (
      <>
        <SiteHeader />
        <main className="bg-canvas" style={{ minHeight: "100vh" }}>
          <div className="mx-auto flex max-w-page flex-col gap-6 px-6 py-20">
            <h1 className="text-heading-xl" style={{ color: "var(--color-text)" }}>Receipt unavailable</h1>
            <p className="text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
              This receipt could not be loaded from the Untch ASP right now. Nothing about the underlying
              purchase has changed — try again shortly.
            </p>
          </div>
        </main>
      </>
    );
  }

  const settled = data.settlement;
  const txUrl = settled?.txHash ? settlementTxUrl(settled.chain, settled.txHash) : null;

  return (
    <>
      <SiteHeader />
      <main className="bg-canvas" style={{ minHeight: "100vh" }}>
        <div className="mx-auto flex max-w-page flex-col gap-10 px-6 py-20">
          <header className="flex flex-col gap-4">
            <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
              Public receipt · no login
            </span>
            <h1 className="text-heading-xl" style={{ color: "var(--color-text)" }}>{data.action}</h1>
            <p className="text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
              Intent <code>{data.intentId}</code> · state <strong>{data.state}</strong>
            </p>
          </header>

          <AnchorBanner anchor={data.receipt} />

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>What was paid</h2>
            <div className="rounded-cards px-5 py-2" style={CARD}>
              {settled ? (
                <>
                  <Row label="Provider">{settled.providerId}</Row>
                  <Row label="Amount settled">{amountOf(settled.amount)} on {chainName(settled.chain)}</Row>
                  <Row label="Paid to">{settled.recipient || "—"}</Row>
                  <Row label="Settlement transaction">
                    {settled.txHash ? (
                      txUrl ? (
                        <a className="underline" style={{ color: "var(--color-data)" }} href={txUrl} target="_blank" rel="noopener noreferrer">
                          {shortHex(settled.txHash)} ↗
                        </a>
                      ) : shortHex(settled.txHash)
                    ) : "not settled"}
                  </Row>
                </>
              ) : (
                <Row label="Provider settlement">No provider payment was made for this intent.</Row>
              )}
              <Row label="Untch fee">{amountOf(data.fee)}</Row>
              <Row label="Disclosed spread">{amountOf(data.spread)}</Row>
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>What was delivered</h2>
            <div className="rounded-cards px-5 py-2" style={CARD}>
              {data.delivery ? (
                <>
                  {/* Never merged: the merchant's claim and Untch's independent check are two
                      different assertions, and a page that combined them would overstate what is known. */}
                  <Row label="Merchant asserted">{data.delivery.providerAttested}</Row>
                  <Row label="Untch independently verified">
                    {data.delivery.untchVerified ? `Yes — via ${data.delivery.method}` : `No — method ${data.delivery.method}`}
                  </Row>
                  <Row label="Verified at">{data.delivery.verifiedAt ?? "—"}</Row>
                </>
              ) : (
                <Row label="Delivery">No delivery evidence was recorded for this intent.</Row>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>What authorised it</h2>
            <div className="rounded-cards px-5 py-2" style={CARD}>
              <Row label="Policy">#{data.policy.policyId} · version {data.policy.policyVersion ?? "—"}</Row>
              <Row label="Policy hash">{data.policy.policyHash ? shortHex(data.policy.policyHash, 12, 10) : "—"}</Row>
              <Row label="Decision">{data.policy.decision ?? "—"}</Row>
              <Row label="Quote hash">{data.quoteHash ? shortHex(data.quoteHash, 12, 10) : "—"}</Row>
              <Row label="Spend-intent hash">{data.spendIntentHash ? shortHex(data.spendIntentHash, 12, 10) : "—"}</Row>
              <Row label="Integrity digest">{shortHex(data.integrity.digest, 12, 10)}</Row>
            </div>
          </section>

          <p className="text-caption" style={{ color: "var(--color-inverse-canvas)" }}>
            {data.disclosure}
          </p>
        </div>
      </main>
    </>
  );
}
