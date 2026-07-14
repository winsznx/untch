import { randomBytes } from "node:crypto";
import type { EscalationState, PreflightDecision } from "@untch/x402-guard";
import { ChannelRegistry } from "./channel";
import { codeMatchesHash, generateCode, hashCode } from "./codes";
import type { EscalationsRepo } from "./repo";
import type {
  ChannelLogEntry,
  EscalationRecord,
  EscalationRequest,
  InboundOutcome,
  InboundResponse,
  InboundResult,
  ResolvedBy,
} from "./types";

/**
 * The escalation service — the §7.2 lifecycle state machine and the §27 authority-boundary check, the
 * one place a channel's transported response is turned (or refused) into a money decision.
 *
 *   CREATED ─▶ FAN_OUT ─▶ PENDING
 *     ├─ all channels fail ─▶ NOTIFY_FAILED (timeout clock still runs)
 *     ├─ APPROVE (passes the FULL §27 check) ─▶ APPROVED     (or AWAITING_SECOND_CHANNEL if dual required)
 *     ├─ DENY    (passes the FULL §27 check) ─▶ DENIED
 *     ├─ invalid / unbound / replayed / capped ─▶ IGNORED_* (logged; escalation stays PENDING)
 *     └─ timeout T ─▶ EXPIRED ─▶ default DENY (I2, fail closed)
 *
 * THE CORE PRINCIPLE: channels never make money decisions. `handleInbound` accepts a transport-neutral
 * `InboundResponse` from ANY channel and, before it counts for anything, checks — in order — that the
 * intent is still active, the channel + sender's binding tuple match, the single-use code is valid and
 * unexpired and unredeemed, the channel cap is respected, and the dual-channel rule is satisfied. Any
 * failure is IGNORED and logged as a failed control event — never silently accepted. This is enforced
 * here, identically, for Telegram, Discord, Slack, Dashboard, and Photon (iMessage).
 */

/** Binding verifier — does this (channel, senderHandle) belong to a bound operator? (§27 pt3.) */
export type BindingVerifier = (channel: string, senderHandle: string) => boolean;

/** Schedules the timeout that fires EXPIRED → default DENY. Injected (BullMQ in prod; omitted in tests). */
export type TimeoutScheduler = (escalationId: string, fireAtMs: number) => Promise<void>;

/** A §27 failed control event — surfaced for alerting. Every IGNORED_* raises one; none is dropped. */
export interface FailedControlEvent {
  readonly escalationId: string | null;
  readonly channel: string;
  readonly senderHandle: string;
  readonly outcome: InboundOutcome;
  readonly detail: string;
}

export interface EscalationServiceDeps {
  readonly repo: EscalationsRepo;
  readonly registry: ChannelRegistry;
  readonly binding: BindingVerifier;
  readonly scheduleTimeout?: TimeoutScheduler;
  readonly clock?: () => number;
  readonly genId?: () => string;
  readonly genCode?: () => string;
  /** §7.2 default timeout when the policy omits `escalationTimeoutMin`. Minutes. */
  readonly defaultTimeoutMin?: number;
  /** Upper clamp so a pathological policy value can't keep a code answerable forever. Minutes. */
  readonly maxTimeoutMin?: number;
  /** §27 alert hook — invoked for every failed control event. */
  readonly onFailedControlEvent?: (evt: FailedControlEvent) => void;
  /**
   * Channels whose inbound is authorized by a proven SESSION IDENTITY (the dashboard's SIWE-verified
   * wallet), NOT a single-use code. For these, the §27 pt4 code check is REPLACED by an ownership check
   * (`verifyOwnership`): the code exists to prove receipt-on-an-external-channel, but a SIWE session already
   * proves identity more strongly, so the code is redundant — the escalation is instead tied to the sender
   * by ownership. Empty by default: Telegram/Discord/Slack always use the code path, unchanged.
   */
  readonly identityAuthorizedChannels?: ReadonlySet<string>;
  /**
   * For an identity-authorized channel: does `senderHandle` (the session's verified wallet) OWN this
   * escalation — i.e. is it the operator of the escalation's policy? This is the multi-tenant authority
   * boundary (§27) for the dashboard: a bound wallet can only resolve escalations for policies IT owns.
   * Required whenever `identityAuthorizedChannels` is non-empty (a channel is never code-waived without it).
   */
  readonly verifyOwnership?: (rec: EscalationRecord, senderHandle: string) => Promise<boolean>;
}

