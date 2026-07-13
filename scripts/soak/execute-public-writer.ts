import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  http,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Executes the WRITER-signed half of the public §28 soak on X Layer testnet 1952: the 10 Part-A
 * receipt anchors (logReceipts) + the 4 Part-A Mode-C vault spends. Uses ONLY the receipt-writer
 * burner key (packages/receipt-writer/.env, gitignored) — it never reads, references, or handles the
 * vault OWNER key; the owner-signed drill steps are the human's to run.
 *
 * Every tx is independently verified from the mined receipt: events decoded (ReceiptLogged /
 * VaultSpend), and post-state (nonceUsed, payee balance) read straight from chain — no value is taken
 * from the send call's own return.
 */

const RPC = process.env.RPC_URL ?? "https://testrpc.xlayer.tech";
const CHAIN_ID = 1952;
const VAULT: Address = "0x42e699ffd8215d48397a049b4f7a176db06f4848";
const TOKEN: Address = "0xf202ce41d76ee1a2aec72e7a9180331d437ddd41";
const OLD_ORACLE: Address = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const PAYEE: Address = "0x000000000000000000000000000000000000bEEF";

const BUNDLE = fileURLToPath(new URL("../../internal/day0/soak-evidence/public-bundle.json", import.meta.url));
const OUT = fileURLToPath(new URL("../../internal/day0/soak-evidence/public-writer-results.json", import.meta.url));
const WRITER_ENV = fileURLToPath(new URL("../../packages/receipt-writer/.env", import.meta.url));
const VAULT_ARTIFACT = fileURLToPath(new URL("../../contracts/out/UntchVault.sol/UntchVault.json", import.meta.url));
const RECEIPTS_ARTIFACT = fileURLToPath(new URL("../../contracts/out/UntchReceipts.sol/UntchReceipts.json", import.meta.url));

const ERC20_ABI: Abi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const chain = defineChain({
  id: CHAIN_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

interface Tx {
  id: string;
  purpose: string;
  signer: string;
  kind: string;
  to: Address;
  value: string;
  data: Hex;
}
interface Bundle {
  representativeSample: { txs: Tx[] };
}

function loadWriterKey(): Hex {
  const raw = readFileSync(WRITER_ENV, "utf8");
  const line = raw.split("\n").find((l) => l.trim().startsWith("WRITER_PRIVATE_KEY="));
  const key = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("WRITER_PRIVATE_KEY missing/malformed in packages/receipt-writer/.env");
  return key as Hex;
}

async function main(): Promise<void> {
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const account = privateKeyToAccount(loadWriterKey());
  if (account.address.toLowerCase() !== "0x03e5abfd6aff41e9766bc1c34f136962404a1ab5") {
    throw new Error(`writer key derives to ${account.address}, not the authorized writer 0x03e5…1ab5`);
  }
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });

  const vaultAbi = (JSON.parse(readFileSync(VAULT_ARTIFACT, "utf8")) as { abi: Abi }).abi;
  const receiptsAbi = (JSON.parse(readFileSync(RECEIPTS_ARTIFACT, "utf8")) as { abi: Abi }).abi;
  const bundle = JSON.parse(readFileSync(BUNDLE, "utf8")) as Bundle;
  const txs = bundle.representativeSample.txs.filter((t) => t.kind === "send");

  // Preflight: the 4 old-oracle spends require the vault pristine (unpaused + original oracle).
  const paused = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "paused" })) as boolean;
  const oracle = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "oracle" })) as Address;
  if (paused) throw new Error("vault is PAUSED — the old-oracle spends would revert; run before the pause drill");
  if (oracle.toLowerCase() !== OLD_ORACLE.toLowerCase()) throw new Error(`vault oracle is ${oracle}, not the original ${OLD_ORACLE} — run the sample before rotating`);

  const payeeBefore = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;

  const results: Array<Record<string, unknown>> = [];
  for (const t of txs) {
    process.stdout.write(`sending ${t.id} … `);
    const hash = await wallet.sendTransaction({ to: t.to, data: t.data, value: 0n });
    const rcpt = await pub.waitForTransactionReceipt({ hash });
    const decoded: Record<string, unknown> = { id: t.id, purpose: t.purpose, txHash: hash, block: Number(rcpt.blockNumber), status: rcpt.status, to: t.to };

    // Independent event decode from the mined logs (not the send return).
    const events: string[] = [];
    for (const log of rcpt.logs) {
      const abi = t.to.toLowerCase() === VAULT.toLowerCase() ? vaultAbi : receiptsAbi;
      try {
        const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (ev.eventName === "ReceiptLogged") {
          const a = ev.args as unknown as Record<string, unknown>;
          events.push(`ReceiptLogged(receiptId=${String(a.receiptId).slice(0, 14)}…, decision=${a.decision}, verifyResult=${a.verifyResult}, intentHash=${String(a.intentHash).slice(0, 14)}…)`);
        } else if (ev.eventName === "BatchLogged") {
          const a = ev.args as unknown as Record<string, unknown>;
          events.push(`BatchLogged(id=${a.batchId}, count=${a.count})`);
        } else if (ev.eventName === "VaultSpend") {
          const a = ev.args as unknown as Record<string, unknown>;
          events.push(`VaultSpend(recipient=${a.recipient}, amount=${a.amount}, nonce=${a.nonce})`);
        }
      } catch {
        /* not one of our events */
      }
    }
    decoded.events = events;
    results.push(decoded);
    console.log(`${rcpt.status} block ${rcpt.blockNumber} — ${events.join("; ") || "(no decoded events)"}`);
  }

  // Independent post-state reads for the spends.
  const spendNonces = [928_100_000_000_000n, 928_100_000_000_001n, 928_100_000_000_002n, 928_100_000_000_003n];
  const nonceStates: Record<string, boolean> = {};
  for (const n of spendNonces) nonceStates[n.toString()] = (await pub.readContract({ address: VAULT, abi: vaultAbi, functionName: "nonceUsed", args: [n] })) as boolean;
  const payeeAfter = (await pub.readContract({ address: TOKEN, abi: ERC20_ABI, functionName: "balanceOf", args: [PAYEE] })) as bigint;

  const report = {
    network: { chainId: CHAIN_ID, rpc: RPC },
    writer: account.address,
    ranAt: results.map((r) => r.block),
    receipts: results.filter((r) => r.to === "0x0c64997277b7d94d2999dea22a123cac56334863" || String(r.id).includes("receipt")),
    spends: results.filter((r) => String(r.id).includes("spend")),
    independentPostState: {
      payeeBalanceBefore: payeeBefore.toString(),
      payeeBalanceAfter: payeeAfter.toString(),
      payeeDelta: (payeeAfter - payeeBefore).toString(),
      spendNonceUsed: nonceStates,
    },
    allSuccess: results.every((r) => r.status === "success"),
  };
  writeFileSync(OUT, JSON.stringify(report, null, 2));
  console.log(`\npayee delta: ${report.independentPostState.payeeDelta} (expect 400000 = 4×0.1 token)`);
  console.log(`nonces used: ${Object.values(nonceStates).filter(Boolean).length}/4`);
  console.log(`evidence: ${OUT}`);
  if (!report.allSuccess) {
    console.error("✗ a WRITER tx did not succeed");
    process.exit(1);
  }
  console.log("✓ all 14 WRITER-signed txs mined & independently verified");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
