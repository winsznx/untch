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
          <RainbowKitProvider
            theme={darkTheme({ accentColor: "#5350cc", accentColorForeground: "white", borderRadius: "large" })}
          >
            <AuthStatusContext.Provider value={status}>{children}</AuthStatusContext.Provider>
          </RainbowKitProvider>
        </RainbowKitAuthenticationProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
