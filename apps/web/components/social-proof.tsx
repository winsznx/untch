import { PROOF_TXS, CONTRACTS, INVARIANTS, txUrl, addressUrl, shortHex, type Net } from "../lib/onchain";

/**
 * Social Proof — NEW INVENTION (confirm). §4d records that neither design file specifies a social
 * proof pattern; there is no Impilo testimonial/logo/rating block to translate. So this is a genuine
 * decision within the token system, not a translation.
 *
 * Reasoning (the component most likely to need a second look): the honest trust signal Untch has
 * right now is that it is a real, working product with real on-chain proof. Testimonials do not exist
 * yet and inventing them would be exactly the AI-slop the standing rules forbid. So the section IS the
 * proof: real settled/anchored transactions a reviewer can open on OKLink, the deployed contracts, and
 * the product invariants stated as guarantees. This mirrors §21 ("judges shouldn't need to trust the
 * video"). Every hash and address is real (see lib/onchain.ts); none are fabricated.
 *
 * FAITHFUL TO SPEC: Deep Iris canvas, token surfaces + hairline borders (no drop shadows), pill tags,
 * body/title type roles, Clinical Cyan reserved for data + links, Mint reserved for the positive
 * (mainnet) signal.
 */
export function SocialProof() {
  return (
    <section className="bg-canvas">
      <div className="mx-auto flex max-w-page flex-col gap-16 px-6 py-24 lg:py-32">
        <header className="flex flex-col gap-5">
          <span className="text-caption uppercase" style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}>
            Verify it yourself
          </span>
          <h2 className="max-w-3xl text-heading-lg" style={{ color: "var(--color-text)" }}>
            Public proof. Private work. Accountable payment.
          </h2>
          <p className="max-w-2xl text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
            No testimonials. Untch is a working product, and its proof is on-chain. Every transaction below
            is real and opens on the X Layer explorer. Business payloads stay off-chain; only hashes are
            anchored.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {INVARIANTS.map((inv) => (
            <div
              key={inv.id}
              className="flex flex-col gap-3 rounded-cards p-6"
              style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
            >
              <span className="text-caption-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
                {inv.id}
              </span>
              <span className="text-title-sm" style={{ color: "var(--color-text)" }}>
                {inv.claim}
              </span>
              <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
                {inv.detail}
              </span>
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Real transactions, on-chain
          </h3>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {PROOF_TXS.map((tx) => (
              <ProofCard
                key={tx.hash}
                label={tx.label}
                value={shortHex(tx.hash)}
                href={txUrl(tx.net, tx.hash)}
                net={tx.net}
                note={tx.note}
              />
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h3 className="text-title-sm" style={{ color: "var(--color-text)" }}>
            Deployed contracts
          </h3>
          <div className="flex flex-wrap gap-3">
            {CONTRACTS.map((c) => (
              <a
                key={c.address}
                href={addressUrl(c.net, c.address)}
                target="_blank"
                rel="noopener noreferrer"
                className="group inline-flex items-center gap-3 rounded-tags px-4 py-2 transition-opacity duration-150 ease-out hover:opacity-80 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                style={{ border: "1px solid var(--color-border)" }}
              >
                <span className="text-body-sm" style={{ color: "var(--color-text)" }}>
                  {c.name}
                </span>
                <span className="text-caption" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
                  {shortHex(c.address)}
                </span>
                <NetChip net={c.net} />
              </a>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ProofCard({
  label,
  value,
  href,
  net,
  note,
}: {
  label: string;
  value: string;
  href: string;
  net: Net;
  note: string;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="group flex flex-col gap-3 rounded-cards p-6 transition duration-150 ease-out hover:brightness-110 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-clinical-cyan focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <span className="text-body" style={{ color: "var(--color-text)" }}>
          {label}
        </span>
        <NetChip net={net} />
      </div>
      <span className="text-caption-lg" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
        {value}
      </span>
      <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
        {note}
      </span>
      <span className="text-caption-lg" style={{ color: "var(--color-data)" }}>
        View on OKLink →
      </span>
    </a>
  );
}

/** mainnet reads positive (real production net, Mint), testnet reads data (Clinical Cyan). */
function NetChip({ net }: { net: Net }) {
  const color = net === "mainnet" ? "var(--color-positive)" : "var(--color-data)";
  const label = net === "mainnet" ? "mainnet" : "testnet";
  return (
    <span
      className="inline-flex items-center rounded-tags px-2 py-1 text-caption"
      style={{ border: `1px solid ${color}`, color, letterSpacing: "0.24px" }}
    >
      {label}
    </span>
  );
}
