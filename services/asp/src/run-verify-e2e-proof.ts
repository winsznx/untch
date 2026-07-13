import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hashCanonicalJson } from "@untch/canon";
import { VERIFY_RESULT_CODE } from "@untch/proof-engine";
import { UNTCH_RECEIPTS_ABI } from "@untch/receipt-writer";
import { chainById, X_LAYER_TESTNET_ID } from "@untch/shared";
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
import { buyerAddress, makeBuyerFetch, makeRecordingFetch, readSettlementBalance } from "./buyer";
import { MissingEnvError, SETTLEMENT_TOKEN, VERIFY_PRICE } from "./config";
import { loadDemoPolicyRef } from "./demo-policy";

/**
 * §13/§7.3 VERIFY_DELIVERY END-TO-END PROOF — the first receipt to carry a REAL verifyResult/proofTier.
 *
 * A real, PAID verify_delivery ($0.10) on the LIVE Railway seller runs the real, deterministic T0
 * Proof Engine (no LLM, I1) against a delivery vs the acceptance criteria the intent COMMITTED, then
 * produces a real VERIFY receipt which the worker really batches and really anchors to the deployed
 * UntchReceipts on X Layer testnet. The anchoring is verified INDEPENDENTLY via raw RPC `eth_getLogs`
 * for ReceiptLogged — and, unlike every prior proof, we decode `verifyResult` + `proofTier` straight
 * from the chain log and assert they are the REAL result (PASS=1, tier 0), NOT read from the service.
 *
 * Two chains by design (same as the receipt e2e): the $0.10 verify settles on X Layer MAINNET (the
 * payment rail); the receipt anchors on X Layer TESTNET (the UntchReceipts log). STOPs (never
 * simulates) if unfunded or if receiptRef comes back null.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EVIDENCE_DIR = resolve(here, "..", "..", "..", "internal", "day0", "D0.1-evidence");
const DEFAULT_SELLER = "https://untch-asp-production.up.railway.app";
const RECEIPTS_CONTRACT = (process.env.RECEIPTS_CONTRACT?.trim() ||
  "0x0c64997277b7d94d2999dea22a123cac56334863") as Hex;
const TESTNET_RPC = process.env.RPC_URL?.trim() || "https://testrpc.xlayer.tech";
const PRICE_ATOMIC = parseUnits("0.10", SETTLEMENT_TOKEN.decimals);
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

/** The committed T0 acceptance criteria for this proof — a market-data schema exercising ajv +
 *  required fields + a regex constraint at once. The intent commits acceptanceHash = its canon hash. */
function acceptanceCriteria(): Record<string, unknown> {
  return {
    canonVersion: "1",
    schema: {
      type: "object",
      required: ["symbol", "price", "asOf"],
      properties: {
        symbol: { type: "string" },
        price: { type: "number", minimum: 0 },
        asOf: { type: "string" },
      },
      additionalProperties: true,
    },
    requiredFields: ["symbol", "price", "asOf"],
    fieldConstraints: [{ field: "symbol", regex: "[A-Z0-9]{2,10}" }],
  };
}

/** A delivery that conforms to `acceptanceCriteria` — T0 must PASS. */
function conformingDelivery(): { payload: Record<string, unknown> } {
  return { payload: { symbol: "OKB", price: 48.15, asOf: "2026-07-11T11:59:00Z" } };
}

function buildIntent(owner: Hex, runSalt: string, policyHash: string, acceptanceHash: Hex): Record<string, unknown> {
  return {
    owner,
    buyerAgentId: "1",
    workerAgentId: "0",
    token: SETTLEMENT_TOKEN.address,
    maxAmount: "1000000",
    taskHash: keccak256(toHex(`untch-verify-e2e-task:${runSalt}`)),
    acceptanceHash,
    schemaHash: keccak256(toHex("untch-verify-e2e-schema")),
    policyHash,
    deadline: "9999999999",
    nonce: runSalt,
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    paramsHash: keccak256(toHex(`untch-verify-e2e-params:${runSalt}`)),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category: "market-data",
    amount: 0.5,
  };
}

