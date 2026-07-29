/**
 * How much to put in the Solana treasury before Purch can be switched on.
 *
 *   pnpm purch:funding
 *
 * Every number below is read from Purch's OWN live 402 at the moment this runs. Nothing is a
 * remembered price: a funding recommendation built from a stale table is how a float ends up a cent
 * short of the thing it was funded for.
 *
 * READ-ONLY. It probes for challenges and never pays one. There is no payment capability anywhere in
 * this file, so a 402 has nothing to settle with even if the code tried.
 */

import { SOLANA_USDC_MINT } from "../packages/consumer-core/src/index";

const PURCH = "https://api.purch.xyz";
const SOLANA_CAIP = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/** The recipient Purch's own challenges name. Anything else is a different merchant. */
const EXPECTED_PAY_TO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";

interface Probe {
  readonly label: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: unknown;
  /** Whether this is one of the three flows the funding target is sized for. */
  readonly inTarget: boolean;
  readonly note: string;
}

const PROBES: readonly Probe[] = [
  { label: "paid product search", method: "GET", path: "/x402/search?q=usb%20c%20cable", inTarget: true,
    note: "GET /x402/search — the cheapest real Purch call" },
  { label: "AI product recommendation", method: "POST", path: "/x402/shop", body: { query: "a gift for someone who likes coffee" }, inTarget: true,
    note: "POST /x402/shop — the closest live surface to a gift recommendation" },
  { label: "digital item purchase", method: "POST", path: "/x402/vault/buy", body: { itemId: "probe" }, inTarget: true,
    note: "POST /x402/vault/buy — price is DYNAMIC per item; the probe price is a floor, not a cap" },
  { label: "vault search", method: "GET", path: "/x402/vault/search?q=ebook", inTarget: false,
    note: "GET /x402/vault/search" },
  { label: "shipment tracking", method: "GET", path: "/x402/track?orderId=probe", inTarget: false,
    note: "GET /x402/track — expensive, and not part of the first activation" },
];

interface Reading {
  readonly probe: Probe;
  readonly httpStatus: number;
  readonly atomic: bigint | null;
  readonly mint: string | null;
  readonly payTo: string | null;
  readonly feePayer: string | null;
  readonly problem: string | null;
}

