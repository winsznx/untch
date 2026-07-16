import { createPublicClient, http } from "viem";
import { TelegramChannel, loadTelegramConfig, type Channel } from "@untch/escalation";
import { GovernanceWatcher } from "./watcher";
import { MemoryCursor } from "./cursor";
import { loadTargets } from "./targets";

/**
 * PROOF: the real watcher, against the REAL deployed X Layer testnet contracts, over the REAL public
 * RPC, alerting through the REAL Telegram bot.
 *
 * Nothing here is mocked. The events it finds are the genuine `OpProposed` / `WriterAdded` /
 * `OpExecuted` that the real 60-second timelock writer provisioning emitted on 2026-07-10 (propose tx
 * 0x253c8689…, execute tx 0x75b4128d…) — the same event types the mainnet 72h timelock will emit.
 *
 * It REPLAYS a known 72-block window rather than running the live `tick()` loop, because those real
 * events are ~15k blocks behind head and the RPC caps ranges at 100 blocks: catching up from there to
 * head would be thousands of sequential requests to prove nothing extra. Live fresh-event detection
 * through `tick()` is proven separately in prove-fork-live.ts. What this proves is the part that only a
 * real chain can: real logs → real ABI decode → real alert on a real operator's phone.
 *
 * Run: pnpm --filter @untch/gov-watch prove:testnet
 */

const RECEIPTS = "0x0C64997277b7D94d2999DEa22A123cac56334863" as const;
const REGISTRY = "0xf87e50f83172c2DacE7D274e4c701212caEB1372" as const;
const RPC = "https://testrpc.xlayer.tech";
const CHAIN_ID = 1952;

// The real provisioning window: propose landed in 35236666, execute in 35236737.
const FROM = 35_236_666n;
const TO = 35_236_737n;

async function main(): Promise<void> {
  const client = createPublicClient({ transport: http(RPC) });
  const liveChainId = await client.getChainId();
  if (liveChainId !== CHAIN_ID) throw new Error(`expected chain ${CHAIN_ID}, RPC says ${liveChainId}`);

  // Prove the contract is really there and really is the timelocked one, read live.
  const delay = await client.readContract({
    address: RECEIPTS,
    abi: [{ type: "function", name: "timelockDelay", inputs: [], outputs: [{ type: "uint64" }], stateMutability: "view" }],
    functionName: "timelockDelay",
  });

  const channels: Channel[] = [new TelegramChannel({ config: loadTelegramConfig() })];

  console.log("── PROOF: real testnet contracts → real Telegram alert ──");
  console.log(`chain ${liveChainId} (X Layer testnet) · rpc ${RPC}`);
  console.log(`UntchReceipts       ${RECEIPTS} · timelockDelay=${delay}s (read live)`);
  console.log(`SpendIntentRegistry ${REGISTRY}`);
  console.log(`replaying REAL blocks ${FROM}..${TO} (the real 60s-timelock provisioning)`);
  console.log(`alerting via: ${channels.map((c) => c.name).join(", ")}\n`);

  const watcher = new GovernanceWatcher({
    client,
    chainId: CHAIN_ID,
    targets: loadTargets({ receipts: RECEIPTS, spendIntentRegistry: REGISTRY }),
    channels,
    cursor: new MemoryCursor(),
    explorerTxBase: "https://www.oklink.com/x-layer-testnet/tx/",
    log: (l) => console.log(l),
  });

  const result = await watcher.scanRange(FROM, TO);

  console.log(`\nfound ${result.alerts.length} REAL governance event(s):`);
  for (const a of result.alerts) {
    console.log(`  ${a.severity.toUpperCase().padEnd(8)} ${a.kind.padEnd(14)} block ${a.blockNumber} tx ${a.txHash}`);
    for (const [k, v] of Object.entries(a.fields)) console.log(`           ${k}: ${v}`);
  }
  console.log(`\ndelivered to at least one channel: ${result.delivered}`);
  if (!result.delivered) throw new Error("PROOF FAILED — real events found but no alert was delivered.");
  if (result.alerts.length === 0) throw new Error("PROOF FAILED — expected the real provisioning events, found none.");
  const kinds = result.alerts.map((a) => a.kind).sort();
  console.log(`\n✓ PROOF PASSED. Real chain → real decode → real alert. Events: ${kinds.join(", ")}`);
  console.log("  Check the Telegram chat: the OpProposed alert names the cancel window and the on-chain lever.");
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
