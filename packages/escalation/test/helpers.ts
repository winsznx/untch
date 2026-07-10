import type { Channel, ChannelReceiver, ChannelSendResult, EscalationMessage } from "../src/channel";
import { ChannelRegistry } from "../src/channel";
import { InMemoryEscalationsRepo } from "../src/repo-memory";
import {
  EscalationService,
  type BindingVerifier,
  type EscalationServiceDeps,
  type FailedControlEvent,
} from "../src/service";
import type { ApprovalsConfig, EscalationRequest, InboundResponse } from "../src/types";
import type { WebSocketLike, WsCloseEvent, WsMessageEvent } from "../src/ws";
import {
  combineBindings,
  interimDiscordBinding,
  interimSlackBinding,
  interimTelegramBinding,
} from "../src/binding";

/** A deterministic, controllable clock (unix ms) so timeout/expiry are exact, not wall-clock flaky. */
export function fakeClock(startMs = 1_700_000_000_000) {
  let t = startMs;
  return {
    now: (): number => t,
    advance: (ms: number): void => {
      t += ms;
    },
    set: (ms: number): void => {
      t = ms;
    },
  };
}

/** A recording, controllable `Channel` — no network. Toggle `sendOk` to exercise the fan-out failure path. */
export class FakeChannel implements Channel {
  readonly sent: EscalationMessage[] = [];
  sendOk = true;
  constructor(readonly name: string) {}

  async send(message: EscalationMessage): Promise<ChannelSendResult> {
    this.sent.push(message);
    return this.sendOk ? { ok: true, meta: {} } : { ok: false, detail: `${this.name} send failed` };
  }

  async startReceiving(): Promise<ChannelReceiver> {
    return { stop: async () => {} };
  }
}

/**
 * A controllable in-memory `WebSocketLike` — no network. The channel attaches its listeners; the test
 * drives the connection with `open()` / `receive(obj)` / `serverClose()` and inspects `sent` frames. This
 * is the WS analogue of the Telegram tests' injected `fetchImpl`: the gateway/socket lifecycle (identify,
 * heartbeat, ack, reconnect) is exercised deterministically with zero network.
 */
