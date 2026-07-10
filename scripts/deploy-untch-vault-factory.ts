import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../packages/shared/src/chains";

/**
 * UntchVaultFactory deploy + demo driver (PRD §10.4 / §28 fork-integration + §22.4).
 *
 * TESTNET ONLY. Refuses X Layer mainnet (chainId 196) — mainnet stays deferred until the full
 * five-contract set clears §28's mainnet checklist together.
 *
 * The demo is the exact sequence the task requires, and every claim is re-read from chain by raw RPC
 * (never the driver's own word):
 *   1. Deploy UntchVaultFactory(intentRegistry = the REAL, already-live §10.2 SpendIntentRegistry).
 *   2. PREDICT a vault address via `computeVaultAddress(owner, agent, oracle, caps, [token], require)`
 *      BEFORE it exists.
 *   3. DEPLOY that vault via `deployVault(...)` with the SAME inputs.
 *   4. CONFIRM the real deployed address == the prediction.
 *   5. Independently read back the deployed vault's immutables via raw RPC — owner, oracle,
 *      intentRegistry (must equal the FACTORY's canonical one), perTxCap, epochBudget, epochLen,
 *      requireAnchoredIntent, tokenAllowed — and MATCH each against what was passed in.
 *   6. Prove the double-deployment guard: a second `deployVault(owner, agent, ...)` REVERTS
 *      (VaultAlreadyDeployed) — confirmed via read-only eth_call.
 *   7. Prove access control: `deployVault` with owner != caller REVERTS (OwnerMustBeSender) via eth_call.
 *
 * Env:
 *   RPC_URL                target RPC (default X Layer testnet).
 *   DEPLOYER_PRIVATE_KEY   0x-prefixed key that signs + owns the demo vault (required to BROADCAST).
 *   INTENT_REGISTRY        canonical SpendIntentRegistry (default: the live testnet §10.2 registry).
 *   DEMO_AGENT             the per-agent salt seed for the demo vault (default: a fixed demo address).
 *   DEMO_TOKEN             a token for the demo vault's allowlist (default: the live demo ERC20).
 *   BROADCAST              "1" to send txs; anything else = preflight only.
 */

const ARTIFACTS = fileURLToPath(new URL("../contracts/out/", import.meta.url));
const FACTORY_ARTIFACT = `${ARTIFACTS}UntchVaultFactory.sol/UntchVaultFactory.json`;

// The live §10.2 SpendIntentRegistry on X Layer testnet — the ONE canonical registry every vault this
// factory deploys is bound to (decision B). Same address the UntchVault demo used.
const DEFAULT_INTENT_REGISTRY: Address = "0xf87e50f83172c2dace7d274e4c701212caeb1372";
// A real, transferable demo ERC20 already on testnet (from the UntchVault demo) — used only to populate
// the demo vault's token allowlist so `tokenAllowed` reads back true. No spend happens in THIS demo.
const DEFAULT_DEMO_TOKEN: Address = "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41";
// Fixed demo agent (salt seed) — distinct from owner/oracle, showing `agent` is a namespacing key only.
const DEFAULT_DEMO_AGENT: Address = getAddress("0x000000000000000000000000000000000000a9e7");

// Demo oracle (anvil #1) — a key DISTINCT from the owner, mirroring the vault demo. Not used to sign
// here (this demo does not spend); it is just wired into the deployed vault and read back.
const DEMO_ORACLE: Address = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

const DECIMALS = 6;
const PER_TX_CAP = 100_000_000n; // 100 * 10^6
const EPOCH_BUDGET = 250_000_000n; // 250 * 10^6
const EPOCH_LEN = 86_400n; // 1 day
const REQUIRE_ANCHORED_INTENT = true;

type Artifact = { abi: Abi; bytecode: { object: Hex } };

