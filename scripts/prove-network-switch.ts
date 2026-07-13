/**
 * ENV-FLIP PROOF (the point of the shared-chains refactor).
 *
 * With ZERO code changes, flipping the single network-selection env var (CHAIN_ID) from testnet to
 * mainnet must switch EVERY consumer's resolved chain ID, RPC URL, and token addresses. This script
 * drives the SAME config loaders the real services use — under CHAIN_ID=1952 then CHAIN_ID=196 — and
 * asserts each one moves to the real X Layer mainnet values. Nothing here redefines a chain; every
 * value comes from packages/shared/src/chains.ts.
 *
 * It also proves the honest guard: on mainnet, a library whose contract is deployed only to testnet
 * refuses to reuse a testnet address — it demands an explicit mainnet address instead of silently
 * anchoring to the wrong place.
 */
import {
  activeChain,
  activeRpcUrl,
  confirmedTokenAllowlist,
  settlementToken,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
} from "../packages/shared/src/chains";
import { loadWorkerConfig } from "../packages/receipt-writer/src/config";
import { loadRegistryConfig } from "../packages/policy-store/src/config";
import { loadAnchorConfig as loadScoreAnchorConfig } from "../packages/trust-bureau/src/config";
import { loadAnchorConfig as loadAuditAnchorConfig } from "../packages/reports/src/config";

const MAINNET_USDT0 = "0x779Ded0c9e1022225f8E0630b35a9b54bE713736".toLowerCase();
const MAINNET_RPC = "https://rpc.xlayer.tech";
const TESTNET_RPC = "https://testrpc.xlayer.tech";

// Placeholder mainnet contract addresses — used ONLY to prove the loaders resolve end-to-end on
// mainnet. The real deployments do not exist yet, which is exactly why they must be passed explicitly.
const MAINNET_POLICY_REGISTRY = "0x00000000000000000000000000000000000000A1";
const MAINNET_RECEIPTS = "0x00000000000000000000000000000000000000B2";

const BASE_ENV: Record<string, string> = {
  DATABASE_URL: "postgres://proof:proof@localhost:5432/proof",
  REDIS_URL: "redis://localhost:6379",
  WRITER_PRIVATE_KEY: `0x${"1".repeat(64)}`,
  OPERATOR_PRIVATE_KEY: `0x${"2".repeat(64)}`,
};

