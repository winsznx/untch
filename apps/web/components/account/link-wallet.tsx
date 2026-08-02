"use client";

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";

/**
 * Link the connected wallet to an Untch account.
 *
 * Two round trips and one signature. The message is the ASP's, over a nonce the ASP minted — this
 * component never composes one, because a message this app wrote would prove a signature over text
 * this app chose, which is not what the ASP is verifying.
 *
 * The one-time code is deliberately absent from everything below: it lives in an httpOnly cookie set
 * by the start call, so completing a link needs the browser session and not merely what was on screen.
 */
export function LinkWallet({ linked }: { linked: boolean }) {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const started = await fetch("/api/account/link", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      const startBody = (await started.json()) as { ok?: boolean; message?: string; code?: string };
      if (!started.ok || !startBody.message) {
        setError(startBody.code ? `${startBody.code}: ${String((startBody as { message?: string }).message ?? "")}` : "could not start the link");
        return;
      }
      const signature = await signMessageAsync({ message: startBody.message });
      const done = await fetch("/api/account/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: startBody.message, signature }),
      });
      const doneBody = (await done.json()) as { ok?: boolean; code?: string; message?: string };
      if (!done.ok) {
        setError(`${doneBody.code ?? "LINK_FAILED"}: ${doneBody.message ?? ""}`);
        return;
      }
      window.location.reload();
    } catch (err) {
      // A rejected signature is the common case and is not an error worth shouting about.
      const m = (err as Error).message ?? String(err);
      setError(/user rejected|denied/i.test(m) ? "Signature declined. Nothing was linked." : m);
    } finally {
      setBusy(false);
    }
  }

  if (linked) return null;

  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={run}
        disabled={!isConnected || busy}
        className="rounded-md px-4 py-2 text-body disabled:opacity-50"
        style={{ background: "var(--color-text)", color: "var(--color-canvas)" }}
      >
        {busy ? "Waiting for your wallet…" : isConnected ? "Link this wallet to an Untch account" : "Connect a wallet first"}
      </button>
      <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
        {isConnected
          ? `You will sign one message with ${address?.slice(0, 6)}…${address?.slice(-4)}. It proves who you are and approves no payment.`
          : "Signing in here proves identity to the dashboard. Linking proves it to the ASP, against a nonce the ASP itself minted."}
      </span>
      {error ? (
        <span className="text-caption" style={{ color: "var(--color-negative, #b23)" }}>{error}</span>
      ) : null}
    </div>
  );
}
