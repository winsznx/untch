import {
  createPublicClient,
  erc20Abi,
  formatEther,
  formatUnits,
  getAddress,
  http,
  isAddress,
  type Address,
  type Chain,
} from "viem";
import {
  isConfirmed,
  TOKENS,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
  xLayerMainnet,
  xLayerTestnet,
  type ConfirmedToken,
} from "../packages/shared/src/chains";

try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env file present — fall back to the ambient environment (e.g. CI-provided vars).
}

function die(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

const raw = process.env.OPS_WALLET_ADDRESS?.trim();
if (!raw) {
  die(
    "OPS_WALLET_ADDRESS is not set. Add it to .env (documented in .env.example).\n" +
      "  This is the funding gate — with no ops wallet address there is nothing to check.",
  );
}
if (!isAddress(raw)) {
  die(`OPS_WALLET_ADDRESS is not a valid EVM address: "${raw}"`);
}
const wallet: Address = getAddress(raw);

const NETWORKS: { chainId: number; chain: Chain; isTestnet: boolean }[] = [
  { chainId: X_LAYER_MAINNET_ID, chain: xLayerMainnet, isTestnet: false },
  { chainId: X_LAYER_TESTNET_ID, chain: xLayerTestnet, isTestnet: true },
];

async function nativeBalance(chain: Chain): Promise<bigint> {
  const client = createPublicClient({ chain, transport: http() });
  return client.getBalance({ address: wallet });
}

async function tokenBalance(chain: Chain, token: ConfirmedToken): Promise<bigint> {
  const client = createPublicClient({ chain, transport: http() });
  return client.readContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [wallet],
  });
}

console.log(`Ops wallet: ${wallet}`);
console.log(`Checked at: ${new Date().toISOString()}\n`);

// D0.1 proved no testnet facilitator exists; mainnet is the operative network for this
// entire build. The funding gate therefore checks MAINNET native OKB, not testnet.
const MIN_MAINNET_NATIVE_WEI = 500_000_000_000_000n; // 0.0005 OKB — a few cents; covers many X Layer gas txns

let mainnetNativeWei: bigint | null = null;

for (const { chainId, chain, isTestnet } of NETWORKS) {
  const rpc = chain.rpcUrls.default.http[0];
  console.log(`── ${chain.name} (chainId ${chainId}) · ${rpc}`);

  try {
    const wei = await nativeBalance(chain);
    if (!isTestnet) mainnetNativeWei = wei;
    console.log(`   OKB (native): ${formatEther(wei)}  [${wei} wei]`);
  } catch (err) {
    console.log(`   OKB (native): ERROR reading balance — ${(err as Error).message}`);
    if (!isTestnet) mainnetNativeWei = null;
  }

  const tokens = TOKENS[chainId as keyof typeof TOKENS] ?? {};
  for (const token of Object.values(tokens)) {
    if (!isConfirmed(token)) {
      console.log(`   ${token.symbol}: skipped — UNCONFIRMED address (${token.reason})`);
      continue;
    }
    try {
      const bal = await tokenBalance(chain, token);
      console.log(
        `   ${token.symbol}: ${formatUnits(bal, token.decimals)}  [${bal} · ${token.address}]`,
      );
    } catch (err) {
      console.log(`   ${token.symbol}: ERROR reading balance — ${(err as Error).message}`);
    }
  }
  console.log("");
}

console.log("──────────────────────────────────────────────");
if (mainnetNativeWei === null) {
  die(
    "FUNDING GATE FAIL: could not read mainnet native OKB balance (RPC error above).\n" +
      "  Treating as unfunded (fail-closed).",
  );
}
if (mainnetNativeWei < MIN_MAINNET_NATIVE_WEI) {
  console.error(
    `\n✗ FUNDING GATE FAIL: mainnet native OKB balance is ${formatEther(mainnetNativeWei)} ` +
      `(below the ${formatEther(MIN_MAINNET_NATIVE_WEI)} OKB floor).\n`,
  );
  console.error("  Fund the ops wallet with mainnet OKB (gas) on X Layer (chainId 196), then re-run:");
  console.error(`    Ops wallet: ${wallet}`);
  console.error("    A dollar or so of OKB covers thousands of X Layer gas transactions.");
  process.exit(1);
}

console.log(
  `\n✓ FUNDING GATE PASS: mainnet native OKB balance is ${formatEther(mainnetNativeWei)} ` +
    `(≥ ${formatEther(MIN_MAINNET_NATIVE_WEI)} OKB floor).`,
);
process.exit(0);
