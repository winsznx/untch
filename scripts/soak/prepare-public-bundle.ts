import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { evaluateIntent } from "../../packages/policy-engine/src/index";
import { verifyDelivery } from "../../packages/proof-engine/src/index";
import { draftFromDecision, draftFromVerify, UNTCH_RECEIPTS_ABI } from "../../packages/receipt-writer/src/index";
import { encodeFunctionData, getAddress, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ACCEPTANCE_CRITERIA,
  ACCEPTANCE_HASH,
  basePolicy,
  buildIntent,
  failingDelivery,
  freshLedger,
} from "./fixtures";

/**
 * Prepares the EXACT public-testnet-1952 transaction bundle the HUMAN executes with their own wallet
 * (PRD §28 — the public-execution complement to the fork-based volume/diversity proof). This preparer
 * needs NO private key and never touches the vault owner's key: owner-only txs (pause/unpause/
 * setOracle/ownerWithdraw) are emitted as calldata for the human's OWNER wallet to sign; oracle-signed
 * spends carry a signature pre-baked from the vault's PUBLIC demo oracle key (anvil #1, the deployed
 * vault's oracle — a documented throwaway, NOT the owner key), so the human only sends the tx.
 *
 * Output:
 *   internal/day0/soak-evidence/public-bundle.json  — ordered tx list (to/data/value/signer/verify)
 * The runbook (soak-public-runbook.md) renders these as copy-paste `cast` commands.
 */

// ── live-verified public testnet 1952 addresses (see soak-public-runbook.md §state) ──────────────
const VAULT = getAddress("0x42e699ffd8215d48397a049b4f7a176db06f4848");
const TOKEN = getAddress("0xf202ce41d76ee1a2aec72e7a9180331d437ddd41");
const RECEIPTS = getAddress("0x0c64997277b7d94d2999dea22a123cac56334863");
const OWNER = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
const WRITER = getAddress("0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5");
const APPROVED_INTENT: Hex = "0xc55751e84cd9ae642d583e70c868672ccf8c51ca6d93e884dd82373c0c4de09a";
const PAYEE = getAddress("0x000000000000000000000000000000000000beef");
const CHAIN_ID = 1952;

// The vault's live oracle (anvil #1) and the rotation target (anvil #2) — both public demo keys.
const OLD_ORACLE_KEY: Hex = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const NEW_ORACLE_KEY: Hex = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const SPEND_AMT = 100_000n; // 0.1 token (6 dp) — tiny, so many spends fit the 200-token epoch headroom
const EXPIRY = 1_900_000_000n; // ~2030-03 — far enough out that a pre-baked sig stays valid until run
const NONCE_BASE = 928_100_000_000_000n; // distinctive, never used on public 1952

const VAULT_ABI: Abi = [
  { type: "function", name: "pause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "unpause", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "setOracle", stateMutability: "nonpayable", inputs: [{ name: "newOracle", type: "address" }], outputs: [] },
  { type: "function", name: "ownerWithdraw", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "address" }, { type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "spend",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "token", type: "address" },
      { name: "intentHash", type: "bytes32" },
      { name: "oracleSig", type: "bytes" },
      { name: "nonce", type: "uint256" },
      { name: "expiry", type: "uint256" },
    ],
    outputs: [],
  },
];

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

const oldOracle = privateKeyToAccount(OLD_ORACLE_KEY);
const newOracle = privateKeyToAccount(NEW_ORACLE_KEY);

async function signSpend(signer: typeof oldOracle, nonce: bigint): Promise<Hex> {
  return signer.signTypedData({
    domain: { name: "UntchVault", chainId: CHAIN_ID, verifyingContract: VAULT },
    types: SPEND_EIP712,
    primaryType: "Spend",
    message: { recipient: PAYEE, amount: SPEND_AMT, token: TOKEN, intentHash: APPROVED_INTENT, nonce, expiry: EXPIRY },
  });
}

function spendData(sig: Hex, nonce: bigint): Hex {
  return encodeFunctionData({ abi: VAULT_ABI, functionName: "spend", args: [PAYEE, SPEND_AMT, TOKEN, APPROVED_INTENT, sig, nonce, EXPIRY] });
}

interface Tx {
  readonly id: string;
  readonly purpose: string;
  readonly signer: "OWNER" | "WRITER" | "ANY_FUNDED";
  readonly kind: "send" | "eth_call-expect-revert";
  readonly to: Address;
  readonly value: string;
  readonly data: Hex;
  readonly expect: string;
  readonly verify: string;
}

const RPC = "https://testrpc.xlayer.tech";
const castVault = (fn: string, args = "") => `cast call ${VAULT} '${fn}' ${args} --rpc-url ${RPC}`.trim();

