import { codeMatchesHash, generateCode, hashCode } from "@untch/escalation/pure";
import type { OperatorsRepo } from "@untch/escalation/pure";

/**
 * Self-serve control-channel binding (§27 / §15) — the dashboard half of the code roundtrip.
 *
 * ─── THE HARD LINE ────────────────────────────────────────────────────────────────────────────────
 * **A code typed into the dashboard is not proof of control, and this module never treats it as one.**
 *
 * The dashboard mints the code and shows it to the operator. If the operator then types that same code
 * back into the dashboard, they have proved exactly one thing: that they are the same browser session
 * that was just shown the code. They have NOT proved they control the Telegram / Discord / Slack handle
 * they typed in. Only an inbound message arriving FROM that handle, observed by that channel's receiver,
 * proves that — and that receiver does not exist yet (see internal/binding-lifecycle-audit.md, F1).
 *
 * So the most this module can produce is `unverified`: a claim the operator has made about a handle.
 * `verified` is reachable ONLY through `verifyWithChannelProof`, which requires a `ChannelProof` that
 * only a real channel receiver can mint. There is deliberately no way to fabricate one from here.
 *
 * The rule this mirrors is x402-guard's "never holds, sees, or requests a private key": the guard
 * decides only WHETHER to call the injected signer. Likewise, this module decides only whether to ASK
 * for a binding. It can never be the thing that proves the human is there.
 *
 * ─── WHY THIS MODULE HOLDS NO AUTHORITY STORE ─────────────────────────────────────────────────────
 * It previously called `operators.ensureBinding(...)` on a dashboard code-paste, writing a row into the
 * operator-identity store — the table the §27 authority boundary reads to decide who may approve a
 * spend. That write was harmless only by accident: the repo was an in-memory object the ASP never read.
 * Swapping it for `PgOperatorsRepo` to "make bindings real" would have silently armed it, letting any
 * signed-in operator claim authority over a handle they do not control (audit F1/F2).
 *
 * This module therefore holds NO authority store by default, and `installBindingAuthority` refuses to
 * accept one without a channel-proof source. That is the fail-loud: the dangerous wiring cannot be done
 * quietly, only deliberately and with the missing half supplied.
 */

export const BINDABLE_CHANNELS = ["telegram", "discord", "slack"] as const;
export type BindableChannel = (typeof BINDABLE_CHANNELS)[number];

const CODE_TTL_MS = 15 * 60_000;

/**
 * `unverified` is what a dashboard code-paste yields: the operator claims this handle, and has proved
 * they are the session that started the flow — nothing about the handle itself. It confers NO authority.
 * `verified` requires a `ChannelProof` and is currently unreachable (no receiver drives it yet).
 */
export type BindingStatus = "pending" | "unverified" | "verified";

/**
 * Proof that a binding code actually arrived over the real channel, from a real sender.
 *
 * ONLY a channel receiver can mint this — it is the receiver's report of what it observed on the wire:
 * which channel, and the sender handle the transport itself attributed the message to. It is not
 * constructible from anything the dashboard or an agent knows. That is the entire point: the type is the
 * boundary. If a future change makes this fabricable from user input, the binding guarantee is gone.
 */
export interface ChannelProof {
  readonly channel: BindableChannel;
  /** The sender handle as reported BY THE TRANSPORT — never echoed from user input. */
  readonly observedSenderHandle: string;
  /** The code as it arrived in the inbound message. */
  readonly code: string;
}

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

interface ClaimedBinding {
  readonly operatorId: string;
  readonly channel: BindableChannel;
  readonly handle: string;
  readonly status: "unverified" | "verified";
  readonly at: number;
}

interface Runtime {
  readonly pending: Map<string, PendingBinding>; // `${operatorId}:${channel}`
  readonly claimed: Map<string, ClaimedBinding>; // `${operatorId}:${channel}`
}

declare global {
  // eslint-disable-next-line no-var
  var __untchBindingRuntime: Runtime | undefined;
}

function runtime(): Runtime {
  if (!globalThis.__untchBindingRuntime) {
    globalThis.__untchBindingRuntime = { pending: new Map(), claimed: new Map() };
  }
  return globalThis.__untchBindingRuntime;
}

function key(operatorId: string, channel: string): string {
  return `${operatorId}:${channel}`;
}

export function isBindableChannel(x: string): x is BindableChannel {
  return (BINDABLE_CHANNELS as readonly string[]).includes(x);
}

// ── Authority wiring (deliberately not installed) ────────────────────────────────────────────────

/** A source of `ChannelProof`s — implemented by the channel receivers. Nothing implements it yet. */
export interface ChannelProofSource {
  readonly kind: "channel-receiver";
}

let authority: { store: OperatorsRepo; proofSource: ChannelProofSource } | null = null;

/**
 * Wire a real authority store into the binding flow. Requires a channel-proof source in the SAME call,
 * by construction: an authority store without a way to prove control is the F1 hole, armed.
 *
 * If you reached for this because bindings "should be real now", the missing piece is not this function
 * — it is the receiver that turns a real inbound message into a `ChannelProof`. Build that first.
 */
export function installBindingAuthority(opts: { store: OperatorsRepo; proofSource: ChannelProofSource }): void {
  if (!opts?.store) throw new Error("installBindingAuthority: store is required");
  if (!opts?.proofSource || opts.proofSource.kind !== "channel-receiver") {
    throw new Error(
      "installBindingAuthority: refusing an authority store with no channel-proof source. A dashboard " +
        "code-paste is not proof of control (internal/binding-lifecycle-audit.md, F1); wiring a real " +
        "OperatorsRepo without a receiver that mints ChannelProof would let any signed-in operator claim " +
        "a handle they do not control. Build the receiver-driven proof first.",
    );
  }
  authority = { store: opts.store, proofSource: opts.proofSource };
}

