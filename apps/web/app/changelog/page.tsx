import type { Metadata } from "next";
import { SiteHeader } from "../../components/site-header";

/**
 * The public changelog.
 *
 * Every date is derived from a real commit or a real on-chain transaction, never invented. Where an
 * entry has evidence a reader can check independently, the link goes to the chain or to a live
 * endpoint rather than to another page of ours — a changelog that only cites itself proves nothing.
 *
 * Status is stated per entry and uses the same vocabulary as the README, so a reader comparing the
 * two never has to reconcile different words for the same thing.
 */

export const metadata: Metadata = {
  title: "Changelog — Untch",
  description:
    "What Untch has actually shipped, dated from commits and on-chain evidence, with the live/beta boundary stated per entry.",
};

type Status = "LIVE" | "BETA" | "EXPERIMENTAL";

interface Entry {
  readonly date: string;
  readonly title: string;
  readonly what: string;
  readonly why: string;
  readonly status: Status;
  readonly evidence?: { readonly label: string; readonly href: string };
}

/** Newest first. Dates come from `git log` and from transaction receipts. */
const ENTRIES: readonly Entry[] = [
  {
    date: "2026-07-28",
    title: "Externally funded Consumer Intent in production",
    what:
      "A wallet that is not any Untch treasury funded a Consumer Intent with real USDT0 on X Layer. Untch then paid StableDomains in USDC on Base from its own settlement float, verified the result through public RDAP, and reconciled both rails to zero under one intent.",
    why:
      "Until now Untch was both funder and settler, so the only novel leg exercised was the outbound merchant payment. This proves the two parties are genuinely separate while policy, payment, delivery verification and accounting stay bound to a single intent. Providers are still settled from Untch's pre-funded operational treasury.",
    status: "BETA",
    evidence: {
      label: "external funding transaction on X Layer",
      href: "https://www.oklink.com/x-layer/tx/0x5ab5820c3f38890f8f187ccf491c7a97ff8983e60de76da1588bf4d7f321d69a",
    },
  },
  {
    date: "2026-07-28",
    title: "Mandatory ownership authentication",
    what:
      "Reading a tenant's consumer intents now requires a SIWE signature over a server-issued, single-use, expiring nonce, verified against the policy's on-chain owner. The legacy path of passing a policy id as a query parameter is refused outright.",
    why:
      "A policy id is public on-chain data. Deriving a tenant from it was namespacing, not authorisation: anyone who read one off the explorer could see that tenant's amounts, provider and decisions. Fourteen attacks were run against live production with real signatures, and all fourteen were refused, including a cryptographically valid signature from a wallet that does not own the policy.",
    status: "LIVE",
    evidence: { label: "catalog reports auth.required", href: "https://asp.untch.xyz/consumer/catalog" },
  },
  {
    date: "2026-07-28",
    title: "Public receipts",
    what:
      "Every completed consumer action has a receipt anyone can open with no account, showing what was paid, to whom, on which chain, what was delivered and what Untch independently verified.",
    why:
      "A receipt only the buyer can read is not a receipt. The public view is built by naming the fields that may be published rather than by removing fields from the private one, so a field added later cannot silently become public. The request payload, correlation id and approval channel are all withheld.",
    status: "LIVE",
    evidence: { label: "open a real receipt", href: "/receipt/ci_82bb2216c02366bc1b839a00" },
  },
  {
    date: "2026-07-27",
    title: "Production worker executed a governed purchase end to end",
    what:
      "The deployed worker picked an approved intent off the queue, paid StableDomains 0.050000 USDC on Base, verified the result, booked the ledger and wrote a receipt, with no local driver involved.",
    why:
      "The first settlement was driven by a script on a laptop. This one proves the deployed system does it by itself, which is the only version that matters.",
    status: "BETA",
    evidence: {
      label: "Base settlement transaction",
      href: "https://basescan.org/tx/0x6815d60e1be688451d36007a4113f858e0a10433dccef01dc3b3d0f8d283e489",
    },
  },
  {
    date: "2026-07-27",
    title: "Independent delivery verification via RDAP",
    what:
      "Domain results are checked against public RDAP, the registry itself, rather than against the merchant's own response.",
    why:
      "A merchant confirming its own delivery is not verification. The receipt reports the merchant's claim and Untch's independent check as two separate fields and never merges them.",
    status: "LIVE",
  },
  {
    date: "2026-07-27",
    title: "First real provider settlement",
    what:
      "Untch paid a real merchant on the merchant's own rail, USDC on Base, from a capped, single-use EIP-3009 authorisation, for an action a deterministic policy had approved.",
    why:
      "Everything before this was a decision about money. This was money.",
    status: "BETA",
    evidence: {
      label: "Base settlement transaction",
      href: "https://basescan.org/tx/0xe7ce102f7a704e9c3113fc7fcc8626db8a9cdc330e614d023c231e88fce21e86",
    },
  },
  {
    date: "2026-07-27",
    title: "Consumer Pack",
    what:
      "An agent proposes a real-world action. Untch decides whether it is authorised, funds it for the exact approved amount, pays the merchant on the merchant's rail, verifies delivery and produces one receipt spanning both payments.",
    why:
      "The purchase value is separate from the call fee, an ambiguous outcome goes to a human rather than a retry, and what the merchant says is never presented as what Untch proved. Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury.",
    status: "BETA",
    evidence: { label: "live capability matrix", href: "https://asp.untch.xyz/consumer/catalog" },
  },
  {
    date: "2026-07-16",
    title: "OKX.AI listing — ASP #6086",
    what: "Untch listed as an Agent Service Provider on OKX.AI, with ERC-8004 agent #6047 and seven priced x402 services.",
    why: "Agents can discover and pay for the authority layer without a bespoke integration.",
    status: "LIVE",
    evidence: { label: "ERC-8004 registration card", href: "https://asp.untch.xyz/agent-registration.json" },
  },
  {
    date: "2026-07-16",
    title: "Mainnet contracts on X Layer",
    what: "PolicyRegistry, SpendIntentRegistry, UntchReceipts and VaultFactory deployed to X Layer mainnet with separated role keys.",
    why: "None of them holds funds. There is no payable, receive or fallback, so the registry layer cannot become a honeypot.",
    status: "LIVE",
    evidence: {
      label: "UntchReceipts on OKLink",
      href: "https://www.oklink.com/x-layer/address/0xb5b853684624aea2ecbcd0e888cbff46ff0a5f95",
    },
  },
  {
    date: "2026-07-12",
    title: "Trust Bureau",
    what: "Receipt-backed vendor and buyer scores with a lower-confidence bound, so a vendor with two good receipts does not outrank one with two hundred.",
    why: "Reputation built from receipts you can check, rather than from self-reported stars.",
    status: "LIVE",
  },
  {
    date: "2026-07-11",
    title: "Escalation across four channels",
    what: "Human approval over Telegram, Discord, Slack and the operator dashboard, with dual-channel enforcement and a single authority boundary.",
    why: "When policy says a human must decide, the human must be reachable where they already are, and no channel may become a way around the boundary.",
    status: "LIVE",
  },
  {
    date: "2026-07-10",
    title: "Receipts anchored on chain",
    what: "Durable Postgres receipts, batched and anchored to the UntchReceipts contract with retry, reorg re-verification and honest degradation.",
    why:
      "The ledger is authoritative. Anchoring is publication. When anchoring fails the receipt says so rather than implying an anchor that does not exist. Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt anchoring is pending writer activation through the contract's three-day timelock.",
    status: "BETA",
  },
  {
    date: "2026-07-09",
    title: "Deterministic policy engine",
    what:
      "Fourteen rules over a bounded SpendIntent, evaluated in a fixed order: budget, per-call cap, category, recipient, agent, duplicate, cooldown, rate limit and expiry.",
    why:
      "No LLM call appears anywhere on the money decision path. The engine is a pure function of the intent, the policy and the ledger window, so the same inputs always produce the same decision and the decision can be re-derived by anyone.",
    status: "LIVE",
  },
  {
    date: "2026-07-09",
    title: "Exact approvals and mutation rejection",
    what: "An approval binds to a hash of the canonical quote, not to a description of it.",
    why:
      "Change the amount, recipient, item or deadline and the hash changes, so the approval stops applying and execution refuses. There is no path where a human approves $5 and $500 leaves.",
    status: "LIVE",
  },
];

