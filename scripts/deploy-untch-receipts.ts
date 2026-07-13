import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  encodeAbiParameters,
  formatEther,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  chainById,
  xLayerTestnet,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
} from "../packages/shared/src/chains";

/**
 * UntchReceipts deploy + demo driver (PRD §10.3 / §28 fork-integration + §22.4).
 *
 * TESTNET ONLY. Refuses X Layer mainnet (chainId 196) — mainnet stays deferred until the full
 * contract set clears §28's mainnet checklist together.
 *
 * One coherent flow (BROADCAST=1):
 *   1. Deploy UntchReceipts(delay). The deployer becomes admin — but NOT a writer, and there is no
 *      immediate way to become one: the writer set is behind the timelock (§10.3).
 *   2. Authorize the deployer as a writer THROUGH THE TIMELOCK end-to-end on real testnet:
 *      propose(ADD_WRITER, deployer) → prove execute reverts before the delay (read-only eth_call)
 *      → wait the real delay → execute(ADD_WRITER, deployer). This is the judgment-call-3 property
 *      demonstrated on-chain, not just in tests.
 *   3. logReceipts([3 §10.3-shaped receipts]) in ONE tx — one ReceiptLogged per entry + one
 *      BatchLogged. `agentId` is bytes32(uint256 buyerAgentId) (judgment call 1), NOT an address;
 *      `receiptId` is caller-supplied (judgment call 2). References the real SpendIntentRegistry demo
 *      intent/policy so the three contracts tell one coherent story.
 *   4. anchorScore(root, epoch, subjectKind) and anchorAudit(reportHash, agentId, period).
 *   5. Read back batchCount / admin / isWriter / opEta on-chain and assert the round-trip.
 *   6. MEASURE REAL GAS: send logReceipts of sizes 1, 10, 50 and record gasUsed from the real
 *      receipts, so gas/receipt is MEASURED on X Layer (§17/§25/§10.4: "no cost claims before
 *      measurement"), never a forge estimate alone.
 *
 * Env:
 *   RPC_URL                target RPC (default X Layer testnet). Point at http://127.0.0.1:8545 for
 *                          a local anvil end-to-end proof.
 *   DEPLOYER_PRIVATE_KEY   0x-prefixed key that signs (required to BROADCAST).
 *   TIMELOCK_DELAY         admin timelock delay in seconds (default 60 — short so the demo can wait
 *                          it out; a mainnet deploy would use e.g. 48h).
 *   BROADCAST              "1" to send txs; anything else = preflight only.
 */

const ARTIFACT_PATH = fileURLToPath(
  new URL("../contracts/out/UntchReceipts.sol/UntchReceipts.json", import.meta.url),
);

// The real SpendIntentRegistry demo intent/policy on X Layer testnet (deploy/spend-intent-testnet-
// receipt.json), referenced so the receipt demo is coherent with the intent/policy demos.
const DEMO_POLICY_ID =
  43689584780193288224528649685930235207374048247885169918877241264404980193079n;
const DEMO_POLICY_HASH: Hex =
  "0x640bdb4c3a438728839abd08b38361df44db3acb60503307214a34b28407384d";
const DEMO_INTENT_HASH: Hex =
  "0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a";
const DEMO_TOKEN: Address = "0x000000000000000000000000000000000000d97a";

// UntchReceipts.OpKind: NONE=0, ADD_WRITER=1, REMOVE_WRITER=2, TRANSFER_ADMIN=3.
const OP_ADD_WRITER = 1;

// §8.1 buyerAgentId of the demo intent = 1. agentId in a receipt is bytes32(uint256 buyerAgentId),
// NOT an address (judgment call 1).
const DEMO_BUYER_AGENT_ID = 1n;
const agentIdBytes32 = (id: bigint): Hex => toHex(id, { size: 32 });

type Receipt = {
  receiptId: Hex;
  policyId: bigint;
  policyHash: Hex;
  agentId: Hex;
  vendorId: Hex;
  amount: bigint;
  token: Address;
  category: Hex;
  payType: number;
  intentHash: Hex;
  taskHash: Hex;
  decision: number;
  verifyResult: number;
  proofTier: number;
  metadataHash: Hex;
};

function demoReceipt(i: number): Receipt {
  return {
    receiptId: keccak256(toHex(`untch-demo-receipt-${i}`)),
    policyId: DEMO_POLICY_ID,
    policyHash: DEMO_POLICY_HASH,
    agentId: agentIdBytes32(DEMO_BUYER_AGENT_ID),
    vendorId: keccak256(toHex(`untch-demo-vendor-${i}`)),
    amount: 1_000_000n + BigInt(i),
    token: DEMO_TOKEN,
    category: keccak256(toHex("a2mcp")),
    payType: 0, // A2MCP
    intentHash: DEMO_INTENT_HASH,
    taskHash: keccak256(toHex(`untch-demo-task-${i}`)),
    decision: 1, // APPROVED
    verifyResult: 1,
    proofTier: 2,
    metadataHash: keccak256(toHex(`untch-demo-metadata-${i}`)),
  };
}

