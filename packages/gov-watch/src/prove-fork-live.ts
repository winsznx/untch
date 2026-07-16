import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TelegramChannel, loadTelegramConfig, type Channel } from "@untch/escalation";
import { GovernanceWatcher } from "./watcher";
import { MemoryCursor } from "./cursor";

/**
 * PROOF: the LIVE poll loop detects a FRESH `OpProposed` the moment it lands, and alerts for real.
 *
 * The companion to prove-testnet-alert.ts, which proves real-chain decode against the real deployed
 * contract but replays known history. This proves the other half — that `tick()` notices a proposal it
 * has never seen, while the cancel window is still open — which requires making a proposal, which
 * requires an admin key.
 *
 * WHY A FORK: this is the honest boundary. Making a real proposal on mainnet needs the mainnet admin
 * key, which no session ever handles; and mainnet has no contracts yet anyway. Making one on the real
 * testnet contract needs ITS admin key (0x98F43e…), which is not in this repo either. So the fresh
 * proposal is made against a real UntchReceipts, with real bytecode and a real 72h delay, deployed to
 * an anvil fork of real X Layer mainnet (chainId 196) where an admin key exists. The chain is forked;
 * the contract, the tx, the emitted event, the decode and the Telegram alert are all real.
 *
 * Prereq: anvil --fork-url https://rpc.xlayer.tech --port 8599
 * Run:    pnpm --filter @untch/gov-watch prove:fork
 */

const RPC = process.env.FORK_RPC ?? "http://127.0.0.1:8599";
const TIMELOCK = 259_200n; // 72h — the real mainnet value from the runbook
const OP_ADD_WRITER = 1;
const WRITER = "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5" as const;

const art = (p: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(`../../../contracts/out/${p}`, import.meta.url)), "utf8")) as {
    abi: Abi;
    bytecode: { object: Hex };
  };

// anvil dev key — LOCAL FORK ONLY. Never a real key; nothing it signs exists off this fork.
const DEV_KEY = "0xac0913a2c8b0eb8d3f6c1dabbd5b1b6f7d0d4c1a3e1f2b4c6d8e0a2c4e6f8a0b" as Hex;

async function main(): Promise<void> {
  const pub = createPublicClient({ transport: http(RPC) });
  const chainId = await pub.getChainId().catch(() => {
    throw new Error(`no fork at ${RPC} — start: anvil --fork-url https://rpc.xlayer.tech --port 8599`);
  });
  const chain = defineChain({
    id: chainId,
    name: `fork-${chainId}`,
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [RPC] } },
  });
  const account = privateKeyToAccount(DEV_KEY);
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });
  await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "anvil_setBalance", params: [account.address, "0xDE0B6B3A7640000"], id: 1 }),
  });

  const receiptsArt = art("UntchReceipts.sol/UntchReceipts.json");
  const registryArt = art("SpendIntentRegistry.sol/SpendIntentRegistry.json");

  console.log("── PROOF: live tick() detects a FRESH OpProposed → real Telegram alert ──");
  console.log(`fork of X Layer mainnet · chainId ${chainId} · rpc ${RPC}`);

  const dh = await wallet.deployContract({ abi: receiptsArt.abi, bytecode: receiptsArt.bytecode.object, args: [TIMELOCK] });
  const receipts = (await pub.waitForTransactionReceipt({ hash: dh })).contractAddress!;
  const rh = await wallet.deployContract({ abi: registryArt.abi, bytecode: registryArt.bytecode.object, args: [] });
  const registry = (await pub.waitForTransactionReceipt({ hash: rh })).contractAddress!;
  console.log(`UntchReceipts       ${receipts} (timelockDelay=${TIMELOCK}s = 72h, real bytecode)`);
  console.log(`SpendIntentRegistry ${registry}`);

  const channels: Channel[] = [new TelegramChannel({ config: loadTelegramConfig() })];
  const cursor = new MemoryCursor();
  const watcher = new GovernanceWatcher({
    client: pub,
    chainId,
    targets: [
      { name: "UntchReceipts", address: receipts as Address, abi: receiptsArt.abi },
      { name: "SpendIntentRegistry", address: registry as Address, abi: registryArt.abi },
    ],
    channels,
    cursor,
    log: (l) => console.log(l),
  });

  // First tick with no cursor parks the watcher at head: it is now watching, and has seen nothing.
  await watcher.tick();
  const idle = await watcher.tick();
  console.log(`\nwatcher live at head. idle tick found: ${idle === null ? "nothing (correct)" : "UNEXPECTED"}`);
  if (idle !== null) throw new Error("PROOF FAILED — watcher alerted on an empty chain.");

  // ── the fresh proposal — exactly what an attacker with a stolen admin key would do ──
  console.log(`\nproposing ADD_WRITER(${WRITER}) now …`);
  const ph = await wallet.writeContract({
    address: receipts,
    abi: receiptsArt.abi,
    functionName: "propose",
    args: [OP_ADD_WRITER, WRITER],
    chain,
    account,
  });
  const prcpt = await pub.waitForTransactionReceipt({ hash: ph });
  console.log(`propose landed: tx ${ph} block ${prcpt.blockNumber}`);

  console.log("\npolling …");
  const result = await watcher.tick();
  if (!result || result.alerts.length === 0) throw new Error("PROOF FAILED — live tick missed a fresh OpProposed.");

  const alert = result.alerts.find((a) => a.kind === "OpProposed");
  if (!alert) throw new Error(`PROOF FAILED — expected OpProposed, got ${result.alerts.map((a) => a.kind).join(",")}`);

  console.log(`\ndetected ${result.alerts.length} fresh event(s):`);
  for (const a of result.alerts) console.log(`  ${a.severity.toUpperCase()} ${a.kind} tx ${a.txHash}`);
  console.log(`\ncancel window on the fresh proposal:`);
  console.log(`  eta        ${alert.cancelWindow?.etaIso}`);
  console.log(`  remaining  ${alert.cancelWindow?.secondsRemaining}s (~${Math.round((alert.cancelWindow?.secondsRemaining ?? 0) / 3600)}h)`);
  console.log(`delivered: ${result.delivered}`);
  if (!result.delivered) throw new Error("PROOF FAILED — fresh OpProposed detected but no alert delivered.");
  if (!alert.cancelWindow || alert.cancelWindow.secondsRemaining < 250_000) {
    throw new Error("PROOF FAILED — the alert must carry a real, still-open ~72h cancel window.");
  }

  console.log(`\n✓ PROOF PASSED. Fresh proposal → live tick → real Telegram alert, with ~72h left to cancel().`);
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
