import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import type { ChallengeBinding } from "@untch/x402-guard";
import { buyerAddress, readSettlementBalance } from "./buyer";
import { guardedBuyerCall, type PreflightCallResult, type SettledPayment } from "./guard-buyer";
import { MissingEnvError, NETWORK, SETTLEMENT_TOKEN } from "./config";
import { loadDemoPolicyRef } from "./demo-policy";

/**
 * §14 Mode B DOGFOOD PROOF — the buyer routes a real paid call through @untch/x402-guard.
 *
 * This REPLACES the ad-hoc "fetch the 402 then immediately sign it" path. One real end-to-end cycle,
 * no mocks, against the live Railway seller:
 *   1. The buyer authorizes a $0.01 `logistics` call to the Untch endpoint (its own known payTo,
 *      token, amount, resource) — the source-of-truth binding.
 *   2. `guardedBuyerCall` probes the endpoint, intercepts the 402, and runs the Challenge Binding
 *      Check against that authorization.
 *   3. On a bound challenge it makes a REAL paid `preflight_payment` ($0.05) against the real
 *      policy-storage-backed engine → APPROVED (the stored demo policy allows `logistics`).
 *   4. APPROVE ⇒ the buyer's OWN signer settles the $0.01 call. The guard never held the key.
 *
 * Two real settlements land on X Layer (preflight $0.05 + the guarded $0.01). Verify each by raw RPC.
 * STOPs (never simulates) if unfunded or if the binding/decision withholds.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://untch-asp-production.up.railway.app";
const PING_PRICE_ATOMIC = "10000"; // $0.01 in USDT0 base units (6dp) — the live ping_untch price
const NEEDED_ATOMIC = parseUnits("0.10", SETTLEMENT_TOKEN.decimals); // preflight $0.05 + call $0.01 + margin

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return path;
}

function fail(code: number, message: string): never {
  console.error(`\nRESULT: FAIL / BLOCKED — ${message}`);
  console.error("Settlement reference: NONE (no real settled guarded call).");
  process.exit(code);
}

/**
 * The intent the guarded purchase commits to — a $0.01 `logistics` call, bound to the real stored demo
 * policy by `policyHash`. Unique taskHash/nonce so a re-run is not a duplicate in the seller's ledger.
 */
function buildIntent(
  owner: `0x${string}`,
  payTo: `0x${string}`,
  resourceUrl: string,
  runSalt: string,
  policyHash: string,
  category: string,
): Record<string, unknown> {
  return {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: SETTLEMENT_TOKEN.address,
    maxAmount: PING_PRICE_ATOMIC, // exact $0.01 — the guarded call's price
    taskHash: keccak256(toHex(`untch-guard-e2e-task:${runSalt}`)),
    acceptanceHash: keccak256(toHex(`untch-guard-e2e-acceptance:${category}.v1`)),
    schemaHash: keccak256(toHex(`untch-guard-e2e-schema:${category}.v1`)),
    policyHash,
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: resourceUrl,
    paramsHash: keccak256(toHex(`untch-guard-e2e-params:${runSalt}`)),
    recipientAddress: payTo,
    // The category the intent commits to — must be allowed by the policy the deployed seller enforces.
    // Overridable via GUARD_CATEGORY so this proof targets whichever policy the live seller runs.
    category,
    amount: 0.01,
  };
}

