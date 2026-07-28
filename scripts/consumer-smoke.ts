/**
 * Live provider smoke test — the ONLY thing in this repository that spends real money.
 *
 * It exists because a provider cannot be promoted to `verified` on the strength of a fixture. The
 * whole maturity ladder rests on the claim "a real settled payment from an Untch treasury wallet has
 * been observed", and this script is how that observation is made.
 *
 * It is deliberately hard to run by accident:
 *
 *   • CONSUMER_SMOKE_ENABLED=1 must be set explicitly.
 *   • CONSUMER_SMOKE_MAX_SPEND caps the total, and the script STOPS before exceeding it.
 *   • A treasury key for the provider's rail must be present, and its float must be funded.
 *   • It runs NOTHING in CI. No workflow references it, and it refuses without the flag.
 *   • By default it runs only READ-priced endpoints (cents). Registering a domain or buying a
 *     product needs --allow-purchase as well, because those are non-idempotent and irreversible.
 *
 *   CONSUMER_SMOKE_ENABLED=1 CONSUMER_SMOKE_MAX_SPEND=0.25 pnpm consumer:smoke --provider stabledomains
 *
 * What it proves, and what it does not: a green run proves ONE settlement happened on ONE rail. It
 * does not prove delivery. Promotion needs the settlement re-read independently (a block explorer,
 * not this script's stdout) and delivery verified through a path that is not the merchant's own
 * assertion — see docs/consumer-pack-runbook.md → "Promoting a provider to verified".
 */

import {
  asset,
  displayMoney,
  formatMoney,
  gtMoney,
  isProviderError,
  money,
  parseMoney,
  unknownProviderError,
  type CaipChainId,
  type Money,
  type PaymentCapability,
  type PaymentRequest,
  type PaymentResult,
} from "../packages/consumer-core/src/index";
import {
  StableDomainsAdapter,
  StableEmailAdapter,
  X402EvmExactClient,
  type AdapterContext,
  type ConsumerProviderAdapter,
} from "../packages/consumer-providers/src/index";

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

function stop(code: number, message: string): never {
  console.error(`\nSMOKE: STOP — ${message}`);
  console.error("No payment was attempted.");
  process.exit(code);
}

/** The verified Base payTo per provider, read from the live 402s on 2026-07-27. */
const RECIPIENTS: Readonly<Record<string, readonly string[]>> = {
  stabledomains: ["0xABcb091D90419E1c8AD4818f1B33FC4645501892"],
  stableemail: ["0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671"],
};

/**
 * A capability whose ceiling is the REMAINING budget, re-derived on every mint. It is the same
 * shape the treasury router hands an adapter, minus the Postgres round trip — this script has no
 * database, and the control that matters here is the cap.
 */
function budgetedCapability(args: {
  readonly rail: X402EvmExactClient;
  readonly recipients: readonly string[];
  readonly remaining: () => Money;
  readonly onSpend: (m: Money) => void;
}): PaymentCapability {
  let consumed = false;
  return {
    capabilityId: "smoke",
    intentId: "smoke",
    chain: BASE,
    asset: USDC,
    maxAmount: args.remaining(),
    allowedRecipients: args.recipients.map((r) => r.toLowerCase()),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    async pay(req: PaymentRequest): Promise<PaymentResult> {
      if (consumed) throw new Error("smoke capability already consumed");
      const remaining = args.remaining();
      if (gtMoney(req.amount, remaining)) {
        stop(
          3,
          `the provider asked ${displayMoney(req.amount)} but only ${displayMoney(remaining)} of the ` +
            "spend cap is left (CONSUMER_SMOKE_MAX_SPEND)",
        );
      }
      if (!args.recipients.some((r) => r.toLowerCase() === req.recipient.toLowerCase())) {
        stop(3, `the provider asked to be paid at ${req.recipient}, which is not the verified payTo`);
      }
      consumed = true;
      console.log(`  paying ${displayMoney(req.amount)} → ${req.recipient}`);
      const result = await args.rail.pay(req);
      args.onSpend(req.amount);
      return result;
    },
  };
}

