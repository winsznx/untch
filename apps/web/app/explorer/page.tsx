import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";
import { PROOF_TXS, CONTRACTS, txUrl, addressUrl, shortHex, type Net } from "../../lib/onchain";

export const metadata: Metadata = {
  title: "Untch public receipts explorer",
  description: "Every Untch decision, verification, score, and report — anchored on X Layer and verifiable on OKLink.",
};

const DEMO = {
  policyHash: "0x308ec9d3a4059f28305277eaf33d45d35422cd8542d762fe3727c5cfed5aad3b",
  intentHash: "0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a",
};

export default function Explorer() {
  return (
    <>
      <SiteHeader />
      <main className="bg-canvas" style={{ minHeight: "100vh" }}>
        <div className="mx-auto flex max-w-page flex-col gap-14 px-6 py-20">
          <header className="flex flex-col gap-5">
            <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
              S6 · public · no login
            </span>
            <h1 className="text-heading-xl" style={{ color: "var(--color-text)" }}>
              Public receipts explorer
            </h1>
            <p className="max-w-2xl text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
              Every decision, verification, score, and report is anchored on X Layer as a hash. Open any row on
              OKLink and verify it directly. Product contracts are on testnet; the first settled call is on mainnet.
            </p>
          </header>

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>Anchored transactions</h2>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {PROOF_TXS.map((tx) => (
                <a
                  key={tx.hash}
                  href={txUrl(tx.net, tx.hash)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-col gap-2 rounded-cards p-5 transition duration-150 ease-out hover:brightness-110 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
                >
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-body-sm" style={{ color: "var(--color-text)" }}>{tx.label}</span>
                    <NetChip net={tx.net} />
                  </div>
                  <span className="text-caption-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>{shortHex(tx.hash)}</span>
                  <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>{tx.note}</span>
                </a>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>Deployed contracts</h2>
            <div className="flex flex-col gap-2">
              {CONTRACTS.map((c) => (
                <a
                  key={c.address}
                  href={addressUrl(c.net, c.address)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex flex-wrap items-center justify-between gap-3 rounded-inputs px-4 py-3 transition-opacity duration-150 ease-out hover:opacity-80 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  style={{ border: "1px solid var(--color-border)" }}
                >
                  <span className="text-body-sm" style={{ color: "var(--color-text)" }}>{c.name}</span>
                  <span className="text-caption-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>{shortHex(c.address)}</span>
                  <span className="hidden text-caption-lg sm:inline" style={{ color: "var(--color-inverse-muted)" }}>{c.note}</span>
                  <NetChip net={c.net} />
                </a>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-4">
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>Sample committed hashes</h2>
            <div className="flex flex-col gap-2">
              <HashRow label="Demo policy hash" value={DEMO.policyHash} />
              <HashRow label="Demo intent hash" value={DEMO.intentHash} />
            </div>
          </section>
        </div>
      </main>
    </>
  );
}

function NetChip({ net }: { net: Net }) {
  const color = net === "mainnet" ? "var(--color-positive)" : "var(--color-data)";
  return (
    <span className="inline-flex items-center rounded-tags px-2 py-1 text-caption" style={{ border: `1px solid ${color}`, color, letterSpacing: "0.24px" }}>
      {net}
    </span>
  );
}

function HashRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-inputs px-4 py-3" style={{ border: "1px solid var(--color-border-soft)" }}>
      <span className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>{label}</span>
      <span className="text-caption-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}
