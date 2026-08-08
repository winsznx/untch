import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, keccak256, parseUnits, toHex } from "viem";
import { decodePaymentResponseHeader } from "@okxweb3/x402-fetch";
import {
  buyerAddress,
  makeBuyerFetch,
  makeRecordingFetch,
  readSettlementBalance,
} from "./buyer";
import { MissingEnvError, NETWORK, PREFLIGHT_PRICE, SETTLEMENT_TOKEN } from "./config";
import { loadDemoPolicyRef } from "./demo-policy";

/**
 * Step-2 END-TO-END PROOF (continuation of the D0.1 proof line).
 *
 * Buyer-only driver against the REMOTE deployed seller (SELLER_URL, the Railway box that can reach
 * web3.okx.com). Two real calls, no mocks:
 *   A. POST /create_spend_intent (bundled/unpriced) — mint a real intentHash from @untch/canon.
 *   B. POST /preflight_payment   ($0.05, priced x402) — the buyer signs EIP-3009 and pays the real
 *      $0.05 USDT0; the OKX facilitator settles on X Layer; the seller runs the REAL policy engine
 *      and returns the decision. We capture the 402 challenge, the PAYMENT-SIGNATURE, the
 *      PAYMENT-RESPONSE settlement (tx hash), and the policy decision.
 *
 * STOPs (never simulates) if the buyer is unprovisioned/unfunded. Evidence → internal/day0/D0.1-evidence/.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const PRICE_ATOMIC = parseUnits("0.05", SETTLEMENT_TOKEN.decimals);
const DEFAULT_SELLER = "https://asp.untch.xyz";

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n";
  writeFileSync(path, text);
  return path;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function decodeMaybe(b64: string | undefined): unknown {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return { raw: `${b64.slice(0, 24)}…(${b64.length} chars)` };
  }
}

function fail(code: number, message: string): never {
  console.error(`\nRESULT: FAIL / BLOCKED — ${message}`);
  console.error("Settlement reference: NONE (no real settled preflight call).");
  process.exit(code);
}

/** A real, unique-per-run intent that APPROVES under the real stored demo policy. Unique taskHash +
 *  nonce so a re-run is not a duplicate against the seller's in-memory ledger (60-min TTL). Bound to
 *  the real policy by `policyHash` — the seller enforces intent.policyHash == stored policyHash. */
function buildIntent(owner: `0x${string}`, runSalt: string, policyHash: string): Record<string, unknown> {
  const taskHash = keccak256(toHex(`untch-step2-preflight-task:${runSalt}`));
  const paramsHash = keccak256(toHex(`untch-step2-preflight-params:${runSalt}`));
  const acceptanceHash = keccak256(toHex("untch-step2-acceptance:schema=marketdata.v1;deadline<=T+1h"));
  const schemaHash = keccak256(toHex("untch-step2-schema:marketdata.v1"));
  return {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0", // A2MCP endpoint call — no worker agent
    token: SETTLEMENT_TOKEN.address,
    maxAmount: "1000000", // 1.0 USDT ceiling (base units, 6dp)
    taskHash,
    acceptanceHash,
    schemaHash,
    policyHash, // bind to the exact real stored policy this seller enforces
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    paramsHash,
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category: "market-data", // in the demo policy allow-list → passes
    amount: 0.5, // the $0.50 spend being preflighted (distinct from the $0.05 preflight fee)
  };
}

