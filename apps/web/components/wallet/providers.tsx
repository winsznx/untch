"use client";

import "@rainbow-me/rainbowkit/styles.css";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  createAuthenticationAdapter,
  darkTheme,
  RainbowKitAuthenticationProvider,
  RainbowKitProvider,
  type AuthenticationStatus,
} from "@rainbow-me/rainbowkit";
import { cookieToInitialState, WagmiProvider } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { buildSiweMessage } from "../../lib/wallet/siwe";
import { wagmiConfig } from "../../lib/wallet/wagmi";
import { xLayerTestnet } from "../../lib/chain/chains";
import { AuthStatusContext } from "./wallet-context";

/**
 * The wallet + auth provider tree for the dashboard, RainbowKit's official SIWE integration.
 *
 * Connect and sign happen as ONE continuous flow inside RainbowKit's modal: because a
 * `RainbowKitAuthenticationProvider` is present and the status is `unauthenticated` after connecting,
 * RainbowKit shows its own Sign-In step right there and only closes once the SIWE signature is verified.
 * There is no separate "Sign in" button to hunt for.
 *
 * The authentication adapter drives OUR existing backend (`/api/auth/*`): a server-issued single-use nonce,
 * the SIWE message built by our shared `buildSiweMessage`, verification + the HMAC session cookie, and
 * sign-out. `status` is fetched once from `/api/auth/me` and flipped by the adapter's verify/signOut, so a
 * page reload keeps the operator signed in.
 */

const queryClient = new QueryClient();

/**
 * RainbowKit themed to Untch's design tokens. RainbowKit's default darkTheme renders the connect-button
 * pills and modal in a near-black grey that clashes with the deep-iris canvas; here every surface/text/border
 * color is remapped to `var(--color-*)` (RainbowKit applies these as inline `--rk-colors-*` custom props, and
 * the nested `var()` resolves against our tokens), so the wallet chrome reads as part of the dashboard.
 */
const untchRainbowTheme = (() => {
  const base = darkTheme({ accentColor: "#5350cc", accentColorForeground: "#ffffff", borderRadius: "large" });
  return {
    ...base,
    colors: {
      ...base.colors,
      connectButtonBackground: "var(--color-surface)",
      connectButtonInnerBackground: "var(--color-surface-raised)",
      connectButtonText: "var(--color-text)",
      connectButtonTextError: "var(--color-signal)",
      modalBackground: "var(--color-surface)",
      modalBorder: "var(--color-border)",
      modalText: "var(--color-text)",
      modalTextSecondary: "var(--color-inverse-muted)",
      modalTextDim: "var(--color-inverse-muted)",
      menuItemBackground: "var(--color-canvas)",
      profileForeground: "var(--color-surface)",
      profileAction: "var(--color-surface-raised)",
      profileActionHover: "var(--color-border-soft)",
      closeButton: "var(--color-inverse-muted)",
      closeButtonBackground: "var(--color-canvas)",
      generalBorder: "var(--color-border)",
      generalBorderDim: "var(--color-border)",
      actionButtonBorder: "var(--color-border)",
      actionButtonBorderMobile: "var(--color-border)",
      actionButtonSecondaryBackground: "var(--color-surface-raised)",
      selectedOptionBorder: "var(--color-action)",
    },
  };
})();

export function Providers({ children, cookie }: { children: ReactNode; cookie: string | null }) {
  const [status, setStatus] = useState<AuthenticationStatus>("loading");
  // Hydrate wagmi's React state from the connection cookie on the very first render, so a wallet that is
  // already connected reads as connected immediately (matching the browser extension) instead of flashing
  // "disconnected" — which would leave RainbowKit's SIWE step with no connector and hang "Preparing message".
  const initialState = cookieToInitialState(wagmiConfig, cookie ?? undefined);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const me = (await (await fetch("/api/auth/me")).json()) as { authenticated: boolean };
        if (!cancelled) setStatus(me.authenticated ? "authenticated" : "unauthenticated");
      } catch {
        if (!cancelled) setStatus("unauthenticated");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const adapter = useMemo(
    () =>
      createAuthenticationAdapter({
        getNonce: async () => {
          const res = await fetch("/api/auth/nonce");
          return ((await res.json()) as { nonce: string }).nonce;
        },
        // `chainId` here is the wallet's ACTUAL current chain (RainbowKit passes `useAccount().chain.id`),
        // never an assumed/hardcoded value — so the message and the wallet always agree. The NetworkGuard
        // has already normalised the wallet to X Layer testnet by the time this runs.
        createMessage: ({ nonce, address, chainId }) =>
          buildSiweMessage({
            address,
            chainId,
            domain: window.location.host,
            uri: window.location.origin,
            nonce,
            issuedAt: new Date(),
            expirationTime: new Date(Date.now() + 10 * 60_000),
          }),
        verify: async ({ message, signature }) => {
          const res = await fetch("/api/auth/verify", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ message, signature }),
          });
          const ok = res.ok && Boolean(((await res.json()) as { ok?: boolean }).ok);
          if (ok) setStatus("authenticated");
          return ok;
        },
        signOut: async () => {
          await fetch("/api/auth/logout", { method: "POST" });
          setStatus("unauthenticated");
        },
      }),
    [],
  );

  return (
    <WagmiProvider config={wagmiConfig} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitAuthenticationProvider adapter={adapter} status={status}>
          <RainbowKitProvider initialChain={xLayerTestnet} theme={untchRainbowTheme}>
            <AuthStatusContext.Provider value={status}>{children}</AuthStatusContext.Provider>
          </RainbowKitProvider>
        </RainbowKitAuthenticationProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
