import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Abi,
  type Address,
  type Chain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pairwiseDistinct, type Role } from "./soak/role-lib";
import { settlementToken, X_LAYER_MAINNET_ID } from "../packages/shared/src/chains";

/**
 * Deploy the four base Untch contracts to X Layer MAINNET, in dependency order:
 *
 *   1. PolicyRegistry        (§10.1) — no constructor args, no admin, no writer: permissionless.
 *   2. SpendIntentRegistry   (§10.2) — no constructor args; deployer = admin; IMMEDIATE admin.
 *   3. UntchReceipts         (§10.3) — constructor(uint64 delay); deployer = admin; TIMELOCKED admin.
 *   4. UntchVaultFactory     (§10.4) — constructor(address intentRegistry) ← needs (2)'s real address.
 *
 * No UntchVault instances are deployed here. Vaults are deployed later, per-operator, through the
 * Factory's `deployVault(owner, agent, oracle, perTxCap, epochBudget, epochLenSecs, tokenAllow[],
 * requireAnchoredIntent)` — which is where OWNER_ADDRESS, ORACLE_ADDRESS, the USDT0 allowlist and
 * requireAnchoredIntent=true are actually supplied. None of the four contracts above takes them.
 *
 * TWO PHASES, because UntchReceipts' admin sits behind an immutable timelock and there is NO
 * initial-writer constructor arg (AuthorizedWriters: "the writer set is always established through
 * the audited add-writer path"). A writer can only be added via propose → wait `delay` → execute.
 * At a 72h delay that is a 72-hour gap, so it cannot live inside one process:
 *
 *   PHASE=1  deploy all four · registry addWriter+transferAdmin · receipts propose ADD_WRITER +
 *            propose TRANSFER_ADMIN. Deployer REMAINS receipts-admin (it must, to execute later).
 *            Writes a run artifact with the addresses and the earliest execute time (eta).
 *   PHASE=2  at/after eta: receipts execute ADD_WRITER, then execute TRANSFER_ADMIN (admin LAST —
 *            executing TRANSFER_ADMIN first would hand admin away mid-sequence). Deployer ends with
 *            NO live role on any contract.
 *
 * Roles are set to the real intended addresses directly wherever a contract supports it; the deployer
 * never holds a role it keeps. The one unavoidable exception is UntchReceipts' admin, which the base
 * constructor hardcodes to `msg.sender` — it is transferred away in PHASE 2 as the final act.
 *
 * Env:
 *   DEPLOYER_PRIVATE_KEY  signs (required to BROADCAST). Supplied by the operator at runtime only.
 *   OWNER_ADDRESS / ORACLE_ADDRESS / ADMIN_ADDRESS / WRITER_ADDRESS   the four role PUBLIC addresses.
 *                         ADMIN + WRITER are used by this deployment; OWNER + ORACLE are validated
 *                         for distinctness and recorded for the later per-vault step, not set here.
 *   RPC_URL               default X Layer mainnet.
 *   TIMELOCK_DELAY        UntchReceipts delay in seconds (default 259200 = 72h). IMMUTABLE once set.
 *   PHASE                 "1" (default) | "2".
 *   BROADCAST=1           actually send txs (else preflight: validate + distinctness + funding only).
 *   ALLOW_MAINNET=1       required to target chainId 196.
 *   RUN_FILE              phase artifact path (default deployments/mainnet-suite.json).
 */

const ART = (p: string) => fileURLToPath(new URL(`../contracts/out/${p}`, import.meta.url));
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const load = (p: string): Artifact => JSON.parse(readFileSync(ART(p), "utf8")) as Artifact;

const OP = { ADD_WRITER: 1, TRANSFER_ADMIN: 3 } as const;
const DEFAULT_TIMELOCK = 259_200n; // 72 hours

/** Measured on an anvil fork of real X Layer mainnet (chainId 196), 2026-07-14. */
const MEASURED_GAS = {
  PolicyRegistry: 556_622n,
  SpendIntentRegistry: 612_817n,
  UntchReceipts: 655_920n,
  UntchVaultFactory: 1_617_020n,
  phase1Writes: 174_569n, // addWriter + transferAdmin + 2× propose
  phase2Writes: 82_479n, // 2× execute
} as const;
const TOTAL_GAS =
  MEASURED_GAS.PolicyRegistry +
  MEASURED_GAS.SpendIntentRegistry +
  MEASURED_GAS.UntchReceipts +
  MEASURED_GAS.UntchVaultFactory +
  MEASURED_GAS.phase1Writes +
  MEASURED_GAS.phase2Writes;

