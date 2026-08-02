import type { ReactNode } from "react";
import Link from "next/link";
import { LinkWallet } from "./link-wallet";
import { ConnectAgenticWallet } from "./connect-agentic";

/** A titled block. Kept local to the approval surface so it can carry a subtitle that is a warning. */
export function Panel({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>{title}</h2>
      {sub ? <p className="text-body" style={{ color: "var(--color-inverse-muted)" }}>{sub}</p> : null}
      {children}
    </section>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border p-4" style={{ borderColor: "var(--color-hairline, #e4e6ea)" }}>
      {children}
    </div>
  );
}

export function KV({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 py-1">
      <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{k}</span>
      <span className="text-caption break-all" style={{ color: "var(--color-text)" }}>{v}</span>
    </div>
  );
}

/**
 * What an unlinked visitor sees.
 *
 * It states the distinction rather than just offering a button, because "I am already signed in, why
 * am I being asked again" is the first thing anyone thinks here, and the answer — a different service
 * verifies a different nonce — is the whole reason the second signature is worth anything.
 */
export function NotLinked() {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <div className="flex flex-col gap-4">
          <p className="text-body" style={{ color: "var(--color-text)" }}>
            This surface is scoped to an Untch account, and an account is created by one thing only: a
            signature from the wallet that will own your policies.
          </p>
          <ConnectAgenticWallet />
        </div>
      </Card>

      {/*
        Secondary, and labelled as a different product rather than a different button. The failure this
        ordering prevents is a user reaching for an extension because it was the obvious control, and
        ending up with policies owned by a wallet their agent cannot spend from.
      */}
      <details className="rounded-lg border p-4" style={{ borderColor: "var(--color-hairline, #e4e6ea)" }}>
        <summary className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
          Other wallet methods
        </summary>
        <div className="mt-4 flex flex-col gap-3">
          <p className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
            A browser wallet is a separate product from the Onchain OS Agentic Wallet, with different
            keys and a different recovery story. Linking one records a browser binding. Your agent
            cannot spend from it, so a policy it owns is a policy your agent cannot use.
          </p>
          <LinkWallet linked={false} />
        </div>
      </details>
    </div>
  );
}

/** A named refusal, shown as itself. */
export function Refusal({ code, message }: { code: string; message: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <span className="text-caption" style={{ color: "var(--color-text)" }}>{code}</span>
        <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{message}</span>
      </div>
    </Card>
  );
}

export function Empty({ what, note }: { what: string; note?: string }) {
  return (
    <Card>
      <div className="flex flex-col gap-1">
        <span className="text-body" style={{ color: "var(--color-text)" }}>{what}</span>
        {note ? <span className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>{note}</span> : null}
      </div>
    </Card>
  );
}

export function Back({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className="text-caption" style={{ color: "var(--color-inverse-muted)" }}>
      ← {label}
    </Link>
  );
}
