import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader } from "../../components/site-header";
import { SiteFooter } from "../../components/site-footer";

export const metadata: Metadata = {
  title: "Untch pricing",
  description: "Per-call USDT0 prices for Untch ASP tools on X Layer mainnet.",
};

type Row = { tool: string; path: string; price: string; note?: string };

const CONTROL: Row[] = [
  { tool: "ping_untch", path: "GET /ping_untch", price: "$0.01", note: "Rail health" },
  { tool: "create_spend_intent", path: "POST /create_spend_intent", price: "Bundled" },
  { tool: "preflight_payment", path: "POST /preflight_payment", price: "$0.05", note: "Policy gate" },
  { tool: "verify_delivery", path: "POST /verify_delivery", price: "$0.10", note: "T0 proof" },
  { tool: "detect_duplicate", path: "POST /detect_duplicate", price: "$0.02" },
  { tool: "redact_payment_metadata", path: "POST /redact_payment_metadata", price: "$0.02" },
  { tool: "get_ledger", path: "POST /get_ledger", price: "Free" },
  { tool: "log_receipt", path: "POST /log_receipt", price: "Free" },
  { tool: "score_vendor", path: "POST /score_vendor", price: "$0.20" },
  { tool: "score_buyer", path: "POST /score_buyer", price: "$0.20" },
  { tool: "generate_dispute_packet", path: "POST /generate_dispute_packet", price: "$0.50" },
  { tool: "reconcile_agent_spend", path: "POST /reconcile_agent_spend", price: "$0.25" },
];

const LIFESTYLE: Row[] = [
  { tool: "café menu", path: "GET /cafe/menu", price: "Free" },
  { tool: "order latte", path: "POST /cafe/order/latte", price: "$0.04", note: "Demo voucher" },
];

const BUILDER: Row[] = [
  { tool: "brand_pack", path: "POST /builder/brand_pack", price: "$0.05", note: "Names + RDAP + rank + SEO" },
  { tool: "suggest_names", path: "POST /builder/suggest_names", price: "$0.01" },
  { tool: "check_domains", path: "POST /builder/check_domains", price: "Free", note: "Live RDAP" },
  { tool: "rank_options", path: "POST /builder/rank_options", price: "Free" },
  { tool: "seo_tips", path: "POST /builder/seo_tips", price: "Free" },
];

function PriceTable({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>
        {title}
      </h2>
      <div
        className="overflow-x-auto rounded-cards"
        style={{ border: "1px solid var(--color-border)" }}
      >
        <table className="w-full min-w-[520px] text-left">
          <thead>
            <tr style={{ borderBottom: "1px solid var(--color-border)", background: "var(--color-surface)" }}>
              <th className="px-4 py-3 text-caption uppercase" style={{ color: "var(--color-inverse-canvas)", letterSpacing: "0.24px" }}>
                Tool
              </th>
              <th className="px-4 py-3 text-caption uppercase" style={{ color: "var(--color-inverse-canvas)", letterSpacing: "0.24px" }}>
                Path
              </th>
              <th className="px-4 py-3 text-caption uppercase" style={{ color: "var(--color-inverse-canvas)", letterSpacing: "0.24px" }}>
                Price
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.path} style={{ borderBottom: "1px solid var(--color-border-soft)" }}>
                <td className="px-4 py-3 text-body-sm" style={{ color: "var(--color-text)" }}>
                  {r.tool}
                  {r.note ? (
                    <span className="block text-caption" style={{ color: "var(--color-inverse-canvas)" }}>
                      {r.note}
                    </span>
                  ) : null}
                </td>
                <td
                  className="px-4 py-3 text-caption-lg"
                  style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}
                >
                  {r.path}
                </td>
                <td className="px-4 py-3 text-body-sm" style={{ color: "var(--color-text)" }}>
                  {r.price}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function PricingPage() {
  return (
    <>
      <SiteHeader />
      <main className="bg-canvas" style={{ minHeight: "100vh" }}>
        <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-20">
          <header className="flex flex-col gap-5">
            <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
              Pricing
            </span>
            <h1 className="text-heading-xl" style={{ color: "var(--color-text)" }}>
              Per-call prices on X Layer
            </h1>
            <p className="max-w-2xl text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
              Paid tools settle in USDT0 via OKX x402 on mainnet (eip155:196). Dashboard, explorer, and docs are free.
              Operator on-chain txs pay gas in OKB from your wallet.
            </p>
            <div className="flex flex-wrap gap-4">
              <Link
                href="https://asp.untch.xyz/catalog"
                className="text-body-sm underline-offset-4 hover:underline"
                style={{ color: "var(--color-data)" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Live ASP catalog
              </Link>
              <Link
                href="https://docs.untch.xyz/reference/pricing"
                className="text-body-sm underline-offset-4 hover:underline"
                style={{ color: "var(--color-data)" }}
                target="_blank"
                rel="noopener noreferrer"
              >
                Docs pricing page
              </Link>
            </div>
          </header>

          <PriceTable title="Control plane" rows={CONTROL} />
          <PriceTable title="Lifestyle (demo café)" rows={LIFESTYLE} />
          <PriceTable title="Launch Pack (builder)" rows={BUILDER} />

          <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            Base URL:{" "}
            <span style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
              https://asp.untch.xyz
            </span>
          </p>
        </div>
      </main>
      <SiteFooter />
    </>
  );
}