interface RunArtifact {
  chainId: number;
  phase1CompletedAt: string;
  deployer: Address;
  roles: { owner: Address; oracle: Address; admin: Address; writer: Address };
  policyRegistry: Address;
  spendIntentRegistry: Address;
  receipts: Address;
  vaultFactory: Address;
  timelockDelay: string;
  receiptsEta: string;
  settlementTokenForLaterVaults: { symbol: string; address: Address; decimals: number };
}

function role(name: string): Address {
  const raw = process.env[name]?.trim();
  if (!raw || !isAddress(raw)) throw new Error(`${name} missing or not a valid address`);
  return getAddress(raw);
}

const runFilePath = () =>
  process.env.RUN_FILE?.trim() ?? fileURLToPath(new URL("../deployments/mainnet-suite.json", import.meta.url));

/** Readbacks return uint64/uint256 as bigint, which JSON.stringify throws on. */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "https://rpc.xlayer.tech";
  const broadcast = process.env.BROADCAST === "1";
  const phase = process.env.PHASE ?? "1";
  if (phase !== "1" && phase !== "2") throw new Error(`PHASE must be "1" or "2" (got "${phase}")`);
  const timelock = BigInt(process.env.TIMELOCK_DELAY ?? DEFAULT_TIMELOCK.toString());
  if (timelock === 0n) throw new Error("TIMELOCK_DELAY=0 is rejected by the contract (ZeroDelay).");

  const owner = role("OWNER_ADDRESS");
  const oracle = role("ORACLE_ADDRESS");
  const admin = role("ADMIN_ADDRESS");
  const writer = role("WRITER_ADDRESS");

  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  if (chainId === X_LAYER_MAINNET_ID && process.env.ALLOW_MAINNET !== "1") {
    throw new Error("Refusing X Layer MAINNET (196) without ALLOW_MAINNET=1.");
  }
  const chain: Chain = defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });

  // The settlement token is NOT a constructor arg of any contract deployed here — it is a per-vault
  // `tokenAllow` entry supplied later at deployVault. Resolved and existence-checked now so the
  // address carried into that step is the real, live one rather than a copy-paste.
  const token = settlementToken(chainId);
  const tokenCode = await pub.getCode({ address: token.address });
  if (!tokenCode || tokenCode === "0x") {
    throw new Error(`Settlement token ${token.symbol} ${token.address} has NO code on chainId ${chainId}.`);
  }

  const pk = process.env.DEPLOYER_PRIVATE_KEY as Hex | undefined;
  const gasPrice = await pub.getGasPrice();

  if (!pk) {
    console.log(`── mainnet suite — PREFLIGHT (no DEPLOYER_PRIVATE_KEY) · PHASE ${phase} ──`);
    console.log(`chainId ${chainId} · timelock ${timelock}s (${Number(timelock) / 3600}h)`);
    console.log(`admin  ${admin}   (receives SpendIntentRegistry + UntchReceipts admin)`);
    console.log(`writer ${writer}   (authorized on both registries)`);
    console.log(`owner  ${owner}   (per-vault arg — NOT set by this deployment)`);
    console.log(`oracle ${oracle}   (per-vault arg — NOT set by this deployment)`);
    console.log(`token  ${token.symbol} ${token.address} (${token.decimals} dp) — live, referenced for later vaults`);
    console.log(`\ngas: ${TOTAL_GAS} total @ ${formatUnits(gasPrice, 9)} gwei = ${formatUnits(TOTAL_GAS * gasPrice, 18)} OKB`);
    console.log("Set DEPLOYER_PRIVATE_KEY + BROADCAST=1 to deploy.");
    return;
  }
  const deployer = privateKeyToAccount(pk).address;

  // Role separation across ALL FIVE must hold before anything is sent.
  const five: Record<Role, Address> = { deployer, owner, admin, writer, oracle };
  const collisions = pairwiseDistinct(five).filter((c) => !c.distinct);
  if (collisions.length) {
    for (const c of collisions) console.error(`✗ ${c.a} == ${c.b} (${c.addrA})`);
    throw new Error("role collision — refusing to deploy (run pnpm verify:role-separation).");
  }

  const balance = await pub.getBalance({ address: deployer });
  console.log(`── mainnet suite · PHASE ${phase} ──`);
  console.log(`chainId ${chainId} · rpc ${rpcUrl} · gasPrice ${formatUnits(gasPrice, 9)} gwei`);
  console.log(`deployer ${deployer} · balance ${formatUnits(balance, 18)} OKB`);

  if (!broadcast) {
    console.log("\nPreflight OK (BROADCAST!=1) — distinctness holds, token live. Not sending.");
    return;
  }
  if (balance === 0n) throw new Error("deployer has 0 OKB — fund it for gas.");

  const wallet = createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(rpcUrl) });
  const send = async (call: Parameters<typeof wallet.writeContract>[0]): Promise<Hex> => {
    const h = await wallet.writeContract(call);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`tx reverted ${h}`);
    return h;
  };
  const deploy = async (art: Artifact, args: unknown[]): Promise<Address> => {
    const h = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (!r.contractAddress) throw new Error("deploy produced no address");
    return r.contractAddress;
  };
  const read = (a: Address, abi: Abi, fn: string, args: unknown[] = []) =>
    pub.readContract({ address: a, abi, functionName: fn, args });
  const eq = (a: unknown, b: string) => String(a).toLowerCase() === b.toLowerCase();

  const polArt = load("PolicyRegistry.sol/PolicyRegistry.json");
  const regArt = load("SpendIntentRegistry.sol/SpendIntentRegistry.json");
  const recArt = load("UntchReceipts.sol/UntchReceipts.json");
  const facArt = load("UntchVaultFactory.sol/UntchVaultFactory.json");

  if (phase === "1") {
    console.log(`\n[1/3] deploying four contracts in dependency order (timelock ${timelock}s) …`);
    const policyRegistry = await deploy(polArt, []);
    console.log(`  PolicyRegistry      ${policyRegistry}  (permissionless — no roles to set)`);
    const spendIntentRegistry = await deploy(regArt, []);
    console.log(`  SpendIntentRegistry ${spendIntentRegistry}  (deployer = admin, transferred below)`);
    const receipts = await deploy(recArt, [timelock]);
    console.log(`  UntchReceipts       ${receipts}  (deployer = admin, timelocked)`);
    const vaultFactory = await deploy(facArt, [spendIntentRegistry]);
    console.log(`  UntchVaultFactory   ${vaultFactory}  (intentRegistry=${spendIntentRegistry})`);

    console.log("\n[2/3] SpendIntentRegistry (immediate admin): addWriter(writer) → transferAdmin(admin) …");
    await send({ address: spendIntentRegistry, abi: regArt.abi, functionName: "addWriter", args: [writer] });
    await send({ address: spendIntentRegistry, abi: regArt.abi, functionName: "transferAdmin", args: [admin] });

    console.log("[3/3] UntchReceipts (timelocked admin): propose ADD_WRITER + TRANSFER_ADMIN …");
    await send({ address: receipts, abi: recArt.abi, functionName: "propose", args: [OP.ADD_WRITER, writer] });
    await send({ address: receipts, abi: recArt.abi, functionName: "propose", args: [OP.TRANSFER_ADMIN, admin] });

    const addWriterOpId = (await read(receipts, recArt.abi, "opId", [OP.ADD_WRITER, writer])) as Hex;
    const eta = (await read(receipts, recArt.abi, "opEta", [addWriterOpId])) as bigint;

    const factoryRegistry = await read(vaultFactory, facArt.abi, "intentRegistry");
    const state = {
      registryAdmin: await read(spendIntentRegistry, regArt.abi, "admin"),
      registryWriter: await read(spendIntentRegistry, regArt.abi, "isWriter", [writer]),
      receiptsAdmin: await read(receipts, recArt.abi, "admin"),
      receiptsWriter: await read(receipts, recArt.abi, "isWriter", [writer]),
      receiptsDelay: await read(receipts, recArt.abi, "timelockDelay"),
      factoryIntentRegistry: factoryRegistry,
    };
    const ok =
      eq(state.registryAdmin, admin) &&
      state.registryWriter === true &&
      eq(state.receiptsAdmin, deployer) && // still deployer BY DESIGN — needed to execute in phase 2
      state.receiptsWriter === false && // not yet — the timelock has not elapsed
      state.receiptsDelay === timelock &&
      eq(factoryRegistry, spendIntentRegistry);

    const artifact: RunArtifact = {
      chainId,
      phase1CompletedAt: new Date().toISOString(),
      deployer,
      roles: { owner, oracle, admin, writer },
      policyRegistry,
      spendIntentRegistry,
      receipts,
      vaultFactory,
      timelockDelay: timelock.toString(),
      receiptsEta: eta.toString(),
      settlementTokenForLaterVaults: { symbol: token.symbol, address: token.address, decimals: token.decimals },
    };
    writeFileSync(runFilePath(), json(artifact));

    console.log(`\n${json({ ...artifact, readback: state, ok })}`);
    if (!ok) throw new Error("READBACK MISMATCH — phase 1 state not as intended.");
    console.log(`\n✓ Phase 1 complete. Artifact → ${runFilePath()}`);
    console.log(`  PolicyRegistry / SpendIntentRegistry / UntchVaultFactory are LIVE NOW.`);
    console.log(`  UntchReceipts CANNOT accept writes until eta ${eta} (${new Date(Number(eta) * 1000).toISOString()}).`);
    console.log(`  Deployer still holds UntchReceipts admin — that is required for phase 2, by design.`);
    console.log(`\n  At/after that time, run PHASE=2 with the SAME deployer key.`);
    return;
  }

  // ── PHASE 2 ──
  const artifact = JSON.parse(readFileSync(runFilePath(), "utf8")) as RunArtifact;
  if (artifact.chainId !== chainId) throw new Error(`artifact chainId ${artifact.chainId} != connected ${chainId}`);
  if (!eq(artifact.deployer, deployer)) {
    throw new Error(`artifact deployer ${artifact.deployer} != this key's ${deployer} — phase 2 needs the phase-1 key.`);
  }
  const receipts = artifact.receipts;

  const currentAdmin = await read(receipts, recArt.abi, "admin");
  if (!eq(currentAdmin, deployer)) {
    throw new Error(`UntchReceipts admin is ${String(currentAdmin)}, not the deployer — phase 2 already ran?`);
  }

  const block = await pub.getBlock();
  const eta = BigInt(artifact.receiptsEta);
  if (block.timestamp < eta) {
    const left = Number(eta - block.timestamp);
    throw new Error(
      `Timelock not elapsed: eta ${eta}, chain now ${block.timestamp} — ${Math.ceil(left / 60)} min left ` +
        `(${new Date(Number(eta) * 1000).toISOString()}). The contract would revert TimelockNotElapsed.`,
    );
  }

  console.log(`\n[1/2] receipts: execute ADD_WRITER(${artifact.roles.writer}) …`);
  await send({ address: receipts, abi: recArt.abi, functionName: "execute", args: [OP.ADD_WRITER, artifact.roles.writer] });
  console.log(`[2/2] receipts: execute TRANSFER_ADMIN(${artifact.roles.admin}) — admin LAST …`);
  await send({ address: receipts, abi: recArt.abi, functionName: "execute", args: [OP.TRANSFER_ADMIN, artifact.roles.admin] });

  const state = {
    receiptsAdmin: await read(receipts, recArt.abi, "admin"),
    receiptsWriter: await read(receipts, recArt.abi, "isWriter", [artifact.roles.writer]),
    receiptsDeployerIsWriter: await read(receipts, recArt.abi, "isWriter", [deployer]),
    registryAdmin: await read(artifact.spendIntentRegistry, regArt.abi, "admin"),
    registryWriter: await read(artifact.spendIntentRegistry, regArt.abi, "isWriter", [artifact.roles.writer]),
  };
  const ok =
    eq(state.receiptsAdmin, artifact.roles.admin) &&
    state.receiptsWriter === true &&
    state.receiptsDeployerIsWriter === false &&
    eq(state.registryAdmin, artifact.roles.admin) &&
    state.registryWriter === true;

  console.log(`\n${json({ ...artifact, readback: state, ok })}`);
  console.log("\nverify independently:");
  console.log(`  RPC_URL=${rpcUrl} RECEIPTS_ADDRESS=${receipts} SPEND_INTENT_REGISTRY_ADDRESS=${artifact.spendIntentRegistry} \\`);
  console.log(`  DEPLOYER_ADDRESS=${deployer} OWNER_ADDRESS=${artifact.roles.owner} ADMIN_ADDRESS=${artifact.roles.admin} \\`);
  console.log(`  WRITER_ADDRESS=${artifact.roles.writer} ORACLE_ADDRESS=${artifact.roles.oracle} pnpm verify:deployment-roles`);
  if (!ok) throw new Error("READBACK MISMATCH — roles not set as intended.");
  console.log("\n✓ Phase 2 complete. Writer live on both registries; admin held by ADMIN_ADDRESS; deployer holds NO role.");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