// ── Representative sample: 2 of each outcome (real decisions → real receipts; approved → real spend) ──
function receiptTx(id: string, outcome: string, onchain: ReturnType<typeof draftFromDecision>["onchain"]): Tx {
  const data = encodeFunctionData({ abi: UNTCH_RECEIPTS_ABI as Abi, functionName: "logReceipts", args: [[onchain]] });
  return {
    id,
    purpose: `anchor receipt — ${outcome} (receiptId ${onchain.receiptId.slice(0, 14)}…, decision=${onchain.decision}, verifyResult=${onchain.verifyResult})`,
    signer: "WRITER",
    kind: "send",
    to: RECEIPTS,
    value: "0",
    data,
    expect: "ReceiptLogged event for this receiptId; BatchLogged(count=1)",
    verify: `cast receipt <TXHASH> --rpc-url ${RPC}  # decode ReceiptLogged: decision=${onchain.decision}, verifyResult=${onchain.verifyResult}, intentHash=${onchain.intentHash.slice(0, 14)}…`,
  };
}

async function buildSample(): Promise<{ txs: Tx[]; index: object[] }> {
  const txs: Tx[] = [];
  const index: object[] = [];
  const now = () => 1_700_000_000_000;
  let spendNonce = NONCE_BASE;

  const mk = (outcome: string, i: number, decisionCode: string, onchainForReceipt: Tx, spend?: Tx) => {
    index.push({ outcome, n: i, decision: decisionCode, receipt: onchainForReceipt.id, spend: spend?.id ?? null });
  };

  // approve ×2 → receipt(decision=APPROVED) + real vault spend
  for (let i = 1; i <= 2; i++) {
    const intent = buildIntent(1000 + i, { amount: 5 });
    const d = evaluateIntent(intent, basePolicy(), freshLedger(), { now });
    const draft = draftFromDecision(intent, d);
    const rtx = receiptTx(`sample.approve.${i}.receipt`, "approve", draft.onchain);
    const nonce = spendNonce++;
    const stx: Tx = {
      id: `sample.approve.${i}.spend`,
      purpose: `approved settlement (Mode C) — vault spend 0.1 token to payee, oracle-signed`,
      signer: "ANY_FUNDED",
      kind: "send",
      to: VAULT,
      value: "0",
      data: spendData(await signSpend(oldOracle, nonce), nonce),
      expect: "VaultSpend event; payee +0.1 token; nonce consumed",
      verify: `${castVault("nonceUsed(uint256)(bool)", String(nonce))}  # true after`,
    };
    txs.push(rtx, stx);
    mk("approve", i, "APPROVED(1)", rtx, stx);
  }

  // escalate-approve ×2 → receipt(preflight ESCALATED_THRESHOLD) + real vault spend (settled after approval)
  for (let i = 1; i <= 2; i++) {
    const intent = buildIntent(2000 + i, { amount: 15 });
    const d = evaluateIntent(intent, basePolicy(), freshLedger(), { now });
    const draft = draftFromDecision(intent, d);
    const rtx = receiptTx(`sample.escalate-approve.${i}.receipt`, "escalate-approve (preflight ESCALATED_THRESHOLD → off-chain APPROVE)", draft.onchain);
    const nonce = spendNonce++;
    const stx: Tx = {
      id: `sample.escalate-approve.${i}.spend`,
      purpose: `settlement after escalation APPROVE (Mode C) — vault spend 0.1 token, oracle-signed`,
      signer: "ANY_FUNDED",
      kind: "send",
      to: VAULT,
      value: "0",
      data: spendData(await signSpend(oldOracle, nonce), nonce),
      expect: "VaultSpend event; payee +0.1 token; nonce consumed",
      verify: `${castVault("nonceUsed(uint256)(bool)", String(nonce))}  # true after`,
    };
    txs.push(rtx, stx);
    mk("escalate-approve", i, "ESCALATED_THRESHOLD(14)→APPROVED", rtx, stx);
  }

  // block ×2 → receipt only (no settlement). Two distinct BLOCKED_* codes.
  const blockCases: Array<[string, ReturnType<typeof buildIntent>, ReturnType<typeof basePolicy>]> = [
    ["block-budget", buildIntent(3001, { amount: 5 }), basePolicy({ budgets: { daily: 3, token: "USDT" } })],
    ["block-category", buildIntent(3002, { amount: 5, category: "gambling" }), basePolicy()],
  ];
  blockCases.forEach(([name, intent, policy], idx) => {
    const d = evaluateIntent(intent, policy, freshLedger(), { now });
    const draft = draftFromDecision(intent, d);
    const rtx = receiptTx(`sample.${name}.receipt`, `block (${d.decision})`, draft.onchain);
    txs.push(rtx);
    mk("block", idx + 1, `${d.decision}`, rtx);
  });

  // escalate-timeout ×2 → receipt only (preflight ESCALATED_THRESHOLD; off-chain EXPIRED→default DENY, no settlement)
  for (let i = 1; i <= 2; i++) {
    const intent = buildIntent(4000 + i, { amount: 15 });
    const d = evaluateIntent(intent, basePolicy(), freshLedger(), { now });
    const draft = draftFromDecision(intent, d);
    const rtx = receiptTx(`sample.escalate-timeout.${i}.receipt`, "escalate-timeout (ESCALATED_THRESHOLD → off-chain EXPIRED / default DENY — NO spend)", draft.onchain);
    txs.push(rtx);
    mk("escalate-timeout", i, "ESCALATED_THRESHOLD(14)→EXPIRED", rtx);
  }

  // verify-fail-withhold ×2 → VERIFY receipt (verifyResult=FAIL); no settlement
  for (let i = 1; i <= 2; i++) {
    const intent = buildIntent(5000 + i, { amount: 5 });
    const d = evaluateIntent(intent, basePolicy(), freshLedger(), { now });
    const outcome = verifyDelivery({ intentHash: d.intentHash, acceptanceHash: ACCEPTANCE_HASH, criteria: ACCEPTANCE_CRITERIA, delivery: failingDelivery(), now });
    const draft = draftFromVerify(intent, {
      policyId: d.policyId,
      intentHash: d.intentHash,
      verifyResultCode: outcome.verifyResultCode,
      proofTier: outcome.proofTier,
      payloadHash: outcome.payloadHash,
      verifiedAt: outcome.verifiedAt,
      provenance: "caller-supplied",
    });
    const rtx = receiptTx(`sample.verify-fail.${i}.receipt`, `verify-fail-withhold (verifyResult=FAIL/${outcome.verifyResultCode}, WITHHOLD — NO spend)`, draft.onchain);
    txs.push(rtx);
    mk("verify-fail-withhold", i, `VERIFY_FAILED(${outcome.verifyResultCode})`, rtx);
  }

  return { txs, index };
}