const OPEN_STATES = ["PENDING", "AWAITING_SECOND_CHANNEL", "NOTIFY_FAILED"] as const;

export interface CreatedEscalation {
  readonly record: EscalationRecord;
  /** The plaintext single-use code (only the hash is persisted). The channel already received it. */
  readonly code: string;
}

export class EscalationService {
  private readonly repo: EscalationsRepo;
  private readonly registry: ChannelRegistry;
  private readonly binding: BindingVerifier;
  private readonly scheduleTimeout: TimeoutScheduler | undefined;
  private readonly clock: () => number;
  private readonly genId: () => string;
  private readonly genCode: () => string;
  private readonly defaultTimeoutMin: number;
  private readonly maxTimeoutMin: number;
  private readonly onFailedControlEvent: (evt: FailedControlEvent) => void;
  private readonly identityAuthorizedChannels: ReadonlySet<string>;
  private readonly verifyOwnership: (rec: EscalationRecord, senderHandle: string) => Promise<boolean>;

  constructor(deps: EscalationServiceDeps) {
    this.repo = deps.repo;
    this.registry = deps.registry;
    this.binding = deps.binding;
    this.scheduleTimeout = deps.scheduleTimeout;
    this.clock = deps.clock ?? Date.now;
    this.genId = deps.genId ?? (() => `esc_${randomBytes(6).toString("hex")}`);
    this.genCode = deps.genCode ?? generateCode;
    this.defaultTimeoutMin = deps.defaultTimeoutMin ?? 30;
    this.maxTimeoutMin = deps.maxTimeoutMin ?? 1440;
    this.onFailedControlEvent = deps.onFailedControlEvent ?? (() => {});
    this.identityAuthorizedChannels = deps.identityAuthorizedChannels ?? new Set();
    this.verifyOwnership = deps.verifyOwnership ?? (async () => false);
  }

  // ── CREATE → FAN_OUT → PENDING ──────────────────────────────────────────────────────────────────

  /**
   * `opts.restrictToChannels`, when present, is the set of channels the escalating policy's OWNER's
   * operator is reachable on (owner-based routing). The fan-out targets are then the policy's authorized
   * channels ∩ the registered channels ∩ this set — so an escalation reaches the RIGHT owner's channels
   * and not another operator's. Absent ⇒ no owner restriction (the pre-routing behavior). It NEVER widens
   * the fan-out; it only narrows it. The inbound §27 authority check is unaffected (a channel a policy
   * authorizes can still resolve if it somehow received the code) — routing decides who is NOTIFIED.
   */
  async createEscalation(
    req: EscalationRequest,
    opts: { restrictToChannels?: ReadonlySet<string> } = {},
  ): Promise<CreatedEscalation> {
    // Idempotent by pollRef: a retried preflight (or a duplicate ESCALATED decision) must NOT mint a
    // fresh code and re-notify — the stored code hash would no longer match the new plaintext, breaking
    // a legitimate approval. The first escalation for a poll ref wins; a repeat returns it untouched.
    const prior = await this.repo.getByPollRef(req.pollRef);
    if (prior) return { record: prior, code: "" };

    const now = this.clock();
    const timeoutMin = clamp(
      req.approvals.escalationTimeoutMin ?? this.defaultTimeoutMin,
      1,
      this.maxTimeoutMin,
    );
    const codeExpiresAtMs = now + timeoutMin * 60_000;
    const code = this.genCode();
    const id = this.genId();

    const record = await this.repo.create({
      id,
      intentId: req.intentId,
      pollRef: req.pollRef,
      reason: req.reason,
      policyId: req.policyId,
      amount: req.amount,
      token: req.token,
      approvals: req.approvals,
      approvalCodeHash: hashCode(code),
      codeExpiresAt: new Date(codeExpiresAtMs).toISOString(),
      initialLog: [],
    });

    const targets = this.resolveTargetChannels(req.approvals.channels, opts.restrictToChannels);
    let anyOk = false;
    for (const ch of targets) {
      const t0 = this.clock();
      const res = await ch.send({
        escalationId: id,
        intentId: req.intentId,
        reason: req.reason,
        amount: req.amount,
        token: req.token,
        policyId: req.policyId,
        code,
        expiresAt: record.codeExpiresAt,
      });
      anyOk = anyOk || res.ok;
      await this.repo.appendLog(id, {
        at: new Date(this.clock()).toISOString(),
        channel: ch.name,
        kind: res.ok ? "FANOUT" : "FANOUT_FAILED",
        latencyMs: this.clock() - t0,
        ...(res.detail ? { detail: res.detail } : {}),
      });
    }

    if (targets.length === 0 || !anyOk) {
      // §7.2: all channels failed (or none available) ⇒ NOTIFY_FAILED, but the timeout clock still runs
      // so an unreachable operator still fails closed to DENY rather than leaving the spend held forever.
      await this.repo.transition(id, {
        toStatus: "NOTIFY_FAILED",
        fromStatuses: ["PENDING"],
        appendLog: sysLog(this.clock(), "no channel delivered the escalation"),
      });
    }

    if (this.scheduleTimeout) await this.scheduleTimeout(id, codeExpiresAtMs);

    const fresh = await this.repo.getById(id);
    return { record: fresh ?? record, code };
  }

