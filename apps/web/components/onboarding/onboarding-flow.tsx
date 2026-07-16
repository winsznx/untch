"use client";

import { useState } from "react";
import Link from "next/link";
import type { Hex } from "viem";
import type { PolicyRules } from "../../lib/chain/policy-tx";
import { productTxUrl } from "../../lib/onchain";
import { PolicyActions } from "../dashboard/policy-actions";
import { ChannelBindings } from "../dashboard/channel-bindings";
import { VaultActions } from "../dashboard/vault-actions";
import { useWallet } from "../wallet/wallet-context";

/**
 * The first-run onboarding sequence (Step-31). It does not rebuild any capability: it sequences and frames
 * the real, already-built pieces — connect + SIWE (useWallet), policy creation (PolicyActions), channel
 * binding (ChannelBindings), and the Mode C vault (VaultActions) — into one guided path a first-time
 * operator can follow start to finish. The order is fixed by the product need: choose how enforcement
 * works, write the policy, bind a channel BEFORE finishing (an operator with no channel has every future
 * approval time out to DENY), then the concrete next step for the mode they picked, then a real completion
 * state with the on-chain proof.
 */

type Mode = "A" | "B" | "C";
type StepId = "mode" | "policy" | "channel" | "agent" | "done";

const STEPS: { id: StepId; label: string }[] = [
  { id: "mode", label: "Mode" },
  { id: "policy", label: "Policy" },
  { id: "channel", label: "Channel" },
  { id: "agent", label: "Connect agent" },
  { id: "done", label: "Done" },
];

const MODES: { id: Mode; name: string; badge: string; body: string; recommended?: boolean }[] = [
  {
    id: "A",
    name: "Advisory MCP",
    badge: "Recommended · zero setup",
    recommended: true,
    body: "Add the Untch MCP server and one line to your agent's system prompt. Your agent creates an intent and calls preflight before it pays, then obeys the decision. Works with any framework, and nothing in your code changes.",
  },
  {
    id: "B",
    name: "Untch Guard",
    badge: "One import",
    body: "The open-source x402 middleware wraps your agent's paid calls. On a 402 challenge it runs the binding check and preflight before your agent signs. It never sees or holds your key.",
  },
  {
    id: "C",
    name: "Untch Vault",
    badge: "One deploy",
    body: "Your agent's funds live in an on-chain vault. Only oracle-signed approvals within your caps can move them. Preflight becomes physics, and owner withdraw is always yours.",
  },
];