// ── The two drills (ordered; reversible — vault ends exactly as it started) ───────────────────────
async function buildDrills(): Promise<{ pause: Tx[]; rotation: Tx[] }> {
  const nPauseWhilePaused = NONCE_BASE + 900n;
  const nPostUnpause = NONCE_BASE + 901n;
  const nRotOld = NONCE_BASE + 902n;
  const nRotNew = NONCE_BASE + 903n;

  const ethCallSpend = (id: string, purpose: string, sig: Hex, nonce: bigint, expectErr: string): Tx => ({
    id,
    purpose,
    signer: "ANY_FUNDED",
    kind: "eth_call-expect-revert",
    to: VAULT,
    value: "0",
    data: spendData(sig, nonce),
    expect: `revert ${expectErr}`,
    verify: `cast call ${VAULT} 'spend(address,uint256,address,bytes32,bytes,uint256,uint256)' ${PAYEE} ${SPEND_AMT} ${TOKEN} ${APPROVED_INTENT} ${sig} ${nonce} ${EXPIRY} --rpc-url ${RPC}  # expect: reverts with ${expectErr}`,
  });

  const pause: Tx[] = [
    { id: "pause.1.pause", purpose: "PAUSE the vault", signer: "OWNER", kind: "send", to: VAULT, value: "0", data: encodeFunctionData({ abi: VAULT_ABI, functionName: "pause", args: [] }), expect: "Paused event; paused()==true", verify: castVault("paused()(bool)") + "  # true" },
    ethCallSpend("pause.2.spend-while-paused", "prove a valid oracle-signed spend is BLOCKED while paused", await signSpend(oldOracle, nPauseWhilePaused), nPauseWhilePaused, "VaultPaused"),
    { id: "pause.3.ownerWithdraw-while-paused", purpose: "prove ownerWithdraw STILL works while paused (§16 I4 invariant)", signer: "OWNER", kind: "send", to: VAULT, value: "0", data: encodeFunctionData({ abi: VAULT_ABI, functionName: "ownerWithdraw", args: [TOKEN, OWNER, SPEND_AMT] }), expect: "OwnerWithdraw event; owner +0.1 token DESPITE pause", verify: `cast call ${TOKEN} 'balanceOf(address)(uint256)' ${OWNER} --rpc-url ${RPC}  # increased by 0.1` },
    { id: "pause.4.unpause", purpose: "UNPAUSE the vault", signer: "OWNER", kind: "send", to: VAULT, value: "0", data: encodeFunctionData({ abi: VAULT_ABI, functionName: "unpause", args: [] }), expect: "Unpaused event; paused()==false", verify: castVault("paused()(bool)") + "  # false" },
    { id: "pause.5.spend-after-unpause", purpose: "prove normal operation resumes — valid spend now SUCCEEDS", signer: "ANY_FUNDED", kind: "send", to: VAULT, value: "0", data: spendData(await signSpend(oldOracle, nPostUnpause), nPostUnpause), expect: "VaultSpend event; payee +0.1 token", verify: castVault("nonceUsed(uint256)(bool)", String(nPostUnpause)) + "  # true" },
  ];

  const rotation: Tx[] = [
    { id: "rotate.1.setOracle-new", purpose: `ROTATE oracle → ${newOracle.address} (anvil #2, demo)`, signer: "OWNER", kind: "send", to: VAULT, value: "0", data: encodeFunctionData({ abi: VAULT_ABI, functionName: "setOracle", args: [newOracle.address] }), expect: `OracleChanged event; oracle()==${newOracle.address}`, verify: castVault("oracle()(address)") + `  # ${newOracle.address}` },
    ethCallSpend("rotate.2.old-sig-rejected", "prove OLD oracle's signature is now REJECTED", await signSpend(oldOracle, nRotOld), nRotOld, "BadOracle"),
    { id: "rotate.3.new-sig-accepted", purpose: "prove NEW oracle's signature is ACCEPTED — spend succeeds", signer: "ANY_FUNDED", kind: "send", to: VAULT, value: "0", data: spendData(await signSpend(newOracle, nRotNew), nRotNew), expect: "VaultSpend event; payee +0.1 token", verify: castVault("nonceUsed(uint256)(bool)", String(nRotNew)) + "  # true" },
    { id: "rotate.4.setOracle-restore", purpose: `RESTORE oracle → ${oldOracle.address} (leave the vault exactly as found)`, signer: "OWNER", kind: "send", to: VAULT, value: "0", data: encodeFunctionData({ abi: VAULT_ABI, functionName: "setOracle", args: [oldOracle.address] }), expect: `OracleChanged event; oracle()==${oldOracle.address}`, verify: castVault("oracle()(address)") + `  # ${oldOracle.address} (restored)` },
  ];

  return { pause, rotation };
}

