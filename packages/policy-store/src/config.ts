import { defineChain, type Address, type Chain, type Hex } from "viem";

/**
 * Policy-store configuration. Two consumer shapes, mirroring the receipt-writer split:
 *   • the READ side (preflight's PolicyProvider) needs only DATABASE_URL — it loads stored policies,
 *     never signs.
 *   • the WRITE side (the create/update/pause tools) additionally needs the operator wallet key + RPC
 *     + the PolicyRegistry address, because it broadcasts real registerPolicy/updatePolicy/pausePolicy.
 */

export const X_LAYER_TESTNET_ID = 1952 as const;
export const X_LAYER_MAINNET_ID = 196 as const;

/**
 * Deployed PolicyRegistry (§10.1) on X Layer testnet — the anchoring target. This is the POST-lint-fix
 * redeploy (supersedes the earlier 0xc571…); see contracts/deploy/testnet-receipt.json. Overridable
 * via POLICY_REGISTRY, but never guess a different address — a stale one silently anchors to nothing.
 */
export const POLICY_REGISTRY_DEFAULT: Address = "0xe1d74c90801db0fa806c72eb818b7671b8233532";

export const xLayerTestnet: Chain = defineChain({
  id: X_LAYER_TESTNET_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: { default: { http: ["https://testrpc.xlayer.tech", "https://xlayertestrpc.okx.com"] } },
  blockExplorers: { default: { name: "OKLink", url: "https://www.oklink.com/x-layer-testnet" } },
  testnet: true,
});

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
  const rpcUrl = process.env.RPC_URL?.trim() || xLayerTestnet.rpcUrls.default.http[0]!;
  const registry = (process.env.POLICY_REGISTRY?.trim() || POLICY_REGISTRY_DEFAULT) as Address;
  return { ...loadStorageConfig(), rpcUrl, chain: xLayerTestnet, registry };
}

/**
 * Write side: the operator identity that signs registerPolicy/updatePolicy/pausePolicy. In this
 * interim build `operatorPrivateKey` is the demo/burner wallet 0x98F43e… (OPERATOR_PRIVATE_KEY),
 * a TEMPORARY stand-in for the operator's own dashboard-connected wallet (§15) — see the README's
 * "operator-signing" section for the target state (backend returns unsigned calldata; the operator's
 * wallet signs). Refuses X Layer mainnet (196): testnet only until the full §28 checklist clears.
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
