import { codeMatchesHash, generateCode, hashCode, InMemoryOperatorsRepo } from "@untch/escalation/pure";

/**
 * Self-serve control-channel binding (§27 / §15) — the code-roundtrip flow that replaces the env-var
 * single-operator interim (`TELEGRAM_CHAT_ID` etc.).
 *
 * The operator, once signed in, links their own Telegram / Discord / Slack handle:
 *   1. START — the server mints a single-use code and stores a pending binding (operatorId, channel,
 *      handle, code hash, expiry). The code is shown once.
 *   2. CONFIRM — the operator sends that code from the handle to the Untch bot; the running channel
 *      receiver matches it and calls `confirm`, which promotes the pending binding to a verified one and
 *      records it in the operator-identity store (the same `ensureBinding` the ASP wiring provisions).
 *
 * This is the real flow and the real persistence. What it does NOT do inside the dashboard alone is run
 * the bots that receive the code — that half lives in the ASP server's channel receivers (Telegram/
 * Discord/Slack). So `confirm` is exposed for the operator to complete once they have sent the code; in
 * production the receiver drives it automatically. Every binding here is per-operator, so a second
 * operator is data, not a redeploy.
 */

export const BINDABLE_CHANNELS = ["telegram", "discord", "slack"] as const;
export type BindableChannel = (typeof BINDABLE_CHANNELS)[number];

const CODE_TTL_MS = 15 * 60_000;

export type BindingStatus = "pending" | "verified";

export interface BindingView {
  readonly channel: BindableChannel;
  readonly handle: string;
  readonly status: BindingStatus;
  readonly since: string;
}

interface PendingBinding {
  readonly operatorId: string;
  readonly channel: BindableChannel;
  readonly handle: string;
  readonly codeHash: string;
  readonly expiresAt: number;
  readonly startedAt: number;
}

interface VerifiedBinding {
  readonly operatorId: string;
  readonly channel: BindableChannel;
  readonly handle: string;
  readonly verifiedAt: number;
}

interface Runtime {
  readonly operators: InMemoryOperatorsRepo;
  readonly pending: Map<string, PendingBinding>; // `${operatorId}:${channel}`
  readonly verified: Map<string, VerifiedBinding>; // `${operatorId}:${channel}`
}

declare global {
  // eslint-disable-next-line no-var
  var __untchBindingRuntime: Runtime | undefined;
}

function runtime(): Runtime {
  if (!globalThis.__untchBindingRuntime) {
    globalThis.__untchBindingRuntime = {
      operators: new InMemoryOperatorsRepo(),
      pending: new Map(),
      verified: new Map(),
    };
  }
  return globalThis.__untchBindingRuntime;
}

function key(operatorId: string, channel: string): string {
  return `${operatorId}:${channel}`;
}

export function isBindableChannel(x: string): x is BindableChannel {
  return (BINDABLE_CHANNELS as readonly string[]).includes(x);
}

export interface StartResult {
  readonly code: string;
  readonly expiresAt: string;
  readonly channel: BindableChannel;
  readonly handle: string;
}

/** Mint a single-use code and record the pending binding. The code is shown once. */
export function startBinding(params: { operatorId: string; channel: BindableChannel; handle: string }): StartResult {
  const handle = params.handle.trim();
  if (!handle) throw new Error("handle is required");
  const code = generateCode();
  const now = Date.now();
  const pending: PendingBinding = {
    operatorId: params.operatorId,
    channel: params.channel,
    handle,
    codeHash: hashCode(code),
    expiresAt: now + CODE_TTL_MS,
    startedAt: now,
  };
  runtime().pending.set(key(params.operatorId, params.channel), pending);
  return { code, expiresAt: new Date(pending.expiresAt).toISOString(), channel: params.channel, handle };
}

export interface ConfirmResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly binding?: BindingView;
}

/** Promote a pending binding to verified when the correct, unexpired code is presented. */
export async function confirmBinding(params: {
  operatorId: string;
  channel: BindableChannel;
  code: string;
}): Promise<ConfirmResult> {
  const rt = runtime();
  const k = key(params.operatorId, params.channel);
  const pending = rt.pending.get(k);
  if (!pending) return { ok: false, reason: "no pending binding for this channel; start again" };
  if (Date.now() > pending.expiresAt) {
    rt.pending.delete(k);
    return { ok: false, reason: "code expired; start again" };
  }
  if (!codeMatchesHash(params.code.trim(), pending.codeHash)) {
    return { ok: false, reason: "code did not match" };
  }
  await rt.operators.ensureBinding(pending.operatorId, pending.channel, pending.handle);
  const verified: VerifiedBinding = {
    operatorId: pending.operatorId,
    channel: pending.channel,
    handle: pending.handle,
    verifiedAt: Date.now(),
  };
  rt.verified.set(k, verified);
  rt.pending.delete(k);
  return { ok: true, binding: { channel: verified.channel, handle: verified.handle, status: "verified", since: new Date(verified.verifiedAt).toISOString() } };
}

/** Remove a binding (verified or pending) for a channel. */
export function removeBinding(operatorId: string, channel: BindableChannel): void {
  const rt = runtime();
  rt.pending.delete(key(operatorId, channel));
  rt.verified.delete(key(operatorId, channel));
}

/** Every binding (pending + verified) for one operator, for the settings screen. */
export function listBindings(operatorId: string): BindingView[] {
  const rt = runtime();
  const out: BindingView[] = [];
  for (const v of rt.verified.values()) {
    if (v.operatorId === operatorId) out.push({ channel: v.channel, handle: v.handle, status: "verified", since: new Date(v.verifiedAt).toISOString() });
  }
  for (const p of rt.pending.values()) {
    if (p.operatorId === operatorId && !rt.verified.has(key(operatorId, p.channel))) {
      out.push({ channel: p.channel, handle: p.handle, status: "pending", since: new Date(p.startedAt).toISOString() });
    }
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel));
}
