import { createPublicClient, decodeEventLog, encodePacked, getAddress, http, keccak256, type Hex } from "viem";
import { POLICY_REGISTRY_ABI } from "../packages/policy-store/src/registry";

const RPC = "https://rpc.xlayer.tech";
const REGISTRY = getAddress("0xa2177E6D8682367637A3C2aF53E2cF8088EFA954");
const OWNER = getAddress("0x5a2C16C74e9E15cF74add824F2ef97D6B3FbaB64");
const AGENT = OWNER;
const POLICY_HASH = "0x8b634b5e16ee3632ef4ffce126bc8c2253c67efb7c7d167bbd1eb42e28c79f82".toLowerCase();
const EXPIRY = 1790726400n;
const TX = process.argv[2] as Hex;
/** Canonical ERC-4337 v0.7 EntryPoint, the same address on every chain that has one. */
const ENTRYPOINT_V07 = getAddress("0x0000000071727De22E5E9d8BAf0edAc6f37da032");

const chain = {
  id: 196,
  name: "X Layer Mainnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
} as const;

async function main(): Promise<void> {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const receipt = await pub.getTransactionReceipt({ hash: TX });
  const tx = await pub.getTransaction({ hash: TX });

  /**
   * The log that carries the event, and WHICH CONTRACT emitted it.
   *
   * `tx.to` is the wrong thing to check on this path. The OKX Agentic Wallet is an ERC-4337 smart
   * account, so a sponsored call goes to the EntryPoint and the EntryPoint invokes the registry. The
   * transaction's `to` is therefore the EntryPoint, and asserting it equals the registry would fail on
   * a transaction that is entirely correct.
   *
   * What actually proves the target is the emitter of `PolicyRegistered`: an event from the registry
   * address can only have been produced by the registry's own code. That is a stronger claim than
   * `tx.to` anyway, because `tx.to` says where a transaction was addressed and this says which
   * contract executed.
   */
  const registeredLog = receipt.logs.find((l) => getAddress(l.address) === REGISTRY);
  const registered = receipt.logs
    .filter((l) => getAddress(l.address) === REGISTRY)
    .map((l) => {
      try {
        return decodeEventLog({ abi: POLICY_REGISTRY_ABI, data: l.data, topics: l.topics });
      } catch {
        return null;
      }
    })
    .find((e) => e?.eventName === "PolicyRegistered");

  const args = (registered?.args ?? {}) as Record<string, unknown>;
  const policyId = args.policyId as bigint | undefined;

  /**
   * `previewPolicyId` is `public pure` on the contract but absent from the stored ABI, so the
   * fragment is supplied inline. It is also pure keccak over (owner, nonce), which means the
   * derivation can be checked TWICE: once by asking the chain and once by computing it here. Two
   * independent answers agreeing is a stronger check than either alone.
   */
  const PREVIEW_ABI = [
    {
      type: "function",
      name: "previewPolicyId",
      stateMutability: "pure",
      inputs: [
        { name: "owner", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
      outputs: [{ name: "", type: "uint256" }],
    },
  ] as const;

  const preview =
    policyId === undefined
      ? null
      : ((await pub.readContract({
          address: REGISTRY,
          abi: PREVIEW_ABI,
          functionName: "previewPolicyId",
          args: [OWNER, 0n],
        })) as bigint);

  // The same value, derived locally with no RPC involved.
  const localPreview = BigInt(keccak256(encodePacked(["address", "uint256"], [OWNER, 0n])));

  const onchain =
    policyId === undefined
      ? null
      : ((await pub.readContract({
          address: REGISTRY,
          abi: POLICY_REGISTRY_ABI,
          functionName: "getPolicy",
          args: [policyId],
        })) as Record<string, unknown>);

  const checks: [string, boolean, string][] = [
    ["1  transaction status is successful", receipt.status === "success", receipt.status],
    ["2  chain is 196", (await pub.getChainId()) === 196, "196"],
    [
      "3  PolicyRegistered was emitted BY the exact registry",
      registeredLog !== undefined && getAddress(registeredLog.address) === REGISTRY,
      registeredLog ? getAddress(registeredLog.address) : "no log from the registry",
    ],
    [
      "3b transaction routed via the EntryPoint or directly, and nothing else",
      getAddress(tx.to as string) === REGISTRY || getAddress(tx.to as string) === ENTRYPOINT_V07,
      `${tx.to}${getAddress(tx.to as string) === ENTRYPOINT_V07 ? " (ERC-4337 EntryPoint v0.7 — sponsored AA path)" : " (direct)"}`,
    ],
    ["4  PolicyRegistered was emitted", registered !== undefined, registered ? "yes" : "no"],
    ["5  owner is the agentic wallet", getAddress(String(args.owner)) === OWNER, String(args.owner)],
    ["6  governed agent is the same address", getAddress(String(args.agent)) === AGENT, String(args.agent)],
    ["7  policyHash matches exactly", String(args.policyHash).toLowerCase() === POLICY_HASH, String(args.policyHash)],
    ["8  expiry matches exactly", (args.expiry as bigint) === EXPIRY, String(args.expiry)],
    [
      "9  policyId equals previewPolicyId(owner, nonce 0)",
      policyId !== undefined && preview !== null && policyId === preview,
      `${policyId} vs chain ${preview} vs local ${localPreview}`,
    ],
    [
      "9b policyId also equals the locally derived keccak(owner,0)",
      policyId !== undefined && policyId === localPreview,
      String(localPreview),
    ],
    [
      "10 the policy is ACTIVE on chain",
      Number((onchain as { status?: number })?.status) === 1,
      `status=${(onchain as { status?: number })?.status}`,
    ],
  ];

  let allOk = true;
  for (const [label, ok, actual] of checks) {
    if (!ok) allOk = false;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(48)} ${actual}`);
  }
  console.log("");
  console.log(`txHash      ${TX}`);
  console.log(`block       ${receipt.blockNumber}`);
  console.log(`gasUsed     ${receipt.gasUsed}`);
  console.log(`tx.to       ${tx.to}`);
  console.log(`emitter     ${registeredLog ? getAddress(registeredLog.address) : "none"}`);
  console.log(`route       ${getAddress(tx.to as string) === ENTRYPOINT_V07 ? "ERC-4337 sponsored (smart account = the bound address)" : "direct EOA"}`);
  console.log(`policyId    ${policyId}`);
  console.log(`onchain     ${JSON.stringify(onchain, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`);
  console.log("");
  console.log(allOk ? "ALL TEN CONDITIONS VERIFIED" : "VERIFICATION FAILED - DO NOT SYNC");
  process.exit(allOk ? 0 : 1);
}

main().catch((err) => {
  console.error("verification failed:", (err as Error).message);
  process.exit(1);
});
