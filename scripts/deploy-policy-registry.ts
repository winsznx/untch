import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
// canon Surface A, imported from source by path (root scripts resolve workspace packages
// relatively, exactly like scripts/check-wallet.ts imports packages/shared) — this is the same
// hashCanonicalJson module @untch/canon exports, not a reimplementation.
import { hashCanonicalJson } from "../packages/canon/src/index";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatEther,
  getAddress,
  http,
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
 * PolicyRegistry deploy + demo-registration driver (PRD §10.1 / §28 fork-integration + §22.4).
 *
 * TESTNET ONLY. This script never targets X Layer mainnet — mainnet is deliberately deferred
 * until the full contract set (IntentRegistry / UntchReceipts / UntchVault) exists and clears
 * §28's mainnet checklist together.
 *
 * What it does, in one coherent flow:
 *   1. Builds a realistic §8-shaped demo policy and computes its `policyHash` with @untch/canon's
 *      `hashCanonicalJson` — the SAME canonical-JSON hashing surface the ASP preflight uses
 *      (services/asp/src/policy-fixture.ts), NOT an ad-hoc scheme.
 *   2. Reads the Foundry-compiled PolicyRegistry artifact (same solc 0.8.34 / optimizer / paris
 *      settings as test + static analysis — one compiler truth).
 *   3. Preflights: fetches chainId, estimates deploy gas, checks the deployer's balance, and
 *      reports GO / NO-GO with the exact shortfall. This is key-free and safe to run anywhere.
 *   4. Only when BROADCAST=1 (and funds cover the cost): deploys, registers the demo policy,
 *      then reads it back on-chain (getPolicy + isUsable) and asserts it round-trips.
 *
 * Env:
 *   RPC_URL                 target RPC (default: X Layer testnet). Point at http://127.0.0.1:8545
 *                           for a local anvil end-to-end proof.
 *   DEPLOYER_PRIVATE_KEY    0x-prefixed key that signs the deploy (required to BROADCAST).
 *   AGENT_ADDRESS           agent the demo policy governs (default: a fixed demo agent).
 *   POLICY_EXPIRY_UNIX      expiry (default: now + 365 days).
 *   BROADCAST               "1" to actually send txs; anything else = preflight only.
 */

const ARTIFACT_PATH = fileURLToPath(
  new URL("../contracts/out/PolicyRegistry.sol/PolicyRegistry.json", import.meta.url),
);

const DEMO_AGENT: Address = "0x000000000000000000000000000000000000A9E7";

/**
 * §8-shaped demo policy. Values are illustrative but structurally real; the object is hashed
 * verbatim through canon Surface A, exactly like the ASP's FIXTURE_RULES. Same rules ⇒ same hash
 * everywhere, which is the whole point of anchoring: the ruleset the MCP server enforces and the
 * ruleset committed on-chain are provably the same bytes.
 */
