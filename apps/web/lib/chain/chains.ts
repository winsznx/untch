import { defineChain } from "viem";

/**
 * Client-safe X Layer testnet definition for the dashboard's real wallet writes.
 *
 * The product contracts (PolicyRegistry, UntchVaultFactory, UntchVault) live on X Layer testnet
 * (chainId 1952 / 0x7a0); mainnet is deferred until the §28 gate clears. These values mirror
 * `@untch/shared` chains.ts, inlined here so client components never pull the whole shared package
 * into the browser bundle. Any address/chainId change flows from the D0.3-verified source in shared.
 */

export const X_LAYER_TESTNET_ID = 1952 as const;

/** The 0x-hex chainId wallets speak in wallet_switchEthereumChain / wallet_addEthereumChain. */
export const X_LAYER_TESTNET_HEX = "0x7a0" as const;

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

/** The EIP-3085 params a wallet needs to add X Layer testnet when the operator hasn't got it yet. */
export const X_LAYER_TESTNET_ADD_PARAMS = {
  chainId: X_LAYER_TESTNET_HEX,
  chainName: "X Layer Testnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: ["https://testrpc.xlayer.tech"],
  blockExplorerUrls: ["https://www.oklink.com/x-layer-testnet"],
};
