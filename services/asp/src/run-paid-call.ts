import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { parseUnits, formatUnits } from "viem";
import { decodePaymentResponseHeader } from "@okxweb3/x402-fetch";
import { createSellerApp } from "./server";
import {
  buyerAddress,
  makeBuyerFetch,
  makeRecordingFetch,
  readSettlementBalance,
} from "./buyer";
import {
  loadBuyerConfig,
  loadSellerConfig,
  MissingEnvError,
  NETWORK,
  PING_PRICE,
  PING_ROUTE,
  SETTLEMENT_TOKEN,
} from "./config";

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const BLOCKERS_FILE = resolve(here, "..", "..", "..", "internal", "day0", "BLOCKERS.md");

const PRICE_ATOMIC = parseUnits("0.01", SETTLEMENT_TOKEN.decimals);

type Transcript = Record<string, unknown>;

function saveTranscript(name: string, data: Transcript): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function fail(code: number, message: string): never {
  console.error("");
  console.error(`RESULT: FAIL / BLOCKED — ${message}`);
  console.error("Settlement reference: NONE (no real settled call was executed).");
  process.exit(code);
}

async function main(): Promise<void> {
  let seller;
  let buyer;
  try {
    seller = loadSellerConfig();
    buyer = loadBuyerConfig();
  } catch (err) {
    if (err instanceof MissingEnvError) {
      if (err.varName === "BUYER_PRIVATE_KEY") {
        console.error("No BUYER_PRIVATE_KEY set. Generate a burner wallet first:");
        console.error("  pnpm --filter @untch/asp gen-buyer-wallet");
        fail(2, "buyer wallet not provisioned");
      }
      console.error(err.message);
      fail(2, `missing config (${err.varName})`);
    }
    throw err;
  }

  const address = buyerAddress(buyer.buyerPrivateKey);
  console.log(`[pay] buyer   : ${address}`);
  console.log(`[pay] seller  : ${buyer.sellerUrl}${PING_ROUTE} (payTo ${seller.payTo})`);
  console.log(`[pay] price   : ${PING_PRICE} in ${SETTLEMENT_TOKEN.symbol} on ${NETWORK}`);

  // --- Funding precheck (STOP here if unfunded — never simulate a payment) ---
  let balance: bigint;
  try {
    balance = await readSettlementBalance(address);
  } catch (err) {
    fail(2, `could not read buyer balance from X Layer RPC: ${(err as Error).message}`);
  }
  console.log(
    `[pay] balance : ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} ` +
      `(need >= ${formatUnits(PRICE_ATOMIC, SETTLEMENT_TOKEN.decimals)})`,
  );

  if (balance < PRICE_ATOMIC) {
    const needed = formatUnits(PRICE_ATOMIC, SETTLEMENT_TOKEN.decimals);
    writeFundingBlocker(address, needed);
    console.error("");
    console.error(`Buyer wallet ${address} holds insufficient ${SETTLEMENT_TOKEN.symbol}.`);
    console.error(`Fund it with >= ${needed} ${SETTLEMENT_TOKEN.symbol} (${SETTLEMENT_TOKEN.address})`);
    console.error(`on X Layer Mainnet (${NETWORK}), then re-run. Details appended to BLOCKERS.md.`);
    fail(2, "buyer wallet unfunded");
  }

  // --- Funded: execute exactly one real paid call ---
  const app = createSellerApp(seller);
  const server: Server = await new Promise((res) => {
    const s = app.listen(seller.port, () => res(s));
  });

  try {
    const url = `${buyer.sellerUrl}${PING_ROUTE}`;

    const unpaid = await fetch(url);
    const unpaidBody = await unpaid.text();
    const challenge = {
      status: unpaid.status,
      headers: headersToObject(unpaid.headers),
      paymentRequired: unpaid.headers.get("PAYMENT-REQUIRED"),
      body: unpaidBody,
    };
    saveTranscript("402-challenge.json", challenge);
    console.log(`[pay] 402 challenge captured (status ${unpaid.status})`);

    const recording = makeRecordingFetch();
    const payFetch = makeBuyerFetch(buyer.buyerPrivateKey, recording);

    const paid = await payFetch(url);
    const paidBody = await paid.text();
    const paymentResponseHeader = paid.headers.get("PAYMENT-RESPONSE");
    const settlement = paymentResponseHeader
      ? decodePaymentResponseHeader(paymentResponseHeader)
      : undefined;

    const record = {
      challenge,
      paymentSignature: recording.getPaymentSignature() ?? null,
      response: {
        status: paid.status,
        headers: headersToObject(paid.headers),
        body: paidBody,
      },
      settlement: settlement ?? null,
    };
    saveTranscript("paid-call-transcript.json", record);

    if (paid.status === 200 && settlement) {
      const txHash =
        (settlement as { transaction?: string }).transaction ?? "(no tx in PAYMENT-RESPONSE)";
      console.log("");
      console.log(`RESULT: PASS — one real settled paid call on X Layer via the OKX x402 facilitator.`);
      console.log(`Settlement reference (tx): ${txHash}`);
      console.log(`Explorer: https://www.oklink.com/x-layer/tx/${txHash}`);
      process.exit(0);
    }

    fail(3, `paid retry returned status ${paid.status} without a settlement record ` +
      `(seller could not reach the OKX facilitator at web3.okx.com)`);
  } catch (err) {
    fail(3, `payment failed: ${(err as Error).message} ` +
      `(expected when web3.okx.com facilitator is unreachable)`);
  } finally {
    server.close();
  }
}

function writeFundingBlocker(address: `0x${string}`, needed: string): void {
  const block = [
    "",
    "---",
    "",
    "# D0.1 FUNDING BLOCKER — buyer wallet generated but unfunded",
    "",
    "**Gate:** §29 D0.1 · **Result:** BLOCKED (buyer wallet has no settlement token).",
    "",
    "A fresh burner buyer wallet was generated. It must be funded before a real x402 call",
    "can settle. No payment was simulated.",
    "",
    `- **Fund this address:** \`${address}\``,
    `- **Token:** ${SETTLEMENT_TOKEN.symbol} \`${SETTLEMENT_TOKEN.address}\` (${SETTLEMENT_TOKEN.decimals} decimals)`,
    `- **Amount:** at least ${needed} ${SETTLEMENT_TOKEN.symbol} (send ~$0.05 worth for margin)`,
    `- **Network:** X Layer Mainnet (${NETWORK}, chainId 196)`,
    "- **Gas:** none needed on the buyer — EIP-3009 is gasless for the signer.",
    "",
    "After funding, re-run `pnpm --filter @untch/asp pay`.",
    "",
  ].join("\n");
  appendFileSync(BLOCKERS_FILE, block);
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
