import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// canon Surface B, imported from source by path (root scripts resolve workspace packages
// relatively, exactly like deploy-policy-registry.ts imports packages/canon) — this is the same
// hashSpendIntent module @untch/canon exports, not a reimplementation.
import { hashSpendIntent, type SpendIntent } from "../packages/canon/src/spendIntent";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  getAddress,
  http,
  keccak256,
  toHex,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../packages/shared/src/chains";

/**
 * SpendIntentRegistry deploy + demo-lifecycle driver (PRD §10.2 / §28 fork-integration + §22.4).
 *
 * TESTNET ONLY. This script never targets X Layer mainnet — mainnet is deliberately deferred until
 * the full contract set (PolicyRegistry / SpendIntentRegistry / UntchReceipts / UntchVault) exists
 * and clears §28's mainnet checklist together. It refuses chainId 196.
 *
 * What it does, in one coherent flow:
 *   1. Builds a §8.1-shaped demo SpendIntent and computes its `intentHash` with @untch/canon's
 *      `hashSpendIntent` (Surface B) — the SAME off-chain hashing surface the middleware/receipt path
 *      uses. The demo's policyId/policyHash reference the real PolicyRegistry demo policy so the two
 *      contracts tell one coherent story (policyId is stored as an opaque reference — this registry
 *      does NOT validate it against PolicyRegistry, by design; see contracts/README.md).
 *   2. Reads the Foundry-compiled SpendIntentRegistry artifact (same solc 0.8.34 / optimizer / paris
 *      settings as test + static analysis — one compiler truth).
 *   3. Preflights: chainId, deploy-gas estimate, deployer balance → GO / NO-GO. Key-free-safe.
 *   4. Only when BROADCAST=1 (and funds cover cost): deploys, authorizes the deployer as a writer
 *      (exercises the admin-managed writer-set access-control path end-to-end), registers the demo
 *      intent (PENDING), transitions it to APPROVED, then reads it back on-chain and asserts the
 *      round-trip — including that the on-chain intentHash equals canon's off-chain hash.
 *
 * Env:
 *   RPC_URL                 target RPC (default: X Layer testnet). Point at http://127.0.0.1:8545
 *                           for a local anvil end-to-end proof.
 *   DEPLOYER_PRIVATE_KEY    0x-prefixed key that signs the deploy (required to BROADCAST).
 *   POLICY_ID               policyId the demo intent references (default: the PolicyRegistry demo id).
 *   INTENT_DEADLINE_UNIX    demo intent deadline (default: now + 30 days).
 *   BROADCAST               "1" to actually send txs; anything else = preflight only.
 */

const ARTIFACT_PATH = fileURLToPath(
  new URL("../contracts/out/SpendIntentRegistry.sol/SpendIntentRegistry.json", import.meta.url),
);

// The real PolicyRegistry demo policy on X Layer testnet (deploy/testnet-receipt.json), referenced
// so the intent demo is coherent with the policy demo. Not validated on-chain here (decision #2).
const DEMO_POLICY_ID =
  43689584780193288224528649685930235207374048247885169918877241264404980193079n;
const DEMO_POLICY_HASH: Hex =
  "0x640bdb4c3a438728839abd08b38361df44db3acb60503307214a34b28407384d";
const DEMO_TOKEN: Address = "0x000000000000000000000000000000000000d97a"; // demo token (testnet has no confirmed stable)

// SpendIntentRegistry.Status enum: NONE=0, PENDING=1, APPROVED=2, BLOCKED=3, SETTLED=4, DISPUTED=5.
const STATUS_APPROVED = 2;

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function loadArtifact(): Artifact {
  const raw = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Artifact;
  if (!raw.bytecode?.object?.startsWith("0x")) {
    throw new Error(`SpendIntentRegistry artifact missing bytecode — run \`forge build\` first`);
  }
  return raw;
}