const DEMO_POLICY_RULES = {
  budgets: { daily: 25, token: "USDT" },
  perCallCap: 1.0,
  onPerCallCapExceeded: "ESCALATE",
  escalateAbove: 5.0,
  categories: { allow: ["market-data", "security", "research"], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  cooldowns: { sameServiceMin: 5 },
  rateLimit: { callsPerHour: 40 },
  expiry: "2026-12-31T00:00:00Z",
} as const;

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function loadArtifact(): Artifact {
  const raw = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Artifact;
  if (!raw.bytecode?.object?.startsWith("0x")) {
    throw new Error(`PolicyRegistry artifact missing bytecode — run \`forge build\` first`);
  }
  return raw;
}

function targetChain(rpcUrl: string, chainId: number): Chain {
  if (chainId === X_LAYER_TESTNET_ID || chainId === X_LAYER_MAINNET_ID) return chainById(chainId);
  // Local anvil / any other dev chain — define minimally from the observed chainId.
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function main() {
  const rpcUrl = process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0] ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const agent = getAddress(process.env.AGENT_ADDRESS ?? DEMO_AGENT);
  const expiry = BigInt(
    process.env.POLICY_EXPIRY_UNIX ?? Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60,
  );

  const artifact = loadArtifact();
  const policyHash = hashCanonicalJson(DEMO_POLICY_RULES as unknown as Record<string, unknown>);

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = targetChain(rpcUrl, chainId);

  console.log("── PolicyRegistry deploy driver (TESTNET ONLY) ─────────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(`chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`);
  console.log(`agent            : ${agent}`);
  console.log(`policy expiry    : ${expiry} (${new Date(Number(expiry) * 1000).toISOString()})`);
  console.log(`policyHash       : ${policyHash}   ← @untch/canon hashCanonicalJson(demo rules)`);

  if (chainId === X_LAYER_MAINNET_ID && process.env.ALLOW_MAINNET !== "1") {
    throw new Error(
      "Refusing X Layer MAINNET (196) without explicit opt-in — mainnet deploys stay gated on the §28 checklist. Set ALLOW_MAINNET=1 to proceed.",
    );
  }

  if (!pk) {
    console.log("\nNo DEPLOYER_PRIVATE_KEY set — preflight without a signer.");
    const deployGas = await pub.estimateGas({
      account: "0x000000000000000000000000000000000000dEaD",
      data: artifact.bytecode.object,
    }).catch((e) => {
      console.log(`  deploy gas estimate unavailable: ${(e as Error).message.split("\n")[0]}`);
      return 0n;
    });
    if (deployGas) console.log(`  estimated deploy gas: ${deployGas}`);
    console.log("Set DEPLOYER_PRIVATE_KEY and BROADCAST=1 to deploy.");
    return;
  }

  const account = privateKeyToAccount(pk);
  const balance = await pub.getBalance({ address: account.address });
  const gasPrice = await pub.getGasPrice();
  const deployGas = await pub.estimateGas({ account: account.address, data: artifact.bytecode.object });
  const estCost = deployGas * gasPrice;

  console.log(`\ndeployer         : ${account.address}`);
  console.log(`deployer balance : ${formatEther(balance)} (native)`);
  console.log(`gasPrice         : ${gasPrice}`);
  console.log(`est. deploy gas  : ${deployGas}  →  est. cost ${formatEther(estCost)}`);

  const funded = balance >= estCost;
  console.log(`funding          : ${funded ? "GO — balance covers deploy" : "NO-GO — INSUFFICIENT for gas"}`);

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

  console.log("\n[1/3] deploying PolicyRegistry …");
  const deployHash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode.object,
    args: [],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const registry = deployRcpt.contractAddress;
  if (!registry) throw new Error("deploy receipt has no contractAddress");
  console.log(`      tx ${deployHash} → ${registry} (block ${deployRcpt.blockNumber})`);

  const predictedId = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "nextPolicyId",
    args: [account.address],
  })) as bigint;

  console.log("[2/3] registering demo policy …");
  const regHash = await wallet.writeContract({
    address: registry,
    abi: artifact.abi,
    functionName: "registerPolicy",
    args: [agent, policyHash, expiry],
  });
  const regRcpt = await pub.waitForTransactionReceipt({ hash: regHash });

  let eventPolicyId: bigint | undefined;
  for (const log of regRcpt.logs) {
    try {
      const ev = decodeEventLog({ abi: artifact.abi, data: log.data, topics: log.topics });
      if (ev.eventName === "PolicyRegistered") {
        eventPolicyId = (ev.args as unknown as { policyId: bigint }).policyId;
      }
    } catch {
      /* not our event */
    }
  }
  console.log(`      tx ${regHash} → policyId ${eventPolicyId} (predicted ${predictedId})`);

  console.log("[3/3] reading policy back on-chain …");
  const policy = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "getPolicy",
    args: [predictedId],
  })) as { owner: Address; agent: Address; policyHash: Hex; status: number; expiry: bigint; version: number };
  const usable = (await pub.readContract({
    address: registry,
    abi: artifact.abi,
    functionName: "isUsable",
    args: [predictedId],
  })) as boolean;

  const ok =
    eventPolicyId === predictedId &&
    getAddress(policy.owner) === account.address &&
    getAddress(policy.agent) === agent &&
    policy.policyHash === policyHash &&
    policy.status === 1 &&
    policy.expiry === expiry &&
    usable === true;

  console.log(
    `      readback owner=${policy.owner} agent=${policy.agent} status=${policy.status} ` +
      `version=${policy.version} usable=${usable}`,
  );
  console.log(`      policyHash matches canon: ${policy.policyHash === policyHash}`);

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(
    JSON.stringify(
      {
        chainId,
        registry,
        deployTx: deployHash,
        registerTx: regHash,
        policyId: eventPolicyId?.toString(),
        policyHash,
        agent,
        owner: account.address,
        expiry: expiry.toString(),
        usable,
        roundTripOk: ok,
        verifyCmd:
          chainId === X_LAYER_TESTNET_ID
            ? `forge verify-contract ${registry} src/PolicyRegistry.sol:PolicyRegistry --chain ${X_LAYER_TESTNET_ID} --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET`
            : "(local chain — no explorer verification)",
      },
      null,
      2,
    ),
  );

  if (!ok) throw new Error("READBACK MISMATCH — on-chain policy does not match what was registered");
  console.log("\n✓ deploy → register → readback round-trip OK");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
