import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  formatUnits,
  getAddress,
  http,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Runs the two §28 drills (pause + oracle-rotation) LIVE on PUBLIC X Layer testnet 1952, against a
 * FRESHLY-DEPLOYED UntchVault whose owner is the receipt-writer wallet (0x03e5…1ab5) — a key this
 * session is authorized to hold.
 *
 * Why a fresh instance: the original demo vault (0x42e6…4848) is owned by 0x98F4…3c0b, whose key is
 * not available (the operator did not retain it), and its owner-only functions can never be reached
 * again. The drills prove the *contract's* behavior, not that one instance, so a new deployment of the
 * identical UntchVault bytecode — owned by a key we DO hold — demonstrates them on the public ledger
 * with real, explorer-verifiable hashes. The lost owner key is never touched.
 *
 * requireAnchoredIntent=false keeps the drill vault self-contained: a spend needs only a valid oracle
 * signature (the drills are about pause + oracle rotation, not the anchored-intent gate, which the
 * fork run already exercised against the real registry).
 */

const RPC = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = 1952;
const PAYEE: Address = getAddress("0x000000000000000000000000000000000000beef");
const DUMMY_INTENT: Hex = `0x${"0".repeat(64)}`;

const OLD_ORACLE_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"; // anvil #1
const NEW_ORACLE_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"; // anvil #2
const IMPOSTOR_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil #3

const DECIMALS = 6;
const PER_TX_CAP = parseUnits("100", DECIMALS);
const EPOCH_BUDGET = parseUnits("250", DECIMALS);
const EPOCH_LEN = 86_400n;
const DEPOSIT = parseUnits("10", DECIMALS);
const SPEND_AMT = parseUnits("0.1", DECIMALS);

const WRITER_ENV = fileURLToPath(new URL("../../packages/receipt-writer/.env", import.meta.url));
const OUT = fileURLToPath(new URL("../../internal/day0/soak-evidence/public-drills.json", import.meta.url));
const VAULT_ARTIFACT = fileURLToPath(new URL("../../contracts/out/UntchVault.sol/UntchVault.json", import.meta.url));
const TOKEN_ARTIFACT = fileURLToPath(new URL("../../contracts/out/VaultMocks.sol/MockERC20.json", import.meta.url));

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

