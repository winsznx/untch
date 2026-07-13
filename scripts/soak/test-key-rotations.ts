import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseEther,
  parseUnits,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Tests each key-role rotation mechanism FOR REAL on public X Layer testnet 1952, on fresh instances
 * owned/admin'd by the receipt-writer wallet (0x03e5…1ab5) — the only owner-class key this session
 * holds. Produces the tested evidence the §28 key-custody + rotation runbook cites. No lost key is
 * touched.
 *
 *   owner  (UntchVault)     — two-step transferOwnership → acceptOwnership (old key authorizes; new key accepts)
 *   oracle (UntchVault)     — setOracle (onlyOwner, immediate)
 *   writer (UntchReceipts)  — timelock: propose(ADD/REMOVE_WRITER) → wait delay → execute; early execute reverts
 *   admin  (UntchReceipts)  — timelock: propose(TRANSFER_ADMIN) → wait delay → execute
 *
 * Fixed demo counterparties (public anvil keys, documented throwaways):
 *   K2 = anvil #3 (0x90F7…b906) — new owner / new admin (needs gas → funded from writer)
 *   K3 = anvil #4 (0x15d3…6A65) — writer target (passive address, no tx)
 */

const RPC = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = 1952;
const K2_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"; // anvil #3 → 0x90F7…b906
const K3: Address = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"; // anvil #4 → address only (writer target)
const NEW_ORACLE: Address = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"; // anvil #2
const OLD_ORACLE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1
const TIMELOCK = 60n; // seconds — the fresh receipts' delay

const OP = { NONE: 0, ADD_WRITER: 1, REMOVE_WRITER: 2, TRANSFER_ADMIN: 3 } as const;

const WRITER_ENV = fileURLToPath(new URL("../../packages/receipt-writer/.env", import.meta.url));
const OUT = fileURLToPath(new URL("../../internal/day0/soak-evidence/key-rotation-tests.json", import.meta.url));
const VAULT_ART = fileURLToPath(new URL("../../contracts/out/UntchVault.sol/UntchVault.json", import.meta.url));
const TOKEN_ART = fileURLToPath(new URL("../../contracts/out/VaultMocks.sol/MockERC20.json", import.meta.url));
const RECEIPTS_ART = fileURLToPath(new URL("../../contracts/out/UntchReceipts.sol/UntchReceipts.json", import.meta.url));

const chain = defineChain({ id: CHAIN_ID, name: "X Layer Testnet", nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 }, rpcUrls: { default: { http: [RPC] } } });
type Artifact = { abi: Abi; bytecode: { object: Hex } };
const load = (p: string) => JSON.parse(readFileSync(p, "utf8")) as Artifact;

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
const wait = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

interface Check { step: string; expect: string; got: string; ok: boolean; txHash?: Hex }