const NETWORK_KEYS = ["CHAIN_ID", "NETWORK", "RPC_URL", "POLICY_REGISTRY", "RECEIPTS_CONTRACT"];
const ALL_KEYS = [...NETWORK_KEYS, ...Object.keys(BASE_ENV)];

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const k of ALL_KEYS) saved.set(k, process.env[k]);
  for (const k of ALL_KEYS) delete process.env[k];
  for (const [k, v] of Object.entries({ ...BASE_ENV, ...overrides })) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const k of ALL_KEYS) {
      const v = saved.get(k);
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = String(actual) === String(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? "✓" : "✗"} ${label}: ${String(actual)}${ok ? "" : ` (expected ${String(expected)})`}`);
}

console.log("\n════════ ENV-FLIP PROOF: single CHAIN_ID switches every consumer ════════\n");

console.log("shared primitives (the one source every consumer calls):");
console.log("── CHAIN_ID=1952 (testnet) ──");
withEnv({ CHAIN_ID: String(X_LAYER_TESTNET_ID) }, () => {
  check("activeChain().id", activeChain(process.env).id, X_LAYER_TESTNET_ID);
  check("activeRpcUrl()", activeRpcUrl(process.env), TESTNET_RPC);
  check("confirmedTokenAllowlist length (no confirmed testnet stablecoin)", confirmedTokenAllowlist(activeChain(process.env).id).length, 0);
});
console.log("── CHAIN_ID=196 (mainnet) ──");
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID) }, () => {
  const id = activeChain(process.env).id;
  check("activeChain().id", id, X_LAYER_MAINNET_ID);
  check("activeRpcUrl()", activeRpcUrl(process.env), MAINNET_RPC);
  check("settlementToken().address == real mainnet USDT0", settlementToken(id).address.toLowerCase(), MAINNET_USDT0);
  check("confirmedTokenAllowlist non-empty (real mainnet stablecoins)", confirmedTokenAllowlist(id).length > 0, true);
});
console.log("── NETWORK=eip155:196 (CAIP-2 form of the same var) ──");
withEnv({ NETWORK: "eip155:196" }, () => {
  check("activeChain().id", activeChain(process.env).id, X_LAYER_MAINNET_ID);
});

console.log("\nreceipt-writer · loadWorkerConfig():");
withEnv({ CHAIN_ID: String(X_LAYER_TESTNET_ID) }, () => {
  const c = loadWorkerConfig();
  check("chain.id", c.chain.id, X_LAYER_TESTNET_ID);
  check("rpcUrl", c.rpcUrl, TESTNET_RPC);
});
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID), RECEIPTS_CONTRACT: MAINNET_RECEIPTS }, () => {
  const c = loadWorkerConfig();
  check("chain.id", c.chain.id, X_LAYER_MAINNET_ID);
  check("rpcUrl", c.rpcUrl, MAINNET_RPC);
  check("receiptsContract (explicit mainnet)", c.receiptsContract.toLowerCase(), MAINNET_RECEIPTS.toLowerCase());
});

console.log("\npolicy-store · loadRegistryConfig():");
withEnv({ CHAIN_ID: String(X_LAYER_TESTNET_ID) }, () => {
  const c = loadRegistryConfig();
  check("chain.id", c.chain.id, X_LAYER_TESTNET_ID);
  check("rpcUrl", c.rpcUrl, TESTNET_RPC);
});
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID), POLICY_REGISTRY: MAINNET_POLICY_REGISTRY }, () => {
  const c = loadRegistryConfig();
  check("chain.id", c.chain.id, X_LAYER_MAINNET_ID);
  check("rpcUrl", c.rpcUrl, MAINNET_RPC);
  check("registry (explicit mainnet)", c.registry.toLowerCase(), MAINNET_POLICY_REGISTRY.toLowerCase());
});

console.log("\ntrust-bureau · loadAnchorConfig() and reports · loadAnchorConfig():");
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID), RECEIPTS_CONTRACT: MAINNET_RECEIPTS }, () => {
  const s = loadScoreAnchorConfig();
  const a = loadAuditAnchorConfig();
  check("trust-bureau chain.id", s.chain.id, X_LAYER_MAINNET_ID);
  check("trust-bureau rpcUrl", s.rpcUrl, MAINNET_RPC);
  check("reports chain.id", a.chain.id, X_LAYER_MAINNET_ID);
  check("reports rpcUrl", a.rpcUrl, MAINNET_RPC);
});

console.log("\nASP seller · CHAIN = activeChain(env, mainnet-fallback), SETTLEMENT_TOKEN = settlementToken(chainId):");
withEnv({}, () => {
  // asp's exact expression: no CHAIN_ID set → its own mainnet fallback.
  const chain = activeChain(process.env, X_LAYER_MAINNET_ID);
  check("default (no CHAIN_ID) chain.id", chain.id, X_LAYER_MAINNET_ID);
  check("default SETTLEMENT_TOKEN.address", settlementToken(chain.id).address.toLowerCase(), MAINNET_USDT0);
  check("default NETWORK string", `eip155:${chain.id}`, "eip155:196");
});
withEnv({ CHAIN_ID: String(X_LAYER_TESTNET_ID) }, () => {
  const chain = activeChain(process.env, X_LAYER_MAINNET_ID);
  check("CHAIN_ID=1952 flips asp chain.id", chain.id, X_LAYER_TESTNET_ID);
  let threw = false;
  try {
    settlementToken(chain.id);
  } catch {
    threw = true;
  }
  check("asp on testnet has NO confirmed settlement token (honest fail)", threw, true);
});

console.log("\nHonest guard · mainnet without an explicit contract address refuses (no stale testnet reuse):");
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID) }, () => {
  let threw = false;
  try {
    loadRegistryConfig();
  } catch {
    threw = true;
  }
  check("policy-store refuses mainnet without POLICY_REGISTRY", threw, true);
});
withEnv({ CHAIN_ID: String(X_LAYER_MAINNET_ID) }, () => {
  let threw = false;
  try {
    loadWorkerConfig();
  } catch {
    threw = true;
  }
  check("receipt-writer refuses mainnet without RECEIPTS_CONTRACT", threw, true);
});

console.log(`\n════════ ${failures === 0 ? "PASS" : "FAIL"} — ${failures} failed check(s) ════════\n`);
if (failures > 0) process.exit(1);