async function main(): Promise<void> {
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  let buyerKey: `0x${string}`;
  const raw = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!raw) {
    fail(2, new MissingEnvError("BUYER_PRIVATE_KEY").message + " — run gen-buyer-wallet first");
  }
  buyerKey = raw as `0x${string}`;

  const demoPolicy = loadDemoPolicyRef();
  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());
  console.log(`[proof] buyer/owner : ${owner}`);
  console.log(`[proof] seller      : ${sellerUrl}`);
  console.log(`[proof] policyId    : ${demoPolicy.policyId} (real stored policy; hash ${demoPolicy.policyHash})`);
  console.log(`[proof] preflight   : ${PREFLIGHT_PRICE} in ${SETTLEMENT_TOKEN.symbol} on ${NETWORK}`);

  // Funding precheck — STOP if unfunded (never simulate).
  const balance = await readSettlementBalance(owner);
  console.log(
    `[proof] balance     : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} ` +
      `(need >= ${formatUnits(PRICE_ATOMIC, SETTLEMENT_TOKEN.decimals)})`,
  );
  if (balance < PRICE_ATOMIC) fail(2, "buyer wallet unfunded for a $0.05 preflight");

  // ── Step A: create_spend_intent (unpriced) ──────────────────────────────────
  const intent = buildIntent(owner, runSalt, demoPolicy.policyHash);
  const createRes = await fetch(`${sellerUrl}/create_spend_intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...intent, policyId: demoPolicy.policyId }),
  });
  const createBody = (await createRes.json()) as { intentHash?: string; onchain?: unknown };
  if (createRes.status !== 200 || !createBody.intentHash) {
    save("step2-preflight-proof.json", { step: "create_spend_intent", status: createRes.status, body: createBody });
    fail(3, `create_spend_intent returned ${createRes.status} without an intentHash`);
  }
  const intentHash = createBody.intentHash;
  console.log(`[proof] intentHash  : ${intentHash}  (onchain=${JSON.stringify(createBody.onchain)})`);

  // ── Step B: preflight_payment ($0.05, priced) ───────────────────────────────
  const url = `${sellerUrl}/preflight_payment`;
  // Send intentHash + inline intent: the seller cross-checks the hash matches (create→preflight
  // binding) AND can evaluate the intent regardless of its in-memory store state — a robust
  // one-shot paid proof. (The store-lookup-by-hash path is covered by the unit tests.)
  const payload = JSON.stringify({ intentHash, intent, policyId: demoPolicy.policyId });

  // 1. Raw 402 challenge (unpaid).
  const unpaid = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
  });
  const unpaidBody = await unpaid.text();
  const paymentRequired = unpaid.headers.get("PAYMENT-REQUIRED");
  const challenge = {
    status: unpaid.status,
    headers: headersToObject(unpaid.headers),
    paymentRequiredDecoded: paymentRequired
      ? JSON.parse(Buffer.from(paymentRequired, "base64").toString("utf8"))
      : null,
    body: unpaidBody,
  };
  console.log(`[proof] 402 challenge captured (status ${unpaid.status})`);
  if (unpaid.status !== 402) {
    save("step2-preflight-proof.json", { step: "preflight-402", challenge });
    fail(3, `expected 402 from preflight_payment, got ${unpaid.status} (seller may not reach the facilitator)`);
  }

  // 2. Pay: sign EIP-3009 + retry (wrapper), recording the PAYMENT-SIGNATURE header.
  const recording = makeRecordingFetch();
  const payFetch = makeBuyerFetch(buyerKey, recording);
  let paid: Response;
  try {
    paid = await payFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
  } catch (err) {
    save("step2-preflight-proof.json", {
      step: "preflight-pay",
      challenge,
      paymentSignatureDecoded: decodeMaybe(recording.getPaymentSignature()),
      error: (err as Error).message,
    });
    fail(3, `payment failed: ${(err as Error).message}`);
  }

  const decisionBody = await paid.text();
  const paymentResponseHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = paymentResponseHeader ? decodePaymentResponseHeader(paymentResponseHeader) : null;
  let decision: Record<string, unknown> | null = null;
  try {
    decision = JSON.parse(decisionBody) as Record<string, unknown>;
  } catch {
    /* non-JSON body captured raw below */
  }

  const proof = {
    meta: {
      step: "Step-2 preflight_payment end-to-end proof",
      note: "Continuation of the D0.1 proof line. Real x402 settlement + real §7.1 policy decision.",
      buyer: owner,
      seller: sellerUrl,
      price: PREFLIGHT_PRICE,
      network: NETWORK,
      settlementToken: SETTLEMENT_TOKEN,
      runSalt,
      capturedAt: new Date().toISOString(),
    },
    createSpendIntent: { status: createRes.status, request: intent, response: createBody },
    preflightPayment: {
      challenge,
      paymentSignatureDecoded: decodeMaybe(recording.getPaymentSignature()),
      response: { status: paid.status, headers: headersToObject(paid.headers), body: decision ?? decisionBody },
      settlement,
    },
    decision: (decision?.decision as string) ?? null,
    settlementTx: (settlement as { transaction?: string } | null)?.transaction ?? null,
  };
  const proofPath = save("step2-preflight-proof.json", proof);

  const settled = paid.status === 200 && settlement && (settlement as { success?: boolean }).success;
  const decisionCode = (decision?.decision as string) ?? "(no decision in body)";
  const txHash = proof.settlementTx ?? "(none)";

  const transcript = [
    "# Step-2 — preflight_payment end-to-end proof (continuation of D0.1)",
    "",
    `- **When:** ${proof.meta.capturedAt}`,
    `- **Buyer / owner:** \`${owner}\` (funded burner from D0.1)`,
    `- **Seller:** ${sellerUrl} (Railway; reaches the OKX facilitator)`,
    `- **Price paid:** ${PREFLIGHT_PRICE} ${SETTLEMENT_TOKEN.symbol} on ${NETWORK} (real x402/EIP-3009)`,
    "",
    "## Cycle",
    `1. \`POST /create_spend_intent\` → 200, intentHash \`${intentHash}\` (onchain: null — no registry yet).`,
    `2. \`POST /preflight_payment\` unpaid → **402** PAYMENT-REQUIRED (challenge captured).`,
    `3. Buyer signed EIP-3009 \`transferWithAuthorization\`; PAYMENT-SIGNATURE sent (captured).`,
    `4. OKX facilitator settled on X Layer → PAYMENT-RESPONSE tx \`${txHash}\`.`,
    `5. Seller ran the REAL @untch/policy-engine → decision **${decisionCode}**.`,
    "",
    `## Result: ${settled ? "PASS" : "INCOMPLETE"}`,
    `- Settlement success: ${Boolean(settled)}`,
    `- Settlement tx: \`${txHash}\`` + (txHash !== "(none)" ? ` — https://www.oklink.com/x-layer/tx/${txHash}` : ""),
    `- Policy decision returned: **${decisionCode}**`,
    "- receiptRef / sig in the decision: **null** (receipt writer + oracle signer not built yet).",
    "",
    `Full structured evidence: \`${proofPath.split("/").slice(-1)[0]}\`.`,
    "",
  ].join("\n");
  const transcriptPath = save("step2-preflight-transcript.md", transcript);

  console.log("");
  if (settled) {
    console.log(`RESULT: PASS — real settled $0.05 preflight_payment on X Layer via the OKX facilitator.`);
    console.log(`Policy decision returned: ${decisionCode}`);
    console.log(`Settlement tx: ${txHash}`);
    console.log(`Explorer: https://www.oklink.com/x-layer/tx/${txHash}`);
    console.log(`Evidence: ${proofPath}`);
    console.log(`Transcript: ${transcriptPath}`);
    process.exit(0);
  }
  fail(3, `preflight paid retry returned status ${paid.status} without a successful settlement (decision=${decisionCode})`);
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
