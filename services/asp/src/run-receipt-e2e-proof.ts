import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  decodeEventLog,
  formatUnits,
  http,
  keccak256,
  parseUnits,
  toHex,
  type Hex,
} from "viem";
import { UNTCH_RECEIPTS_ABI } from "@untch/receipt-writer";
import { chainById, X_LAYER_TESTNET_ID } from "@untch/shared";
import { buyerAddress, makeBuyerFetch, makeRecordingFetch, readSettlementBalance } from "./buyer";
import { MissingEnvError, PREFLIGHT_PRICE, SETTLEMENT_TOKEN } from "./config";
import { loadDemoPolicyRef } from "./demo-policy";

/**
 * §7.4 RECEIPT WRITER END-TO-END PROOF — the one that matters most.
 *
 * A real preflight_payment on the LIVE Railway seller produces a real queued receipt, which the
 * worker really batches and really anchors to the deployed UntchReceipts on X Layer testnet. The
 * anchoring is verified INDEPENDENTLY via raw RPC `eth_getLogs` for the ReceiptLogged event — the
 * receiptId is matched from chain logs, NOT trusted from the service's own status response.
 *
 * Two chains, by design: the $0.05 preflight settles on X Layer MAINNET (the payment rail); the
 * receipt anchors on X Layer TESTNET (the UntchReceipts log). This script talks to both.
 *
 * Env: BUYER_PRIVATE_KEY (funded burner), SELLER_URL (default prod), RECEIPTS_CONTRACT / RPC_URL
 * (testnet, defaulted). STOPs (never simulates) if unfunded or if receiptRef comes back null.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://untch-asp-production.up.railway.app";
const RECEIPTS_CONTRACT = (process.env.RECEIPTS_CONTRACT?.trim() ||
  "0x0c64997277b7d94d2999dea22a123cac56334863") as Hex;
const TESTNET_RPC = process.env.RPC_URL?.trim() || "https://testrpc.xlayer.tech";
const PRICE_ATOMIC = parseUnits("0.05", SETTLEMENT_TOKEN.decimals);
const POLL_TIMEOUT_MS = Number(process.env.PROOF_POLL_TIMEOUT_MS ?? 180_000);
const POLL_INTERVAL_MS = Number(process.env.PROOF_POLL_INTERVAL_MS ?? 5_000);

const xLayerTestnet = {
  ...chainById(X_LAYER_TESTNET_ID),
  rpcUrls: { default: { http: [TESTNET_RPC] } },
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function save(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const path = resolve(EVIDENCE_DIR, name);
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data, null, 2) + "\n");
  return path;
}

function fail(msg: string): never {
  console.error(`\nRESULT: FAIL — ${msg}`);
  process.exit(1);
}

function buildIntent(owner: Hex, runSalt: string, policyHash: string): Record<string, unknown> {
  return {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: SETTLEMENT_TOKEN.address,
    maxAmount: "1000000",
    taskHash: keccak256(toHex(`untch-receipt-e2e-task:${runSalt}`)),
    acceptanceHash: keccak256(toHex("untch-receipt-e2e-acceptance")),
    schemaHash: keccak256(toHex("untch-receipt-e2e-schema")),
    policyHash,
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    paramsHash: keccak256(toHex(`untch-receipt-e2e-params:${runSalt}`)),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category: "market-data",
    amount: 0.5,
  };
}

/** Independently confirm the receipt is anchored: resolve the batch tx's block by raw RPC, then
 *  eth_getLogs for ReceiptLogged around it and match the receiptId decoded from chain — never read
 *  from the service. Works as soon as the batch tx is mined (SUBMITTED), not only once CONFIRMED. */
async function verifyOnChain(
  receiptId: Hex,
  batchTx: Hex,
): Promise<{ found: boolean; txHash: Hex | null; block: number | null }> {
  const pub = createPublicClient({ chain: xLayerTestnet, transport: http(TESTNET_RPC) });
  const rcpt = await pub.getTransactionReceipt({ hash: batchTx });
  const blockNumber = rcpt.blockNumber;
  const window = 3n;
  const logs = await pub.getLogs({
    address: RECEIPTS_CONTRACT,
    fromBlock: blockNumber > window ? blockNumber - window : 0n,
    toBlock: blockNumber + window,
  });
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: UNTCH_RECEIPTS_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "ReceiptLogged") {
        const args = ev.args as unknown as { receiptId: Hex };
        if (args.receiptId.toLowerCase() === receiptId.toLowerCase()) {
          return { found: true, txHash: log.transactionHash, block: Number(log.blockNumber) };
        }
      }
    } catch {
      /* not our event */
    }
  }
  return { found: false, txHash: null, block: null };
}

