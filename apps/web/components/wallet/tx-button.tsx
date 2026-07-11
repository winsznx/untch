"use client";

import { useState } from "react";
import type { Hex } from "viem";
import { txUrl } from "../../lib/onchain";
import { useWallet, type ContractCall } from "./wallet-context";

/**
 * One reusable write-action button for every real on-chain operation in the dashboard.
 *
 * A `prepare()` returns the ordered steps to sign (one for a policy write, two for an ERC-20 approve then
 * a vault deposit). The button walks them: sign each with the connected wallet, wait for its receipt,
 * then move on, showing "Step 1/2" progress and, at the end, the confirmed tx hash linked to OKLink.
 * Everything routes through the wallet context, so connect + chain-switch + fresh signature per tx is
 * handled once here rather than in every screen. A revert or a rejected signature surfaces inline.
 */

export interface TxStep {
  readonly label: string;
  readonly call: ContractCall;
}

type Phase =
  | { kind: "idle" }
  | { kind: "running"; step: number; total: number; label: string }
  | { kind: "done"; hash: Hex }
  | { kind: "error"; message: string };

export function TxButton({
  label,
  prepare,
  requireAuth = false,
  disabled = false,
  variant = "primary",
  onConfirmed,
}: {
  label: string;
  prepare: () => Promise<TxStep[]> | TxStep[];
  requireAuth?: boolean;
  disabled?: boolean;
  variant?: "primary" | "signal";
  onConfirmed?: (hash: Hex) => void;
}) {
  const w = useWallet();
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });

  const gated = requireAuth ? w.status !== "authenticated" : false;
  const running = phase.kind === "running";
  const isDisabled = disabled || gated || running || w.busy;

  async function run() {
    setPhase({ kind: "running", step: 0, total: 1, label: "Preparing" });
    try {
      const steps = await prepare();
      if (steps.length === 0) throw new Error("Nothing to do.");
      let last: Hex | null = null;
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]!;
        setPhase({ kind: "running", step: i + 1, total: steps.length, label: s.label });
        const hash = await w.writeContract(s.call);
        const status = await w.waitForReceipt(hash);
        if (status === "reverted") throw new Error(`${s.label} reverted on-chain (${short(hash)}).`);
        last = hash;
      }
      if (last) {
        setPhase({ kind: "done", hash: last });
        onConfirmed?.(last);
      } else {
        setPhase({ kind: "idle" });
      }
    } catch (e) {
      setPhase({ kind: "error", message: messageOf(e) });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => void run()} disabled={isDisabled} className="w-fit" style={btnStyle(variant, isDisabled)}>
        {running ? `${phase.label}${phase.total > 1 ? ` (${phase.step}/${phase.total})` : ""}…` : label}
      </button>

      {gated ? (
        <span className="text-caption-lg" style={{ color: "var(--color-inverse-muted)" }}>Sign in above to enable.</span>
      ) : null}

      {phase.kind === "done" ? (
        <span className="text-caption-lg" style={{ color: "var(--color-positive)" }}>
          Confirmed ·{" "}
          <a href={txUrl("testnet", phase.hash)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace" }}>
            {short(phase.hash)}
          </a>
        </span>
      ) : null}

      {phase.kind === "error" ? (
        <span className="text-caption-lg" style={{ color: "var(--color-signal)" }}>{phase.message}</span>
      ) : null}
    </div>
  );
}

function short(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

function messageOf(e: unknown): string {
  if (e && typeof e === "object" && "shortMessage" in e && typeof e.shortMessage === "string") return e.shortMessage;
  const msg = e instanceof Error ? e.message : String(e);
  if (/rejected|denied|user cancel/i.test(msg)) return "Request rejected in wallet.";
  return msg.split("\n")[0] ?? "Transaction failed.";
}

function btnStyle(variant: "primary" | "signal", isDisabled: boolean) {
  const base = { borderRadius: "9999px", padding: "12px 24px", fontSize: 14, fontWeight: 500, cursor: isDisabled ? "not-allowed" : "pointer", opacity: isDisabled ? 0.55 : 1 };
  if (variant === "signal") return { ...base, background: "transparent", color: "var(--color-signal)", border: "1px solid var(--color-signal)" };
  return { ...base, background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)" };
}