/** Test seam — drop any installed authority. */
export function __resetBindingAuthority(): void {
  authority = null;
}

export function bindingAuthorityInstalled(): boolean {
  return authority !== null;
}

// ── The flow ─────────────────────────────────────────────────────────────────────────────────────

export interface StartResult {
  readonly code: string;
  readonly expiresAt: string;
  readonly channel: BindableChannel;
  readonly handle: string;
}

/**
 * Mint a single-use code and record the pending claim. The code is shown once, to the human.
 *
 * A pending claim deliberately reserves NOTHING: it writes no authority row, so it cannot squat a handle
 * another operator legitimately controls. Only a proved binding may ever claim `(channel, handle)`.
 */
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
  /** Always true for the dashboard path — the handle is claimed, not proved. Surface it to the human. */
  readonly unverified?: boolean;
}

/**
 * Record the operator's dashboard code-paste as an UNVERIFIED CLAIM.
 *
 * Named for what it is. It does not confirm, verify, or bind: it checks the operator can echo a code the
 * dashboard just showed them, which proves only that they are that session. The handle stays unproved
 * and the result confers no authority anywhere. Compare `verifyWithChannelProof`.
 */
export async function submitDashboardCode(params: {
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

  // NO operators.ensureBinding(...) here — that would write an authority row off an unproved handle.
  // See the header. The claim is recorded for the operator's own reference and nothing more.
  const claimed: ClaimedBinding = {
    operatorId: pending.operatorId,
    channel: pending.channel,
    handle: pending.handle,
    status: "unverified",
    at: Date.now(),
  };
  rt.claimed.set(k, claimed);
  rt.pending.delete(k);
  return {
    ok: true,
    unverified: true,
    binding: {
      channel: claimed.channel,
      handle: claimed.handle,
      status: "unverified",
      since: new Date(claimed.at).toISOString(),
    },
  };
}

/**
 * The ONLY path to `verified`: a code that actually arrived over the real channel, from the handle being
 * claimed, as observed by that channel's receiver.
 *
 * Not reachable yet — no receiver mints a `ChannelProof` (audit F1). It exists as a real, typed seam so
 * the shape of the missing half is unambiguous, and so the dashboard cannot quietly grow into this role:
 * the dashboard has no `ChannelProof` to pass and cannot construct one.
 */
export async function verifyWithChannelProof(params: {
  operatorId: string;
  proof: ChannelProof;
}): Promise<ConfirmResult> {
  const rt = runtime();
  const k = key(params.operatorId, params.proof.channel);
  const pending = rt.pending.get(k);
  if (!pending) return { ok: false, reason: "no pending binding for this channel; start again" };
  if (Date.now() > pending.expiresAt) {
    rt.pending.delete(k);
    return { ok: false, reason: "code expired; start again" };
  }
  if (!codeMatchesHash(params.proof.code.trim(), pending.codeHash)) {
    return { ok: false, reason: "code did not match" };
  }
  // The load-bearing check the dashboard path structurally cannot make: the code arrived FROM the handle
  // being claimed. A code echoed from anywhere else proves nothing about this handle.
  if (params.proof.observedSenderHandle.trim().toLowerCase() !== pending.handle.trim().toLowerCase()) {
    return { ok: false, reason: "code arrived from a different handle than the one being bound" };
  }
  if (!authority) {
    throw new Error(
      "verifyWithChannelProof: no binding authority installed. The receiver-driven proof path is not " +
        "built yet (internal/binding-lifecycle-audit.md, F1/F2). Refusing to report a binding as " +
        "verified when nothing would record it.",
    );
  }
  await authority.store.ensureBinding(pending.operatorId, pending.channel, pending.handle);
  const verified: ClaimedBinding = {
    operatorId: pending.operatorId,
    channel: pending.channel,
    handle: pending.handle,
    status: "verified",
    at: Date.now(),
  };
  rt.claimed.set(k, verified);
  rt.pending.delete(k);
  return {
    ok: true,
    binding: {
      channel: verified.channel,
      handle: verified.handle,
      status: "verified",
      since: new Date(verified.at).toISOString(),
    },
  };
}

/** Remove a binding (claimed or pending) for a channel. */
export function removeBinding(operatorId: string, channel: BindableChannel): void {
  const rt = runtime();
  rt.pending.delete(key(operatorId, channel));
  rt.claimed.delete(key(operatorId, channel));
}

/** Every binding (pending + claimed) for one operator, for the settings screen. */
export function listBindings(operatorId: string): BindingView[] {
  const rt = runtime();
  const out: BindingView[] = [];
  for (const c of rt.claimed.values()) {
    if (c.operatorId === operatorId) {
      out.push({ channel: c.channel, handle: c.handle, status: c.status, since: new Date(c.at).toISOString() });
    }
  }
  for (const p of rt.pending.values()) {
    if (p.operatorId === operatorId && !rt.claimed.has(key(operatorId, p.channel))) {
      out.push({ channel: p.channel, handle: p.handle, status: "pending", since: new Date(p.startedAt).toISOString() });
    }
  }
  return out.sort((a, b) => a.channel.localeCompare(b.channel));
}
