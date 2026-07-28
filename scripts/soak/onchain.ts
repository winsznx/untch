import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BaseError,
  ContractFunctionRevertedError,
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

/**
 * On-chain soak layer + the two §28 drills, run against an anvil FORK of X Layer testnet (chainId
 * 1952). It exercises the REAL deployed UntchVault (0x42e6…4848) with its REAL state — same bytecode,
 * same owner/oracle/caps/balance the public testnet holds — so every spend, revert, pause and oracle
 * rotation is genuine EVM execution against the production contract, not a redeploy or a mock.
 *
 * Why a fork rather than the public testnet ledger: broadcasting to public 1952 requires the vault
 * OWNER's private key, which is not present in this environment (only the public ops-wallet address
 * is). The fork lets the owner be impersonated (an anvil capability) so the owner-only drills
 * (pause/unpause, setOracle, ownerWithdraw) and the oracle-signed spends all execute for real. The
 * one thing a fork cannot do — write to the public 1952 ledger — is documented as the remaining
 * human-key step; the mainnet x402 charge is the D0.1-proven piece.
 *
 * Money-movement authorization here is the ORACLE SIGNATURE (spend() is not owner-gated). The oracle
 * is anvil account #1 — a publicly-known key — so this harness can produce both VALID oracle sigs and,
 * for the rotation drill, sigs from a superseded key that must now be rejected.
 */

const VAULT: Address = "0x42e699ffd8215d48397a049b4f7a176db06f4848";
const TOKEN: Address = "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41";
const INTENT_REGISTRY: Address = "0xf87e50f83172c2dace7d274e4c701212caeb1372";
const APPROVED_INTENT: Hex = "0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a";
const OWNER: Address = "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b";

// anvil account #1 — the vault's current oracle (0x7099…79C8). Publicly known; holds no real funds.
// ANVIL DEFAULT ACCOUNT #1 — a publicly documented local-dev key, not a secret. It exists in
// every Anvil install, is used here only against a local fork, and protects nothing. Secret
// scanners flag it by pattern; that finding is a true positive by shape and a false positive by risk.
const OLD_ORACLE_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
// anvil account #2 — the rotation target (0x3C44…93BC).
const NEW_ORACLE_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
// anvil account #3 — a NON-oracle key, used to prove an unauthorized spend reverts (the withhold case).
const IMPOSTOR_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

const DECIMALS = 6;
const PAYEE: Address = getAddress("0x000000000000000000000000000000000000beef");

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