  private resolveTargetChannels(allowed: readonly string[], restrict?: ReadonlySet<string>) {
    // Intersection ONLY — a policy naming a channel that isn't registered (e.g. imessage/Photon) simply
    // doesn't fan out there. A channel is never faked to satisfy the policy's list.
    const base =
      allowed.length === 0
        ? this.registry.all()
        : allowed
            .map((name) => this.registry.get(name))
            .filter((c): c is NonNullable<typeof c> => c !== undefined);
    // Owner routing narrows further: only channels the escalating policy's owner-operator is bound to.
    return restrict ? base.filter((c) => restrict.has(c.name)) : base;
  }

  // ── INBOUND: the §27 authority-boundary check ───────────────────────────────────────────────────

  async handleInbound(r: InboundResponse): Promise<InboundResult> {
    const now = this.clock();

    // Resolve the escalation this response targets. Prefer the id the channel embedded; fall back to the
    // code's hash (the "APPROVE <code>" text baseline). Either way the code is re-validated below.
    let rec = r.escalationRef ? await this.repo.getById(r.escalationRef) : null;
    if (!rec) rec = await this.repo.getByCodeHash(hashCode(r.code));
    if (!rec) {
      this.alert(null, r, "IGNORED_NOT_FOUND", "no escalation matches this ref/code");
      return result("IGNORED_NOT_FOUND", null, null, "no escalation matches this ref/code");
    }
    const escId = rec.id;

    // (idempotent) A terminal decision already reached — first valid decision wins; ack the rest.
    if (rec.status === "APPROVED" || rec.status === "DENIED" || rec.status === "EXPIRED") {
      await this.logInbound(escId, r, "IGNORED_ALREADY_RESOLVED", `already ${rec.status}`);
      return result("IGNORED_ALREADY_RESOLVED", rec.status, escId, `already ${rec.status}`);
    }

    // §27 pt1 — intent still active. Fail-closed derived expiry: if the escalation is past its code TTL,
    // it EXPIRES to default DENY here even if the BullMQ timeout job hasn't fired yet.
    if (now > Date.parse(rec.codeExpiresAt)) {
      await this.repo.transition(escId, {
        toStatus: "EXPIRED",
        fromStatuses: OPEN_STATES,
        resolvedAtMs: now,
        appendLog: sysLog(now, "expired before this response (default DENY)"),
      });
      await this.logInbound(escId, r, "IGNORED_EXPIRED", "response arrived after expiry");
      this.alert(escId, r, "IGNORED_EXPIRED", "response arrived after expiry");
      return result("IGNORED_EXPIRED", "EXPIRED", escId, "response arrived after expiry");
    }

    // §27 pt2/pt3 — channel authorized by policy AND the sender's binding tuple matches.
    const channelAllowed =
      rec.approvals.channels.length === 0
        ? this.registry.get(r.channel) !== undefined
        : rec.approvals.channels.includes(r.channel);
    if (!channelAllowed || !this.binding(r.channel, r.senderHandle)) {
      const detail = channelAllowed
        ? "sender handle not bound to the operator"
        : "channel not authorized by policy";
      await this.logInbound(escId, r, "IGNORED_UNBOUND", detail);
      this.alert(escId, r, "IGNORED_UNBOUND", detail);
      return result("IGNORED_UNBOUND", rec.status, escId, detail);
    }

    // §27 pt4 — proof this response is a legitimate, single-use resolution of THIS escalation. Two paths:
    //   • external channels (Telegram/Discord/Slack): a valid single-use code, not already redeemed here.
    //   • identity-authorized channels (dashboard): the SIWE session proved identity, so the code is
    //     replaced by an OWNERSHIP check — the sender must be the operator of this escalation's policy. A
    //     foreign escalation (a policy the sender doesn't own) fails the §27 boundary here, exactly like a
    //     bad code. Same-channel replay is refused on both paths.
    const replayedOnChannel = rec.approvedChannels.includes(r.channel);
    if (this.identityAuthorizedChannels.has(r.channel)) {
      const owns = await this.verifyOwnership(rec, r.senderHandle);
      if (!owns) {
        const detail = "session identity does not own this escalation's policy";
        await this.logInbound(escId, r, "IGNORED_UNBOUND", detail);
        this.alert(escId, r, "IGNORED_UNBOUND", detail);
        return result("IGNORED_UNBOUND", rec.status, escId, detail);
      }
      if (replayedOnChannel) {
        const detail = "already confirmed on this channel (replay)";
        await this.logInbound(escId, r, "IGNORED_BAD_CODE", detail);
        this.alert(escId, r, "IGNORED_BAD_CODE", detail);
        return result("IGNORED_BAD_CODE", rec.status, escId, detail);
      }
    } else {
      const codeOk = codeMatchesHash(r.code, rec.approvalCodeHash);
      if (!codeOk || replayedOnChannel) {
        const detail = !codeOk ? "code invalid" : "code already redeemed on this channel (replay)";
        await this.logInbound(escId, r, "IGNORED_BAD_CODE", detail);
        this.alert(escId, r, "IGNORED_BAD_CODE", detail);
        return result("IGNORED_BAD_CODE", rec.status, escId, detail);
      }
    }

    if (r.action === "DENY") {
      return this.resolveTerminal(escId, r, "DENIED", now);
    }

    // §27 pt5 — channel amount cap.
    const cap = rec.approvals.channelCaps[r.channel];
    if (cap !== undefined && rec.amount > cap) {
      const detail = `amount ${rec.amount} exceeds ${r.channel} cap ${cap}`;
      await this.logInbound(escId, r, "IGNORED_CHANNEL_CAP", detail);
      this.alert(escId, r, "IGNORED_CHANNEL_CAP", detail);
      return result("IGNORED_CHANNEL_CAP", rec.status, escId, detail);
    }

    // §27 pt6 — dual-channel rule. Above the threshold, two DISTINCT channels must each confirm.
    const dualAbove = rec.approvals.dualChannelAbove;
    if (dualAbove !== null && rec.amount > dualAbove) {
      const distinct = new Set([...rec.approvedChannels, r.channel]);
      if (distinct.size < 2) {
        const updated = await this.repo.transition(escId, {
          toStatus: "AWAITING_SECOND_CHANNEL",
          fromStatuses: ["PENDING", "NOTIFY_FAILED"],
          addApprovedChannel: r.channel,
        });
        if (!updated) return this.alreadyResolved(escId, r);
        const detail = "first channel confirmed; a distinct second channel is required";
        await this.logInbound(escId, r, "AWAITING_SECOND_CHANNEL", detail);
        return result("AWAITING_SECOND_CHANNEL", updated.status, escId, detail);
      }
      // A distinct second channel has now confirmed ⇒ fully approved.
      return this.resolveTerminal(escId, r, "APPROVED", now);
    }

    return this.resolveTerminal(escId, r, "APPROVED", now);
  }

