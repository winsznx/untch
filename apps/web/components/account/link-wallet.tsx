"use client";

import { useState } from "react";
import { useAccount, useChainId, useSignMessage } from "wagmi";

/**
 * Link the connected wallet to an Untch account.
 *
 * ONE signature, and the user sees it before their wallet does.
 *
 * The flow is deliberately two presses even though it is one signature. "Review" fetches the exact
 * message the ASP will verify and shows it, with the address that will sign and the authority the
 * signature establishes. Only the second press opens the wallet. A single button labelled "Connect"
 * that goes straight to a prompt is how people learn to sign things without reading them, and this is
 * the surface where that habit costs the most.
 *
 * The message is composed by the SERVER. `buildLinkMessage` was exported for callers to reproduce,
 * and a client that formatted one line differently would sign something the server never authored.
 *
 * The one-time code is absent from everything below. It lives in an httpOnly cookie set by the start
 * call, so completing a link needs the browser session and not merely what was on screen.
 */

interface Authority {
  readonly signatures: number;
  readonly format: string;
  readonly address: string | null;
  readonly chainId: number;
  readonly domain: string;
  readonly scopes: readonly string[];
  readonly expiresAt: string;
  readonly creates: readonly string[];
  readonly doesNotCreate: readonly string[];
}

interface Prepared {
  readonly message: string;
  readonly authorityRequested: Authority | null;
}

export function LinkWallet({ linked }: { linked: boolean }) {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function review() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/account/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address, chainId }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok || typeof body.message !== "string") {
        setError(`${String(body.code ?? "LINK_FAILED")}: ${String(body.message ?? "could not prepare the link")}`);
        return;
      }
      setPrepared({
        message: body.message,
        authorityRequested: (body.authorityRequested as Authority | null) ?? null,
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function sign() {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await signMessageAsync({ message: prepared.message });
      const res = await fetch("/api/account/link", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: prepared.message, signature }),
      });
      const body = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        // A ROLE_COLLISION names which role conflicted. Surfaced, because "refused" without the role
        // leaves the user guessing which of their wallets is the operational one.
        const roles = Array.isArray(body.conflictingRoles)
          ? (body.conflictingRoles as { role: string }[]).map((r) => r.role).join(", ")
          : null;
        setError(
          `${String(body.code ?? "LINK_FAILED")}: ${String(body.message ?? "")}${roles ? ` (roles: ${roles})` : ""}`,
        );
        return;
      }
      window.location.reload();
    } catch (err) {
      const m = (err as Error).message ?? String(err);
      // A declined signature is the common case and is not an error worth shouting about.
      setError(/user rejected|denied/i.test(m) ? "Signature declined. Nothing was linked." : m);
    } finally {
      setBusy(false);
    }
  }

  if (linked) return null;

  if (!isConnected) {
    return (
      <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
        Connect a wallet to begin. Connecting opens no signature prompt.
      </span>
    );
  }

  if (!prepared) {
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={review}
          disabled={busy}
          className="rounded-md px-4 py-2 text-body disabled:opacity-50"
          style={{ background: "var(--color-text)", color: "var(--color-canvas)" }}
        >
          {busy ? "Preparing" : "Review what you will sign"}
        </button>
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          This opens no wallet prompt. It fetches the exact message and shows it first.
        </span>
        {error ? <span className="text-caption" style={{ color: "var(--color-negative, #b23)" }}>{error}</span> : null}
      </div>
    );
  }

  const a = prepared.authorityRequested;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>Signing address</span>
        <span className="text-body break-all" style={{ color: "var(--color-text)" }}>{address}</span>
      </div>

      {a ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
              {a.signatures} signature. {a.format}. Chain {a.chainId}. Domain {a.domain}.
            </span>
            <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
              Scopes: {a.scopes.join(", ")}. Expires {a.expiresAt}.
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-caption" style={{ color: "var(--color-text)" }}>This signature creates</span>
            <ul className="ml-4 list-disc">
              {a.creates.map((c) => (
                <li key={c} className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{c}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-caption" style={{ color: "var(--color-text)" }}>It does not create</span>
            <ul className="ml-4 list-disc">
              {a.doesNotCreate.map((c) => (
                <li key={c} className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{c}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-1">
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          The exact message your wallet will show
        </span>
        <pre
          className="overflow-x-auto rounded-md border p-3 text-caption"
          style={{ borderColor: "var(--color-hairline, #e4e6ea)", color: "var(--color-text)" }}
        >
          {prepared.message}
        </pre>
      </div>

      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={sign}
          disabled={busy}
          className="rounded-md px-4 py-2 text-body disabled:opacity-50"
          style={{ background: "var(--color-text)", color: "var(--color-canvas)" }}
        >
          {busy ? "Waiting for your wallet" : "Sign this message"}
        </button>
        <button
          type="button"
          onClick={() => setPrepared(null)}
          disabled={busy}
          className="rounded-md border px-4 py-2 text-body disabled:opacity-50"
          style={{ borderColor: "var(--color-hairline, #ddd)", color: "var(--color-text)" }}
        >
          Cancel
        </button>
      </div>
      {error ? <span className="text-caption" style={{ color: "var(--color-negative, #b23)" }}>{error}</span> : null}
    </div>
  );
}