const ARTIFACT = fileURLToPath(new URL("../../contracts/out/UntchVault.sol/UntchVault.json", import.meta.url));
const VAULT_ABI = (JSON.parse(readFileSync(ARTIFACT, "utf8")) as { abi: Abi }).abi;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;
const REGISTRY_ABI = [
  { type: "function", name: "isUsable", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
] as const;

export interface StepResult {
  readonly step: string;
  readonly expect: string;
  readonly got: string;
  readonly ok: boolean;
  readonly txHash?: Hex;
  readonly revertReason?: string;
}

export interface OnchainReport {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly vault: Address;
  readonly oldOracle: Address;
  readonly newOracle: Address;
  readonly spendCycles: StepResult[];
  readonly withholdProof: StepResult[];
  readonly pauseDrill: StepResult[];
  readonly rotationDrill: StepResult[];
  readonly finalState: Record<string, string>;
  readonly allOk: boolean;
}

function forkChain(rpcUrl: string, chainId: number): Chain {
  return defineChain({
    id: chainId,
    name: `xlayer-testnet-fork-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** Decode the custom-error NAME from a viem revert (e.g. "VaultPaused", "BadOracle"). */
function revertOf(err: unknown): string {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      return revert.data?.errorName ?? revert.reason ?? "reverted";
    }
  }
  const s = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const m = s.match(/(VaultPaused|BadOracle|NonceReplay|SigExpired|CapExceeded|BudgetExceeded|TokenNotAllowed|IntentNotApproved)/);
  return m ? m[0] : "reverted";
}

async function main(): Promise<void> {
  const rpcUrl = process.env.RPC_URL ?? "http://127.0.0.1:8545";
  const pub = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await pub.getChainId();
  const chain = forkChain(rpcUrl, chainId);

  const oldOracle = privateKeyToAccount(OLD_ORACLE_KEY);
  const newOracle = privateKeyToAccount(NEW_ORACLE_KEY);
  const impostor = privateKeyToAccount(IMPOSTOR_KEY);

  const rpc = (method: string, params: unknown[]) =>
    pub.request({ method: method as never, params: params as never });

  // Fund + impersonate the owner so owner-only ops and gas-paying relays run without its private key.
  await rpc("anvil_setBalance", [OWNER, "0x56BC75E2D63100000"]); // 100 OKB
  await rpc("anvil_impersonateAccount", [OWNER]);
  const ownerWallet = createWalletClient({ account: OWNER, chain, transport: http(rpcUrl) });

  const vault = { address: VAULT, abi: VAULT_ABI } as const;
  const read = (fn: string, args: unknown[] = []) => pub.readContract({ ...vault, functionName: fn, args });

  const signSpend = (
    signer: typeof oldOracle,
    msg: { recipient: Address; amount: bigint; token: Address; intentHash: Hex; nonce: bigint; expiry: bigint },
  ) =>
    signer.signTypedData({
      domain: { name: "UntchVault", chainId, verifyingContract: VAULT },
      types: SPEND_EIP712,
      primaryType: "Spend",
      message: msg,
    });

  const latest = await pub.getBlock({ blockTag: "latest" });
  const forkTs = Number(latest.timestamp);
  const expiry = BigInt(forkTs + 3600);
  let nonceCounter = BigInt(forkTs) * 1000n;
  const nextNonce = () => ++nonceCounter;

  const sendSpend = async (sig: Hex, amount: bigint, nonce: bigint): Promise<Hex> => {
    const hash = await ownerWallet.writeContract({
      ...vault,
      functionName: "spend",
      args: [PAYEE, amount, TOKEN, APPROVED_INTENT, sig, nonce, expiry],
      account: OWNER,
      chain,
    });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    if (rcpt.status !== "success") throw new Error(`spend reverted ${hash}`);
    return hash;
  };

  const simulateSpendRevert = async (sig: Hex, amount: bigint, nonce: bigint): Promise<string> => {
    try {
      await pub.simulateContract({
        ...vault,
        functionName: "spend",
        args: [PAYEE, amount, TOKEN, APPROVED_INTENT, sig, nonce, expiry],
        account: OWNER,
      });
      return "";
    } catch (e) {
      return revertOf(e);
    }
  };

  // Preflight sanity: the anchored intent the vault re-checks on-chain must be usable.
  const intentUsable = (await pub.readContract({ address: INTENT_REGISTRY, abi: REGISTRY_ABI, functionName: "isUsable", args: [APPROVED_INTENT] })) as boolean;
  if (!intentUsable) throw new Error(`anchored intent ${APPROVED_INTENT} not usable on fork — cannot exercise anchored spends`);

  const payeeStart = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;

  // ── APPROVED → Mode-C vault spend cycles (real settlement on the fork) ──────────────────────────
  const spendCycles: StepResult[] = [];
  const SPEND_AMT = 1_000_000n; // 1.0 token
  for (let i = 0; i < 6; i++) {
    const nonce = nextNonce();
    const sig = await signSpend(oldOracle, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce, expiry });
    const before = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    const tx = await sendSpend(sig, SPEND_AMT, nonce);
    const after = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    const nonceUsed = (await read("nonceUsed", [nonce])) as boolean;
    const ok = after - before === SPEND_AMT && nonceUsed;
    spendCycles.push({ step: `approved-spend#${i + 1}`, expect: `payee +${formatUnits(SPEND_AMT, DECIMALS)} & nonce consumed`, got: `+${formatUnits(after - before, DECIMALS)} nonceUsed=${nonceUsed}`, ok, txHash: tx });
  }

  // ── verify-fail-withhold on-chain proof: with no valid oracle authorization, money cannot move ──
  const withholdProof: StepResult[] = [];
  {
    const nonce = nextNonce();
    const badSig = await signSpend(impostor, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce, expiry });
    const reason = await simulateSpendRevert(badSig, SPEND_AMT, nonce);
    withholdProof.push({ step: "withhold-no-oracle-sig", expect: "BadOracle revert (no settlement)", got: reason || "did NOT revert", ok: reason.includes("BadOracle") });
    const nonceUsed = (await read("nonceUsed", [nonce])) as boolean;
    withholdProof.push({ step: "withhold-nonce-untouched", expect: "nonce never consumed", got: `nonceUsed=${nonceUsed}`, ok: nonceUsed === false });
  }

  // ── PAUSE DRILL ─────────────────────────────────────────────────────────────────────────────────
  const pauseDrill: StepResult[] = [];
  {
    const pauseTx = await ownerWallet.writeContract({ ...vault, functionName: "pause", args: [], account: OWNER, chain });
    await pub.waitForTransactionReceipt({ hash: pauseTx });
    pauseDrill.push({ step: "pause", expect: "paused=true", got: `paused=${await read("paused")}`, ok: (await read("paused")) === true, txHash: pauseTx });

    const nonce = nextNonce();
    const sig = await signSpend(oldOracle, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce, expiry });
    const reason = await simulateSpendRevert(sig, SPEND_AMT, nonce);
    pauseDrill.push({ step: "spend-while-paused", expect: "VaultPaused revert", got: reason || "did NOT revert", ok: reason.includes("VaultPaused") });

    // ownerWithdraw MUST still work while paused (§16 I4 / §7.5 invariant).
    const wBefore = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [OWNER] })) as bigint;
    const wTx = await ownerWallet.writeContract({ ...vault, functionName: "ownerWithdraw", args: [TOKEN, OWNER, SPEND_AMT], account: OWNER, chain });
    const wRcpt = await pub.waitForTransactionReceipt({ hash: wTx });
    const wAfter = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [OWNER] })) as bigint;
    pauseDrill.push({ step: "ownerWithdraw-while-paused", expect: `owner +${formatUnits(SPEND_AMT, DECIMALS)} despite pause`, got: `+${formatUnits(wAfter - wBefore, DECIMALS)} status=${wRcpt.status}`, ok: wAfter - wBefore === SPEND_AMT && wRcpt.status === "success", txHash: wTx });

    const unpauseTx = await ownerWallet.writeContract({ ...vault, functionName: "unpause", args: [], account: OWNER, chain });
    await pub.waitForTransactionReceipt({ hash: unpauseTx });
    const nonce2 = nextNonce();
    const sig2 = await signSpend(oldOracle, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce: nonce2, expiry });
    const before = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    const tx = await sendSpend(sig2, SPEND_AMT, nonce2);
    const after = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    pauseDrill.push({ step: "spend-after-unpause", expect: `paused=false & payee +${formatUnits(SPEND_AMT, DECIMALS)}`, got: `paused=${await read("paused")} +${formatUnits(after - before, DECIMALS)}`, ok: (await read("paused")) === false && after - before === SPEND_AMT, txHash: tx });
  }

  // ── ORACLE-ROTATION DRILL ────────────────────────────────────────────────────────────────────────
  const rotationDrill: StepResult[] = [];
  {
    const capBefore = (await read("perTxCap")) as bigint;
    const budgetBefore = (await read("epochBudget")) as bigint;
    const ownerBefore = (await read("owner")) as Address;
    const tokenAllowedBefore = (await read("tokenAllowed", [TOKEN])) as boolean;

    const oracleBefore = (await read("oracle")) as Address;
    rotationDrill.push({ step: "oracle-before", expect: oldOracle.address, got: oracleBefore, ok: oracleBefore.toLowerCase() === oldOracle.address.toLowerCase() });

    const rotTx = await ownerWallet.writeContract({ ...vault, functionName: "setOracle", args: [newOracle.address], account: OWNER, chain });
    await pub.waitForTransactionReceipt({ hash: rotTx });
    const oracleAfter = (await read("oracle")) as Address;
    rotationDrill.push({ step: "setOracle", expect: newOracle.address, got: oracleAfter, ok: oracleAfter.toLowerCase() === newOracle.address.toLowerCase(), txHash: rotTx });

    // OLD oracle's signature must now be REJECTED.
    const nOld = nextNonce();
    const oldSig = await signSpend(oldOracle, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce: nOld, expiry });
    const oldReason = await simulateSpendRevert(oldSig, SPEND_AMT, nOld);
    rotationDrill.push({ step: "old-oracle-sig-rejected", expect: "BadOracle revert", got: oldReason || "did NOT revert", ok: oldReason.includes("BadOracle") });

    // NEW oracle's signature must be ACCEPTED.
    const nNew = nextNonce();
    const newSig = await signSpend(newOracle, { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce: nNew, expiry });
    const before = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    const tx = await sendSpend(newSig, SPEND_AMT, nNew);
    const after = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;
    rotationDrill.push({ step: "new-oracle-sig-accepted", expect: `payee +${formatUnits(SPEND_AMT, DECIMALS)}`, got: `+${formatUnits(after - before, DECIMALS)}`, ok: after - before === SPEND_AMT, txHash: tx });

    // Nothing else changed during the transition.
    const capAfter = (await read("perTxCap")) as bigint;
    const budgetAfter = (await read("epochBudget")) as bigint;
    const ownerAfter = (await read("owner")) as Address;
    const tokenAllowedAfter = (await read("tokenAllowed", [TOKEN])) as boolean;
    const intact = capAfter === capBefore && budgetAfter === budgetBefore && ownerAfter === ownerBefore && tokenAllowedAfter === tokenAllowedBefore;
    rotationDrill.push({ step: "invariants-intact", expect: "owner/caps/token-allowlist unchanged", got: `cap=${capAfter === capBefore} budget=${budgetAfter === budgetBefore} owner=${ownerAfter === ownerBefore} token=${tokenAllowedAfter === tokenAllowedBefore}`, ok: intact });
  }

  await rpc("anvil_stopImpersonatingAccount", [OWNER]);

  const finalState: Record<string, string> = {
    owner: String(await read("owner")),
    oracle: String(await read("oracle")),
    paused: String(await read("paused")),
    perTxCap: String(await read("perTxCap")),
    epochBudget: String(await read("epochBudget")),
    epochSpent: String(await read("epochSpent")),
    payeeBalance: String((await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint),
    payeeStart: String(payeeStart),
  };

  const all = [...spendCycles, ...withholdProof, ...pauseDrill, ...rotationDrill];
  const report: OnchainReport = {
    rpcUrl,
    chainId,
    vault: VAULT,
    oldOracle: oldOracle.address,
    newOracle: newOracle.address,
    spendCycles,
    withholdProof,
    pauseDrill,
    rotationDrill,
    finalState,
    allOk: all.every((s) => s.ok),
  };

  console.log(JSON.stringify(report, null, 2));
  if (!report.allOk) {
    console.error("\n✗ ON-CHAIN SOAK FAILED — a step did not match expectation.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
