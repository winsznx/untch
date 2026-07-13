import { createPublicClient, defineChain, getAddress, http, isAddress, zeroAddress, type Abi, type Address } from "viem";
import { eq, pairwiseDistinct, readRoleAddresses } from "./role-lib";

/**
 * §28 post-deploy assertion — reads each deployed contract's ACTUAL on-chain roles and confirms they
 * match the intended five addresses exactly. An automated gate, not an eyeball check. Also re-runs the
 * pairwise distinctness gate and the anti-incident cross-check that the DEPLOYER holds no live role
 * (the exact concentration — deployer==owner==admin — that made the key loss maximal).
 *
 * READ-ONLY. Public addresses + `eth_call` only — no private key, and it performs NO deployment. Run
 * after the human has deployed and set roles:
 *
 *   RPC_URL=… DEPLOYER_ADDRESS=0x… OWNER_ADDRESS=0x… ADMIN_ADDRESS=0x… WRITER_ADDRESS=0x… ORACLE_ADDRESS=0x… \
 *   VAULT_ADDRESS=0x… RECEIPTS_ADDRESS=0x… SPEND_INTENT_REGISTRY_ADDRESS=0x… \
 *     pnpm verify:deployment-roles
 *
 * Each contract address is optional; a contract is checked only if its address is supplied. Exit 0 iff
 * every provided contract's on-chain roles match intent (and distinctness holds); exit 1 (loud) else.
 */

const RPC = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";

const VAULT_ABI: Abi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "pendingOwner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "oracle", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const AW_ABI: Abi = [
  { type: "function", name: "admin", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isWriter", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
];

interface Assertion {
  readonly contract: string;
  readonly check: string;
  readonly expected: string;
  readonly actual: string;
  readonly ok: boolean;
}

function envAddr(name: string): Address | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  if (!isAddress(raw)) throw new Error(`${name} is not a valid EVM address: "${raw}"`);
  return getAddress(raw);
}

async function main(): Promise<void> {
  const { addresses, missing, malformed } = readRoleAddresses(process.env);
  if (missing.length || malformed.length) {
    console.error("✗ FAIL — intended role addresses incomplete/invalid:");
    if (missing.length) console.error(`   missing: ${missing.join(", ")}`);
    for (const m of malformed) console.error(`   malformed ${m.role}: "${m.value}"`);
    process.exit(1);
  }
  const { deployer, owner, admin, writer, oracle } = addresses;

  // Precondition: the five intended addresses must themselves be pairwise distinct.
  const collisions = pairwiseDistinct(addresses).filter((c) => !c.distinct);
  if (collisions.length) {
    console.error("✗ FAIL — intended addresses are not pairwise distinct (run verify:role-separation):");
    for (const c of collisions) console.error(`   • ${c.a} == ${c.b} (${c.addrA})`);
    process.exit(1);
  }

  const chainId = await createPublicClient({ transport: http(RPC) }).getChainId();
  const chain = defineChain({ id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
  const pub = createPublicClient({ chain, transport: http(RPC) });

  const vault = envAddr("VAULT_ADDRESS");
  const receipts = envAddr("RECEIPTS_ADDRESS");
  const registry = envAddr("SPEND_INTENT_REGISTRY_ADDRESS");
  if (!vault && !receipts && !registry) {
    console.error("✗ FAIL — supply at least one of VAULT_ADDRESS / RECEIPTS_ADDRESS / SPEND_INTENT_REGISTRY_ADDRESS.");
    process.exit(1);
  }

  const results: Assertion[] = [];
  const readAddr = (address: Address, abi: Abi, fn: string, args: unknown[] = []) =>
    pub.readContract({ address, abi, functionName: fn, args }) as Promise<Address>;
  const readBool = (address: Address, abi: Abi, fn: string, args: unknown[]) =>
    pub.readContract({ address, abi, functionName: fn, args }) as Promise<boolean>;

  const push = (contract: string, check: string, expected: string, actual: string, ok: boolean) =>
    results.push({ contract, check, expected, actual, ok });

  console.log(`── §28 deployment-role assertion  (chainId ${chainId}, ${RPC}) ──`);

  if (vault) {
    const bytecode = await pub.getBytecode({ address: vault });
    if (!bytecode || bytecode === "0x") throw new Error(`no contract code at VAULT_ADDRESS ${vault}`);
    const [onOwner, onPending, onOracle] = await Promise.all([
      readAddr(vault, VAULT_ABI, "owner"),
      readAddr(vault, VAULT_ABI, "pendingOwner"),
      readAddr(vault, VAULT_ABI, "oracle"),
    ]);
    push("UntchVault", "owner()", owner, onOwner, eq(onOwner, owner));
    push("UntchVault", "oracle()", oracle, onOracle, eq(onOracle, oracle));
    push("UntchVault", "pendingOwner()==0 (no dangling transfer)", zeroAddress, onPending, onPending.toLowerCase() === zeroAddress);
    push("UntchVault", "deployer holds NO owner role", `≠ ${deployer}`, onOwner, !eq(onOwner, deployer));
    push("UntchVault", "deployer holds NO oracle role", `≠ ${deployer}`, onOracle, !eq(onOracle, deployer));
  }

  for (const [name, addr] of [["UntchReceipts", receipts], ["SpendIntentRegistry", registry]] as const) {
    if (!addr) continue;
    const bytecode = await pub.getBytecode({ address: addr });
    if (!bytecode || bytecode === "0x") throw new Error(`no contract code at ${name} ${addr}`);
    const onAdmin = await readAddr(addr, AW_ABI, "admin");
    const writerIsWriter = await readBool(addr, AW_ABI, "isWriter", [writer]);
    const deployerIsWriter = await readBool(addr, AW_ABI, "isWriter", [deployer]);
    push(name, "admin()", admin, onAdmin, eq(onAdmin, admin));
    push(name, "isWriter(intended writer)==true", "true", String(writerIsWriter), writerIsWriter === true);
    push(name, "admin() is NOT the deployer", `≠ ${deployer}`, onAdmin, !eq(onAdmin, deployer));
    push(name, "deployer is NOT a writer", "false", String(deployerIsWriter), deployerIsWriter === false);
  }

  const width = Math.max(...results.map((r) => r.check.length));
  for (const r of results) {
    console.log(`  ${r.ok ? "✓" : "✗"} ${r.contract.padEnd(20)} ${r.check.padEnd(width)}  expected ${r.expected}${r.ok ? "" : `  ACTUAL ${r.actual}`}`);
  }

  const failed = results.filter((r) => !r.ok);
  if (failed.length) {
    console.error(`\n✗ FAIL — ${failed.length}/${results.length} on-chain role assertion(s) do not match intent. Do NOT treat this deployment as correctly keyed.`);
    process.exit(1);
  }
  console.log(`\n✓ PASS — all ${results.length} on-chain role assertions match the intended addresses exactly.`);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
