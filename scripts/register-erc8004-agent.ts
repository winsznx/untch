/**
 * Register Untch on the X Layer mainnet ERC-8004 Identity registry.
 *
 * Safety:
 *   - Does NOT invent keys. Requires AGENT_OWNER_PRIVATE_KEY in env (fresh agent-owner wallet).
 *   - Asserts name()/symbol() before write.
 *   - agentURI defaults to https://asp.untch.xyz/agent-registration.json
 *
 * Dry-run (default): prints cast command + readiness checks. No tx.
 * Live: AGENT_OWNER_PRIVATE_KEY=0x… REGISTER_LIVE=1 pnpm exec tsx scripts/register-erc8004-agent.ts
 *
 * After success: set Railway ERC8004_AGENT_ID=<id> ERC8004_ACTIVE=true on untch-asp and redeploy.
 */

import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { xLayerMainnet } from "../packages/shared/src/chains";

const IDENTITY = "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address;
const AGENT_URI =
  process.env.ERC8004_AGENT_URI?.trim() || "https://asp.untch.xyz/agent-registration.json";
const RPC = process.env.RPC_URL?.trim() || "https://rpc.xlayer.tech";

const ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

async function main() {
  const pub = createPublicClient({ chain: xLayerMainnet, transport: http(RPC) });

  console.log("=== ERC-8004 Identity register (X Layer mainnet) ===");
  console.log(`registry  ${IDENTITY}`);
  console.log(`agentURI  ${AGENT_URI}`);
  console.log(`rpc       ${RPC}`);

  // Preflight: card reachable
  try {
    const res = await fetch(AGENT_URI, { method: "GET" });
    const body = (await res.json()) as { type?: string; name?: string; image?: string };
    console.log(`\ncard HTTP ${res.status}`);
    console.log(`  type: ${body.type}`);
    console.log(`  name: ${body.name}`);
    console.log(`  image: ${body.image}`);
    if (body.type !== "https://eips.ethereum.org/EIPS/eip-8004#registration-v1") {
      console.error("FAIL: card type string is wrong — do not mint until fixed");
      process.exit(1);
    }
    if (body.image) {
      const img = await fetch(body.image, { method: "HEAD" });
      console.log(`  image HEAD ${img.status}`);
      if (!img.ok) {
        console.error("FAIL: image URL not reachable — card will not render");
        process.exit(1);
      }
    }
  } catch (err) {
    console.error("FAIL: could not fetch agentURI", err);
    process.exit(1);
  }

  const [name, symbol] = await Promise.all([
    pub.readContract({ address: IDENTITY, abi: ABI, functionName: "name" }),
    pub.readContract({ address: IDENTITY, abi: ABI, functionName: "symbol" }),
  ]);
  console.log(`\nidentity name/symbol: ${name} / ${symbol}`);
  if (name !== "AgentIdentity" || symbol !== "AGENT") {
    console.error("FAIL: unexpected Identity registry — abort");
    process.exit(1);
  }

  const live = process.env.REGISTER_LIVE === "1";
  const pk = process.env.AGENT_OWNER_PRIVATE_KEY?.trim() as Hex | undefined;

  if (!live || !pk) {
    console.log(`
=== DRY RUN (no tx) ===

1) Generate a fresh agent-owner wallet (do NOT reuse the contract deployer):

   cast wallet new

2) Fund it with a little OKB on X Layer mainnet (gas only).

3) Confirm card + image are live (already checked above).

4) Mint:

   export AGENT_OWNER_PRIVATE_KEY=0xYOUR_KEY
   export REGISTER_LIVE=1
   export RPC_URL=${RPC}
   pnpm exec tsx scripts/register-erc8004-agent.ts

   # or with cast:
   cast send ${IDENTITY} "register(string)" "${AGENT_URI}" \\
     --rpc-url ${RPC} \\
     --private-key $AGENT_OWNER_PRIVATE_KEY

5) Read agentId from the Registered event (or script output).

6) Set on Railway untch-asp and redeploy:

   railway variable set ERC8004_AGENT_ID=<agentId> --service untch-asp
   railway variable set ERC8004_ACTIVE=true --service untch-asp

7) Verify:

   curl -sS https://asp.untch.xyz/agent-registration.json | jq .registrations
   curl -sS https://asp.untch.xyz/.well-known/agent-registration.json | jq .active
`);
    return;
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    console.error("AGENT_OWNER_PRIVATE_KEY must be 0x + 64 hex");
    process.exit(1);
  }

  const account = privateKeyToAccount(pk);
  const bal = await pub.getBalance({ address: account.address });
  console.log(`\nowner ${account.address}`);
  console.log(`OKB   ${Number(bal) / 1e18}`);
  if (bal === 0n) {
    console.error("FAIL: agent-owner has 0 OKB — fund gas first");
    process.exit(1);
  }

  const wallet = createWalletClient({
    account,
    chain: xLayerMainnet,
    transport: http(RPC),
  });

  console.log("\nSending register(agentURI)...");
  const hash = await wallet.writeContract({
    address: IDENTITY,
    abi: ABI,
    functionName: "register",
    args: [AGENT_URI],
    account,
    chain: xLayerMainnet,
  });
  console.log(`tx ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(`status ${receipt.status} block ${receipt.blockNumber}`);

  let agentId: bigint | null = null;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === "Registered") {
        agentId = decoded.args.agentId as bigint;
        console.log(`Registered agentId=${agentId} owner=${decoded.args.owner}`);
      }
    } catch {
      // not our event
    }
  }

  if (agentId === null) {
    console.warn("Could not decode agentId from logs — check explorer for Registered event");
  } else {
    console.log(`
=== NEXT ===
railway variable set ERC8004_AGENT_ID=${agentId} --service untch-asp
railway variable set ERC8004_ACTIVE=true --service untch-asp
# then redeploy untch-asp
`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
