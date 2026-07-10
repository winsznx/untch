import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  hashTypedData,
  http,
  parseUnits,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../packages/shared/src/chains";

/**
 * UntchVault deploy + demo driver (PRD §10.4 / §7.5 / §28 fork-integration + §22.4).
 *
 * TESTNET ONLY. Refuses X Layer mainnet (chainId 196) — mainnet stays deferred until the full
 * contract set clears §28's mainnet checklist together.
 *
 * TOKEN NOTE (honest, not hand-waved): packages/shared/chains.ts has NO confirmed X Layer *testnet*
 * USDT0 address (only mainnet is confirmed; the testnet faucet issues native OKB only). So this demo
 * deploys a standard-compliant test ERC20 (the same `MockERC20` the unit tests use) as the settlement
 * token. SafeERC20 is used in the vault precisely so the same code also handles non-standard mainnet
 * tokens; the demo just needs a real, transferable ERC20 to exercise deposit/spend/withdraw on-chain.
 *
 * One coherent flow (BROADCAST=1):
 *   1. Deploy MockERC20 (demo settlement token); mint to the deployer.
 *   2. Deploy UntchVault(owner=deployer, oracle, intentRegistry=REAL §10.2 SpendIntentRegistry, caps,
 *      [token], requireAnchoredIntent=true) — so the vault's cross-contract check hits the REAL,
 *      already-deployed SpendIntentRegistry (0xf87e…1372) and its REAL APPROVED demo intent.
 *   3. deposit() real tokens.
 *   4. spend() — an EIP-712 oracle-signed spend that references the REAL approved intentHash; the vault
 *      calls the real registry's isUsable() on-chain (fail-closed) → true → funds move. Measures gas.
 *   5. spendFallback() — owner-set allowlist micro-spend (oracle-offline path). Measures gas.
 *   6. A deliberately-invalid spend (over perTxCap) — confirmed to REVERT via read-only eth_call.
 *   7. ownerWithdraw() — the unconditional owner exit.
 *   8. Independently reads back EVERY state change via raw RPC (not the driver's own word).
 *
 * Env:
 *   RPC_URL                target RPC (default X Layer testnet).
 *   DEPLOYER_PRIVATE_KEY   0x-prefixed key that signs + owns the vault (required to BROADCAST).
 *   ORACLE_PRIVATE_KEY     0x-prefixed oracle key (default: a fixed throwaway testnet demo key).
 *   INTENT_REGISTRY        SpendIntentRegistry address (default: the live testnet §10.2 registry).
 *   DEMO_INTENT_HASH       an APPROVED intent in that registry (default: the live demo intent).
 *   BROADCAST              "1" to send txs; anything else = preflight only.
 */

const ARTIFACTS = fileURLToPath(new URL("../contracts/out/", import.meta.url));
const VAULT_ARTIFACT = `${ARTIFACTS}UntchVault.sol/UntchVault.json`;
const TOKEN_ARTIFACT = `${ARTIFACTS}VaultMocks.sol/MockERC20.json`;

// The live §10.2 SpendIntentRegistry on X Layer testnet + its REAL APPROVED demo intent
// (contracts/deploy/spend-intent-testnet-receipt.json). The vault's cross-contract check hits this.
const DEFAULT_INTENT_REGISTRY: Address = "0xf87e50f83172c2dace7d274e4c701212caeb1372";
const DEFAULT_INTENT_HASH: Hex =
  "0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a";

// Fixed throwaway testnet demo oracle key (anvil account #1) — holds no funds, exists only so the demo
// has an oracle DISTINCT from the owner, showing the oracle key that signs is not the fund sovereign.
const DEFAULT_ORACLE_KEY: Hex =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const DECIMALS = 6;
const PER_TX_CAP = parseUnits("100", DECIMALS);
const EPOCH_BUDGET = parseUnits("250", DECIMALS);
const EPOCH_LEN = 86_400n; // 1 day
const DEPOSIT = parseUnits("500", DECIMALS);
const SPEND_AMOUNT = parseUnits("40", DECIMALS);
const FALLBACK_CAP = parseUnits("50", DECIMALS);
const FALLBACK_AMOUNT = parseUnits("10", DECIMALS);
const WITHDRAW_AMOUNT = parseUnits("100", DECIMALS);
const OVER_CAP_AMOUNT = parseUnits("200", DECIMALS); // > PER_TX_CAP → must revert CapExceeded

