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
