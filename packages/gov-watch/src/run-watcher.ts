import { fileURLToPath } from "node:url";
import { createPublicClient, http, type Address } from "viem";
import {
  DiscordChannel,
  SlackChannel,
  TelegramChannel,
  loadDiscordConfig,
  loadSlackConfig,
  loadTelegramConfig,
  type Channel,
} from "@untch/escalation";
import { chainById, resolveChainId, activeRpcUrl } from "@untch/shared/src/chains";
import { GovernanceWatcher } from "./watcher";
import { FileCursor } from "./cursor";
import { loadArtifactTargets, loadTargets } from "./targets";

/**
 * The governance watcher as a long-running service.
 *
 * Targets come from the phase-1 deployment artifact by default (ARTIFACT, written by
 * scripts/deploy-mainnet-suite.ts), so the moment mainnet phase 1 runs this points at the real
 * addresses with no edit. RECEIPTS_ADDRESS / SPEND_INTENT_REGISTRY_ADDRESS override for pointing it at
 * an already-deployed contract (e.g. the testnet UntchReceipts).
 *
 * Env:
 *   ARTIFACT                       deployment artifact path (default deployments/mainnet-suite.json)
 *   RECEIPTS_ADDRESS               override; skips the artifact
 *   SPEND_INTENT_REGISTRY_ADDRESS  override; skips the artifact
 *   CHAIN_ID / NETWORK / RPC_URL   standard chains.ts selection
 *   CURSOR_FILE                    cursor path (default deployments/gov-watch-cursor.json)
 *   FROM_BLOCK                     seed the cursor (scan starts at FROM_BLOCK+1); else start at head
 *   POLL_INTERVAL_SEC              default 15
 *   TELEGRAM_BOT_TOKEN/_CHAT_ID, DISCORD_BOT_TOKEN/_USER_ID, SLACK_BOT_TOKEN/_USER_ID  per channel;
 *                                  a channel is registered only if its credentials are present.
 */

const DEFAULT_POLL_SEC = 15;
const repoPath = (rel: string) => fileURLToPath(new URL(`../../../${rel}`, import.meta.url));

/**
 * Only channels whose credentials are actually present — never a stub that silently drops alerts.
 * Each is built through the escalation package's OWN config loader, so the env contract stays defined
 * in exactly one place and a channel here is the same channel the approval path uses.
 */
function liveChannels(): Channel[] {
  const channels: Channel[] = [];
  const tryAdd = (name: string, build: () => Channel) => {
    try {
      channels.push(build());
    } catch (err) {
      console.log(`channel "${name}" not configured — skipped (${(err as Error).message})`);
    }
  };
  tryAdd("telegram", () => new TelegramChannel({ config: loadTelegramConfig() }));
  tryAdd("discord", () => new DiscordChannel({ config: loadDiscordConfig() }));
  tryAdd("slack", () => new SlackChannel({ config: loadSlackConfig() }));
  return channels;
}

async function main(): Promise<void> {
  const receiptsOverride = process.env.RECEIPTS_ADDRESS?.trim();
  const registryOverride = process.env.SPEND_INTENT_REGISTRY_ADDRESS?.trim();

  let chainId: number;
  let targets;
  if (receiptsOverride && registryOverride) {
    chainId = resolveChainId(process.env);
    targets = loadTargets({ receipts: receiptsOverride as Address, spendIntentRegistry: registryOverride as Address });
  } else {
    const artifactPath = process.env.ARTIFACT?.trim() ?? repoPath("deployments/mainnet-suite.json");
    try {
      const loaded = loadArtifactTargets(artifactPath);
      chainId = loaded.chainId;
      targets = loaded.targets;
    } catch (err) {
      throw new Error(
        `No targets: could not read ${artifactPath} (${(err as Error).message}). Phase 1 has not been ` +
          `deployed yet, or set RECEIPTS_ADDRESS + SPEND_INTENT_REGISTRY_ADDRESS to watch an existing pair.`,
      );
    }
  }

  const rpcUrl = activeRpcUrl(process.env, chainId);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const liveChainId = await client.getChainId();
  if (liveChainId !== chainId) {
    throw new Error(`RPC ${rpcUrl} is chain ${liveChainId}, but targets are for chain ${chainId}. Refusing.`);
  }

  const channels = liveChannels();
  if (channels.length === 0) {
    throw new Error(
      "No channel credentials in env — the watcher would have nowhere to alert. Set at least " +
        "TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (or the Discord/Slack pair).",
    );
  }

  const explorer = chainById(chainId).blockExplorers?.default.url;
  const cursorPath = process.env.CURSOR_FILE?.trim() ?? repoPath("deployments/gov-watch-cursor.json");
  const cursor = new FileCursor(cursorPath);
  if (process.env.FROM_BLOCK?.trim()) await cursor.write(BigInt(process.env.FROM_BLOCK.trim()));

  const pollSec = Number(process.env.POLL_INTERVAL_SEC ?? DEFAULT_POLL_SEC);
  const watcher = new GovernanceWatcher({
    client,
    chainId,
    targets,
    channels,
    cursor,
    ...(explorer ? { explorerTxBase: `${explorer}/tx/` } : {}),
    log: (l) => console.log(l),
  });

  console.log("── governance watcher ──");
  console.log(`chain ${chainId} · rpc ${rpcUrl} · poll ${pollSec}s`);
  for (const t of targets) console.log(`watching ${String(t.name).padEnd(20)} ${t.address}`);
  console.log(`alerting via: ${channels.map((c) => c.name).join(", ")}`);
  console.log(`cursor: ${cursorPath}`);
  console.log("NOT watched: PolicyRegistry, UntchVaultFactory — no admin/writer/owner, no governance events.");

  let stopping = false;
  const stop = () => {
    stopping = true;
    console.log("\nstopping after current tick…");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    try {
      const result = await watcher.tick();
      if (result && result.alerts.length > 0) {
        console.log(`[${new Date().toISOString()}] ${result.alerts.length} governance event(s) in ${result.fromBlock}..${result.toBlock}`);
        for (const a of result.alerts) console.log(`  ${a.severity.toUpperCase()} ${a.kind} on ${a.contract} tx ${a.txHash}`);
      }
    } catch (err) {
      // Never exit on a transient RPC failure: a watcher that dies on one bad response is a watcher
      // that is not watching. The cursor did not advance, so the range is retried next tick.
      console.error(`[${new Date().toISOString()}] tick failed (will retry): ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, pollSec * 1000));
  }
}

main().catch((e) => {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
});