  private async resolveTerminal(
    escId: string,
    r: InboundResponse,
    to: "APPROVED" | "DENIED",
    nowMs: number,
  ): Promise<InboundResult> {
    const resolvedBy: ResolvedBy = { channel: r.channel, handle: r.senderHandle };
    const updated = await this.repo.transition(escId, {
      toStatus: to,
      fromStatuses: OPEN_STATES,
      resolvedBy,
      resolvedAtMs: nowMs,
      addApprovedChannel: r.channel,
    });
    if (!updated) return this.alreadyResolved(escId, r);
    await this.logInbound(escId, r, to, `resolved ${to} via ${r.channel}`);
    return result(to, updated.status, escId, `resolved ${to} via ${r.channel}`);
  }

  private async alreadyResolved(escId: string, r: InboundResponse): Promise<InboundResult> {
    await this.logInbound(escId, r, "IGNORED_ALREADY_RESOLVED", "resolved concurrently");
    const cur = await this.repo.getById(escId);
    return result("IGNORED_ALREADY_RESOLVED", cur?.status ?? null, escId, "resolved concurrently");
  }

  // ── TIMEOUT: EXPIRED → default DENY (I2) ────────────────────────────────────────────────────────

  /** Fire the timeout for one escalation. Idempotent: a no-op if already resolved or not yet due. */
  async expire(escalationId: string): Promise<boolean> {
    const now = this.clock();
    const rec = await this.repo.getById(escalationId);
    if (!rec) return false;
    if (now < Date.parse(rec.codeExpiresAt)) return false;
    const updated = await this.repo.transition(escalationId, {
      toStatus: "EXPIRED",
      fromStatuses: OPEN_STATES,
      resolvedAtMs: now,
      appendLog: sysLog(now, "timeout reached → EXPIRED (default DENY, I2)"),
    });
    return updated !== null;
  }

