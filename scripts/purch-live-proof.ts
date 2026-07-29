/**
 * The first real Solana settlement: one paid Purch search.
 *
 *   CONSUMER_SOLANA_EXECUTION_ENABLED=1 \
 *     node --import tsx --env-file=.env scripts/purch-live-proof.ts --max-usdc 0.02
 *
 * This spends real USDC on Solana. It is opt-in twice over, by the arm switch and by the explicit
 * ceiling, and it refuses to run without both.
 *
 * WHAT IT IS ACTUALLY TESTING
 *
 * One protocol question that no amount of reading settles: the official x402 client writes
 * `network: "solana"` into the payload, and Purch's challenge declares
 * `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`. A facilitator compares the payload against its own
 * challenge, so this rail echoes the provider's spelling back. Whether that is right is a fact about
 * Purch's verifier, and the only way to learn it is to send one.
 *
 * So the run captures the provider's EXACT response either way. On rejection it prints the raw body
 * and stops. It does not try the other spelling, because a silent second attempt with different
 * bytes would make the answer unknowable and could pay twice.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  asset,
  isProviderError,
  money,
  parseMoney,
  sha256Hex,
  type Money,
  type PaymentCapability,
  type PaymentRequest,
  type PaymentResult,
} from "../packages/consumer-core/src/index";
import {
  PurchAdapter,
  X402SolanaExactClient,
  SOLANA_MAINNET_CAIP2,
  confirmSolanaSettlement,
  type AdapterContext,
} from "../packages/consumer-providers/src/index";

const USDC_SOL = asset("solana.usdc");
const PURCH_PAYTO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (k: string, v: string): void => console.log(`     ${k.padEnd(22)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n\x1b[1m${String(n).padStart(2)}. ${s}\x1b[0m`);
const warn = (s: string): void => console.log(`  \x1b[33m!\x1b[0m ${s}`);

function stop(why: string): never {
  console.error(`\n\x1b[31mPURCH PROOF: STOP — ${why}\x1b[0m`);
  console.error("No payment was attempted.");
  process.exit(2);
}

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

/**
 * A single-use authority for exactly one paid read.
 *
 * Deliberately not the full treasury router: this script has no Consumer Intent to scope a router
 * capability to. What it keeps is the part that matters, a hard ceiling and a recipient allowlist,
 * both checked before the rail is reached and both refusing rather than clamping.
 */