const chain = defineChain({
  id: CHAIN_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

type Artifact = { abi: Abi; bytecode: { object: Hex } };
function load(path: string): Artifact {
  return JSON.parse(readFileSync(path, "utf8")) as Artifact;
}
function loadWriterKey(): Hex {
  const raw = readFileSync(WRITER_ENV, "utf8");
  const line = raw.split("\n").find((l) => l.trim().startsWith("WRITER_PRIVATE_KEY="));
  const key = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("WRITER_PRIVATE_KEY missing in packages/receipt-writer/.env");
  return key as Hex;
}
function revertOf(err: unknown): string {
  if (err instanceof BaseError) {
    const r = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (r instanceof ContractFunctionRevertedError) return r.data?.errorName ?? r.reason ?? "reverted";
  }
  return "reverted";
}

interface Step {
  step: string;
  expect: string;
  got: string;
  ok: boolean;
  txHash?: Hex;
}

async function main(): Promise<void> {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const owner = privateKeyToAccount(loadWriterKey());
  if (owner.address.toLowerCase() !== "0x03e5abfd6aff41e9766bc1c34f136962404a1ab5") {
    throw new Error(`key derives to ${owner.address}, not the writer 0x03e5…1ab5`);
  }
  const wallet = createWalletClient({ account: owner, chain, transport: http(RPC) });
  const oldOracle = privateKeyToAccount(OLD_ORACLE_KEY);
  const newOracle = privateKeyToAccount(NEW_ORACLE_KEY);
  const impostor = privateKeyToAccount(IMPOSTOR_KEY);

  const vArt = load(VAULT_ARTIFACT);
  const tArt = load(TOKEN_ARTIFACT);

  console.log(`deployer/owner = writer ${owner.address}  balance ${formatUnits(await pub.getBalance({ address: owner.address }), 18)} OKB`);

  // ── Deploy token + vault (owner = writer) ────────────────────────────────────────────────────────
  console.log("deploying MockERC20 …");
  const tokenHash = await wallet.deployContract({ abi: tArt.abi, bytecode: tArt.bytecode.object, args: [] });
  const token = (await pub.waitForTransactionReceipt({ hash: tokenHash })).contractAddress as Address;

  console.log("deploying UntchVault (owner=writer, requireAnchoredIntent=false) …");
  const vaultHash = await wallet.deployContract({
    abi: vArt.abi,
    bytecode: vArt.bytecode.object,
    args: [owner.address, oldOracle.address, zeroAddress, PER_TX_CAP, EPOCH_BUDGET, EPOCH_LEN, [token], false],
  });
  const vaultRcpt = await pub.waitForTransactionReceipt({ hash: vaultHash });
  const vault = vaultRcpt.contractAddress as Address;
  console.log(`token ${token}\nvault ${vault} (block ${vaultRcpt.blockNumber})`);

  const vc = { address: vault, abi: vArt.abi } as const;
  const tc = { address: token, abi: tArt.abi } as const;
  const read = (fn: string, args: unknown[] = []) => pub.readContract({ ...vc, functionName: fn, args });
  const bal = (who: Address) => pub.readContract({ ...tc, functionName: "balanceOf", args: [who] }) as Promise<bigint>;

  console.log("mint + approve + deposit …");
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...tc, functionName: "mint", args: [owner.address, parseUnits("100", DECIMALS)] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...tc, functionName: "approve", args: [vault, parseUnits("100", DECIMALS)] }) });
  await pub.waitForTransactionReceipt({ hash: await wallet.writeContract({ ...vc, functionName: "deposit", args: [token, DEPOSIT] }) });

  const latest = await pub.getBlock({ blockTag: "latest" });
  const expiry = BigInt(Number(latest.timestamp) + 7200);
  let nonce = BigInt(Number(latest.timestamp)) * 1000n;
  const nextNonce = () => ++nonce;

  const sign = (signer: typeof oldOracle, n: bigint) =>
    signer.signTypedData({
      domain: { name: "UntchVault", chainId: CHAIN_ID, verifyingContract: vault },
      types: SPEND_EIP712,
      primaryType: "Spend",
      message: { recipient: PAYEE, amount: SPEND_AMT, token, intentHash: DUMMY_INTENT, nonce: n, expiry },
    });
  const spendArgs = (sig: Hex, n: bigint) => [PAYEE, SPEND_AMT, token, DUMMY_INTENT, sig, n, expiry] as const;
  const sendSpend = async (sig: Hex, n: bigint): Promise<Hex> => {
    const h = await wallet.writeContract({ ...vc, functionName: "spend", args: spendArgs(sig, n) });
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`spend ${h} reverted`);
    return h;
  };
  const spendRevert = async (sig: Hex, n: bigint): Promise<string> => {
    try {
      await pub.simulateContract({ ...vc, functionName: "spend", args: spendArgs(sig, n), account: owner.address });
      return "";
    } catch (e) {
      return revertOf(e);
    }
  };
  const ownerTx = async (fn: string, args: unknown[]): Promise<Hex> => {
    const h = await wallet.writeContract({ ...vc, functionName: fn, args });
    await pub.waitForTransactionReceipt({ hash: h });
    return h;
  };

  // ── PAUSE DRILL (real public txs; transient revert checked in-window via eth_call) ───────────────
  console.log("\n── pause drill ──");
  const pauseDrill: Step[] = [];
  const pauseTx = await ownerTx("pause", []);
  const pausedAfter = (await read("paused")) as boolean;
  pauseDrill.push({ step: "pause", expect: "paused=true", got: `paused=${pausedAfter}`, ok: pausedAfter === true, txHash: pauseTx });

  const p1 = nextNonce();
  const rWhilePaused = await spendRevert(await sign(oldOracle, p1), p1);
  pauseDrill.push({ step: "spend-while-paused", expect: "VaultPaused", got: rWhilePaused, ok: rWhilePaused === "VaultPaused" });

  const oBefore = await bal(owner.address);
  const wTx = await ownerTx("ownerWithdraw", [token, owner.address, SPEND_AMT]);
  const oAfter = await bal(owner.address);
  pauseDrill.push({ step: "ownerWithdraw-while-paused", expect: `owner +${formatUnits(SPEND_AMT, DECIMALS)} despite pause`, got: `+${formatUnits(oAfter - oBefore, DECIMALS)}`, ok: oAfter - oBefore === SPEND_AMT, txHash: wTx });

  const unpauseTx = await ownerTx("unpause", []);
  const p2 = nextNonce();
  const payeeB = await bal(PAYEE);
  const spendAfter = await sendSpend(await sign(oldOracle, p2), p2);
  const payeeA = await bal(PAYEE);
  const pausedNow = (await read("paused")) as boolean;
  pauseDrill.push({ step: "spend-after-unpause", expect: `paused=false & payee +${formatUnits(SPEND_AMT, DECIMALS)}`, got: `paused=${pausedNow} +${formatUnits(payeeA - payeeB, DECIMALS)}`, ok: pausedNow === false && payeeA - payeeB === SPEND_AMT, txHash: spendAfter });

  // ── ORACLE-ROTATION DRILL ────────────────────────────────────────────────────────────────────────
  console.log("── oracle-rotation drill ──");
  const rot: Step[] = [];
  const capB = (await read("perTxCap")) as bigint;
  const ownerB = (await read("owner")) as Address;
  const tokAllowB = (await read("tokenAllowed", [token])) as boolean;

  const oracleBefore = String(await read("oracle"));
  rot.push({ step: "oracle-before", expect: oldOracle.address, got: oracleBefore, ok: oracleBefore.toLowerCase() === oldOracle.address.toLowerCase() });
  const setNewTx = await ownerTx("setOracle", [newOracle.address]);
  const oracleAfterSet = String(await read("oracle"));
  rot.push({ step: "setOracle-new", expect: newOracle.address, got: oracleAfterSet, ok: oracleAfterSet.toLowerCase() === newOracle.address.toLowerCase(), txHash: setNewTx });

  const r1 = nextNonce();
  const rOld = await spendRevert(await sign(oldOracle, r1), r1);
  rot.push({ step: "old-sig-rejected", expect: "BadOracle", got: rOld, ok: rOld === "BadOracle" });

  const r2 = nextNonce();
  const payeeB2 = await bal(PAYEE);
  const newSpend = await sendSpend(await sign(newOracle, r2), r2);
  const payeeA2 = await bal(PAYEE);
  rot.push({ step: "new-sig-accepted", expect: `payee +${formatUnits(SPEND_AMT, DECIMALS)}`, got: `+${formatUnits(payeeA2 - payeeB2, DECIMALS)}`, ok: payeeA2 - payeeB2 === SPEND_AMT, txHash: newSpend });

  const restoreTx = await ownerTx("setOracle", [oldOracle.address]);
  const oracleAfterRestore = String(await read("oracle"));
  rot.push({ step: "setOracle-restore", expect: oldOracle.address, got: oracleAfterRestore, ok: oracleAfterRestore.toLowerCase() === oldOracle.address.toLowerCase(), txHash: restoreTx });

  const capA = (await read("perTxCap")) as bigint;
  const ownerA = (await read("owner")) as Address;
  const tokAllowA = (await read("tokenAllowed", [token])) as boolean;
  rot.push({ step: "invariants-intact", expect: "owner/cap/token unchanged", got: `owner=${ownerA === ownerB} cap=${capA === capB} token=${tokAllowA === tokAllowB}`, ok: ownerA === ownerB && capA === capB && tokAllowA === tokAllowB });

  // impostor sanity (a non-oracle sig is rejected even after restore)
  const im = nextNonce();
  const rImp = await spendRevert(await impostor.signTypedData({ domain: { name: "UntchVault", chainId: CHAIN_ID, verifyingContract: vault }, types: SPEND_EIP712, primaryType: "Spend", message: { recipient: PAYEE, amount: SPEND_AMT, token, intentHash: DUMMY_INTENT, nonce: im, expiry } }), im);

  const report = {
    network: { chainId: CHAIN_ID, rpc: RPC, explorer: "https://www.oklink.com/x-layer-testnet" },
    note: "Fresh UntchVault deployed for the public drills because the original demo vault's owner key (0x98F4…3c0b) is unavailable. Owner of this instance = receipt-writer wallet 0x03e5…1ab5.",
    freshVault: vault,
    freshToken: token,
    owner: owner.address,
    oldOracle: oldOracle.address,
    newOracle: newOracle.address,
    deploy: { tokenTx: tokenHash, vaultTx: vaultHash, vaultBlock: Number(vaultRcpt.blockNumber) },
    pauseDrill,
    oracleRotationDrill: rot,
    impostorRejected: rImp === "BadOracle",
    allOk: [...pauseDrill, ...rot].every((s) => s.ok) && rImp === "BadOracle",
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  if (!report.allOk) {
    console.error("✗ a drill step did not match expectation");
    process.exit(1);
  }
  console.log("\n✓ both drills executed & verified LIVE on public testnet 1952");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