async function main(): Promise<void> {
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  const buyerKeyRaw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!buyerKeyRaw) fail(2, new MissingEnvError("BUYER_PRIVATE_KEY").message + " — run gen-buyer-wallet");
  const buyerKey = buyerKeyRaw as `0x${string}`;

  const payToRaw = process.env.PAY_TO_ADDRESS?.trim();
  if (!payToRaw || !/^0x[0-9a-fA-F]{40}$/.test(payToRaw)) {
    fail(2, "PAY_TO_ADDRESS (the seller's known payout wallet the buyer authorizes) not set/invalid");
  }
  const payTo = payToRaw as `0x${string}`;

  const demoPolicy = loadDemoPolicyRef();
  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());

  // The buyer authorizes paying the Untch seller: its known payTo, USDT0, exactly $0.01, for the
  // advertised ping resource, invoked over https. This is the INDEPENDENT source of truth the guard
  // checks the live 402 challenge against — a redirected recipient / altered amount / swapped resource
  // would be a terminal REJECTED_BINDING here, before any preflight spend and before any signing.
  const advertisedResource = "http://untch-asp-production.up.railway.app/ping_untch"; // seller advertises http
  const invokedEndpoint = `${sellerUrl}/ping_untch`;
  const expectedBinding: ChallengeBinding = {
    recipient: payTo,
    token: SETTLEMENT_TOKEN.address,
    amount: PING_PRICE_ATOMIC,
    resourceUrl: advertisedResource,
    endpoint: invokedEndpoint,
    method: "GET",
    nonce: "", // this seller binds no per-challenge nonce
    expiry: "", // and no explicit expiry
  };

  const category = process.env.GUARD_CATEGORY?.trim() || "market-data";
  const intent = buildIntent(owner, payTo, advertisedResource, runSalt, demoPolicy.policyHash, category);

  console.log(`[guard-e2e] buyer/owner : ${owner}`);
  console.log(`[guard-e2e] seller      : ${sellerUrl}`);
  console.log(`[guard-e2e] authorized  : $0.01 → ${payTo} for ${invokedEndpoint} (category ${category})`);
  console.log(`[guard-e2e] policyId    : ${demoPolicy.policyId} (real stored policy; hash ${demoPolicy.policyHash})`);

  const balance = await readSettlementBalance(owner);
  console.log(
    `[guard-e2e] balance     : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} ` +
      `(need >= ${formatUnits(NEEDED_ATOMIC, SETTLEMENT_TOKEN.decimals)} for preflight $0.05 + call $0.01)`,
  );
  if (balance < NEEDED_ATOMIC) fail(2, "buyer wallet unfunded for a guarded preflight+call cycle");

  let preflightResult: PreflightCallResult | null = null;
  const outcome = await guardedBuyerCall({
    buyerKey,
    sellerUrl,
    resourceUrl: invokedEndpoint,
    method: "GET",
    expectedBinding,
    intent,
    policyId: demoPolicy.policyId,
    onPreflight: (r) => {
      preflightResult = r;
      console.log(`[guard-e2e] preflight   : decision ${r.decision} (settled tx ${r.settlementTx ?? "none"})`);
    },
  });

  const proof: Record<string, unknown> = {
    meta: {
      proof: "§14 Mode B — @untch/x402-guard real dogfood e2e (buyer routes a paid call through the middleware)",
      buyer: owner,
      seller: sellerUrl,
      network: NETWORK,
      settlementToken: SETTLEMENT_TOKEN,
      policyId: demoPolicy.policyId,
      policyHash: demoPolicy.policyHash,
      runSalt,
      capturedAt: new Date().toISOString(),
    },
    authorizedBinding: expectedBinding,
    intent,
    guardStatus: outcome.status,
    preflight: preflightResult,
    outcome,
  };

  if (outcome.status !== "APPROVED") {
    const detail =
      outcome.status === "BLOCKED"
        ? `${outcome.code}: ${outcome.detail}`
        : `ESCALATED (${outcome.pollHandle.reason}) — held, pollable, not settled`;
    save("guard-e2e-proof.json", proof);
    fail(3, `guard returned ${outcome.status} — ${detail}`);
  }

  const settled = outcome.response as SettledPayment;
  const guardedTx = settled.settlementTx;
  const preflightTx = preflightResult ? (preflightResult as PreflightCallResult).settlementTx : null;
  (proof as { settlementTxs?: unknown }).settlementTxs = { preflight: preflightTx, guardedCall: guardedTx };

  const proofPath = save("guard-e2e-proof.json", proof);

  const transcript = [
    "# §14 Mode B — @untch/x402-guard real dogfood e2e",
    "",
    `- **When:** ${(proof.meta as { capturedAt: string }).capturedAt}`,
    `- **Buyer:** \`${owner}\``,
    `- **Seller:** ${sellerUrl} (live Railway)`,
    `- **Policy:** \`${demoPolicy.policyId}\` (real stored, allows \`logistics\`)`,
    "",
    "## Cycle (all real, no mocks)",
    "1. Buyer authorized $0.01 → the Untch payTo for the ping resource (independent source of truth).",
    "2. `@untch/x402-guard` probed the endpoint, intercepted the **402**, ran the Challenge Binding Check → **BOUND**.",
    `3. Real paid \`preflight_payment\` ($0.05) → decision **${(preflightResult as unknown as PreflightCallResult | null)?.decision}** (settled tx \`${preflightTx}\`).`,
    "4. APPROVE ⇒ the buyer's OWN signer settled the $0.01 call. The middleware never held the key.",
    "",
    "## Settlements (verify by raw RPC — not the service's word)",
    `- **preflight ($0.05):** \`${preflightTx}\`` + (preflightTx ? ` — https://www.oklink.com/x-layer/tx/${preflightTx}` : ""),
    `- **guarded call ($0.01):** \`${guardedTx}\`` + (guardedTx ? ` — https://www.oklink.com/x-layer/tx/${guardedTx}` : ""),
    "",
    `Structured evidence: \`${proofPath.split("/").slice(-1)[0]}\`.`,
    "",
  ].join("\n");
  const transcriptPath = save("guard-e2e-transcript.md", transcript);

  if (!guardedTx) fail(3, "APPROVED but the guarded call returned no settlement tx");

  console.log("");
  console.log("RESULT: PASS — real paid call through @untch/x402-guard → CBC BOUND → preflight APPROVED → settled.");
  console.log(`Preflight settlement tx : ${preflightTx}`);
  console.log(`Guarded call settlement : ${guardedTx}`);
  console.log(`Explorer (guarded call) : https://www.oklink.com/x-layer/tx/${guardedTx}`);
  console.log(`Evidence  : ${proofPath}`);
  console.log(`Transcript: ${transcriptPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