function batch(n: number): Receipt[] {
  return Array.from({ length: n }, (_, i) => demoReceipt(i));
}

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function loadArtifact(): Artifact {
  const raw = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Artifact;
  if (!raw.bytecode?.object?.startsWith("0x")) {
    throw new Error("UntchReceipts artifact missing bytecode — run `forge build` first");
  }
  return raw;
}

function targetChain(rpcUrl: string, chainId: number): Chain {
  if (chainId === X_LAYER_TESTNET_ID || chainId === X_LAYER_MAINNET_ID) return chainById(chainId);
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

const OP_ID_TYPES = [{ type: "uint8" }, { type: "address" }] as const;
function computeOpId(kind: number, target: Address): Hex {
  return keccak256(encodeAbiParameters(OP_ID_TYPES, [kind, target]));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0] ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const delay = BigInt(process.env.TIMELOCK_DELAY ?? 60);

  const artifact = loadArtifact();
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = targetChain(rpcUrl, chainId);

  console.log("── UntchReceipts deploy driver (TESTNET ONLY) ──────────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(
    `chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`,
  );
  console.log(`timelock delay   : ${delay}s`);

  if (chainId === X_LAYER_MAINNET_ID && process.env.ALLOW_MAINNET !== "1") {
    throw new Error(
      "Refusing X Layer MAINNET (196) without explicit opt-in — mainnet deploys stay gated on the §28 checklist. Set ALLOW_MAINNET=1 to proceed.",
    );
  }
  if (!pk) {
    console.log("\nNo DEPLOYER_PRIVATE_KEY set — preflight without a signer.");
    console.log("Set DEPLOYER_PRIVATE_KEY and BROADCAST=1 to deploy.");
    return;
  }

  const account = privateKeyToAccount(pk);
  const deployer = account.address;
  console.log(`deployer/admin   : ${deployer}`);

  const balance = await pub.getBalance({ address: deployer });
  const gasPrice = await pub.getGasPrice();
  const deployGas = await pub.estimateGas({
    account: deployer,
    data: (artifact.bytecode.object +
      encodeAbiParameters([{ type: "uint64" }], [delay]).slice(2)) as Hex,
  });
  console.log(`deployer balance : ${formatEther(balance)} (native)`);
  console.log(`gasPrice         : ${gasPrice}`);
  console.log(`est. deploy gas  : ${deployGas} → est. cost ${formatEther(deployGas * gasPrice)}`);
  if (balance < deployGas * gasPrice) {
    console.log("funding          : NO-GO — INSUFFICIENT for gas");
    if (broadcast) throw new Error("Cannot broadcast: insufficient balance for gas.");
  } else {
    console.log("funding          : GO — balance covers deploy");
  }

  if (!broadcast) {
    console.log("\nPreflight only (BROADCAST != 1). Not sending any transaction.");
    return;
  }

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });

  console.log("\n[1/7] deploying UntchReceipts …");
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [delay],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const contract = deployRcpt.contractAddress;
  if (!contract) throw new Error("deploy receipt has no contractAddress");
  console.log(`      tx ${deployHash} → ${contract} (block ${deployRcpt.blockNumber})`);

  const call = { address: contract, abi: artifact.abi } as const;

  console.log("[2/7] propose(ADD_WRITER, deployer) — enters the timelock …");
  const proposeHash = await wallet.writeContract({
    ...call,
    functionName: "propose",
    args: [OP_ADD_WRITER, deployer],
  });
  await pub.waitForTransactionReceipt({ hash: proposeHash });
  const opId = computeOpId(OP_ADD_WRITER, deployer);
  const eta = (await pub.readContract({ ...call, functionName: "opEta", args: [opId] })) as bigint;
  console.log(`      tx ${proposeHash} → opId ${opId}, eta ${eta}`);

  // Prove execute reverts BEFORE the delay — read-only eth_call, no gas spent, no state change.
  let earlyReverted = false;
  try {
    await pub.simulateContract({
      ...call,
      functionName: "execute",
      args: [OP_ADD_WRITER, deployer],
      account: deployer,
    });
  } catch {
    earlyReverted = true;
  }
  console.log(`      execute-before-delay reverts (eth_call): ${earlyReverted}`);
  if (!earlyReverted) throw new Error("TIMELOCK BROKEN: execute did not revert before the delay");

  console.log("[3/7] waiting out the timelock delay …");
  for (;;) {
    const block = await pub.getBlock();
    if (block.timestamp >= eta) break;
    const remaining = Number(eta - block.timestamp);
    console.log(`      block.timestamp ${block.timestamp} < eta ${eta} — waiting ~${remaining}s`);
    await sleep(Math.min(remaining + 3, 15) * 1000);
  }

  console.log("[4/7] execute(ADD_WRITER, deployer) — after the delay …");
  const executeHash = await wallet.writeContract({
    ...call,
    functionName: "execute",
    args: [OP_ADD_WRITER, deployer],
  });
  await pub.waitForTransactionReceipt({ hash: executeHash });
  const isWriter = (await pub.readContract({
    ...call,
    functionName: "isWriter",
    args: [deployer],
  })) as boolean;
  console.log(`      tx ${executeHash} → isWriter[deployer] = ${isWriter}`);
  if (!isWriter) throw new Error("execute did not authorize the writer");

  console.log("[5/7] logReceipts([3 receipts]) — one tx …");
  const demoBatch = batch(3);
  const logHash = await wallet.writeContract({
    ...call,
    functionName: "logReceipts",
    args: [demoBatch],
  });
  const logRcpt = await pub.waitForTransactionReceipt({ hash: logHash });
  let receiptLoggedCount = 0;
  let batchLoggedId: bigint | undefined;
  for (const log of logRcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "ReceiptLogged") receiptLoggedCount++;
      if (ev.eventName === "BatchLogged") {
        batchLoggedId = (ev.args as unknown as { batchId: bigint }).batchId;
      }
    } catch {
      /* not our event */
    }
  }
  console.log(
    `      tx ${logHash} → ReceiptLogged×${receiptLoggedCount}, BatchLogged id ${batchLoggedId}, gasUsed ${logRcpt.gasUsed}`,
  );

  console.log("[6/7] anchorScore + anchorAudit …");
  const scoreHash = await wallet.writeContract({
    ...call,
    functionName: "anchorScore",
    args: [keccak256(toHex("untch-demo-score-root")), 1n, 0],
  });
  await pub.waitForTransactionReceipt({ hash: scoreHash });
  const auditHash = await wallet.writeContract({
    ...call,
    functionName: "anchorAudit",
    args: [keccak256(toHex("untch-demo-audit-report")), agentIdBytes32(DEMO_BUYER_AGENT_ID), 202607n],
  });
  await pub.waitForTransactionReceipt({ hash: auditHash });
  console.log(`      anchorScore tx ${scoreHash}`);
  console.log(`      anchorAudit tx ${auditHash}`);

  console.log("[7/7] MEASURING REAL GAS at batch sizes 1, 10, 50 …");
  const gasBySize: Record<number, string> = {};
  for (const size of [1, 10, 50]) {
    const h = await wallet.writeContract({ ...call, functionName: "logReceipts", args: [batch(size)] });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    gasBySize[size] = r.gasUsed.toString();
    console.log(`      batch ${String(size).padStart(2)} → gasUsed ${r.gasUsed}  (${(Number(r.gasUsed) / size).toFixed(0)}/receipt, tx ${h})`);
  }
  const perReceiptMarginal = (Number(gasBySize[50]) - Number(gasBySize[10])) / 40;
  console.log(`      marginal gas/receipt (from 50 vs 10): ${perReceiptMarginal.toFixed(0)}`);

  const batchCount = (await pub.readContract({ ...call, functionName: "batchCount" })) as bigint;
  const admin = (await pub.readContract({ ...call, functionName: "admin" })) as Address;
  const etaAfter = (await pub.readContract({ ...call, functionName: "opEta", args: [opId] })) as bigint;

  const ok =
    receiptLoggedCount === 3 &&
    batchLoggedId === 1n &&
    isWriter === true &&
    admin.toLowerCase() === deployer.toLowerCase() &&
    etaAfter === 0n &&
    batchCount === 4n; // demo batch (1) + gas batches 1/10/50 (3) = 4

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(
    JSON.stringify(
      {
        chainId,
        contract,
        timelockDelaySeconds: delay.toString(),
        deployTx: deployHash,
        proposeTx: proposeHash,
        executeTx: executeHash,
        logReceiptsTx: logHash,
        anchorScoreTx: scoreHash,
        anchorAuditTx: auditHash,
        opId,
        eta: eta.toString(),
        earlyExecuteReverted: earlyReverted,
        receiptLoggedCount,
        batchLoggedId: batchLoggedId?.toString(),
        batchCount: batchCount.toString(),
        admin,
        isWriterDeployer: isWriter,
        gasUsedByBatchSize: gasBySize,
        marginalGasPerReceipt: perReceiptMarginal.toFixed(0),
        roundTripOk: ok,
        verifyCmd:
          chainId === X_LAYER_TESTNET_ID
            ? `forge verify-contract ${contract} src/UntchReceipts.sol:UntchReceipts --chain ${X_LAYER_TESTNET_ID} --constructor-args $(cast abi-encode "constructor(uint64)" ${delay}) --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET`
            : "(local chain — no explorer verification)",
      },
      null,
      2,
    ),
  );

  if (!ok) throw new Error("READBACK MISMATCH — on-chain state does not match the demo");
  console.log("\n✓ deploy → timelock (propose/wait/execute) → logReceipts → anchors → readback OK");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