const STATUS_STYLE: Record<Status, { bg: string; fg: string }> = {
  LIVE: { bg: "rgba(35,134,54,0.16)", fg: "#3fb950" },
  BETA: { bg: "rgba(210,153,34,0.16)", fg: "#d29922" },
  EXPERIMENTAL: { bg: "rgba(219,109,40,0.16)", fg: "#db6d28" },
};

function StatusChip({ status }: { status: Status }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="text-caption uppercase"
      style={{
        background: s.bg,
        color: s.fg,
        padding: "2px 10px",
        borderRadius: 999,
        letterSpacing: "0.24px",
        whiteSpace: "nowrap",
      }}
    >
      {status}
    </span>
  );
}

export default function Changelog() {
  return (
    <>
      <SiteHeader />
      <main className="bg-canvas" style={{ minHeight: "100vh" }}>
        <div className="mx-auto flex max-w-page flex-col gap-12 px-6 py-20">
          <header className="flex flex-col gap-5">
            <span
              className="text-caption uppercase"
              style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}
            >
              public · no login
            </span>
            <h1 className="text-heading-xl" style={{ color: "var(--color-text)" }}>
              Changelog
            </h1>
            <p className="max-w-2xl text-subheading" style={{ color: "var(--color-inverse-canvas)" }}>
              What has actually shipped. Every date comes from a commit or an on-chain transaction, and
              every entry states whether the capability is live or still in beta. Where there is
              evidence you can check without trusting us, the link goes to the chain.
            </p>
          </header>

          <section
            className="flex flex-col gap-3 rounded-cards p-6"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
          >
            <span
              className="text-caption uppercase"
              style={{ color: "var(--color-data)", letterSpacing: "0.24px" }}
            >
              Production maturity
            </span>
            <p className="max-w-3xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              {"Untch has completed an externally funded Consumer Intent in production. The user funding wallet and Untch provider-settlement treasury are separate, while policy, payment, delivery verification and accounting remain bound to one intent. Providers are currently settled from Untch's pre-funded operational treasury. The externally funded intent flow is implemented and undergoing final production proof."}
            </p>
            <p className="max-w-3xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              {"Receipts currently include durable Untch records and X Layer testnet anchors. Mainnet receipt anchoring is pending writer activation through the contract's three-day timelock."}
            </p>
          </section>

          <ol className="flex flex-col gap-4" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {ENTRIES.map((e) => (
              <li
                key={`${e.date}-${e.title}`}
                className="flex flex-col gap-3 rounded-cards p-6"
                style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <time
                    className="text-caption"
                    style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}
                    dateTime={e.date}
                  >
                    {e.date}
                  </time>
                  <StatusChip status={e.status} />
                </div>

                <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>
                  {e.title}
                </h2>

                <p className="max-w-3xl text-body" style={{ color: "var(--color-text)" }}>
                  {e.what}
                </p>

                <p className="max-w-3xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
                  <strong style={{ color: "var(--color-inverse-canvas)" }}>Why it matters: </strong>
                  {e.why}
                </p>

                {e.evidence ? (
                  <a
                    className="text-body-sm underline"
                    style={{ color: "var(--color-data)" }}
                    href={e.evidence.href}
                    {...(e.evidence.href.startsWith("http")
                      ? { target: "_blank", rel: "noopener noreferrer" }
                      : {})}
                  >
                    {e.evidence.label} {e.evidence.href.startsWith("http") ? "↗" : "→"}
                  </a>
                ) : null}
              </li>
            ))}
          </ol>

          <section
            className="flex flex-col gap-3 rounded-cards p-6"
            style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}
          >
            <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>
              What is deliberately not here
            </h2>
            <p className="max-w-3xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
              Domain registration, shopping, gift ordering, travel booking, notification sending,
              Solana settlement and Tempo settlement are implemented and gated, and every one of them
              refuses with a named reason. They are not listed above because they have not shipped.
              The live capability matrix at{" "}
              <a
                className="underline"
                style={{ color: "var(--color-data)" }}
                href="https://asp.untch.xyz/consumer/catalog"
                target="_blank"
                rel="noopener noreferrer"
              >
                /consumer/catalog
              </a>{" "}
              reports each provider&rsquo;s real maturity, so any claim here can be checked against the
              machine rather than against this page. The full production-proof page lives at{" "}
              <a
                className="underline"
                style={{ color: "var(--color-data)" }}
                href="https://docs.untch.xyz/consumer-pack-proof"
                target="_blank"
                rel="noopener noreferrer"
              >
                docs.untch.xyz/consumer-pack-proof
              </a>
              .
            </p>
          </section>
        </div>
      </main>
    </>
  );
}