export class FakeWebSocket implements WebSocketLike {
  readyState = 1;
  readonly sent: string[] = [];
  private readonly handlers = {
    open: [] as Array<() => void>,
    message: [] as Array<(ev: WsMessageEvent) => void>,
    close: [] as Array<(ev: WsCloseEvent) => void>,
    error: [] as Array<(ev: unknown) => void>,
  };
  closed: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closed = { ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) };
    for (const h of this.handlers.close) h({ ...(code !== undefined ? { code } : {}), ...(reason !== undefined ? { reason } : {}) });
  }
  addEventListener(type: "open", cb: () => void): void;
  addEventListener(type: "message", cb: (ev: WsMessageEvent) => void): void;
  addEventListener(type: "close", cb: (ev: WsCloseEvent) => void): void;
  addEventListener(type: "error", cb: (ev: unknown) => void): void;
  addEventListener(type: keyof FakeWebSocket["handlers"], cb: (ev: never) => void): void {
    (this.handlers[type] as Array<(ev: never) => void>).push(cb);
  }

  // ── test drivers ──────────────────────────────────────────────────────────────────────────────
  receive(obj: unknown): void {
    const data = typeof obj === "string" ? obj : JSON.stringify(obj);
    for (const h of this.handlers.message) h({ data });
  }
  serverClose(code?: number, reason?: string): void {
    this.close(code, reason);
  }
  /** The parsed frames the channel has sent so far. */
  sentJson(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

/** A capturing WebSocket factory — hands out `FakeWebSocket`s and remembers each one the channel opens. */
export function fakeWsFactory(): { factory: (url: string) => WebSocketLike; sockets: FakeWebSocket[] } {
  const sockets: FakeWebSocket[] = [];
  return {
    factory: (url: string) => {
      const s = new FakeWebSocket(url);
      sockets.push(s);
      return s;
    },
    sockets,
  };
}

export const BOUND_HANDLE = "OPERATOR";

export function approvals(partial: Partial<ApprovalsConfig> = {}): ApprovalsConfig {
  return {
    channels: [],
    dualChannelAbove: null,
    channelCaps: {},
    escalationTimeoutMin: null,
    ...partial,
  };
}

export function escalationRequest(partial: Partial<EscalationRequest> = {}): EscalationRequest {
  return {
    pollRef: "poll_1",
    intentId: "0xintent",
    reason: "ESCALATED_THRESHOLD",
    policyId: "12",
    amount: 8,
    token: "USDT",
    approvals: approvals(),
    ...partial,
  };
}

export interface Harness {
  readonly service: EscalationService;
  readonly repo: InMemoryEscalationsRepo;
  readonly registry: ChannelRegistry;
  readonly telegram: FakeChannel;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly failed: FailedControlEvent[];
  readonly scheduled: Array<{ escalationId: string; fireAtMs: number }>;
}

export function makeHarness(overrides: Partial<EscalationServiceDeps> = {}): Harness {
  const repo = new InMemoryEscalationsRepo();
  const registry = new ChannelRegistry();
  const telegram = new FakeChannel("telegram");
  registry.register(telegram);
  const clock = fakeClock();
  const failed: FailedControlEvent[] = [];
  const scheduled: Array<{ escalationId: string; fireAtMs: number }> = [];
  let idSeq = 0;
  let codeSeq = 0;

  const binding: BindingVerifier = (ch, handle) => ch === "telegram" && handle === BOUND_HANDLE;

  const service = new EscalationService({
    repo,
    registry,
    binding,
    clock: clock.now,
    genId: () => `esc_${(++idSeq).toString(16).padStart(12, "0")}`,
    genCode: () => (++codeSeq).toString(16).padStart(24, "0"),
    scheduleTimeout: async (escalationId, fireAtMs) => {
      scheduled.push({ escalationId, fireAtMs });
    },
    defaultTimeoutMin: 30,
    maxTimeoutMin: 1440,
    onFailedControlEvent: (e) => failed.push(e),
    ...overrides,
  });

  return { service, repo, registry, telegram, clock, failed, scheduled };
}

export interface TriHarness {
  readonly service: EscalationService;
  readonly repo: InMemoryEscalationsRepo;
  readonly registry: ChannelRegistry;
  readonly telegram: FakeChannel;
  readonly discord: FakeChannel;
  readonly slack: FakeChannel;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly failed: FailedControlEvent[];
}

/**
 * A harness with all THREE real-named channels registered and the SAME operator bound on each via the
 * real `combineBindings(interim*Binding(...))` composition — the "one operator, three surfaces" model.
 * This is what makes the dual-channel rule genuinely testable: two DISTINCT channels can now confirm.
 */
export function makeTriHarness(): TriHarness {
  const repo = new InMemoryEscalationsRepo();
  const registry = new ChannelRegistry();
  const telegram = new FakeChannel("telegram");
  const discord = new FakeChannel("discord");
  const slack = new FakeChannel("slack");
  registry.register(telegram);
  registry.register(discord);
  registry.register(slack);
  const clock = fakeClock();
  const failed: FailedControlEvent[] = [];
  let idSeq = 0;
  let codeSeq = 0;

  const binding = combineBindings(
    interimTelegramBinding(BOUND_HANDLE),
    interimDiscordBinding(BOUND_HANDLE),
    interimSlackBinding(BOUND_HANDLE),
  );

  const service = new EscalationService({
    repo,
    registry,
    binding,
    clock: clock.now,
    genId: () => `esc_${(++idSeq).toString(16).padStart(12, "0")}`,
    genCode: () => (++codeSeq).toString(16).padStart(24, "0"),
    scheduleTimeout: async () => {},
    defaultTimeoutMin: 30,
    maxTimeoutMin: 1440,
    onFailedControlEvent: (e) => failed.push(e),
  });

  return { service, repo, registry, telegram, discord, slack, clock, failed };
}

/** Build an inbound response; defaults to a well-formed bound APPROVE carrying `code`. */
export function inbound(code: string, partial: Partial<InboundResponse> = {}): InboundResponse {
  return {
    channel: "telegram",
    senderHandle: BOUND_HANDLE,
    action: "APPROVE",
    code,
    receivedAtMs: 0,
    ...partial,
  };
}