async function main(): Promise<void> {
  console.log("\nUntch Consumer Pack — LIVE provider smoke test");
  console.log("This spends REAL money on a REAL merchant.\n");

  if (process.env.CONSUMER_SMOKE_ENABLED !== "1") {
    stop(2, "CONSUMER_SMOKE_ENABLED is not 1. This script never runs by accident, and never in CI.");
  }

  const capRaw = process.env.CONSUMER_SMOKE_MAX_SPEND?.trim();
  if (!capRaw) stop(2, "CONSUMER_SMOKE_MAX_SPEND is not set. A live spend needs an explicit ceiling.");
  let cap: Money;
  try {
    cap = parseMoney(capRaw, USDC);
  } catch {
    stop(2, `CONSUMER_SMOKE_MAX_SPEND=${JSON.stringify(capRaw)} is not an exact decimal`);
  }
  if (cap.amount <= 0n) stop(2, "CONSUMER_SMOKE_MAX_SPEND must be positive");

  const providerId = arg("provider") ?? "stabledomains";
  const recipients = RECIPIENTS[providerId];
  if (!recipients) {
    stop(2, `no verified Base payTo is recorded for '${providerId}' — capture one before spending`);
  }

  const key = process.env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  if (!key) {
    stop(2, "CONSUMER_TREASURY_BASE_PRIVATE_KEY is not set — there is no wallet to pay from");
  }

  const rail = new X402EvmExactClient({
    chain: BASE,
    evmChainId: 8453,
    privateKey: key as `0x${string}`,
    rpcUrl: process.env.CONSUMER_BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  });
  if (!rail.available()) stop(2, "the Base rail reports unavailable");

  console.log(`provider   ${providerId}`);
  console.log(`wallet     ${rail.address()}`);
  console.log(`spend cap  ${displayMoney(cap)}`);

  // Funding precheck — STOP if unfunded rather than discovering it mid-flight.
  let balance: Money;
  try {
    balance = await rail.balanceOf(USDC);
  } catch (err) {
    stop(2, `could not read the USDC balance: ${(err as Error).message}`);
  }
  console.log(`balance    ${displayMoney(balance)}`);
  if (balance.amount < cap.amount) {
    stop(2, `the float holds ${formatMoney(balance)} USDC, less than the ${formatMoney(cap)} cap`);
  }

  let spent = money(0n, USDC);
  const remaining = (): Money => money(cap.amount - spent.amount, USDC);
  const onSpend = (m: Money): void => {
    spent = money(spent.amount + m.amount, USDC);
  };

  const adapter: ConsumerProviderAdapter =
    providerId === "stableemail" ? new StableEmailAdapter() : new StableDomainsAdapter();

  const ctx: AdapterContext = {
    correlationId: `smoke-${Date.now().toString(36)}`,
    timeoutMs: 20_000,
    signableChains: new Set<CaipChainId>([BASE]),
    siwx: null,
    discoveryPayment: budgetedCapability({ rail, recipients, remaining, onSpend }),
  };

  console.log("\n1. health");
  const health = await adapter.health(ctx);
  console.log(`   ${health.healthy ? "reachable" : "UNREACHABLE"} ${health.latencyMs ?? "?"}ms — ${health.detail}`);
  if (!health.healthy) stop(3, "the provider is unreachable");

  console.log("\n2. paid discovery (a READ — cents-scale)");
  try {
    const result = await adapter.discover(
      {
        action: providerId === "stableemail" ? "notify.receipt" : "domains.check",
        params: { name: arg("name") ?? `untchsmoke${Date.now().toString(36).slice(-6)}` },
        limit: 5,
      },
      ctx,
    );
    console.log(`   ${result.options.length} option(s) from ${result.providerId}`);
    console.log(`   spent so far: ${displayMoney(spent)}`);
  } catch (err) {
    const n = isProviderError(err) ? err.normalized : unknownProviderError(err);
    console.error(`\nSMOKE: discovery FAILED — ${n.code}: ${n.message}`);
    console.error(`Spent: ${displayMoney(spent)}`);
    process.exit(3);
  }

  if (!has("allow-purchase")) {
    console.log("\nSMOKE: PASS (read only).");
    console.log(`Total spent: ${displayMoney(spent)}`);
    console.log("\nA purchase is NOT included. Non-idempotent, irreversible actions need");
    console.log("--allow-purchase in addition to every flag above.");
    console.log("\nThis proves ONE settlement on ONE rail. It does not prove delivery, and it is not");
    console.log("sufficient on its own to promote a provider — see docs/consumer-pack-runbook.md.");
    return;
  }

  console.log("\n3. purchase — IRREVERSIBLE");
  console.error("   Purchase mode is not wired in this script.");
  console.error("   A live purchase must go through the ORCHESTRATOR so it is bounded by a policy,");
  console.error("   an approval and a funded intent — not through a standalone driver that bypasses");
  console.error("   every control the Consumer Pack exists to enforce.");
  console.error("   Drive it through POST /consumer/domains/quote → /consumer/fund/:intentId instead.");
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(`\nSMOKE: unexpected error — ${(err as Error).message}`);
  process.exit(1);
});
