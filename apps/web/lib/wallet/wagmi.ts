import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, okxWallet, walletConnectWallet } from "@rainbow-me/rainbowkit/wallets";
import { http } from "wagmi";
import { xLayerTestnet } from "../chain/chains";

/**
 * The wagmi + RainbowKit config for the operator dashboard.
 *
 * OKX Wallet is the priority connector (its own "Recommended" group, first in the modal), matching §15's
 * OKX-first requirement; the rest are grouped under "More". The WalletConnect entry is only added when a
 * Reown Cloud project id is configured (`NEXT_PUBLIC_REOWN_PROJECT_ID`) — read from env, never a fake
 * placeholder. Without it, injected wallets (OKX, MetaMask) still work; only the WalletConnect QR path is
 * unavailable, and a build-time warning says so. The only chain is X Layer testnet, so RainbowKit enforces
 * the right network in its own UI.
 */

const projectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() ?? "";

if (!projectId && typeof window === "undefined") {
  console.warn(
    "[untch] NEXT_PUBLIC_REOWN_PROJECT_ID is not set — WalletConnect is disabled; OKX/MetaMask (injected) " +
      "still work. Set it from cloud.reown.com to enable the WalletConnect QR path.",
  );
}

const moreWallets = projectId
  ? [metaMaskWallet, walletConnectWallet, injectedWallet]
  : [metaMaskWallet, injectedWallet];

export const wagmiConfig = getDefaultConfig({
  appName: "Untch",
  projectId: projectId || "untch-no-walletconnect",
  chains: [xLayerTestnet],
  transports: { [xLayerTestnet.id]: http() },
  wallets: [
    { groupName: "Recommended", wallets: [okxWallet] },
    { groupName: "More", wallets: moreWallets },
  ],
  ssr: true,
});
