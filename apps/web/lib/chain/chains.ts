import { defineChain } from "viem";
import { resolveChainId, X_LAYER_MAINNET_ID as SHARED_MAINNET, X_LAYER_TESTNET_ID as SHARED_TESTNET } from "@untch/shared";

/**
 * Client-safe X Layer chain definitions for the dashboard.
 *
 * Product chain is selected by NEXT_PUBLIC_CHAIN_ID (inlined at build; unset ⇒ mainnet 196).
 * Testnet (1952) remains fully selectable for soak/dev. Addresses live in @untch/shared
 * CONTRACTS_BY_CHAIN — never hardcode base contracts here.
 */

export const X_LAYER_TESTNET_ID = SHARED_TESTNET;
export const X_LAYER_MAINNET_ID = SHARED_MAINNET;

export const X_LAYER_TESTNET_HEX = "0x7a0" as const;
export const X_LAYER_MAINNET_HEX = "0xc4" as const;

export const xLayerTestnet = defineChain({
  id: X_LAYER_TESTNET_ID,
  name: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://testrpc.xlayer.tech", "https://xlayertestrpc.okx.com"] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/x-layer-testnet" },
  },
  testnet: true,
});

export const xLayerMainnet = defineChain({
  id: X_LAYER_MAINNET_ID,
  name: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: {
    default: { http: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"] },
  },
  blockExplorers: {
    default: { name: "OKLink", url: "https://www.oklink.com/x-layer" },
  },
  testnet: false,
});

/** EIP-3085 params — testnet. */
export const X_LAYER_TESTNET_ADD_PARAMS = {
  chainId: X_LAYER_TESTNET_HEX,
  chainName: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: ["https://testrpc.xlayer.tech"],
  blockExplorerUrls: ["https://www.oklink.com/x-layer-testnet"],
};

/** EIP-3085 params — mainnet. */
export const X_LAYER_MAINNET_ADD_PARAMS = {
  chainId: X_LAYER_MAINNET_HEX,
  chainName: "X Layer",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: ["https://rpc.xlayer.tech"],
  blockExplorerUrls: ["https://www.oklink.com/x-layer"],
};

/** Product chain id (build-time). Default mainnet. */
export const PRODUCT_CHAIN_ID: number = resolveChainId(
  { CHAIN_ID: process.env.NEXT_PUBLIC_CHAIN_ID },
  X_LAYER_MAINNET_ID,
);

export function productChain() {
  return PRODUCT_CHAIN_ID === X_LAYER_TESTNET_ID ? xLayerTestnet : xLayerMainnet;
}

export function productAddChainParams() {
  return PRODUCT_CHAIN_ID === X_LAYER_TESTNET_ID ? X_LAYER_TESTNET_ADD_PARAMS : X_LAYER_MAINNET_ADD_PARAMS;
}

export function productExplorerNet(): "mainnet" | "testnet" {
  return PRODUCT_CHAIN_ID === X_LAYER_MAINNET_ID ? "mainnet" : "testnet";
}