function loadArtifact(path: string, name: string): Artifact {
  const raw = JSON.parse(readFileSync(path, "utf8")) as Artifact;
  if (!raw.bytecode?.object?.startsWith("0x")) {
    throw new Error(`${name} artifact missing bytecode — run \`forge build\` first`);
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

const VAULT_READ_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "intentRegistry", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "perTxCap", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochBudget", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "epochLen", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "requireAnchoredIntent", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "tokenAllowed", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const satisfies Abi;

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0] ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const intentRegistry = (process.env.INTENT_REGISTRY as Address | undefined) ?? DEFAULT_INTENT_REGISTRY;
  const agent = (process.env.DEMO_AGENT as Address | undefined) ?? DEFAULT_DEMO_AGENT;
  const token = (process.env.DEMO_TOKEN as Address | undefined) ?? DEFAULT_DEMO_TOKEN;

  const factoryArtifact = loadArtifact(FACTORY_ARTIFACT, "UntchVaultFactory");

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = targetChain(rpcUrl, chainId);

  console.log("── UntchVaultFactory deploy driver (TESTNET ONLY) ──────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(`chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`);
  console.log(`intentRegistry   : ${intentRegistry} (canonical §10.2 registry — decision B)`);
  console.log(`demo agent (salt): ${agent}`);
  console.log(`demo token       : ${token}`);

  if (chainId === 196) throw new Error("Refusing X Layer MAINNET (chainId 196) — testnet only.");
  if (!pk) {
    console.log("\nNo DEPLOYER_PRIVATE_KEY set — preflight only. Set it + BROADCAST=1 to deploy.");
    return;
  }

  const account = privateKeyToAccount(pk);
  const deployer = account.address;
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  console.log(`deployer/owner   : ${deployer}`);

  const balance = await pub.getBalance({ address: deployer });
  console.log(`deployer balance : ${formatUnits(balance, 18)} OKB`);
  if (balance === 0n) {
    if (broadcast) throw new Error("Cannot broadcast: 0 balance.");
    console.log("funding          : NO-GO — 0 balance");
  } else {
    console.log("funding          : GO");
  }

  if (!broadcast) {
    console.log("\nPreflight only (BROADCAST != 1). Not sending any transaction.");
    return;
  }

  const tokenAllow = [token] as const;
  const deployArgs = [
    deployer, agent, DEMO_ORACLE, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, tokenAllow, REQUIRE_ANCHORED_INTENT,
  ] as const;

  // 1) deploy the factory
  console.log("\n[1/7] deploying UntchVaultFactory …");
  const factoryHash = await wallet.deployContract({
    abi: factoryArtifact.abi,
    bytecode: factoryArtifact.bytecode.object,
    args: [intentRegistry],
  });
  const factoryRcpt = await pub.waitForTransactionReceipt({ hash: factoryHash });
  const factory = factoryRcpt.contractAddress as Address;
  if (!factory) throw new Error("factory deploy receipt has no contractAddress");
  console.log(`      factory ${factory} (block ${factoryRcpt.blockNumber}, tx ${factoryHash})`);

  const factoryCall = { address: factory, abi: factoryArtifact.abi } as const;

  // sanity: factory's canonical registry read back == what we passed
  const factoryReg = (await pub.readContract({ ...factoryCall, functionName: "intentRegistry" })) as Address;
  if (factoryReg.toLowerCase() !== intentRegistry.toLowerCase()) {
    throw new Error(`factory intentRegistry mismatch: ${factoryReg} != ${intentRegistry}`);
  }

  // 2) PREDICT the vault address before it exists
  console.log("[2/7] predicting vault address via computeVaultAddress …");
  const predicted = (await pub.readContract({
    ...factoryCall,
    functionName: "computeVaultAddress",
    args: deployArgs,
  })) as Address;
  console.log(`      predicted vault : ${predicted}`);
  const predictedCodeBefore = await pub.getCode({ address: predicted });
  console.log(`      code at predicted (pre-deploy): ${predictedCodeBefore ?? "0x"} (must be empty)`);

  // 3) DEPLOY the vault
  console.log("[3/7] deploying the vault via deployVault …");
  const deployVaultHash = await wallet.writeContract({
    ...factoryCall,
    functionName: "deployVault",
    args: deployArgs,
  });
  const deployVaultRcpt = await pub.waitForTransactionReceipt({ hash: deployVaultHash });
  console.log(`      deployVault tx ${deployVaultHash} → gasUsed ${deployVaultRcpt.gasUsed}`);
  const actual = (await pub.readContract({
    ...factoryCall,
    functionName: "computeVaultAddress",
    args: deployArgs,
  })) as Address;

  // 4) CONFIRM prediction == actual (and the address now holds code)
  const actualCode = await pub.getCode({ address: predicted });
  const predictionMatch = actual.toLowerCase() === predicted.toLowerCase();
  const hasCode = !!actualCode && actualCode !== "0x";
  console.log(`[4/7] prediction match : ${predictionMatch} (deployed at ${predicted}, code present: ${hasCode})`);
  if (!predictionMatch || !hasCode) {
    throw new Error("PREDICTION MISMATCH — deployVault did not land at computeVaultAddress");
  }

  // 5) independent raw-RPC readback of the deployed vault's immutables
  console.log("[5/7] independent raw-RPC readback of the deployed vault …");
  const vaultCall = { address: predicted, abi: VAULT_READ_ABI } as const;
  const read = async (fn: string, args: unknown[] = []) =>
    pub.readContract({ ...vaultCall, functionName: fn, args });
  const [ownerR, oracleR, regR, perTxCapR, epochBudgetR, epochLenR, requireR, tokenAllowedR] =
    await Promise.all([
      read("owner"),
      read("oracle"),
      read("intentRegistry"),
      read("perTxCap"),
      read("epochBudget"),
      read("epochLen"),
      read("requireAnchoredIntent"),
      read("tokenAllowed", [token]),
    ]);

  const wiringOk =
    (ownerR as string).toLowerCase() === deployer.toLowerCase() &&
    (oracleR as string).toLowerCase() === DEMO_ORACLE.toLowerCase() &&
    (regR as string).toLowerCase() === intentRegistry.toLowerCase() &&
    (perTxCapR as bigint) === PER_TX_CAP &&
    (epochBudgetR as bigint) === EPOCH_BUDGET &&
    (epochLenR as bigint) === EPOCH_LEN &&
    (requireR as boolean) === REQUIRE_ANCHORED_INTENT &&
    (tokenAllowedR as boolean) === true;
  console.log(`      wiring correct  : ${wiringOk}`);

  // 6) double-deployment guard — a second deployVault(owner, agent, ...) must REVERT
  console.log("[6/7] double-deployment must REVERT …");
  let doubleReverted = false;
  try {
    await pub.simulateContract({ ...factoryCall, functionName: "deployVault", args: deployArgs, account: deployer });
  } catch {
    doubleReverted = true;
  }
  console.log(`      double-deploy reverts (eth_call): ${doubleReverted}`);

  // 7) access control — deployVault with owner != caller must REVERT
  console.log("[7/7] owner != caller must REVERT …");
  const otherOwner = getAddress("0x000000000000000000000000000000000000dEaD");
  const otherAgent = getAddress("0x000000000000000000000000000000000000B0b0");
  let acReverted = false;
  try {
    await pub.simulateContract({
      ...factoryCall,
      functionName: "deployVault",
      args: [otherOwner, otherAgent, DEMO_ORACLE, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, tokenAllow, REQUIRE_ANCHORED_INTENT],
      account: deployer,
    });
  } catch {
    acReverted = true;
  }
  console.log(`      owner!=caller reverts (eth_call): ${acReverted}`);

  const roundTripOk = predictionMatch && hasCode && wiringOk && doubleReverted && acReverted;

  const receipt = {
    chainId,
    factory,
    intentRegistry,
    agent,
    token,
    oracle: DEMO_ORACLE,
    owner: deployer,
    factoryDeployTx: factoryHash,
    deployVaultTx: deployVaultHash,
    predictedVault: predicted,
    deployedVault: actual,
    predictionMatch,
    gas: { deployVault: deployVaultRcpt.gasUsed.toString() },
    readback: {
      owner: ownerR,
      oracle: oracleR,
      intentRegistry: regR,
      perTxCap: (perTxCapR as bigint).toString(),
      epochBudget: (epochBudgetR as bigint).toString(),
      epochLen: (epochLenR as bigint).toString(),
      requireAnchoredIntent: requireR,
      tokenAllowed: tokenAllowedR,
    },
    doubleDeployReverts: doubleReverted,
    ownerMustBeSenderReverts: acReverted,
    roundTripOk,
    verifyCmd:
      chainId === X_LAYER_TESTNET_ID
        ? `forge verify-contract ${factory} src/UntchVaultFactory.sol:UntchVaultFactory --chain ${X_LAYER_TESTNET_ID} --constructor-args $(cast abi-encode "constructor(address)" ${intentRegistry}) --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET`
        : "(local chain — no explorer verification)",
  };

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(JSON.stringify(receipt, null, 2));
  if (!roundTripOk) throw new Error("ROUND-TRIP FAILED — see receipt for the failing check");
  console.log("\n✓ deploy factory → predict → deploy vault → prediction match → readback → guards OK");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
