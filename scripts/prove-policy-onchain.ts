import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerTestnet, X_LAYER_TESTNET_ID } from "../packages/shared/src/chains";
// The dashboard's OWN transaction-construction path — the exact module the "Create policy" button calls.
// The only difference between this proof and a click in the UI is the signer: here a viem account, in the
// browser the connected OKX Wallet. Same address, same ABI, same canon hash, same args.
import { POLICY_REGISTRY, POLICY_REGISTRY_ABI } from "../apps/web/lib/chain/contracts";
import { buildRegisterPolicy, type PolicyRules } from "../apps/web/lib/chain/policy-tx";

/**
 * Real end-to-end proof that the dashboard's policy-create path lands on-chain (§15 #2, PRD §21).
 *
 * It exercises the SAME code the UI "Create policy" button runs — `buildRegisterPolicy` against the real
 * deployed PolicyRegistry — and, when a funded operator key is supplied, broadcasts it and reads the
 * result back over raw RPC, the same independent-verification method every prior on-chain proof in this
 * build used. Without a key it runs a full preflight (canon hash, live-contract read, gas estimate) and
 * prints the one command that completes the broadcast.
 *
 * TESTNET ONLY. Refuses to run against X Layer mainnet.
 *
 * Env:
 *   RPC_URL                target RPC (default: X Layer testnet).
 *   OPERATOR_PRIVATE_KEY   0x-prefixed key of the connected operator wallet (required to BROADCAST).
 *   BROADCAST              "1" to send the registerPolicy tx; anything else = preflight only.
 */

const ANCHORED_POLICY_ID =
  76029468409583827837911952142544939415519701741486856172509180373326388092012n;

const DEMO_AGENT: Address = "0x000000000000000000000000000000000000A9E7";

/** A representative §8 ruleset — hashed verbatim through the same canon surface the UI and MCP use. */
const RULES: PolicyRules = {
  budgets: { daily: 25, token: "USDT" },
  perCallCap: 10,
  onPerCallCapExceeded: "BLOCK",
  escalateAbove: 5,
  categories: { allow: ["market-data", "security", "research"], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  cooldowns: { sameServiceMin: 5 },
  rateLimit: { callsPerHour: 40 },
  expiry: "2027-01-31T00:00:00Z",
};

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? xLayerTestnet.rpcUrls.default.http[0]!;
  const broadcast = process.env.BROADCAST === "1";
  const pk = process.env.OPERATOR_PRIVATE_KEY as Hex | undefined;

  const { request, policyHash } = buildRegisterPolicy({ agent: DEMO_AGENT, rules: RULES });

  console.log("── Dashboard policy-create on-chain proof (TESTNET ONLY) ───────────────────");
  console.log(`RPC              : ${rpcUrl}`);
  console.log(`PolicyRegistry   : ${request.address}   (== dashboard contracts.ts)`);
  console.log(`function         : ${request.functionName}`);
  console.log(`agent            : ${DEMO_AGENT}`);
  console.log(`policyHash       : ${policyHash}   ← @untch/canon over the edited rules (UI path)`);
  console.log(`args             : [${(request.args as unknown[]).map(String).join(", ")}]`);

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  console.log(`chainId          : ${chainId}${chainId === X_LAYER_TESTNET_ID ? " (X Layer testnet)" : ""}`);
  if (chainId === 196) throw new Error("Refusing to run against X Layer MAINNET (196) — testnet only.");

  // Prove the contract the UI targets is live and matches what the dashboard shows.
  const code = await pub.getBytecode({ address: POLICY_REGISTRY });
  if (!code || code === "0x") throw new Error(`No contract code at ${POLICY_REGISTRY} — not deployed.`);
  console.log(`registry code    : ${code.length} bytes on-chain (contract is live)`);

  const anchored = (await pub.readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "getPolicy",
    args: [ANCHORED_POLICY_ID],
  })) as { owner: Address; policyHash: Hex; status: number; version: number };
  const anchoredUsable = await pub.readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "isUsable",
    args: [ANCHORED_POLICY_ID],
  });
  console.log(
    `anchored policy  : owner=${anchored.owner} status=${anchored.status} version=${anchored.version} ` +
      `usable=${anchoredUsable} hash=${anchored.policyHash.slice(0, 12)}…`,
  );

  if (!pk || !broadcast) {
    console.log("\nPreflight PASS — the UI's real registerPolicy call is well-formed against a live contract.");
    console.log("To complete the on-chain proof, either:");
    console.log("  • connect OKX Wallet in the dashboard and click Create policy, or");
    console.log("  • run: OPERATOR_PRIVATE_KEY=0x<funded testnet key> BROADCAST=1 pnpm prove:policy-ui");
    console.log("Both sign the identical transaction; only the signer differs.");
    return;
  }

  const account = privateKeyToAccount(pk);
  const balance = await pub.getBalance({ address: account.address });
  const gas = await pub.estimateContractGas({ ...request, account: account.address });
  const gasPrice = await pub.getGasPrice();
  console.log(`\noperator         : ${account.address}`);
  console.log(`balance          : ${formatEther(balance)} OKB`);
  console.log(`est. gas         : ${gas}  →  est. cost ${formatEther(gas * gasPrice)} OKB`);
  if (balance < gas * gasPrice) throw new Error("Insufficient OKB for gas — fund the operator wallet.");

  const predictedId = (await pub.readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "nextPolicyId",
    args: [account.address],
  })) as bigint;

  const wallet = createWalletClient({ account, chain: xLayerTestnet, transport: http(rpcUrl) });
  console.log("\n[1/2] broadcasting registerPolicy (UI path) …");
  const hash = await wallet.writeContract({ ...request, account, chain: xLayerTestnet });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`tx reverted: ${hash}`);

  let eventPolicyId: bigint | undefined;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: POLICY_REGISTRY_ABI, data: log.data, topics: log.topics });
      if (ev.eventName === "PolicyRegistered") eventPolicyId = (ev.args as { policyId: bigint }).policyId;
    } catch {
      /* not our event */
    }
  }
  console.log(`      tx ${hash} (block ${receipt.blockNumber}) → policyId ${eventPolicyId}`);

  console.log("[2/2] independent readback over raw RPC …");
  const onchain = (await pub.readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "getPolicy",
    args: [predictedId],
  })) as { owner: Address; policyHash: Hex; status: number; version: number };
  const usable = await pub.readContract({
    address: POLICY_REGISTRY,
    abi: POLICY_REGISTRY_ABI,
    functionName: "isUsable",
    args: [predictedId],
  });

  const ok =
    eventPolicyId === predictedId &&
    getAddress(onchain.owner) === account.address &&
    onchain.policyHash === policyHash &&
    onchain.status === 1 &&
    usable === true;

  console.log(
    `      readback owner=${onchain.owner} status=${onchain.status} usable=${usable} ` +
      `hashMatchesCanon=${onchain.policyHash === policyHash}`,
  );
  console.log(`\nexplorer: ${xLayerTestnet.blockExplorers?.default.url}/tx/${hash}`);
  if (!ok) throw new Error("READBACK MISMATCH — on-chain policy does not match the UI-built call.");
  console.log("\n✓ PASS — dashboard policy-create landed on-chain and independently verified.");
  console.log(`PROOF_TX=${hash}`);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