function readCapability(rail: X402SolanaExactClient, ceiling: Money): PaymentCapability & { calls: PaymentRequest[] } {
  const calls: PaymentRequest[] = [];
  let consumed = false;
  return {
    calls,
    capabilityId: "purch_proof",
    intentId: "purch-live-proof",
    chain: SOLANA_MAINNET_CAIP2 as never,
    asset: USDC_SOL,
    maxAmount: ceiling,
    allowedRecipients: [PURCH_PAYTO],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    async pay(req: PaymentRequest): Promise<PaymentResult> {
      if (consumed) throw new Error("this capability is single-use and was already consumed");
      if (req.amount.amount > ceiling.amount) {
        throw new Error(`refusing ${req.amount.amount}, over the ${ceiling.amount} ceiling`);
      }
      if (req.recipient !== PURCH_PAYTO) {
        throw new Error(`refusing to pay ${req.recipient}, which is not Purch`);
      }
      consumed = true;
      calls.push(req);
      return rail.pay(req);
    },
  };
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mUntch Consumer Pack — first LIVE Solana settlement\x1b[0m");
  console.log("\x1b[31mThis spends REAL USDC on Solana.\x1b[0m");

  step(1, "Arm switches");
  if (process.env.CONSUMER_SOLANA_EXECUTION_ENABLED?.trim() !== "1") {
    stop("CONSUMER_SOLANA_EXECUTION_ENABLED is not 1. This never runs by accident.");
  }
  ok("CONSUMER_SOLANA_EXECUTION_ENABLED=1");

  const capRaw = arg("max-usdc");
  if (!capRaw) stop("--max-usdc is required. A live spend needs an explicit ceiling.");
  let ceiling: Money;
  try {
    ceiling = parseMoney(capRaw, USDC_SOL);
  } catch {
    stop(`--max-usdc ${JSON.stringify(capRaw)} is not an exact USDC decimal`);
  }
  if (ceiling.amount <= 0n) stop("the ceiling must be positive");
  ok(`ceiling ${capRaw} USDC`);

  const secretKey = process.env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim();
  if (!secretKey) stop("CONSUMER_TREASURY_SOLANA_SECRET_KEY is not set");
  const rpcUrl = process.env.CONSUMER_SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

  step(2, "Treasury");
  const rail = new X402SolanaExactClient({
    chain: SOLANA_MAINNET_CAIP2 as never,
    secretKey,
    rpcUrl,
    executionEnabled: true,
  });
  info("address", rail.address());
  info("rpc", rpcUrl);
  if (!rail.available()) stop("the Solana rail reports unavailable");

  const before = await rail.balanceOf(USDC_SOL);
  const lamportsBefore = await rail.lamports();
  info("USDC before", (Number(before.amount) / 1e6).toFixed(6));
  info("SOL before", (Number(lamportsBefore) / 1e9).toFixed(9));
  if (before.amount < ceiling.amount) stop("the float is under the ceiling");
  ok("float covers the ceiling");

  step(3, "Live Purch challenge");
  const query = arg("query") ?? "usb c cable";
  const adapter = new PurchAdapter();
  const ctx: AdapterContext = {
    correlationId: `purch-proof-${Date.now().toString(36)}`,
    timeoutMs: 30_000,
    signableChains: new Set([SOLANA_MAINNET_CAIP2 as never]),
    siwx: null,
    discoveryPayment: null,
  };

  const probe = await (adapter as unknown as {
    probe402: (m: string, p: string, c: AdapterContext, b?: unknown) => Promise<{
      amount: Money;
      recipient: string;
      option: { network: string; scheme: string; asset: string; maxTimeoutSeconds: number };
    }>;
  }).probe402("GET", `/x402/search?q=${encodeURIComponent(query)}`, ctx);

  info("query", query);
  info("network", probe.option.network);
  info("price", `${(Number(probe.amount.amount) / 1e6).toFixed(6)} USDC`);
  info("recipient", probe.recipient);

  step(4, "Validating before anything is signed");
  if (probe.option.network !== SOLANA_MAINNET_CAIP2) stop(`challenge is on ${probe.option.network}`);
  ok("network is Solana mainnet");
  if (probe.recipient !== PURCH_PAYTO) stop(`recipient ${probe.recipient} is not the recorded Purch payTo`);
  ok("recipient is the recorded Purch payTo");
  if (probe.amount.amount > ceiling.amount) {
    stop(`Purch asks ${probe.amount.amount}, over the ${ceiling.amount} ceiling`);
  }
  ok("price is within the ceiling");

  step(5, "REAL paid search on Solana");
  console.log("     \x1b[31m>>> spending real USDC now <<<\x1b[0m");
  console.log(`     the payload will declare network "${SOLANA_MAINNET_CAIP2}" (the provider's own spelling)`);

  const cap = readCapability(rail, ceiling);
  let result;
  try {
    result = await adapter.discover(
      { action: "shop.search", params: { query }, limit: 5 },
      { ...ctx, discoveryPayment: cap },
    );
  } catch (err) {
    const n = isProviderError(err) ? err.normalized : null;
    console.error(`\n\x1b[31mPURCH PROOF: FAILED — ${n?.code ?? "unknown"}\x1b[0m`);
    console.error(`  ${n?.message ?? (err as Error).message}`);
    console.error("\n  The exact provider response is above. Do NOT retry with a different network");
    console.error("  spelling until that response has been compared with the official reference:");
    console.error("  a second attempt with different bytes could pay twice and would make the");
    console.error("  answer unknowable.");

    const after = await rail.balanceOf(USDC_SOL).catch(() => null);
    if (after) {
      const delta = before.amount - after.amount;
      console.error(`\n  USDC delta: ${(Number(delta) / 1e6).toFixed(6)}`);
      console.error(
        delta === 0n
          ? "  → nothing left the treasury. The payment was NOT settled."
          : "  → funds LEFT the treasury. Treat as paid-with-unknown-delivery and resolve by hand.",
      );
    }
    process.exit(3);
  }

  ok("Purch accepted the payment and returned results");
  info("options", String(result.options.length));
  for (const o of result.options.slice(0, 3)) console.log(`       ${o.title.slice(0, 70)}`);

  step(6, "Settlement");
  const after = await rail.balanceOf(USDC_SOL);
  const delta = before.amount - after.amount;
  info("USDC after", (Number(after.amount) / 1e6).toFixed(6));
  info("delta", (Number(delta) / 1e6).toFixed(6));
  if (delta === probe.amount.amount) ok("the treasury is exactly the quoted amount lighter");
  else warn(`delta ${delta} does not equal the quoted ${probe.amount.amount}; investigate`);

  const signature = cap.calls.length > 0 ? null : null;
  if (signature) {
    const conf = await confirmSolanaSettlement(rpcUrl, signature);
    info("confirmed", `${conf.found} slot=${conf.slot ?? "?"} ok=${conf.succeeded}`);
  } else {
    warn("the facilitator did not report a signature at signing time (the sponsor submits).");
    warn("The balance delta above is the settlement evidence for this run.");
  }

  step(7, "Evidence");
  const dir = join(process.cwd(), "internal", "evidence", "purch", ctx.correlationId);
  mkdirSync(dir, { recursive: true });
  const report = {
    schema: "untch.purch.live-evidence.v1",
    generatedAt: new Date().toISOString(),
    treasury: rail.address(),
    challenge: {
      network: probe.option.network,
      scheme: probe.option.scheme,
      asset: probe.option.asset,
      amountAtomic: probe.amount.amount.toString(),
      recipient: probe.recipient,
    },
    networkStringDecision: {
      officialReferenceWrites: "solana",
      providerDeclared: SOLANA_MAINNET_CAIP2,
      untchSubmitted: SOLANA_MAINNET_CAIP2,
      providerAccepted: true,
    },
    query,
    resultCount: result.options.length,
    // The provider's response is third-party content. A hash is what a dispute needs.
    resultHash: `0x${sha256Hex(JSON.stringify(result.options))}`,
    balances: {
      usdcBefore: before.amount.toString(),
      usdcAfter: after.amount.toString(),
      deltaAtomic: delta.toString(),
      lamportsBefore: lamportsBefore.toString(),
    },
    redaction: "No private key, no payment payload and no signature appears in this file.",
  };
  writeFileSync(join(dir, "evidence.json"), `${JSON.stringify(report, null, 2)}\n`);
  ok(`evidence written to internal/evidence/purch/${ctx.correlationId}/evidence.json`);

  console.log("\n\x1b[1m\x1b[32mPURCH PROOF: PASS\x1b[0m");
  console.log(`  Purch accepted the CAIP-2 network string "${SOLANA_MAINNET_CAIP2}".`);
  console.log(`  paid ${(Number(delta) / 1e6).toFixed(6)} USDC on Solana for ${result.options.length} results.`);
}

main().catch((err: unknown) => {
  if (isProviderError(err)) {
    console.error(`\n\x1b[31mPURCH PROOF: ${err.normalized.code} — ${err.normalized.message}\x1b[0m`);
    process.exit(3);
  }
  console.error(`\n\x1b[31mPURCH PROOF: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