async function main(): Promise<void> {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const writer = privateKeyToAccount(loadWriterKey());
  if (writer.address.toLowerCase() !== "0x03e5abfd6aff41e9766bc1c34f136962404a1ab5") throw new Error(`key is ${writer.address}, not writer`);
  const wc = createWalletClient({ account: writer, chain, transport: http(RPC) });
  const k2 = privateKeyToAccount(K2_KEY);
  const k2c = createWalletClient({ account: k2, chain, transport: http(RPC) });

  const vArt = load(VAULT_ART), tArt = load(TOKEN_ART), rArt = load(RECEIPTS_ART);
  const send = async (call: Parameters<typeof wc.writeContract>[0], w = wc): Promise<Hex> => {
    const h = await w.writeContract(call);
    const r = await pub.waitForTransactionReceipt({ hash: h });
    if (r.status !== "success") throw new Error(`tx reverted ${h}`);
    return h;
  };

  const ownerOracle: Check[] = [];
  const writerAdmin: Check[] = [];

  // ── Deploy fresh vault (owner = writer) ──────────────────────────────────────────────────────────
  const tokenTx = await wc.deployContract({ abi: tArt.abi, bytecode: tArt.bytecode.object, args: [] });
  const token = (await pub.waitForTransactionReceipt({ hash: tokenTx })).contractAddress as Address;
  const vaultTx = await wc.deployContract({ abi: vArt.abi, bytecode: vArt.bytecode.object, args: [writer.address, OLD_ORACLE, zeroAddress, parseUnits("100", 6), parseUnits("250", 6), 86_400n, [token], false] });
  const vaultRc = await pub.waitForTransactionReceipt({ hash: vaultTx });
  const vault = vaultRc.contractAddress as Address;
  const vc = { address: vault, abi: vArt.abi } as const;
  // Single SETTLED read — public 1952 is load-balanced and a read right after a mined tx can hit a
  // lagging node; wait briefly and read ONCE, using that value for both display and the assertion.
  const vread = async (fn: string, args: unknown[] = []): Promise<string> => {
    await wait(3);
    return String(await pub.readContract({ ...vc, functionName: fn, args }));
  };
  console.log(`fresh vault ${vault}`);

  // ── ORACLE rotation (setOracle, immediate) ───────────────────────────────────────────────────────
  const setNew = await send({ ...vc, functionName: "setOracle", args: [NEW_ORACLE] });
  const oNew = await vread("oracle");
  ownerOracle.push({ step: "oracle:setOracle→new", expect: NEW_ORACLE, got: oNew, ok: oNew.toLowerCase() === NEW_ORACLE.toLowerCase(), txHash: setNew });
  const setBack = await send({ ...vc, functionName: "setOracle", args: [OLD_ORACLE] });
  const oBack = await vread("oracle");
  ownerOracle.push({ step: "oracle:setOracle→restore", expect: OLD_ORACLE, got: oBack, ok: oBack.toLowerCase() === OLD_ORACLE.toLowerCase(), txHash: setBack });

  // ── OWNER two-step rotation (transferOwnership → acceptOwnership) ─────────────────────────────────
  // Fund K2 so it can pay gas for acceptOwnership + the round-trip transferOwnership.
  await pub.waitForTransactionReceipt({ hash: await wc.sendTransaction({ to: k2.address, value: parseEther("0.02") }) });

  const transfer1 = await send({ ...vc, functionName: "transferOwnership", args: [k2.address] });
  const ownerMid = await vread("owner");
  const pendingMid = await vread("pendingOwner");
  ownerOracle.push({ step: "owner:transferOwnership (old key)", expect: `pendingOwner=${k2.address}; owner STILL ${writer.address}`, got: `pendingOwner=${pendingMid}; owner=${ownerMid}`, ok: pendingMid.toLowerCase() === k2.address.toLowerCase() && ownerMid.toLowerCase() === writer.address.toLowerCase(), txHash: transfer1 });

  // Safety proof: a non-pending account cannot accept.
  let accBadErr = "";
  try { await pub.simulateContract({ ...vc, functionName: "acceptOwnership", account: writer.address }); } catch (e) { accBadErr = revertOf(e); }
  ownerOracle.push({ step: "owner:accept-by-wrong-account reverts", expect: "NotPendingOwner", got: accBadErr, ok: accBadErr === "NotPendingOwner" });

  const accept1 = await send({ ...vc, functionName: "acceptOwnership", args: [] }, k2c);
  const ownerAfter = await vread("owner");
  const pendingAfter = await vread("pendingOwner");
  ownerOracle.push({ step: "owner:acceptOwnership (new key)", expect: `owner=${k2.address}, pendingOwner=0`, got: `owner=${ownerAfter}, pendingOwner=${pendingAfter}`, ok: ownerAfter.toLowerCase() === k2.address.toLowerCase() && pendingAfter === zeroAddress, txHash: accept1 });

  // Round-trip back so the mechanism is shown symmetric.
  const transfer2 = await send({ ...vc, functionName: "transferOwnership", args: [writer.address] }, k2c);
  const accept2 = await send({ ...vc, functionName: "acceptOwnership", args: [] }, wc);
  void transfer2;
  const ownerFinal = await vread("owner");
  ownerOracle.push({ step: "owner:round-trip back to writer", expect: writer.address, got: ownerFinal, ok: ownerFinal.toLowerCase() === writer.address.toLowerCase(), txHash: accept2 });

  // ── Deploy fresh UntchReceipts (admin = writer, delay = 60s) ──────────────────────────────────────
  const recTx = await wc.deployContract({ abi: rArt.abi, bytecode: rArt.bytecode.object, args: [TIMELOCK] });
  const receipts = (await pub.waitForTransactionReceipt({ hash: recTx })).contractAddress as Address;
  const rc = { address: receipts, abi: rArt.abi } as const;
  const rread = async (fn: string, args: unknown[] = []): Promise<unknown> => {
    await wait(3);
    return pub.readContract({ ...rc, functionName: fn, args });
  };
  console.log(`fresh receipts ${receipts} (delay ${TIMELOCK}s)`);

  // ── WRITER rotation (timelocked add, then remove) ────────────────────────────────────────────────
  const propAdd = await send({ ...rc, functionName: "propose", args: [OP.ADD_WRITER, K3] });
  writerAdmin.push({ step: "writer:propose(ADD_WRITER)", expect: "OpProposed; eta set", got: "proposed", ok: true, txHash: propAdd });
  let early = "";
  try { await pub.simulateContract({ ...rc, functionName: "execute", args: [OP.ADD_WRITER, K3], account: writer.address }); } catch (e) { early = revertOf(e); }
  writerAdmin.push({ step: "writer:execute-before-delay reverts", expect: "TimelockNotElapsed", got: early, ok: early === "TimelockNotElapsed" });
  console.log(`waiting ${TIMELOCK}s for timelock (add) …`);
  await wait(Number(TIMELOCK) + 3);
  const execAdd = await send({ ...rc, functionName: "execute", args: [OP.ADD_WRITER, K3] });
  const isWriterAfterAdd = (await rread("isWriter", [K3])) as boolean;
  writerAdmin.push({ step: "writer:execute(ADD_WRITER) after delay", expect: "isWriter(K3)=true", got: `isWriter=${isWriterAfterAdd}`, ok: isWriterAfterAdd === true, txHash: execAdd });

  const propRem = await send({ ...rc, functionName: "propose", args: [OP.REMOVE_WRITER, K3] });
  const propAdmin = await send({ ...rc, functionName: "propose", args: [OP.TRANSFER_ADMIN, k2.address] });
  console.log(`waiting ${TIMELOCK}s for timelock (remove + admin) …`);
  await wait(Number(TIMELOCK) + 3);
  const execRem = await send({ ...rc, functionName: "execute", args: [OP.REMOVE_WRITER, K3] });
  const isWriterAfterRem = (await rread("isWriter", [K3])) as boolean;
  writerAdmin.push({ step: "writer:execute(REMOVE_WRITER) after delay", expect: "isWriter(K3)=false", got: `isWriter=${isWriterAfterRem}`, ok: isWriterAfterRem === false, txHash: execRem });
  void propRem;

  // ── ADMIN rotation (timelocked TRANSFER_ADMIN) ───────────────────────────────────────────────────
  const execAdmin = await send({ ...rc, functionName: "execute", args: [OP.TRANSFER_ADMIN, k2.address] });
  const adminAfter = String(await rread("admin"));
  writerAdmin.push({ step: "admin:execute(TRANSFER_ADMIN) after delay", expect: `admin=${k2.address}`, got: `admin=${adminAfter}`, ok: adminAfter.toLowerCase() === k2.address.toLowerCase(), txHash: execAdmin });
  void propAdmin;

  const report = {
    network: { chainId: CHAIN_ID, rpc: RPC, explorer: "https://www.oklink.com/x-layer-testnet" },
    freshVault: vault,
    freshReceipts: receipts,
    counterparties: { K2_newOwnerAndAdmin: k2.address, K3_writerTarget: K3, newOracle: NEW_ORACLE, oldOracle: OLD_ORACLE },
    ownerAndOracle: ownerOracle,
    writerAndAdmin: writerAdmin,
    allOk: [...ownerOracle, ...writerAdmin].every((c) => c.ok),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\n${JSON.stringify(report, null, 2)}`);
  if (!report.allOk) { console.error("✗ a rotation check failed"); process.exit(1); }
  console.log("\n✓ owner / oracle / writer / admin rotations all executed & verified LIVE on testnet 1952");
}

main().catch((e) => { console.error(`\n✗ ${(e as Error).message}`); process.exit(1); });