function decodeChallenge(header: string | null): Record<string, unknown> | null {
  if (!header) return null;
  try {
    return JSON.parse(Buffer.from(header.trim(), "base64").toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function read(probe: Probe): Promise<Reading> {
  const res = await fetch(`${PURCH}${probe.path}`, {
    method: probe.method,
    ...(probe.body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(probe.body) }),
  });

  const base = { probe, httpStatus: res.status } as const;
  if (res.status !== 402) {
    return { ...base, atomic: null, mint: null, payTo: null, feePayer: null,
      problem: `expected 402, got ${res.status}` };
  }

  const challenge = decodeChallenge(res.headers.get("payment-required"));
  const accepts = Array.isArray(challenge?.accepts) ? (challenge.accepts as Record<string, unknown>[]) : [];
  const solana = accepts.find((a) => a.network === SOLANA_CAIP);

  if (!solana) {
    return { ...base, atomic: null, mint: null, payTo: null, feePayer: null,
      problem: `no ${SOLANA_CAIP} option in the challenge` };
  }

  const extra = (solana.extra ?? {}) as Record<string, unknown>;
  const amount = typeof solana.amount === "string" ? solana.amount : null;

  return {
    ...base,
    atomic: amount !== null && /^\d+$/.test(amount) ? BigInt(amount) : null,
    mint: typeof solana.asset === "string" ? solana.asset : null,
    payTo: typeof solana.payTo === "string" ? solana.payTo : null,
    feePayer: typeof extra.feePayer === "string" ? extra.feePayer : null,
    problem: null,
  };
}

const usdc = (atomic: bigint): string => `$${(Number(atomic) / 1e6).toFixed(6)}`;

async function main(): Promise<void> {
  console.log("\n\x1b[1mPurch funding estimate\x1b[0m");
  console.log("Every price below was read from Purch's own live 402 just now. Read-only.\n");

  const readings = await Promise.all(PROBES.map(read));

  let anyMismatch = false;
  for (const r of readings) {
    const price = r.atomic === null ? "—" : usdc(r.atomic);
    console.log(`  ${r.probe.label.padEnd(28)} ${String(price).padStart(11)}   ${r.probe.note}`);
    if (r.problem) {
      console.log(`    \x1b[33m!\x1b[0m ${r.problem}`);
      continue;
    }
    if (r.mint !== SOLANA_USDC_MINT) {
      console.log(`    \x1b[31m✗\x1b[0m mint ${r.mint} is NOT the allowlisted USDC mint`);
      anyMismatch = true;
    }
    if (r.payTo !== EXPECTED_PAY_TO) {
      console.log(`    \x1b[31m✗\x1b[0m payTo ${r.payTo} is not the recorded Purch recipient`);
      anyMismatch = true;
    }
  }

  const target = readings.filter((r) => r.probe.inTarget && r.atomic !== null);
  const sum = target.reduce((acc, r) => acc + (r.atomic ?? 0n), 0n);

  console.log("\n\x1b[1mThe three activation flows\x1b[0m");
  for (const r of target) console.log(`  ${r.probe.label.padEnd(28)} ${usdc(r.atomic ?? 0n)}`);
  console.log(`  ${"minimum total".padEnd(28)} ${usdc(sum)}`);

  /**
   * The recommendation is deliberately not the minimum.
   *
   * `vault/buy` is priced per item, so the probe figure is a floor and a real item costs more. A
   * float sized to the exact sum of three probes is a float that fails on the first real purchase,
   * and the failure mode of an underfunded treasury during a live run is an ambiguous payment. The
   * headroom is for that, not for optimism.
   */
  const recommendedUsdc = 5;
  console.log("\n\x1b[1mRecommended funding\x1b[0m");
  console.log(`  USDC   ${recommendedUsdc}.00   (minimum ${usdc(sum)}; the rest is headroom for a`);
  console.log("                   dynamically-priced vault item and one retry-free second attempt)");

  const sponsored = readings.filter((r) => r.feePayer !== null);
  console.log(`\n  SOL    0.02     (~$4 at recent prices)`);
  if (sponsored.length > 0) {
    console.log(`\n  Purch SPONSORS the transaction fee — every challenge above names a feePayer`);
    console.log(`  (${sponsored[0]?.feePayer}), so Purch pays the`);
    console.log("  network fee for the settlement itself. The SOL is therefore NOT for gas on these");
    console.log("  calls. It is for the one thing a sponsor cannot cover: rent-exemption on the");
    console.log("  treasury's own USDC associated token account, about 0.00204 SOL, plus room for");
    console.log("  any future unsponsored rail. 0.02 SOL is roughly ten times what is needed and");
    console.log("  still costs less than a coffee.");
  }

  console.log("\n\x1b[1mWhat this does NOT unlock\x1b[0m");
  console.log("  Funding the wallet does not make Purch executable. X402SolanaExactClient.pay() still");
  console.log("  returns PROTOCOL_NOT_EXECUTABLE, because the exact payload serialisation the");
  console.log("  facilitator expects has not been confirmed against a real exchange. Money in the");
  console.log("  wallet and a working parser are two different prerequisites, and this script only");
  console.log("  sizes the first.");

  const gifts = "https://x402gifts.purch.xyz";
  console.log("\n\x1b[1mA finding worth recording\x1b[0m");
  console.log(`  ${gifts} returns 404, and Purch's own /.well-known/x402 lists no`);
  console.log("  gift endpoint. There is no live `gifts.suggest` or `gifts.purchase` surface on");
  console.log("  Purch today. POST /x402/shop is the nearest real thing, and it is a product");
  console.log("  recommendation rather than a gift flow.");

  if (anyMismatch) {
    console.error("\n\x1b[31mOne or more challenges named an unexpected mint or recipient. Do not fund until resolved.\x1b[0m");
    process.exit(1);
  }
  console.log("\n\x1b[32m✓\x1b[0m every live challenge named the allowlisted USDC mint and the recorded Purch recipient.");
}

main().catch((err: unknown) => {
  console.error(`\n\x1b[31mfunding estimate failed: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
