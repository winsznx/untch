import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  InMemoryPolicyRepo,
  POLICY_REGISTRY_ABI,
  POLICY_REGISTRY_DEFAULT,
  PolicyRegistrationService,
  ViemRegistryReader,
  X_LAYER_TESTNET_ID,
  xLayerTestnet,
} from "@untch/policy-store";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * MULTI-TENANCY END-TO-END PROOF (Part 1) — two DIFFERENT real wallets each create a real policy through
 * the CHANGED `create_spend_policy` flow, and each ends up as the genuine, DISTINCT on-chain owner.
 *
 * The flow exercised is the real one:
 *   1. `PolicyRegistrationService.buildCreate` returns UNSIGNED registerPolicy calldata (the backend never
 *      signs — it holds a key-free reader).
 *   2. each caller's OWN wallet signs + submits that calldata (viem `sendTransaction` on the built bytes).
 *   3. `syncRegistration` records the row with `owner` read from the confirmed `PolicyRegistered` event.
 *   4. an INDEPENDENT raw-RPC `getPolicy(policyId).owner` readback (a separate client) confirms each owner
 *      on-chain — the service's own report is never taken on faith.
 *
 * The two callers register the SAME ruleset on purpose: same input, different submitter ⇒ different owner
 * is the cleanest possible demonstration that ownership follows the signer, not the backend.
 *
 * Env:
 *   CALLER_A_PRIVATE_KEY   funded testnet key for caller A (default: BUYER_PRIVATE_KEY).
 *   CALLER_B_PRIVATE_KEY   funded testnet key for caller B (default: a fresh key, funded from A).
 *   RPC_URL / POLICY_REGISTRY  overridable. TESTNET ONLY — refuses X Layer mainnet (196).
 */

const here = dirname(fileURLToPath(import.meta.url));
const RECEIPT_PATH = resolve(here, "..", "..", "..", "contracts", "deploy", "multi-tenant-policy-testnet-receipt.json");
const DEMO_AGENT: Address = getAddress("0x000000000000000000000000000000000000A9E7");
const FUND_B_WEI = 30_000_000_000_000_000n; // 0.03 OKB — gas for one registerPolicy + margin

