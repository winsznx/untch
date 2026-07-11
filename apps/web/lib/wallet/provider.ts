import {
  createPublicClient,
  createWalletClient,
  custom,
  http,
  type Account,
  type Address,
  type EIP1193Provider,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  X_LAYER_TESTNET_ADD_PARAMS,
  X_LAYER_TESTNET_HEX,
  X_LAYER_TESTNET_ID,
  xLayerTestnet,
} from "../chain/chains";

/**
 * Injected-wallet plumbing with OKX Wallet as the priority connector (§15 auth requirement).
 *
 * OKX Wallet injects its own EIP-1193 provider at `window.okxwallet`; a generic browser wallet lands
 * at `window.ethereum`. We prefer `window.okxwallet` when present and fall back to `window.ethereum`
 * so the dashboard still works with any injected wallet, while OKX is the first-class path the product
 * pitches. Everything downstream (SIWE sign-in, policy/vault writes) speaks to whichever provider this
 * resolves — the rest of the app never reaches into `window` directly.
 */

interface OkxInjected {
  okxwallet?: EIP1193Provider;
  ethereum?: EIP1193Provider;
}

export type WalletKind = "okx" | "injected";

export interface DetectedProvider {
  readonly provider: EIP1193Provider;
  readonly kind: WalletKind;
  readonly label: string;
}

/** Resolve the injected provider, OKX first. Returns null when no wallet is installed. */
export function detectProvider(): DetectedProvider | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as OkxInjected;
  if (w.okxwallet) return { provider: w.okxwallet, kind: "okx", label: "OKX Wallet" };
  if (w.ethereum) return { provider: w.ethereum, kind: "injected", label: "Browser wallet" };
  return null;
}

/** The OKX Wallet download page — shown when no injected wallet is present. */
export const OKX_WALLET_URL = "https://web3.okx.com/download";

export async function requestAccounts(provider: EIP1193Provider): Promise<Address[]> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  return accounts;
}

export async function getAccounts(provider: EIP1193Provider): Promise<Address[]> {
  const accounts = (await provider.request({ method: "eth_accounts" })) as Address[];
  return accounts;
}

export async function getChainId(provider: EIP1193Provider): Promise<number> {
  const hex = (await provider.request({ method: "eth_chainId" })) as string;
  return Number.parseInt(hex, 16);
}

/**
 * Put the wallet on X Layer testnet, adding the network first if the wallet doesn't know it. EIP-3326
 * `wallet_switchEthereumChain` throws 4902 when the chain is unknown; on that we add it (EIP-3085) and
 * switch again. Any other rejection propagates so the caller can surface it.
 */
export async function ensureXLayerTestnet(provider: EIP1193Provider): Promise<void> {
  if ((await getChainId(provider)) === X_LAYER_TESTNET_ID) return;
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: X_LAYER_TESTNET_HEX }],
    });
  } catch (err) {
    if ((err as { code?: number }).code === 4902) {
      await provider.request({ method: "wallet_addEthereumChain", params: [X_LAYER_TESTNET_ADD_PARAMS] });
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: X_LAYER_TESTNET_HEX }],
      });
      return;
    }
    throw err;
  }
}

/** A wallet client bound to the connected account for signing SIWE messages and contract writes. */
export function makeWalletClient(provider: EIP1193Provider, account: Address | Account): WalletClient {
  return createWalletClient({ account, chain: xLayerTestnet, transport: custom(provider) });
}

/** A read-only client over the public X Layer testnet RPC — used for receipts, reads, and readbacks. */
export function makePublicClient(): PublicClient {
  return createPublicClient({ chain: xLayerTestnet, transport: http() });
}
