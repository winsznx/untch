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
  X_LAYER_TESTNET_FAUCET_URL,
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

let testnetNativeWei: bigint | null = null;

for (const { chainId, chain, isTestnet } of NETWORKS) {
  const rpc = chain.rpcUrls.default.http[0];
  console.log(`── ${chain.name} (chainId ${chainId}) · ${rpc}`);

  try {
    const wei = await nativeBalance(chain);
    if (isTestnet) testnetNativeWei = wei;
    console.log(`   OKB (native): ${formatEther(wei)}  [${wei} wei]`);
  } catch (err) {
    console.log(`   OKB (native): ERROR reading balance — ${(err as Error).message}`);
    if (isTestnet) testnetNativeWei = null;
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
if (testnetNativeWei === null) {
  die(
    "FUNDING GATE FAIL: could not read testnet native OKB balance (RPC error above).\n" +
      "  Treating as unfunded (fail-closed).",
  );
}
if (testnetNativeWei === 0n) {
  console.error("\n✗ FUNDING GATE FAIL: testnet native OKB balance is ZERO.\n");
  console.error("  Fund the ops wallet with testnet OKB (gas), then re-run:");
  console.error(`    Faucet: ${X_LAYER_TESTNET_FAUCET_URL}`);
  console.error("    Steps:");
  console.error("      1. Open the faucet URL and sign in with an OKX account.");
  console.error("      2. Select network: X Layer Testnet (chainId 1952).");
  console.error(`      3. Paste the ops wallet address: ${wallet}`);
  console.error("      4. Complete the captcha / eligibility check and claim testnet OKB.");
  console.error("      5. Wait for confirmation, then re-run `pnpm check-wallet`.");
  process.exit(1);
}

console.log(
  `\n✓ FUNDING GATE PASS: testnet native OKB balance is ${formatEther(testnetNativeWei)} (> 0).`,
);
process.exit(0);
