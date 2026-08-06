import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUnits, parseUnits } from "viem";
import { decodePaymentResponseHeader } from "@okxweb3/x402-fetch";
import {
  buyerAddress,
  makeBuyerFetch,
  makeRecordingFetch,
  readSettlementBalance,
} from "./buyer";
import { MissingEnvError, NETWORK, PROOF_OF_RAIL_PRICE, SETTLEMENT_TOKEN } from "./config";

/**
 * Buyer-only D0.1 driver: hits a REMOTE seller (SELLER_URL, e.g. the Railway deploy that can
 * reach web3.okx.com) and pays it. Runs from anywhere the seller URL + rpc.xlayer.tech are
 * reachable — no local seller, no OKX egress needed on this machine. STOPs (never simulates)
 * if the buyer is unprovisioned/unfunded.
 */
const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const PRICE_ATOMIC = parseUnits("0.01", SETTLEMENT_TOKEN.decimals);

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  return path;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((v, k) => {
    out[k] = v;
  });
  return out;
}

function fail(code: number, message: string): never {
  console.error(`\nRESULT: FAIL / BLOCKED — ${message}`);
  console.error("Settlement reference: NONE (no real settled call).");
  process.exit(code);
}

function requirePrivateKey(): `0x${string}` {
  const v = process.env.BUYER_PRIVATE_KEY?.trim();
  if (!v) throw new MissingEnvError("BUYER_PRIVATE_KEY");
  return v as `0x${string}`;
}

async function main(): Promise<void> {
  const sellerUrl = process.env.SELLER_URL?.trim();
  if (!sellerUrl) fail(2, "SELLER_URL not set (point it at the deployed seller, e.g. the Railway URL)");

  let buyerKey: `0x${string}`;
  try {
    buyerKey = requirePrivateKey();
  } catch {
    fail(2, "BUYER_PRIVATE_KEY not set — run gen-buyer-wallet first");
  }

  const url = `${sellerUrl}/ping_untch`;
  const address = buyerAddress(buyerKey);
  console.log(`[pay] buyer  : ${address}`);
  console.log(`[pay] seller : ${url}`);
  console.log(`[pay] price  : ${PROOF_OF_RAIL_PRICE} in ${SETTLEMENT_TOKEN.symbol} on ${NETWORK}`);

  // Funding precheck — STOP if unfunded, never simulate.
  const balance = await readSettlementBalance(address);
  console.log(
    `[pay] balance: ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} ${SETTLEMENT_TOKEN.symbol} ` +
      `(need >= ${formatUnits(PRICE_ATOMIC, SETTLEMENT_TOKEN.decimals)})`,
  );
  if (balance < PRICE_ATOMIC) fail(2, "buyer wallet unfunded");

  // 1. Capture the raw 402 challenge.
  const unpaid = await fetch(url);
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
  save("402-challenge.json", challenge);
  console.log(`[pay] 402 challenge captured (status ${unpaid.status})`);

  // 2. Pay: sign EIP-3009 + retry (wrapper handles it); record the outbound payment header.
  const recording = makeRecordingFetch();
  const payFetch = makeBuyerFetch(buyerKey, recording);

  let paid: Response;
  try {
    paid = await payFetch(url);
  } catch (err) {
    save("paid-call-transcript.json", {
      challenge,
      paymentSignature: recording.getPaymentSignature() ?? null,
      error: (err as Error).message,
    });
    fail(3, `payment failed: ${(err as Error).message}`);
  }

  const paidBody = await paid.text();
  const paymentResponseHeader = paid.headers.get("PAYMENT-RESPONSE");
  const settlement = paymentResponseHeader
    ? decodePaymentResponseHeader(paymentResponseHeader)
    : null;

  save("paid-call-transcript.json", {
    challenge,
    paymentSignatureDecoded: decodeMaybe(recording.getPaymentSignature()),
    response: { status: paid.status, headers: headersToObject(paid.headers), body: paidBody },
    settlement,
  });

  if (paid.status === 200 && settlement) {
    const txHash = (settlement as { transaction?: string }).transaction ?? "(none in PAYMENT-RESPONSE)";
    console.log(`\nRESULT: PASS — real settled paid call on X Layer via the OKX x402 facilitator.`);
    console.log(`Settlement tx: ${txHash}`);
    console.log(`Explorer: https://www.oklink.com/x-layer/tx/${txHash}`);
    process.exit(0);
  }

  fail(3, `paid retry returned status ${paid.status} without a settlement record`);
}

function decodeMaybe(b64: string | undefined): unknown {
  if (!b64) return null;
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return { raw: `${b64.slice(0, 24)}…(${b64.length} chars)` };
  }
}

main().catch((err) => {
  console.error(err);
  fail(1, `unexpected error: ${(err as Error).message}`);
});