  /** Safety sweep — expire any open escalation past its TTL (backstop for a missed BullMQ job). */
  async sweepExpired(limit = 100): Promise<number> {
    const due = await this.repo.findExpirable(this.clock(), limit);
    let n = 0;
    for (const rec of due) if (await this.expire(rec.id)) n++;
    return n;
  }

  // ── RESOLVE for the x402-guard poll() ───────────────────────────────────────────────────────────

  /**
   * The state the guard's `poll()` resolves to (§7.2 / §14 Mode B). Fail-closed: an unknown escalation
   * is PENDING (not yet created), and an open escalation past its TTL reads as DENIED (default DENY)
   * even before the timeout job runs — the guard never settles an escalation that timed out.
   */
  async getState(pollRef: string): Promise<EscalationState> {
    const rec = await this.repo.getByPollRef(pollRef);
    if (!rec) return { status: "PENDING", reason: "escalation not yet created" };

    if (rec.status === "APPROVED") {
      return { status: "APPROVED", decision: approvedDecision(rec) };
    }
    if (rec.status === "DENIED") return { status: "DENIED", reason: "ESCALATION_DENIED" };
    if (rec.status === "EXPIRED") {
      return { status: "DENIED", reason: "ESCALATION_EXPIRED_DEFAULT_DENY" };
    }

    if (this.clock() > Date.parse(rec.codeExpiresAt)) {
      await this.repo.transition(rec.id, {
        toStatus: "EXPIRED",
        fromStatuses: OPEN_STATES,
        resolvedAtMs: this.clock(),
        appendLog: sysLog(this.clock(), "expired on poll (default DENY, I2)"),
      });
      return { status: "DENIED", reason: "ESCALATION_EXPIRED_DEFAULT_DENY" };
    }
    return { status: "PENDING", reason: rec.reason };
  }

  getByPollRef(pollRef: string): Promise<EscalationRecord | null> {
    return this.repo.getByPollRef(pollRef);
  }

  // ── internals ───────────────────────────────────────────────────────────────────────────────────

  private async logInbound(
    escId: string,
    r: InboundResponse,
    outcome: InboundOutcome,
    detail: string,
  ): Promise<void> {
    await this.repo.appendLog(escId, {
      at: new Date(this.clock()).toISOString(),
      channel: r.channel,
      kind: "INBOUND",
      handle: r.senderHandle,
      outcome,
      latencyMs: Math.max(0, this.clock() - r.receivedAtMs),
      detail,
    });
  }

  private alert(
    escalationId: string | null,
    r: InboundResponse,
    outcome: InboundOutcome,
    detail: string,
  ): void {
    this.onFailedControlEvent({
      escalationId,
      channel: r.channel,
      senderHandle: r.senderHandle,
      outcome,
      detail,
    });
  }
}

function result(
  outcome: InboundOutcome,
  status: InboundResult["status"],
  escalationId: string | null,
  detail: string,
): InboundResult {
  return { outcome, status, escalationId, detail };
}

function approvedDecision(rec: EscalationRecord): PreflightDecision {
  return {
    decision: "APPROVED",
    intentHash: rec.intentId,
    policyId: rec.policyId,
    escalation: {
      id: rec.id,
      reason: rec.reason,
      resolvedBy: rec.resolvedBy,
      resolvedAt: rec.resolvedAt,
    },
  };
}

function sysLog(nowMs: number, detail: string): ChannelLogEntry {
  return { at: new Date(nowMs).toISOString(), channel: "system", kind: "SYSTEM", detail };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}