const PAYEE: Address = getAddress("0x000000000000000000000000000000000000beef");
const FALLBACKEE: Address = getAddress("0x000000000000000000000000000000000000cafe");

const SPEND_EIP712 = {
  Spend: [
    { name: "recipient", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "token", type: "address" },
    { name: "intentHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
} as const;

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

async function main() {
  const rpcUrl =
    process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0] ?? "https://testrpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const oraclePk = (process.env.ORACLE_PRIVATE_KEY as Hex | undefined) ?? DEFAULT_ORACLE_KEY;
  const intentRegistry = (process.env.INTENT_REGISTRY as Address | undefined) ??
    DEFAULT_INTENT_REGISTRY;
  const intentHash = (process.env.DEMO_INTENT_HASH as Hex | undefined) ?? DEFAULT_INTENT_HASH;

  const vaultArtifact = loadArtifact(VAULT_ARTIFACT, "UntchVault");
  const tokenArtifact = loadArtifact(TOKEN_ARTIFACT, "MockERC20");

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = targetChain(rpcUrl, chainId);
  const oracle = privateKeyToAccount(oraclePk);

  console.log("── UntchVault deploy driver (TESTNET ONLY) ─────────────────────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(`chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`);
  console.log(`intentRegistry   : ${intentRegistry} (real §10.2 registry)`);
  console.log(`demo intentHash  : ${intentHash}`);
  console.log(`oracle (demo)    : ${oracle.address}`);

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
    console.log("funding          : NO-GO — 0 balance");
    if (broadcast) throw new Error("Cannot broadcast: 0 balance.");
  } else {
    console.log("funding          : GO");
  }

  // Sanity: the referenced intent must be usable in the real registry, else the anchored spend can't pass.
  const intentUsable = (await pub.readContract({
    address: intentRegistry,
    abi: [
      { type: "function", name: "isUsable", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
    ],
    functionName: "isUsable",
    args: [intentHash],
  })) as boolean;
  console.log(`intent usable    : ${intentUsable} (real registry isUsable — the vault will re-check this on-chain)`);

  if (!broadcast) {
    console.log("\nPreflight only (BROADCAST != 1). Not sending any transaction.");
    return;
  }
  if (!intentUsable) {
    throw new Error("Referenced intent is not usable in the registry — the anchored spend would revert.");
  }

  // 1) deploy demo token
  console.log("\n[1/8] deploying MockERC20 (demo settlement token) …");
  const tokenHash = await wallet.deployContract({
    abi: tokenArtifact.abi,
    bytecode: tokenArtifact.bytecode.object,
    args: [],
  });
  const tokenRcpt = await pub.waitForTransactionReceipt({ hash: tokenHash });
  const token = tokenRcpt.contractAddress as Address;
  console.log(`      token ${token} (tx ${tokenHash})`);

  // 2) deploy vault
  console.log("[2/8] deploying UntchVault …");
  const deployHash = await wallet.deployContract({
    abi: vaultArtifact.abi,
    bytecode: vaultArtifact.bytecode.object,
    args: [deployer, oracle.address, intentRegistry, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, [token], true],
  });
  const deployRcpt = await pub.waitForTransactionReceipt({ hash: deployHash });
  const vault = deployRcpt.contractAddress as Address;
  if (!vault) throw new Error("vault deploy receipt has no contractAddress");
  console.log(`      vault ${vault} (block ${deployRcpt.blockNumber}, tx ${deployHash})`);

  const vaultCall = { address: vault, abi: vaultArtifact.abi } as const;
  const tokenCall = { address: token, abi: tokenArtifact.abi } as const;

  // 3) mint + approve + deposit
  console.log("[3/8] mint + approve + deposit …");
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ ...tokenCall, functionName: "mint", args: [deployer, parseUnits("1000", DECIMALS)] }),
  });
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ ...tokenCall, functionName: "approve", args: [vault, parseUnits("1000", DECIMALS)] }),
  });
  const depositHash = await wallet.writeContract({ ...vaultCall, functionName: "deposit", args: [token, DEPOSIT] });
  await pub.waitForTransactionReceipt({ hash: depositHash });
  console.log(`      deposited ${formatUnits(DEPOSIT, DECIMALS)} (tx ${depositHash})`);

  // 4) oracle-signed spend referencing the REAL approved intent
  console.log("[4/8] oracle-signed spend (anchored to the real approved intent) …");
  const nonce = BigInt(Math.floor(Date.now() / 1000)); // unique per run — passed in, not from a banned Date in-contract
  const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const message = { recipient: PAYEE, amount: SPEND_AMOUNT, token, intentHash, nonce, expiry };
  const viemDigest = hashTypedData({
    domain: { name: "UntchVault", chainId, verifyingContract: vault },
    types: SPEND_EIP712,
    primaryType: "Spend",
    message,
  });
  const onchainDigest = (await pub.readContract({
    ...vaultCall,
    functionName: "spendDigest",
    args: [PAYEE, SPEND_AMOUNT, token, intentHash, nonce, expiry],
  })) as Hex;
  if (viemDigest.toLowerCase() !== onchainDigest.toLowerCase()) {
    throw new Error(`EIP-712 digest mismatch: viem ${viemDigest} != on-chain ${onchainDigest}`);
  }
  console.log(`      digest match : viem == on-chain (${onchainDigest})`);
  const sig = await oracle.signTypedData({
    domain: { name: "UntchVault", chainId, verifyingContract: vault },
    types: SPEND_EIP712,
    primaryType: "Spend",
    message,
  });
  const spendHash = await wallet.writeContract({
    ...vaultCall,
    functionName: "spend",
    args: [PAYEE, SPEND_AMOUNT, token, intentHash, sig, nonce, expiry],
  });
  const spendRcpt = await pub.waitForTransactionReceipt({ hash: spendHash });
  let spendGas = spendRcpt.gasUsed;
  console.log(`      spend tx ${spendHash} → gasUsed ${spendGas}`);

  // 5) fallback spend
  console.log("[5/8] fallback spend (oracle-offline path) …");
  await pub.waitForTransactionReceipt({
    hash: await wallet.writeContract({ ...vaultCall, functionName: "setFallbackAllowlist", args: [FALLBACKEE, FALLBACK_CAP] }),
  });
  const fbHash = await wallet.writeContract({ ...vaultCall, functionName: "spendFallback", args: [FALLBACKEE, FALLBACK_AMOUNT, token] });
  const fbRcpt = await pub.waitForTransactionReceipt({ hash: fbHash });
  const fbGas = fbRcpt.gasUsed;
  console.log(`      fallback tx ${fbHash} → gasUsed ${fbGas}`);

  // 6) deliberately-invalid spend (over cap) — confirm it reverts via read-only eth_call
  console.log("[6/8] invalid over-cap spend — must REVERT …");
  const badNonce = nonce + 1n;
  const badMessage = { recipient: PAYEE, amount: OVER_CAP_AMOUNT, token, intentHash, nonce: badNonce, expiry };
  const badSig = await oracle.signTypedData({
    domain: { name: "UntchVault", chainId, verifyingContract: vault },
    types: SPEND_EIP712,
    primaryType: "Spend",
    message: badMessage,
  });
  let overCapReverted = false;
  try {
    await pub.simulateContract({
      ...vaultCall,
      functionName: "spend",
      args: [PAYEE, OVER_CAP_AMOUNT, token, intentHash, badSig, badNonce, expiry],
      account: deployer,
    });
  } catch {
    overCapReverted = true;
  }
  console.log(`      over-cap spend reverts (eth_call): ${overCapReverted}`);
  if (!overCapReverted) throw new Error("CAP BROKEN: an over-cap spend did not revert");

  // 7) owner withdraw (unconditional)
  console.log("[7/8] ownerWithdraw …");
  const wHash = await wallet.writeContract({ ...vaultCall, functionName: "ownerWithdraw", args: [token, deployer, WITHDRAW_AMOUNT] });
  await pub.waitForTransactionReceipt({ hash: wHash });
  console.log(`      withdraw tx ${wHash}`);

  // 8) independent raw-RPC readback
  console.log("[8/8] independent raw-RPC readback …");
  const read = async (fn: string, args: unknown[] = []) =>
    pub.readContract({ ...vaultCall, functionName: fn, args });
  const [ownerR, oracleR, perTxCapR, epochBudgetR, epochSpentR, currentEpochR, nonceUsedR, tokenAllowedR, requireR, payeeBal, fallbackeeBal, vaultBal] =
    await Promise.all([
      read("owner"), read("oracle"), read("perTxCap"), read("epochBudget"), read("epochSpent"),
      read("currentEpoch"), read("nonceUsed", [nonce]), read("tokenAllowed", [token]),
      read("requireAnchoredIntent"),
      pub.readContract({ ...tokenCall, functionName: "balanceOf", args: [PAYEE] }),
      pub.readContract({ ...tokenCall, functionName: "balanceOf", args: [FALLBACKEE] }),
      pub.readContract({ ...tokenCall, functionName: "balanceOf", args: [vault] }),
    ]);

  const ok =
    (ownerR as string).toLowerCase() === deployer.toLowerCase() &&
    (oracleR as string).toLowerCase() === oracle.address.toLowerCase() &&
    (perTxCapR as bigint) === PER_TX_CAP &&
    (epochBudgetR as bigint) === EPOCH_BUDGET &&
    (epochSpentR as bigint) === SPEND_AMOUNT + FALLBACK_AMOUNT &&
    (nonceUsedR as boolean) === true &&
    (tokenAllowedR as boolean) === true &&
    (requireR as boolean) === true &&
    (payeeBal as bigint) === SPEND_AMOUNT &&
    (fallbackeeBal as bigint) === FALLBACK_AMOUNT &&
    (vaultBal as bigint) === DEPOSIT - SPEND_AMOUNT - FALLBACK_AMOUNT - WITHDRAW_AMOUNT;

  const receipt = {
    chainId,
    token,
    vault,
    intentRegistry,
    intentHash,
    oracle: oracle.address,
    owner: deployer,
    tokenDeployTx: tokenHash,
    vaultDeployTx: deployHash,
    depositTx: depositHash,
    spendTx: spendHash,
    fallbackTx: fbHash,
    withdrawTx: wHash,
    overCapReverted,
    gas: { spend: spendGas.toString(), fallback: fbGas.toString() },
    readback: {
      owner: ownerR,
      oracle: oracleR,
      perTxCap: (perTxCapR as bigint).toString(),
      epochBudget: (epochBudgetR as bigint).toString(),
      epochSpent: (epochSpentR as bigint).toString(),
      currentEpoch: (currentEpochR as bigint).toString(),
      nonceUsed: nonceUsedR,
      tokenAllowed: tokenAllowedR,
      requireAnchoredIntent: requireR,
      payeeBalance: (payeeBal as bigint).toString(),
      fallbackeeBalance: (fallbackeeBal as bigint).toString(),
      vaultBalance: (vaultBal as bigint).toString(),
    },
    roundTripOk: ok,
    verifyCmd:
      chainId === X_LAYER_TESTNET_ID
        ? `forge verify-contract ${vault} src/UntchVault.sol:UntchVault --chain ${X_LAYER_TESTNET_ID} --constructor-args $(cast abi-encode "constructor(address,address,address,uint256,uint256,uint64,address[],bool)" ${deployer} ${oracle.address} ${intentRegistry} ${PER_TX_CAP} ${EPOCH_BUDGET} ${EPOCH_LEN} "[${token}]" true) --verifier oklink --verifier-url https://www.oklink.com/api/v5/explorer/contract/verify-source-code-plugin/XLAYER_TESTNET`
        : "(local chain — no explorer verification)",
  };

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(JSON.stringify(receipt, null, 2));
  if (!ok) throw new Error("READBACK MISMATCH — on-chain state does not match the demo");
  console.log("\n✓ deploy → deposit → oracle spend → fallback spend → over-cap revert → withdraw → readback OK");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
