import type { Decision, SpendIntentInput } from "@untch/policy-engine";
import { createPublicClient, decodeEventLog, http, keccak256, toHex, type Hex } from "viem";
import { UNTCH_RECEIPTS_ABI } from "./abi";
import { flushOnce, reconcileOnce } from "./anchorer";
import { ViemChainAnchor } from "./chain";
import { loadWorkerConfig } from "./config";
import { createPool, runMigrations } from "./db";
import { draftFromDecision } from "./mapping";
import { PgReceiptsRepo } from "./repo-pg";

/**
 * One-shot REAL anchor proof for the §7.4 path, without the Railway seller or the paid preflight:
 * enqueue one synthetic preflight decision into the durable Postgres store, then drive the real
 * state machine (flushOnce → submit logReceipts on testnet → reconcile until CONFIRMED) with the
 * PROVISIONED writer key, and finally verify the receipt INDEPENDENTLY via raw eth_getLogs for the
 * ReceiptLogged event — receiptId matched from chain, not trusted from the service.
 *
 * Needs: DATABASE_URL, REDIS_URL (unused here but loaded), WRITER_PRIVATE_KEY, RPC_URL/RECEIPTS_CONTRACT.
 * Run: DATABASE_URL=… WRITER_PRIVATE_KEY=… pnpm --filter @untch/receipt-writer tsx src/prove-anchor.ts
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function syntheticDecision(): { input: SpendIntentInput; decision: Decision } {
  const salt = toHex(keccak256(toHex(`prove-anchor:${process.pid}:${process.hrtime.bigint()}`)));
  const input: SpendIntentInput = {
    owner: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
    buyerAgentId: 1n,
    workerAgentId: 0n,
    token: "0x779Ded0c9e1022225f8E0630b35a9b54bE713736",
    maxAmount: 1_000_000n,
    taskHash: keccak256(toHex(`prove-task:${salt}`)),
    acceptanceHash: keccak256(toHex("prove-acceptance")),
    schemaHash: keccak256(toHex("prove-schema")),
    policyHash: keccak256(toHex("prove-policy")),
    deadline: 9_999_999_999n,
    nonce: BigInt(salt) % 1_000_000n,
    endpoint: "https://api.vendor.example/v1/market-data?symbol=okb",
    paramsHash: keccak256(toHex(`prove-params:${salt}`)),
    recipientAddress: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    category: "market-data",
    amount: 0.5,
  };
  const decision: Decision = {
    decision: "APPROVED",
    intentHash: keccak256(toHex(`prove-intent:${salt}`)),
    policyId: "43689584780193288224528649685930235207374048247885169918877241264404980193079",
    policyVersion: 1,
    evaluatedAt: new Date().toISOString(),
    reasons: ["prove-anchor synthetic APPROVED"],
    rules: [],
    policyHash: null,
    evaluator: { engineVersion: "2", ruleManifestHash: "0x00", ruleCount: 14 },
  };
  return { input, decision };
}

async function main(): Promise<void> {
  const config = loadWorkerConfig();
  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);
  const repo = new PgReceiptsRepo(pool);
  const chain = new ViemChainAnchor({
    chain: config.chain,
    rpcUrl: config.rpcUrl,
    contract: config.receiptsContract,
    writerPrivateKey: config.writerPrivateKey,
  });
  const anchorer = {
    repo,
    chain,
    batchMaxSize: config.batchMaxSize,
    retryMax: config.retryMax,
    retryBackoffBaseMs: config.retryBackoffBaseMs,
    confirmDepth: config.confirmDepth,
    log: (m: string, meta?: Record<string, unknown>) =>
      console.log(`[prove] ${m}${meta ? " " + JSON.stringify(meta) : ""}`),
  };

  const { input, decision } = syntheticDecision();
  const draft = draftFromDecision(input, decision);
  const receiptId = draft.onchain.receiptId;
  console.log(`[prove] writer   : ${chain.writerAddress}`);
  console.log(`[prove] contract : ${config.receiptsContract}`);
  console.log(`[prove] receiptId: ${receiptId}`);

  await repo.insertDraft(draft);
  console.log(`[prove] enqueued (QUEUED, durable)`);

  const out = await flushOnce(anchorer);
  console.log(`[prove] flush    : ${JSON.stringify(out)}`);
  if (out.kind !== "submitted") throw new Error(`expected submitted, got ${out.kind}`);

  console.log(`[prove] waiting for CONFIRMED at depth ${config.confirmDepth} …`);
  const deadline = Date.now() + 180_000;
  for (;;) {
    await reconcileOnce(anchorer);
    const status = await repo.statusOf(receiptId);
    console.log(`[prove]   status=${status?.status} tx=${status?.txHash ?? "-"} block=${status?.blockNumber ?? "-"}`);
    if (status?.status === "CONFIRMED") break;
    if (Date.now() > deadline) throw new Error("timed out waiting for CONFIRMED");
    await sleep(5000);
  }

  const status = await repo.statusOf(receiptId);
  const blockNumber = BigInt(status!.blockNumber ?? 0);

  // Independent raw eth_getLogs verification.
  const pub = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
  const window = 5n;
  const logs = await pub.getLogs({
    address: config.receiptsContract,
    fromBlock: blockNumber > window ? blockNumber - window : 0n,
    toBlock: blockNumber + window,
  });
  let matchTx: Hex | null = null;
  for (const log of logs) {
    try {
      const ev = decodeEventLog({ abi: UNTCH_RECEIPTS_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "ReceiptLogged") {
        const a = ev.args as unknown as { receiptId: Hex };
        if (a.receiptId.toLowerCase() === receiptId.toLowerCase()) matchTx = log.transactionHash;
      }
    } catch {
      /* not our event */
    }
  }

  await pool.end();

  if (!matchTx) throw new Error(`receiptId ${receiptId} NOT found in ReceiptLogged near block ${blockNumber}`);
  console.log("");
  console.log("RESULT: PASS — synthetic APPROVED decision → QUEUED → BATCHED → SUBMITTED → CONFIRMED, anchored on UntchReceipts.");
  console.log(`receiptId : ${receiptId}`);
  console.log(`anchor tx : ${matchTx}`);
  console.log(`explorer  : https://www.oklink.com/x-layer-testnet/tx/${matchTx}`);
  console.log(`verified  : raw eth_getLogs matched receiptId in ReceiptLogged (independent of service)`);
}

main().catch((err) => {
  console.error(`[prove] FAIL: ${(err as Error).message}`);
  process.exit(1);
});
