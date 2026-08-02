"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Connect the OKX Onchain OS Agentic Wallet.
 *
 * THIS IS NOT A BROWSER WALLET FLOW, AND THAT IS THE POINT
 *
 * The Agentic Wallet is held in OKX's TEE and restored through email, Google or Apple login. It is
 * not injected into the page. There is no `window.ethereum` for it and no provider to call, so this
 * component never touches wagmi. It creates a link request, shows a prompt the user hands to whatever
 * agent holds their Onchain OS session, and polls.
 *
 * The browser wallet path still exists, one section down, for users who deliberately want an
 * extension to own their policies. It is secondary because it is a different wallet product, not a
 * different button for the same one.
 */

interface StartResult {
  readonly linkRequestId: string;
  readonly linkUrl: string;
  readonly expiresAt: string;
  readonly requestedScopes: readonly string[];
  readonly agentPrompt: string;
  readonly purpose: string;
}

interface StatusResult {
  readonly status: "WAITING_FOR_AGENT" | "WAITING_FOR_SIGNATURE" | "LINKED" | "EXPIRED" | "REFUSED";
  readonly expectedAddress: string | null;
  readonly requestedScopes: readonly string[];
  readonly expiresAt: string;
  readonly hint: string | null;
}

const LABEL: Readonly<Record<StatusResult["status"], string>> = {
  WAITING_FOR_AGENT: "Waiting for your agent to pick this up",
  WAITING_FOR_SIGNATURE: "Your agent has the message. Review it and confirm.",
  LINKED: "Linked",
  EXPIRED: "This link request expired",
  REFUSED: "This link request was refused",
};

export function ConnectAgenticWallet() {
  const [started, setStarted] = useState<StartResult | null>(null);
  const [status, setStatus] = useState<StatusResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timer.current !== null) {
      clearInterval(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/agentic-link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        setError(`${String(body.code ?? "START_FAILED")}: ${String(body.message ?? "")}`);
        return;
      }
      setStarted(body as unknown as StartResult);

      // Poll every three seconds. The agent side is a human reading a message, so a tighter loop buys
      // nothing and a looser one makes a completed link feel broken.
      stopPolling();
      timer.current = setInterval(async () => {
        const r = await fetch(`/api/account/agentic-link?linkRequestId=${encodeURIComponent(String(body.linkRequestId))}`);
        const s = (await r.json()) as StatusResult;
        setStatus(s);
        if (s.status === "LINKED" || s.status === "EXPIRED" || s.status === "REFUSED") {
          stopPolling();
          if (s.status === "LINKED") window.location.reload();
        }
      }, 3000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!started) {
    return (
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="rounded-md px-4 py-2 text-body disabled:opacity-50"
          style={{ background: "var(--color-text)", color: "var(--color-canvas)" }}
        >
          {busy ? "Preparing" : "Connect Agentic Wallet"}
        </button>
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          This uses the wallet you already have in OKX Onchain OS, restored with your email, Google or
          Apple login. It is held in OKX&rsquo;s TEE. No browser extension is involved and no extension
          will open.
        </span>
        {error ? <span className="text-caption" style={{ color: "var(--color-negative, #b23)" }}>{error}</span> : null}
      </div>
    );
  }

  const s = status?.status ?? "WAITING_FOR_AGENT";

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-body" style={{ color: "var(--color-text)" }}>{LABEL[s]}</span>
        {status?.hint ? (
          <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{status.hint}</span>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          Paste this into the agent that holds your Onchain OS session
        </span>
        <pre
          className="overflow-x-auto rounded-md border p-3 text-caption"
          style={{ borderColor: "var(--color-hairline, #e4e6ea)", color: "var(--color-text)" }}
        >
          {started.agentPrompt}
        </pre>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard.writeText(started.agentPrompt);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
          className="self-start rounded-md border px-3 py-1 text-caption"
          style={{ borderColor: "var(--color-hairline, #ddd)", color: "var(--color-text)" }}
        >
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>

      <div className="flex flex-col gap-1">
        {/* Shown as soon as the agent resolves it, which is BEFORE any signature exists. It is what
            lets a user notice the agent picked a different sub-wallet than they expected. */}
        <Row k="Wallet the agent resolved" v={status?.expectedAddress ?? "not resolved yet"} />
        <Row k="Requested scopes" v={(status?.requestedScopes ?? started.requestedScopes).join(", ")} />
        <Row k="Expires" v={status?.expiresAt ?? started.expiresAt} />
        <Row k="Payment" v="None. This authorises no payment." />
        <Row k="Transaction" v="None. Nothing is broadcast." />
        <Row k="Status" v={s} />
      </div>

      {error ? <span className="text-caption" style={{ color: "var(--color-negative, #b23)" }}>{error}</span> : null}
    </div>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex flex-wrap justify-between gap-2">
      <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{k}</span>
      <span className="text-caption break-all" style={{ color: "var(--color-text)" }}>{v}</span>
    </div>
  );
}
