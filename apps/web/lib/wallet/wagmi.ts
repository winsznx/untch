import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, okxWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { xLayerMainnet, xLayerTestnet } from "../chain/chains";

/**
 * The wagmi + RainbowKit config for the operator dashboard.
 *
 * OKX Wallet is the priority connector (its own "Recommended" group, first in the modal), matching §15's
 * OKX-first requirement. WalletConnect is the ONLY connector that needs a Reown project id, so it is added
 * only when `NEXT_PUBLIC_REOWN_PROJECT_ID` is set (read from env, never a fake placeholder). Injected
 * wallets (OKX extension, MetaMask) never need it, so the no-projectId path is clean rather than passing a
 * bogus id that makes WalletConnect init hang the sign-in modal.
 *
 * SSR: cookie storage + `ssr: true`, and the layout hydrates `initialState` from the cookie
 * (`cookieToInitialState`) so wagmi's React state matches the actual wallet connection on first paint. Without
 * that, RainbowKit renders "disconnected" while the wallet is connected and its SIWE signMessage has no
 * connector to sign with — which is exactly the "Preparing message…" hang this replaces.
 *
 * Chains: mainnet first (product default) and testnet selectable via NEXT_PUBLIC_CHAIN_ID=1952.
 */

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";

if (!projectId && typeof window === "undefined") {
  console.warn(
    "[untch] NEXT_PUBLIC_REOWN_PROJECT_ID is not set — WalletConnect is disabled; OKX/MetaMask (injected) " +
      "still work. Set it from cloud.reown.com to enable the WalletConnect QR path.",
  );
}

// RainbowKit's branded connectors (okxWallet, metaMaskWallet, walletConnectWallet) all register a
// WalletConnect fallback and THROW "No projectId found" without a real Reown id. `injectedWallet` is the
// one that needs none. So with an id we lead with OKX + full set; without one we fall back to the injected
// connector, which still connects to the OKX extension (just unbranded, no QR) — no crash, no hang.
const groups = projectId
  ? [
      { groupName: "Recommended", wallets: [okxWallet] },
      { groupName: "More", wallets: [metaMaskWallet, walletConnectWallet, injectedWallet] },
    ]
  : [{ groupName: "Installed wallet", wallets: [injectedWallet] }];

const connectors = connectorsForWallets(groups, { appName: "Untch", projectId });

export const wagmiConfig = createConfig({
  connectors,
  chains: [xLayerMainnet, xLayerTestnet],
  transports: { [xLayerMainnet.id]: http(), [xLayerTestnet.id]: http() },
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
});