async function main(): Promise<void> {
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  const buyerKey = process.env.BUYER_PRIVATE_KEY?.trim() as Hex | undefined;
  if (!buyerKey) fail(new MissingEnvError("BUYER_PRIVATE_KEY").message + " — run gen-buyer-wallet");

  const demoPolicy = loadDemoPolicyRef();
  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());
  console.log(`[e2e] buyer   : ${owner}`);
  console.log(`[e2e] seller  : ${sellerUrl}`);
  console.log(`[e2e] policy  : ${demoPolicy.policyId} (real stored; hash ${demoPolicy.policyHash})`);
  console.log(`[e2e] receipts: ${RECEIPTS_CONTRACT} @ ${TESTNET_RPC}`);

  const balance = await readSettlementBalance(owner);
  if (balance < PRICE_ATOMIC) {
    fail(`buyer unfunded: ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} < 0.05 ${SETTLEMENT_TOKEN.symbol}`);
  }

  // 1. create_spend_intent + paid preflight_payment.
  const intent = buildIntent(owner, runSalt, demoPolicy.policyHash);
  const createRes = await fetch(`${sellerUrl}/create_spend_intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...intent, policyId: demoPolicy.policyId }),
  });
  const created = (await createRes.json()) as { intentHash?: string };
  if (!created.intentHash) fail(`create_spend_intent failed (${createRes.status})`);

  const payFetch = makeBuyerFetch(buyerKey, makeRecordingFetch());
  const paid = await payFetch(`${sellerUrl}/preflight_payment`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intentHash: created.intentHash, intent, policyId: demoPolicy.policyId }),
  });
  const decision = (await paid.json()) as {
    decision?: string;
    receiptRef?: { receiptId?: string; status?: string } | null;
  };
  console.log(`[e2e] preflight ${PREFLIGHT_PRICE} → decision=${decision.decision}, receiptRef=${JSON.stringify(decision.receiptRef)}`);

  const receiptId = decision.receiptRef?.receiptId as Hex | undefined;
  if (!receiptId) {
    fail("receiptRef is null — seller is not wired to the receipt writer (DATABASE_URL/REDIS_URL, or old build).");
  }
  if (decision.receiptRef?.status !== "QUEUED") {
    fail(`expected receiptRef.status QUEUED, got ${decision.receiptRef?.status}`);
  }

  // 2. Poll the status endpoint until the worker CONFIRMS the anchor (falling back to the batch tx
  //    once one exists, so a slow finality-depth confirm still verifies).
  console.log(`[e2e] polling /receipt_status/${receiptId} for CONFIRMED (timeout ${POLL_TIMEOUT_MS}ms) …`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let serviceTx: Hex | null = null;
  let finalStatus = "QUEUED";
  for (;;) {
    const res = await fetch(`${sellerUrl}/receipt_status/${receiptId}`);
    if (res.ok) {
      const status = (await res.json()) as { status: string; txHash: string | null };
      finalStatus = status.status;
      if (status.txHash) serviceTx = status.txHash as Hex;
      console.log(`[e2e]   status=${status.status} tx=${status.txHash ?? "-"}`);
      if (status.status === "CONFIRMED") break;
      if (status.status === "DEGRADED_UNANCHORED") {
        fail("receipt DEGRADED_UNANCHORED — anchoring exhausted retries (ledger is still durable, but no proof).");
      }
    }
    if (Date.now() > deadline) {
      if (serviceTx) break; // batch tx exists (SUBMITTED) — verifiable on-chain even before finality depth
      fail(`timed out waiting for a batch tx; last status ${finalStatus}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!serviceTx) fail("no batch tx hash ever appeared in the receipt status");

  // 3. INDEPENDENT raw-RPC verification (resolve block from the tx, then eth_getLogs), not trusting
  //    the service's own claim — the receiptId is matched from decoded chain logs.
  console.log(`[e2e] independently verifying via eth_getLogs (ReceiptLogged) …`);
  const onchain = await verifyOnChain(receiptId, serviceTx);
  if (!onchain.found) {
    fail(`receiptId ${receiptId} NOT found in ReceiptLogged logs for batch tx ${serviceTx} — independent verification failed.`);
  }

  const proof = {
    meta: {
      step: "§7.4 receipt-writer end-to-end proof",
      when: new Date().toISOString(),
      buyer: owner,
      seller: sellerUrl,
      receiptsContract: RECEIPTS_CONTRACT,
      testnetRpc: TESTNET_RPC,
    },
    decision: decision.decision,
    receiptId,
    serviceReportedTx: serviceTx,
    independentlyVerified: {
      method: "raw eth_getLogs for ReceiptLogged, receiptId matched from decoded chain logs",
      found: onchain.found,
      txHash: onchain.txHash,
      block: onchain.block,
    },
    finalStatus,
    result: "PASS",
  };
  const path = save("receipt-writer-e2e-proof.json", proof);

  console.log("");
  console.log("RESULT: PASS — real preflight decision → queued → batched → anchored on UntchReceipts (testnet).");
  console.log(`receiptId       : ${receiptId}`);
  console.log(`anchor tx       : ${onchain.txHash}`);
  console.log(`explorer        : https://www.oklink.com/x-layer-testnet/tx/${onchain.txHash}`);
  console.log(`independent     : eth_getLogs matched receiptId in ReceiptLogged (not from service logs)`);
  console.log(`evidence        : ${path}`);
}

main().catch((err) => {
  console.error(err);
  fail(`unexpected error: ${(err as Error).message}`);
});