async function main(): Promise<void> {
  const EVID = fileURLToPath(new URL("../../internal/day0/soak-evidence/", import.meta.url));
  mkdirSync(EVID, { recursive: true });

  const sample = await buildSample();
  const drills = await buildDrills();

  const bundle = {
    network: { chainId: CHAIN_ID, rpc: RPC, explorer: "https://www.oklink.com/x-layer-testnet" },
    contracts: { vault: VAULT, token: TOKEN, receipts: RECEIPTS },
    keys: {
      OWNER: { address: OWNER, note: "human's own vault-owner wallet — signs pause/unpause/setOracle/ownerWithdraw" },
      WRITER: { address: WRITER, note: "authorized receipt writer (isWriter==true) — signs logReceipts" },
      oracleOld: { address: oldOracle.address, note: "vault's live oracle (anvil #1, public demo key) — sigs pre-baked by preparer" },
      oracleNew: { address: newOracle.address, note: "rotation target (anvil #2, public demo key) — sigs pre-baked by preparer" },
    },
    constants: { spendAmount: SPEND_AMT.toString(), expiry: EXPIRY.toString(), payee: PAYEE, approvedIntent: APPROVED_INTENT },
    representativeSample: { index: sample.index, txs: sample.txs },
    drills: { pause: drills.pause, oracleRotation: drills.rotation },
  };

  writeFileSync(`${EVID}public-bundle.json`, JSON.stringify(bundle, null, 2));
  const totalSend = [...sample.txs, ...drills.pause, ...drills.rotation].filter((t) => t.kind === "send").length;
  const totalCall = [...sample.txs, ...drills.pause, ...drills.rotation].filter((t) => t.kind !== "send").length;
  console.log(`public bundle written: ${EVID}public-bundle.json`);
  console.log(`  representative sample : ${sample.txs.length} txs (10 receipts + 4 spends)`);
  console.log(`  pause drill           : ${drills.pause.length} steps`);
  console.log(`  oracle-rotation drill : ${drills.rotation.length} steps`);
  console.log(`  → ${totalSend} real sends (public tx hashes) + ${totalCall} eth_call revert assertions`);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