/** Same ruleset for both callers — same input, different owner is the whole point. */
function rules(): Record<string, unknown> {
  return {
    budgets: { daily: 25, token: "USDT" },
    perCallCap: 10,
    onPerCallCapExceeded: "BLOCK",
    escalateAbove: 5,
    categories: { allow: ["market-data"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2027-01-31T00:00:00Z",
  };
}

function save(data: unknown): string {
  mkdirSync(dirname(RECEIPT_PATH), { recursive: true });
  writeFileSync(RECEIPT_PATH, JSON.stringify(data, null, 2) + "\n");
  return RECEIPT_PATH;
}

function fail(msg: string): never {
  console.error(`\nRESULT: FAIL — ${msg}`);
  process.exit(1);
}

function loadKey(name: string): Hex | null {
  const v = process.env[name]?.trim();
  return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL?.trim() || xLayerTestnet.rpcUrls.default.http[0]!;
  const registry = (process.env.POLICY_REGISTRY?.trim() || POLICY_REGISTRY_DEFAULT) as Address;

  const pub = createPublicClient({ chain: xLayerTestnet, transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId === 196) fail("refusing to run against X Layer MAINNET (196) — testnet only");
  if (chainId !== X_LAYER_TESTNET_ID) console.warn(`[multi-tenant] warning: unexpected chainId ${chainId}`);

  const code = await pub.getBytecode({ address: registry });
  if (!code || code === "0x") fail(`no contract code at ${registry} — PolicyRegistry not deployed`);

  const keyA = loadKey("CALLER_A_PRIVATE_KEY") ?? loadKey("BUYER_PRIVATE_KEY");
  if (!keyA) fail("CALLER_A_PRIVATE_KEY (or BUYER_PRIVATE_KEY) must be a funded testnet key");
  const accountA = privateKeyToAccount(keyA);

  let keyB = loadKey("CALLER_B_PRIVATE_KEY");
  const generatedB = !keyB;
  if (!keyB) keyB = generatePrivateKey();
  const accountB = privateKeyToAccount(keyB);

  if (getAddress(accountA.address) === getAddress(accountB.address)) {
    fail("caller A and caller B are the same wallet — the proof needs two DISTINCT wallets");
  }

  // The KEY-FREE backend surface: builds unsigned calldata + syncs from the confirmed event. It never signs.
  const reader = new ViemRegistryReader({ chain: xLayerTestnet, rpcUrl, registry });
  const regService = new PolicyRegistrationService(new InMemoryPolicyRepo(), reader);

  console.log("── MULTI-TENANCY create_spend_policy PROOF (TESTNET) ───────────────────────");
  console.log(`PolicyRegistry : ${registry} (chainId ${chainId})`);
  console.log(`caller A       : ${accountA.address}`);
  console.log(`caller B       : ${accountB.address}${generatedB ? " (freshly generated)" : ""}`);

  const balA = await pub.getBalance({ address: accountA.address });
  console.log(`caller A OKB   : ${formatEther(balA)}`);
  if (balA < FUND_B_WEI * 2n) {
    fail(`caller A is underfunded (${formatEther(balA)} OKB) — fund it on X Layer testnet, or set two funded keys`);
  }

  const walletA = createWalletClient({ account: accountA, chain: xLayerTestnet, transport: http(rpcUrl) });
  const walletB = createWalletClient({ account: accountB, chain: xLayerTestnet, transport: http(rpcUrl) });

  // Fund caller B for gas if it can't pay for its own registerPolicy.
  let balB = await pub.getBalance({ address: accountB.address });
  if (balB < FUND_B_WEI) {
    console.log(`\n[fund] caller B has ${formatEther(balB)} OKB — sending ${formatEther(FUND_B_WEI)} OKB from A …`);
    const fundTx = await walletA.sendTransaction({ account: accountA, chain: xLayerTestnet, to: accountB.address, value: FUND_B_WEI });
    await pub.waitForTransactionReceipt({ hash: fundTx });
    balB = await pub.getBalance({ address: accountB.address });
    console.log(`[fund] caller B OKB now ${formatEther(balB)} (fund tx ${fundTx})`);
  }

  const created: Array<{
    caller: Address;
    policyId: string;
    policyHash: Hex;
    registerTx: Hex;
    syncedOwner: Address;
    rpcOwner: Address;
    ok: boolean;
  }> = [];

  for (const [label, account, wallet] of [
    ["A", accountA, walletA] as const,
    ["B", accountB, walletB] as const,
  ]) {
    const r = rules();
    // 1) backend BUILDS the unsigned call (no signing here).
    const built = regService.buildCreate({ agent: DEMO_AGENT, rules: r });
    console.log(`\n[${label}] built unsigned registerPolicy — policyHash ${built.policyHash}`);

    // 2) the caller's OWN wallet signs + submits the built calldata.
    const txHash = await wallet.sendTransaction({
      account,
      chain: xLayerTestnet,
      to: built.unsignedTx.to,
      data: built.unsignedTx.calldata,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash: txHash });
    if (rcpt.status !== "success") fail(`[${label}] registerPolicy reverted (tx ${txHash})`);
    console.log(`[${label}] submitted by ${account.address} — tx ${txHash} (block ${rcpt.blockNumber})`);

    // 3) backend SYNCS from the confirmed event (owner read from the chain, not assumed).
    const synced = await regService.syncRegistration({ txHash, rules: r });
    console.log(`[${label}] synced   policyId ${synced.policyId} owner ${synced.owner}`);

    // 4) INDEPENDENT raw-RPC readback via a SEPARATE client — never the service's own word.
    const verifyClient = createPublicClient({ chain: xLayerTestnet, transport: http(rpcUrl) });
    const onchain = (await verifyClient.readContract({
      address: registry,
      abi: POLICY_REGISTRY_ABI,
      functionName: "getPolicy",
      args: [BigInt(synced.policyId)],
    })) as { owner: Address };
    const rpcOwner = getAddress(onchain.owner);
    const ok =
      getAddress(synced.owner) === getAddress(account.address) &&
      rpcOwner === getAddress(account.address);
    console.log(`[${label}] raw-RPC  getPolicy(${synced.policyId}).owner = ${rpcOwner} — ownerMatchesSigner=${ok}`);

    created.push({
      caller: getAddress(account.address),
      policyId: synced.policyId,
      policyHash: synced.policyHash,
      registerTx: txHash,
      syncedOwner: getAddress(synced.owner),
      rpcOwner,
      ok,
    });
  }

  const [a, b] = created;
  const distinctOwners = a!.rpcOwner !== b!.rpcOwner;
  const distinctPolicies = a!.policyId !== b!.policyId;
  const pass = a!.ok && b!.ok && distinctOwners && distinctPolicies;

  const receipt = {
    proof: "multi-tenancy — create_spend_policy per-caller ownership (Part 1)",
    network: "X Layer testnet",
    chainId,
    policyRegistry: registry,
    callingConvention:
      "create_spend_policy returns UNSIGNED registerPolicy calldata; each caller's own wallet signs+submits; " +
      "syncRegistration records owner from the confirmed PolicyRegistered event. The backend never signs.",
    callers: created,
    distinctOwners,
    distinctPolicies,
    independentlyVerified: "each owner read via a separate raw-RPC getPolicy() client, not the service's report",
    pass,
    capturedAt: new Date().toISOString(),
  };
  const path = save(receipt);

  console.log("\n=== RECEIPT (JSON) ===");
  console.log(JSON.stringify(receipt, null, 2));
  console.log(`\nReceipt: ${path}`);

  if (!pass) {
    fail(
      `multi-tenancy proof incomplete (A.ok=${a!.ok} B.ok=${b!.ok} distinctOwners=${distinctOwners} distinctPolicies=${distinctPolicies})`,
    );
  }
  console.log("\nRESULT: PASS — two distinct real wallets each created a real policy and each is the genuine on-chain owner.");
  console.log(`caller A owner : ${a!.rpcOwner}  policyId ${a!.policyId}  tx ${a!.registerTx}`);
  console.log(`caller B owner : ${b!.rpcOwner}  policyId ${b!.policyId}  tx ${b!.registerTx}`);
}

main().catch((err) => fail(`unexpected error: ${(err as Error).message}`));