/** Independently confirm the VERIFY receipt is anchored AND decode its verifyResult/proofTier from the
 *  chain log — not from the service. Returns the decoded on-chain fields. */
async function verifyOnChain(
  receiptId: Hex,
  batchTx: Hex,
): Promise<{ found: boolean; txHash: Hex | null; block: number | null; verifyResult: number | null; proofTier: number | null; decision: number | null }> {
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
        const args = ev.args as unknown as { receiptId: Hex; verifyResult: number; proofTier: number; decision: number };
        if (args.receiptId.toLowerCase() === receiptId.toLowerCase()) {
          return {
            found: true,
            txHash: log.transactionHash,
            block: Number(log.blockNumber),
            verifyResult: Number(args.verifyResult),
            proofTier: Number(args.proofTier),
            decision: Number(args.decision),
          };
        }
      }
    } catch {
      /* not our event */
    }
  }
  return { found: false, txHash: null, block: null, verifyResult: null, proofTier: null, decision: null };
}

async function main(): Promise<void> {
  const sellerUrl = (process.env.SELLER_URL?.trim() || DEFAULT_SELLER).replace(/\/$/, "");
  const buyerKey = process.env.BUYER_PRIVATE_KEY?.trim() as Hex | undefined;
  if (!buyerKey) fail(new MissingEnvError("BUYER_PRIVATE_KEY").message + " — run gen-buyer-wallet");

  const demoPolicy = loadDemoPolicyRef();
  const owner = buyerAddress(buyerKey);
  const runSalt = String(Date.now());
  const criteria = acceptanceCriteria();
  const acceptanceHash = hashCanonicalJson(criteria);
  const delivery = conformingDelivery();

  console.log(`[verify-e2e] buyer   : ${owner}`);
  console.log(`[verify-e2e] seller  : ${sellerUrl}`);
  console.log(`[verify-e2e] policy  : ${demoPolicy.policyId} (real stored; hash ${demoPolicy.policyHash})`);
  console.log(`[verify-e2e] criteria: acceptanceHash ${acceptanceHash} (canon of the committed T0 spec)`);
  console.log(`[verify-e2e] receipts: ${RECEIPTS_CONTRACT} @ ${TESTNET_RPC}`);

  const balance = await readSettlementBalance(owner);
  if (balance < PRICE_ATOMIC) {
    fail(`buyer unfunded: ${formatUnits(balance, SETTLEMENT_TOKEN.decimals)} < 0.10 ${SETTLEMENT_TOKEN.symbol}`);
  }

  // 1. create_spend_intent (commits the acceptanceHash) + PAID verify_delivery.
  const intent = buildIntent(owner, runSalt, demoPolicy.policyHash, acceptanceHash);
  const createRes = await fetch(`${sellerUrl}/create_spend_intent`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...intent, policyId: demoPolicy.policyId }),
  });
  const created = (await createRes.json()) as { intentHash?: string };
  if (!created.intentHash) fail(`create_spend_intent failed (${createRes.status}): ${JSON.stringify(created)}`);

  const payFetch = makeBuyerFetch(buyerKey, makeRecordingFetch());
  const paid = await payFetch(`${sellerUrl}/verify_delivery`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      intentHash: created.intentHash,
      intent,
      policyId: demoPolicy.policyId,
      acceptanceCriteria: criteria,
      delivery,
    }),
  });
  const result = (await paid.json()) as {
    final?: string;
    verifyResult?: number;
    proofTier?: number;
    recommendation?: string;
    receiptRef?: { receiptId?: string; status?: string } | null;
  };
  console.log(
    `[verify-e2e] verify ${VERIFY_PRICE} → final=${result.final}, verifyResult=${result.verifyResult}, ` +
      `proofTier=${result.proofTier}, receiptRef=${JSON.stringify(result.receiptRef)}`,
  );

  if (result.final !== "VERIFY_PASSED") fail(`expected VERIFY_PASSED, got ${result.final}`);
  if (result.verifyResult !== VERIFY_RESULT_CODE.PASS) fail(`expected verifyResult PASS(1), got ${result.verifyResult}`);

  const receiptId = result.receiptRef?.receiptId as Hex | undefined;
  if (!receiptId) {
    fail("receiptRef is null — seller is not wired to the receipt writer (DATABASE_URL/REDIS_URL, or old build).");
  }
  if (result.receiptRef?.status !== "QUEUED") fail(`expected receiptRef.status QUEUED, got ${result.receiptRef?.status}`);

  // 2. Poll status until the worker CONFIRMS the anchor (fall back to the batch tx once one exists).
  console.log(`[verify-e2e] polling /receipt_status/${receiptId} for CONFIRMED (timeout ${POLL_TIMEOUT_MS}ms) …`);
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let serviceTx: Hex | null = null;
  let finalStatus = "QUEUED";
  for (;;) {
    const res = await fetch(`${sellerUrl}/receipt_status/${receiptId}`);
    if (res.ok) {
      const status = (await res.json()) as { status: string; txHash: string | null };
      finalStatus = status.status;
      if (status.txHash) serviceTx = status.txHash as Hex;
      console.log(`[verify-e2e]   status=${status.status} tx=${status.txHash ?? "-"}`);
      if (status.status === "CONFIRMED") break;
      if (status.status === "DEGRADED_UNANCHORED") {
        fail("receipt DEGRADED_UNANCHORED — anchoring exhausted retries (ledger is still durable, but no proof).");
      }
    }
    if (Date.now() > deadline) {
      if (serviceTx) break;
      fail(`timed out waiting for a batch tx; last status ${finalStatus}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  if (!serviceTx) fail("no batch tx hash ever appeared in the receipt status");

  // 3. INDEPENDENT raw-RPC verification — decode verifyResult/proofTier from the chain log, not the service.
  console.log(`[verify-e2e] independently verifying via eth_getLogs (ReceiptLogged) …`);
  const onchain = await verifyOnChain(receiptId, serviceTx);
  if (!onchain.found) {
    fail(`receiptId ${receiptId} NOT found in ReceiptLogged logs for batch tx ${serviceTx} — independent verification failed.`);
  }
  if (onchain.verifyResult !== VERIFY_RESULT_CODE.PASS) {
    fail(`on-chain verifyResult is ${onchain.verifyResult}, expected PASS(1) — the anchored receipt did not carry the real result.`);
  }
  if (onchain.proofTier !== 0) {
    fail(`on-chain proofTier is ${onchain.proofTier}, expected 0 (T0).`);
  }

  const proof = {
    meta: {
      step: "§13/§7.3 verify_delivery end-to-end proof (first real verifyResult/proofTier on-chain)",
      when: new Date().toISOString(),
      buyer: owner,
      seller: sellerUrl,
      receiptsContract: RECEIPTS_CONTRACT,
      testnetRpc: TESTNET_RPC,
    },
    committedAcceptanceHash: acceptanceHash,
    delivery: delivery.payload,
    serviceResult: { final: result.final, verifyResult: result.verifyResult, proofTier: result.proofTier },
    receiptId,
    serviceReportedTx: serviceTx,
    independentlyVerified: {
      method: "raw eth_getLogs for ReceiptLogged; receiptId + verifyResult + proofTier decoded from chain logs",
      found: onchain.found,
      txHash: onchain.txHash,
      block: onchain.block,
      verifyResult: onchain.verifyResult,
      proofTier: onchain.proofTier,
      decision: onchain.decision,
    },
    finalStatus,
    result: "PASS",
  };
  const path = save("verify-delivery-e2e-proof.json", proof);

  console.log("");
  console.log("RESULT: PASS — real paid verify_delivery → real T0 PASS → VERIFY receipt anchored on UntchReceipts (testnet).");
  console.log(`receiptId       : ${receiptId}`);
  console.log(`anchor tx       : ${onchain.txHash}`);
  console.log(`explorer        : https://www.oklink.com/x-layer-testnet/tx/${onchain.txHash}`);
  console.log(`on-chain result : verifyResult=${onchain.verifyResult} (PASS), proofTier=${onchain.proofTier} (T0), decision=${onchain.decision} (N/A) — decoded from the chain log, not the service`);
  console.log(`evidence        : ${path}`);
}

main().catch((err) => {
  console.error(err);
  fail(`unexpected error: ${(err as Error).message}`);
});