function targetChain(rpcUrl: string, chainId: number): Chain {
  if (chainId === X_LAYER_TESTNET_ID) return xLayerTestnet;
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0] ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const policyId = BigInt(process.env.POLICY_ID ?? DEMO_POLICY_ID);
  const deadline = BigInt(
    process.env.INTENT_DEADLINE_UNIX ?? Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
  );

  const artifact = loadArtifact();
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = targetChain(rpcUrl, chainId);

  console.log("── SpendIntentRegistry deploy driver (TESTNET ONLY) ────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(
    `chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`,
  );

  if (chainId === 196) {
    throw new Error("Refusing to run against X Layer MAINNET (chainId 196) — testnet only.");
  }

  if (!pk) {
    console.log("\nNo DEPLOYER_PRIVATE_KEY set — preflight without a signer.");
    const deployGas = await pub
      .estimateGas({
        account: "0x000000000000000000000000000000000000dEaD",
        data: artifact.bytecode.object,
      })
      .catch((e) => {
        console.log(`  deploy gas estimate unavailable: ${(e as Error).message.split("\n")[0]}`);
        return 0n;
      });
    if (deployGas) console.log(`  estimated deploy gas: ${deployGas}`);
    console.log("Set DEPLOYER_PRIVATE_KEY and BROADCAST=1 to deploy.");
    return;
  }

  const account = privateKeyToAccount(pk);

  // §8.1 demo intent. `owner` is the operator (ops) wallet; the intent references the real demo
  // policy. Same object hashed on-chain (IntentHash.hashIntent) and off-chain (canon hashSpendIntent).
  const intent: SpendIntent = {
    owner: account.address,
    buyerAgentId: 1n,
    workerAgentId: 0n, // A2MCP endpoint call
    token: DEMO_TOKEN,
    maxAmount: 1_000_000n, // 1.0 unit at 6 decimals
    taskHash: keccak256(toHex("untch-demo-task")),
    acceptanceHash: keccak256(toHex("untch-demo-acceptance")),
    schemaHash: keccak256(toHex("untch-demo-schema")),
    policyHash: DEMO_POLICY_HASH,
    deadline,
    nonce: 1n,
  };
  const offchainIntentHash = hashSpendIntent(intent);

  console.log(`deployer/writer  : ${account.address}`);
  console.log(`policyId (ref)   : ${policyId}`);
  console.log(`intent deadline  : ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);
  console.log(`intentHash (canon): ${offchainIntentHash}   ← @untch/canon hashSpendIntent(demo intent)`);

  const balance = await pub.getBalance({ address: account.address });
  const gasPrice = await pub.getGasPrice();
  const deployGas = await pub.estimateGas({
    account: account.address,
    data: artifact.bytecode.object,
  });
  const estCost = deployGas * gasPrice;

  console.log(`\ndeployer balance : ${formatEther(balance)} (native)`);
  console.log(`gasPrice         : ${gasPrice}`);
  console.log(`est. deploy gas  : ${deployGas}  →  est. cost ${formatEther(estCost)}`);

  const funded = balance >= estCost;
  console.log(
    `funding          : ${funded ? "GO — balance covers deploy" : "NO-GO — INSUFFICIENT for gas"}`,
  );

  if (!broadcast) {
    console.log("\nPreflight only (BROADCAST != 1). Not sending any transaction.");
    return;
  }
  if (!funded) {
    throw new Error(
      `Cannot broadcast: deployer balance ${formatEther(balance)} < est. deploy cost ${formatEther(estCost)}.`,
    );
  }

  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const intentArg = {
    owner: intent.owner,
    buyerAgentId: intent.buyerAgentId,
    workerAgentId: intent.workerAgentId,
    token: intent.token,
    maxAmount: intent.maxAmount,
    taskHash: intent.taskHash,
    acceptanceHash: intent.acceptanceHash,
    schemaHash: intent.schemaHash,
    policyHash: intent.policyHash,
    deadline: intent.deadline,
    nonce: intent.nonce,
  };

  console.log("\n[1/4] deploying SpendIntentRegistry …");
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const registry = deployRcpt.contractAddress;
  if (!registry) throw new Error("deploy receipt has no contractAddress");
  console.log(`      tx ${deployHash} → ${registry} (block ${deployRcpt.blockNumber})`);

  console.log("[2/4] authorizing deployer as a writer (admin-managed writer set) …");
  const addWriterHash = await wallet.writeContract({
    address: registry,
    abi: artifact.abi,
    functionName: "addWriter",
    args: [account.address],
  });
  await pub.waitForTransactionReceipt({ hash: addWriterHash });
  console.log(`      tx ${addWriterHash} → isWriter[deployer] = true`);

  console.log("[3/4] registering demo intent (PENDING) …");
  const regHash = await wallet.writeContract({
    address: registry,
    abi: artifact.abi,
    functionName: "registerIntent",
    args: [intentArg, policyId],
  });
  const regRcpt = await pub.waitForTransactionReceipt({ hash: regHash });

  let eventIntentHash: Hex | undefined;
  for (const log of regRcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "IntentRegistered") {
        eventIntentHash = (ev.args as unknown as { intentHash: Hex }).intentHash;
      }
    } catch {
      /* not our event */
    }
  }
  console.log(`      tx ${regHash} → intentHash ${eventIntentHash} (canon ${offchainIntentHash})`);

  console.log("[4/4] transitioning demo intent PENDING → APPROVED …");
  const setStatusHash = await wallet.writeContract({
    address: registry,
    abi: artifact.abi,
    functionName: "setStatus",
    args: [offchainIntentHash, STATUS_APPROVED],
  });
  await pub.waitForTransactionReceipt({ hash: setStatusHash });
  console.log(`      tx ${setStatusHash} → status APPROVED`);

  const rec = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "getIntent",
    args: [offchainIntentHash],
  })) as { policyId: bigint; maxAmount: bigint; deadline: bigint; status: number };
  const usable = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "isUsable",
    args: [offchainIntentHash],
  })) as boolean;
  const onchainPreview = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "previewIntentHash",
    args: [intentArg],
  })) as Hex;

  const ok =
    eventIntentHash === offchainIntentHash &&
    onchainPreview === offchainIntentHash &&
    rec.policyId === policyId &&
    rec.maxAmount === intent.maxAmount &&
    rec.deadline === deadline &&
    rec.status === STATUS_APPROVED &&
    usable === true;

  console.log(
    `      readback policyId=${rec.policyId} maxAmount=${rec.maxAmount} deadline=${rec.deadline} ` +
      `status=${rec.status} usable=${usable}`,
  );
  console.log(`      on-chain intentHash matches canon: ${onchainPreview === offchainIntentHash}`);

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(
    JSON.stringify(
      {
        chainId,
        registry,
        deployTx: deployHash,
        addWriterTx: addWriterHash,
        registerTx: regHash,
        setStatusTx: setStatusHash,
        intentHash: offchainIntentHash,
        policyId: policyId.toString(),
        policyHash: DEMO_POLICY_HASH,
        owner: account.address,
        maxAmount: intent.maxAmount.toString(),
        deadline: deadline.toString(),
        status: "APPROVED",
        usable,
        roundTripOk: ok,
        verifyCmd:
          chainId === X_LAYER_TESTNET_ID
            ? `forge verify-contract ${registry} src/SpendIntentRegistry.sol:SpendIntentRegistry --chain ${X_LAYER_TESTNET_ID} --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET`
            : "(local chain — no explorer verification)",
      },
      null,
      2,
    ),
  );

  if (!ok) throw new Error("READBACK MISMATCH — on-chain intent does not match what was registered");
  console.log("\n✓ deploy → addWriter → registerIntent → setStatus → readback round-trip OK");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
