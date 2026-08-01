import {
  activeChain,
  activeRpcUrl,
  CONTRACTS_BY_CHAIN,
  DEFAULT_CHAIN_ID,
  X_LAYER_MAINNET_ID,
  X_LAYER_TESTNET_ID,
} from "@untch/shared";
import type { Address, Chain, Hex } from "viem";

/**
 * Policy-store configuration. Two consumer shapes, mirroring the receipt-writer split:
 *   • the READ side (preflight's PolicyProvider) needs only DATABASE_URL — it loads stored policies,
 *     never signs.
 *   • the WRITE side (the create/update/pause tools) additionally needs the operator wallet key + RPC
 *     + the PolicyRegistry address, because it broadcasts real registerPolicy/updatePolicy/pausePolicy.
 *
 * The chain + RPC are resolved through the single shared source (packages/shared/src/chains.ts) via
 * the CHAIN_ID/NETWORK env contract — no chain constants live here. The default network is whatever
 * `DEFAULT_CHAIN_ID` says, which is mainnet.
 */

export { X_LAYER_MAINNET_ID, X_LAYER_TESTNET_ID, xLayerMainnet, xLayerTestnet } from "@untch/shared";

/**
 * Deployed PolicyRegistry (§10.1) on the DEFAULT network — which is mainnet, the network this build
 * ships on.
 *
 * It defaulted to testnet, with a module comment saying so, while `DEFAULT_CHAIN_ID` said mainnet.
 * Production overrode it through `POLICY_REGISTRY`, so the wrong value never served — but a default
 * that is only ever correct because something else overrides it is a trap with a timer on it: the
 * first environment that forgets the override anchors policies to a network nobody is watching.
 * The default now follows `DEFAULT_CHAIN_ID`, so there is one answer to "which network is default"
 * rather than two that happen to disagree.
 *
 * Overridable via POLICY_REGISTRY, but never guess a different address — a stale one silently anchors
 * to nothing.
 */
export const POLICY_REGISTRY_DEFAULT: Address = CONTRACTS_BY_CHAIN[DEFAULT_CHAIN_ID]!.policyRegistry;

/**
 * PolicyRegistry address per network, sourced from the shared CONTRACTS_BY_CHAIN registry (chains.ts)
 * so testnet + mainnet stay in one canonical place. Any other chain has no default and must pass
 * POLICY_REGISTRY explicitly rather than silently reusing another network's address.
 */
export const POLICY_REGISTRY_BY_CHAIN: Partial<Record<number, Address>> = {
  [X_LAYER_TESTNET_ID]: CONTRACTS_BY_CHAIN[X_LAYER_TESTNET_ID]!.policyRegistry,
  [X_LAYER_MAINNET_ID]: CONTRACTS_BY_CHAIN[X_LAYER_MAINNET_ID]!.policyRegistry,
};

export function resolvePolicyRegistry(chainId: number, override?: string): Address {
  const addr = override?.trim() || POLICY_REGISTRY_BY_CHAIN[chainId];
  if (!addr) {
    throw new Error(
      `No PolicyRegistry address for chainId ${chainId} — deploy PolicyRegistry to that network and set POLICY_REGISTRY.`,
    );
  }
  return addr as Address;
}

export class MissingEnvError extends Error {
  constructor(public readonly varName: string) {
    super(`Missing required environment variable: ${varName}`);
    this.name = "MissingEnvError";
  }
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") throw new MissingEnvError(name);
  return v.trim();
}

/** Read side: enqueue-equivalent. No signing key, no RPC. */
export interface StorageConfig {
  readonly databaseUrl: string;
}

export function loadStorageConfig(): StorageConfig {
  return { databaseUrl: requireEnv("DATABASE_URL") };
}

/**
 * Create/sync side WITHOUT a signing key — the per-caller `create_spend_policy` surface. It needs the
 * RPC + PolicyRegistry address to BUILD the unsigned registerPolicy call and READ back a confirmed
 * registration, but it never signs (the caller's own wallet does). This is the config the store wires
 * whenever DATABASE_URL is set, independent of OPERATOR_PRIVATE_KEY. Testnet only.
 */
export interface RegistryConfig extends StorageConfig {
  readonly rpcUrl: string;
  readonly chain: Chain;
  readonly registry: Address;
}

export function loadRegistryConfig(): RegistryConfig {
  const chain = activeChain(process.env);
  const rpcUrl = activeRpcUrl(process.env);
  const registry = resolvePolicyRegistry(chain.id, process.env.POLICY_REGISTRY);
  return { ...loadStorageConfig(), rpcUrl, chain, registry };
}

/**
 * Write side: the operator identity that signs registerPolicy/updatePolicy/pausePolicy. In this
 * interim build `operatorPrivateKey` is the demo/burner wallet 0x98F43e… (OPERATOR_PRIVATE_KEY),
 * a TEMPORARY stand-in for the operator's own dashboard-connected wallet (§15) — see the README's
 * "operator-signing" section for the target state (backend returns unsigned calldata; the operator's
 * wallet signs). Network follows the shared CHAIN_ID/NETWORK selection (default testnet); a mainnet
 * run requires an explicit POLICY_REGISTRY address — it never reuses the testnet default on mainnet.
 */
export interface OperatorConfig extends RegistryConfig {
  readonly operatorPrivateKey: Hex;
}

export function loadOperatorConfig(): OperatorConfig {
  const operatorPrivateKey = requireEnv("OPERATOR_PRIVATE_KEY");
  if (!/^0x[0-9a-fA-F]{64}$/.test(operatorPrivateKey)) {
    throw new Error("OPERATOR_PRIVATE_KEY is not a valid 0x 32-byte private key");
  }
  return { ...loadRegistryConfig(), operatorPrivateKey: operatorPrivateKey as Hex };
}