export function OnboardingFlow({ initialRules }: { initialRules: PolicyRules }) {
  const w = useWallet();
  const authed = w.status === "authenticated";

  const [stepIndex, setStepIndex] = useState(0);
  const [mode, setMode] = useState<Mode>("A");
  const [policy, setPolicy] = useState<{ policyId: bigint; txHash: Hex } | null>(null);
  const [verifiedChannels, setVerifiedChannels] = useState(0);

  const step = STEPS[stepIndex]!;

  // Gate the connect step first: the whole sequence needs a signed-in wallet. Reactive, so connecting via
  // the app bar above advances the flow without a reload.
  if (!authed) {
    return (
      <FlowShell stepIndex={-1}>
        <StepCard
          title="Connect and sign in to begin"
          intro="Use the Connect button at the top of this page and sign the message. Untch never asks for your private key. OKX Wallet is recommended."
        >
          <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
            Once you are signed in, this page walks you through the whole setup in a few minutes.
          </p>
        </StepCard>
      </FlowShell>
    );
  }

  const canContinue =
    step.id === "mode" ? true : step.id === "policy" ? policy !== null : step.id === "channel" ? verifiedChannels >= 1 : true;

  return (
    <FlowShell stepIndex={stepIndex}>
      {step.id === "mode" ? (
        <StepCard
          title="Pick how Untch enforces your policy"
          intro="Untch does not lock you into one channel or one integration path. That is on purpose. Start with advice, and tighten to physics as the stakes rise. The same policy governs every mode, so the control never changes, only how hard it is enforced."
        >
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {MODES.map((m) => {
              const selected = mode === m.id;
              return (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  className="flex flex-col gap-3 rounded-cards p-5 text-left transition-opacity duration-150 hover:opacity-100"
                  style={{
                    background: "var(--color-surface)",
                    border: `1px solid ${selected ? "var(--color-action)" : "var(--color-border)"}`,
                    boxShadow: selected ? "inset 0 0 0 1px var(--color-action)" : "none",
                    opacity: selected ? 1 : 0.82,
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span
                      className="inline-flex h-8 w-8 items-center justify-center rounded-icons text-body-sm"
                      style={{ background: "var(--color-action)", color: "var(--color-text)" }}
                    >
                      {m.id}
                    </span>
                    <span className="text-title-sm" style={{ color: "var(--color-text)" }}>{m.name}</span>
                  </div>
                  <span
                    className="w-fit rounded-tags px-3 py-1 text-caption-lg"
                    style={{
                      border: `1px solid ${m.recommended ? "var(--color-positive)" : "var(--color-border)"}`,
                      color: m.recommended ? "var(--color-positive)" : "var(--color-inverse-muted)",
                    }}
                  >
                    {m.badge}
                  </span>
                  <span className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{m.body}</span>
                </button>
              );
            })}
          </div>
        </StepCard>
      ) : null}

      {step.id === "policy" ? (
        <StepCard
          title="Create your first policy"
          intro="This is the ruleset every payment is checked against. The template below is a safe start. Edit the daily budget, the per-call cap, and the amount that triggers human approval, then create it. It is a real transaction you sign in your wallet and anchor on X Layer."
        >
          <PolicyActions initialRules={initialRules} onCreated={setPolicy} />
          {policy ? (
            <p className="text-body-sm" style={{ color: "var(--color-positive)" }}>
              Policy {policy.policyId.toString()} is on-chain. Continue to bind a channel.
            </p>
          ) : null}
        </StepCard>
      ) : null}

      {step.id === "channel" ? (
        <StepCard
          title="Bind a channel to approve escalations"
          intro="When a payment needs your approval, Untch sends the request to a channel you control. Without a bound channel, every approval request times out and is denied, and no one can release it. Link at least one channel before you finish. It is a quick code roundtrip, not a redeploy."
        >
          <div
            className="rounded-inputs px-4 py-3 text-body-sm"
            style={{
              background: "var(--color-surface)",
              border: `1px solid ${verifiedChannels >= 1 ? "var(--color-positive)" : "var(--color-signal)"}`,
              color: "var(--color-inverse-canvas)",
            }}
          >
            {verifiedChannels >= 1
              ? `Verified channels: ${verifiedChannels}. You can finish setup.`
              : "At least one verified channel is required to finish. This is what makes approvals reachable."}
          </div>
          <ChannelBindings onVerifiedChange={setVerifiedChannels} />
        </StepCard>
      ) : null}

      {step.id === "agent" ? <AgentStep mode={mode} /> : null}

      {step.id === "done" ? <DoneStep mode={mode} policy={policy} verifiedChannels={verifiedChannels} /> : null}

      {step.id !== "done" ? (
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
            style={ghostBtn(stepIndex === 0)}
          >
            Back
          </button>
          <button
            type="button"
            onClick={() => setStepIndex((i) => Math.min(STEPS.length - 1, i + 1))}
            disabled={!canContinue}
            style={primaryBtn(!canContinue)}
          >
            {step.id === "channel" ? "Finish setup" : "Continue"}
          </button>
        </div>
      ) : null}
    </FlowShell>
  );
}

/** The mode-specific concrete next step (Step-31 #5) — real in-product content, not just a link. */
function AgentStep({ mode }: { mode: Mode }) {
  if (mode === "A") {
    return (
      <StepCard
        title="Connect your agent with the MCP server"
        intro="Advisory mode needs no code change. Point your agent at the Untch MCP server, then add one clause to its system prompt so it always checks a payment before making it."
      >
        <Labeled label="System prompt clause">
          <CodeBlock>Before any payment, create an intent and call preflight, then obey the decision.</CodeBlock>
        </Labeled>
        <Labeled label="What happens next">
          <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>
            Your agent creates an intent and calls preflight before it pays. Approved payments proceed,
            blocked ones are refused with a reason, and anything over your escalate-above amount is held and
            sent to your bound channel for a yes or no.
          </p>
        </Labeled>
      </StepCard>
    );
  }
  if (mode === "B") {
    return (
      <StepCard
        title="Wrap your agent with Untch Guard"
        intro="One import. The middleware intercepts the 402 challenge, runs the binding check and preflight, and only then lets your own signer run. It never sees your key, and an escalation never blocks your code."
      >
        <Labeled label="Install">
          <CodeBlock>npm install @untch/x402-guard</CodeBlock>
        </Labeled>
        <Labeled label="Wrap a paid call">
          <CodeBlock>{`import { guardedPay } from "@untch/x402-guard";

const outcome = await guardedPay(
  { url, method: "POST", body, expectedBinding },
  {
    preflight: async ({ binding }) =>
      (await fetch(PREFLIGHT_URL, { method: "POST", body: JSON.stringify({ binding }) })).json(),
    signAndPay: async (ctx) => mySigner(ctx.url, ctx.method, ctx.body),
  },
);
// APPROVED -> outcome.response · BLOCKED -> refusal · ESCALATED -> outcome.pollHandle`}</CodeBlock>
        </Labeled>
        <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
          The guard is fail-closed: an unparseable challenge or a failed preflight resolves to blocked,
          never a silent approve. Full quickstart lives in the package README.
        </p>
      </StepCard>
    );
  }
  return (
    <StepCard
      title="Deploy and fund your vault"
      intro="Hard enforcement. Deploy a vault owned by this wallet, then deposit the funds your agent may spend. From then on, only oracle-signed approvals within your caps can move them, and your withdraw is unconditional."
    >
      <VaultActions />
      <p className="text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>
        The oracle key cannot withdraw or transfer funds. Owner withdraw needs nothing from Untch. Deploy
        first, then deposit an amount to make preflight physics for that agent.
      </p>
    </StepCard>
  );
}

/** Completion (Step-31 #6): the real on-chain proof, the bound channel, the public receipts, next step. */
function DoneStep({
  mode,
  policy,
  verifiedChannels,
}: {
  mode: Mode;
  policy: { policyId: bigint; txHash: Hex } | null;
  verifiedChannels: number;
}) {
  const next =
    mode === "A"
      ? "Point your agent at the Untch MCP server and keep the system-prompt clause in place. Its next payment will run through preflight automatically."
      : mode === "B"
        ? "Ship the guardedPay wrapper around your agent's paid calls. Its next 402 runs the binding check and preflight before it signs."
        : "Fund the vault you deployed. Your agent's payments are now bounded by on-chain caps and oracle approval.";

  return (
    <StepCard title="You are set up" intro="Your policy is live, your approvals are reachable, and everything here is provable on-chain.">
      <div className="flex flex-col gap-3">
        <DoneRow
          ok={policy !== null}
          label="Policy on-chain"
          value={
            policy ? (
              <a href={productTxUrl(policy.txHash)} target="_blank" rel="noopener noreferrer" className="underline-offset-4 hover:underline" style={{ color: "var(--color-data)", fontFamily: "ui-monospace, monospace", fontSize: 13 }}>
                policy {policy.policyId.toString()} · {policy.txHash.slice(0, 10)}…{policy.txHash.slice(-6)}
              </a>
            ) : (
              "not created"
            )
          }
        />
        <DoneRow ok={verifiedChannels >= 1} label="Approval channel" value={verifiedChannels >= 1 ? `${verifiedChannels} verified` : "none bound"} />
        <DoneRow ok label="Enforcement mode" value={`Mode ${mode}`} />
      </div>

      <Labeled label="Do this next">
        <p className="text-body-sm" style={{ color: "var(--color-inverse-canvas)" }}>{next}</p>
      </Labeled>

      <div className="flex flex-wrap items-center gap-3">
        <Link href="/dashboard" style={primaryBtn(false)}>Go to dashboard</Link>
        <Link href="/explorer" className="text-body-sm underline-offset-4 hover:underline" style={{ color: "var(--color-data)" }}>
          View the public receipts explorer
        </Link>
      </div>
    </StepCard>
  );
}

// ── layout + token-only primitives (local to the flow) ─────────────────────────────────────────────

function FlowShell({ stepIndex, children }: { stepIndex: number; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-8">
      <ol className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {STEPS.map((s, i) => {
          const done = stepIndex > i;
          const current = stepIndex === i;
          const color = done ? "var(--color-positive)" : current ? "var(--color-action)" : "var(--color-border)";
          const textColor = done || current ? "var(--color-text)" : "var(--color-inverse-muted)";
          return (
            <li key={s.id} className="flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-full text-caption-lg" style={{ border: `1px solid ${color}`, background: current ? "var(--color-action)" : "transparent", color: textColor }}>
                {i + 1}
              </span>
              <span className="text-caption-lg" style={{ color: textColor }}>{s.label}</span>
              {i < STEPS.length - 1 ? <span aria-hidden style={{ color: "var(--color-divider)" }}>·</span> : null}
            </li>
          );
        })}
      </ol>
      {children}
    </div>
  );
}

function StepCard({ title, intro, children }: { title: string; intro: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-6 rounded-cards p-6" style={{ background: "var(--color-surface)", border: "1px solid var(--color-border)" }}>
      <div className="flex flex-col gap-2">
        <h2 className="text-title-sm" style={{ color: "var(--color-text)" }}>{title}</h2>
        <p className="max-w-2xl text-body-sm" style={{ color: "var(--color-inverse-muted)" }}>{intro}</p>
      </div>
      {children}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-caption uppercase" style={{ color: "var(--color-inverse-muted)", letterSpacing: "0.24px" }}>{label}</span>
      {children}
    </div>
  );
}

function CodeBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-inputs p-4 text-caption-lg" style={{ background: "var(--color-canvas)", border: "1px solid var(--color-border-soft)", color: "var(--color-inverse-canvas)", fontFamily: "ui-monospace, monospace" }}>
      <code>{children}</code>
    </pre>
  );
}

function DoneRow({ ok, label, value }: { ok: boolean; label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-body-sm" style={{ color: "var(--color-text)" }}>
        <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: ok ? "var(--color-positive)" : "var(--color-signal)" }} />
        {label}
      </span>
      <span className="text-body-sm sm:text-right" style={{ color: "var(--color-inverse-canvas)", minWidth: 0, overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function primaryBtn(disabled: boolean): React.CSSProperties {
  return { borderRadius: "9999px", padding: "12px 24px", fontSize: 14, fontWeight: 500, background: "var(--color-action)", color: "var(--color-text)", border: "1px solid var(--color-action)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.55 : 1 };
}
function ghostBtn(disabled: boolean): React.CSSProperties {
  return { borderRadius: "9999px", padding: "12px 24px", fontSize: 14, fontWeight: 500, background: "transparent", color: "var(--color-text)", border: "1px solid var(--color-border)", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1 };
}
