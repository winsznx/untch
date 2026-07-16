import { decodeEventLog, type Abi, type Address, type Log, type PublicClient } from "viem";
import type { Channel, GovernanceAlert, GovernanceEventKind } from "@untch/escalation";
import { OP_KIND_NAMES, severityOf, WATCHED_EVENTS } from "./events";

/**
 * The governance watcher — a deliberately small poller over a handful of low-volume events, NOT an
 * indexer. It stores no history, exposes no query surface, and keeps exactly one number durable (the
 * last block it has fully scanned). Everything it finds it hands straight to the escalation channels
 * and forgets.
 *
 * WHY IT EXISTS: UntchReceipts' 72h timelock and its `cancel()` are only a defense if a human hears
 * about `OpProposed` in time to pull the lever. Without this, the delay is a lever with nobody watching.
 */

/** One contract to watch. `name` must be a key of WATCHED_EVENTS; `abi` is the real deployed artifact. */
export interface WatchTarget {
  readonly name: keyof typeof WATCHED_EVENTS | string;
  readonly address: Address;
  readonly abi: Abi;
}

export interface WatcherOptions {
  readonly client: PublicClient;
  readonly chainId: number;
  readonly targets: readonly WatchTarget[];
  readonly channels: readonly Channel[];
  /** Persisted cursor. Returning null starts the watcher at `startBlock` (or chain head). */
  readonly cursor: CursorStore;
  /**
   * Max blocks per `eth_getLogs`. X Layer's public RPC rejects >100 outright
   * ("block range greater than 100 max"), so this is a hard transport limit, not a tuning knob.
   */
  readonly maxBlockRange?: bigint;
  readonly explorerTxBase?: string;
  readonly now?: () => number;
  readonly log?: (line: string) => void;
  /** Tries per channel per alert before giving up for this tick. Default 3. */
  readonly sendAttempts?: number;
  /** Linear backoff base between send attempts, ms. Default 1000. */
  readonly sendBackoffMs?: number;
  /** DI seam for tests, so retry backoff does not make the suite sleep for real. */
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface CursorStore {
  read(): Promise<bigint | null>;
  write(block: bigint): Promise<void>;
}

export interface ScanResult {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly alerts: readonly GovernanceAlert[];
  /** False when an alert could not be delivered anywhere — the cursor is then NOT advanced. */
  readonly delivered: boolean;
}

const DEFAULT_MAX_RANGE = 100n;
const DEFAULT_SEND_ATTEMPTS = 3;
const DEFAULT_SEND_BACKOFF_MS = 1000;

export class GovernanceWatcher {
  private readonly opts: Required<
    Pick<WatcherOptions, "maxBlockRange" | "now" | "log" | "sendAttempts" | "sendBackoffMs">
  > &
    WatcherOptions;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Guards against double-alerting the same log across an overlapping or retried scan. */
  private readonly seen = new Set<string>();

  constructor(opts: WatcherOptions) {
    this.opts = {
      ...opts,
      maxBlockRange: opts.maxBlockRange ?? DEFAULT_MAX_RANGE,
      now: opts.now ?? Date.now,
      log: opts.log ?? (() => {}),
      sendAttempts: opts.sendAttempts ?? DEFAULT_SEND_ATTEMPTS,
      sendBackoffMs: opts.sendBackoffMs ?? DEFAULT_SEND_BACKOFF_MS,
    };
    this.sleep = opts.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const notifiable = opts.channels.filter((c) => typeof c.notify === "function");
    if (notifiable.length === 0) {
      throw new Error(
        "No channel implements notify() — the watcher would detect governance events and tell nobody. " +
          `Channels given: ${opts.channels.map((c) => c.name).join(", ") || "(none)"}.`,
      );
    }
    for (const c of opts.channels) {
      if (typeof c.notify !== "function") {
        this.opts.log(
          `channel "${c.name}" has no notify() — SKIPPED for governance alerts (it is an approval-only ` +
            `surface). It will not carry these alerts.`,
        );
      }
    }
  }

  /**
   * Scan `[from, to]` in RPC-legal chunks and alert on everything found.
   *
   * Chunking is per-target-per-range because the transport caps the range, so a 10,000-block catch-up
   * after downtime is 100 sequential requests, not one rejected one.
   */
  async scanRange(fromBlock: bigint, toBlock: bigint): Promise<ScanResult> {
    const found: Array<{ alert: GovernanceAlert; key: string }> = [];

    for (let start = fromBlock; start <= toBlock; start += this.opts.maxBlockRange) {
      const end = start + this.opts.maxBlockRange - 1n > toBlock ? toBlock : start + this.opts.maxBlockRange - 1n;
      for (const target of this.opts.targets) {
        const logs = await this.opts.client.getLogs({
          address: target.address,
          fromBlock: start,
          toBlock: end,
        });
        for (const log of logs) {
          const key = `${log.transactionHash}:${log.logIndex}`;
          if (this.seen.has(key)) continue;
          const alert = this.toAlert(target, log);
          if (!alert) continue;
          found.push({ alert, key });
        }
      }
    }

    let delivered = true;
    const alerts: GovernanceAlert[] = [];
    for (const { alert, key } of found) {
      alerts.push(alert);
      const ok = await this.fanOut(alert);
      // `seen` means DELIVERED, not merely observed. Marking it on sight would make the undelivered
      // case unrecoverable: the cursor (correctly) would not advance, but the rescan would then skip
      // this very log as already-seen and never retry it — the watcher would spin forever while the
      // operator heard nothing. A real transient fetch failure against the live Telegram API is what
      // surfaced this; the ordering here is load-bearing, not stylistic.
      if (ok) this.seen.add(key);
      else delivered = false;
    }
    return { fromBlock, toBlock, alerts, delivered };
  }

  /**
   * One poll tick: scan from the cursor to the current head, and advance the cursor ONLY if every alert
   * reached at least one channel.
   *
   * Not advancing on a delivery failure is the whole safety property. Advancing anyway would drop the
   * event permanently and silently — the exact "nobody is watching" hole this service exists to close.
   * The cost is that a hard-down channel re-alerts the same event next tick, which is the right trade:
   * a duplicate governance alert is noise, a missed one can be a stolen writer key.
   */
  async tick(): Promise<ScanResult | null> {
    // cacheTime: 0 is load-bearing. viem caches getBlockNumber for `pollingInterval` (4s default), so
    // the default would let a tick read a STALE head, conclude `cursor >= head`, and report "nothing
    // new" while a fresh OpProposed sat one block ahead — the watcher blind for seconds at a time,
    // silently. Caught by the live fork proof, where the tick right after a propose missed it entirely.
    const head = await this.opts.client.getBlockNumber({ cacheTime: 0 });
    const cursor = await this.opts.cursor.read();
    if (cursor === null) {
      await this.opts.cursor.write(head);
      this.opts.log(`no cursor — starting at head ${head}`);
      return null;
    }
    if (cursor >= head) return null;

    const from = cursor + 1n;
    const result = await this.scanRange(from, head);
    if (result.delivered) {
      await this.opts.cursor.write(head);
    } else {
      this.opts.log(
        `NOT advancing cursor past ${cursor}: an alert failed to reach any channel. Will retry from ` +
          `${from} next tick rather than lose the event.`,
      );
    }
    return result;
  }

  /**
   * Deliver to every channel that can carry a notification. One success = delivered.
   *
   * Each channel gets `sendAttempts` tries with linear backoff. A single dropped TCP connection to the
   * Telegram API (observed for real against the live bot) should not cost an operator a whole poll
   * interval of silence on a `cancel()` window that is already ticking.
   */
  private async fanOut(alert: GovernanceAlert): Promise<boolean> {
    let anyOk = false;
    for (const channel of this.opts.channels) {
      if (typeof channel.notify !== "function") continue;
      for (let attempt = 1; attempt <= this.opts.sendAttempts; attempt++) {
        let detail: string;
        try {
          const res = await channel.notify(alert);
          if (res.ok) {
            anyOk = true;
            this.opts.log(`  → ${channel.name}: delivered${attempt > 1 ? ` (attempt ${attempt})` : ""}`);
            break;
          }
          detail = res.detail ?? "no detail";
        } catch (err) {
          detail = (err as Error).message;
        }
        const last = attempt === this.opts.sendAttempts;
        this.opts.log(`  → ${channel.name}: ${last ? "FAILED" : `retrying after`} attempt ${attempt} (${detail})`);
        if (!last) await this.sleep(this.opts.sendBackoffMs * attempt);
      }
    }
    if (!anyOk) {
      this.opts.log(
        `  !! ${alert.kind} on ${alert.contract} reached NO channel after ${this.opts.sendAttempts} ` +
          `attempts each — undelivered, cursor held, will retry next tick.`,
      );
    }
    return anyOk;
  }

  /** Decode a raw log into an alert, or null if it is not a watched governance event. */
  private toAlert(target: WatchTarget, log: Log): GovernanceAlert | null {
    const watched = WATCHED_EVENTS[target.name as keyof typeof WATCHED_EVENTS];
    if (!watched) return null;

    let decoded: { eventName?: string; args?: unknown };
    try {
      // Decoded against the REAL deployed artifact ABI, so a signature can never drift from the
      // contract. A non-governance log (ReceiptLogged, IntentRegistered, …) decodes fine and is
      // filtered by name below; a log this ABI does not know throws and is skipped.
      decoded = decodeEventLog({ abi: target.abi, data: log.data, topics: log.topics });
    } catch {
      return null;
    }
    const name = decoded.eventName as GovernanceEventKind | undefined;
    if (!name || !watched.includes(name)) return null;

    const args = (decoded.args ?? {}) as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const [k, v] of Object.entries(args)) {
      fields[k] = k === "kind" && typeof v === "number" ? `${OP_KIND_NAMES[v] ?? v} (${v})` : String(v);
    }

    const alert: GovernanceAlert = {
      kind: name,
      contract: String(target.name),
      contractAddress: target.address,
      chainId: this.opts.chainId,
      txHash: log.transactionHash ?? "(pending)",
      blockNumber: String(log.blockNumber ?? "(pending)"),
      fields,
      severity: severityOf(name),
      ...this.cancelWindowFor(name, args),
      ...(this.opts.explorerTxBase && log.transactionHash
        ? { explorerUrl: `${this.opts.explorerTxBase}${log.transactionHash}` }
        : {}),
    };
    return alert;
  }

  /** Only OpProposed carries an `eta`, and only OpProposed has a window worth acting inside. */
  private cancelWindowFor(
    kind: GovernanceEventKind,
    args: Record<string, unknown>,
  ): Pick<GovernanceAlert, "cancelWindow"> | Record<string, never> {
    if (kind !== "OpProposed" || typeof args.eta !== "bigint") return {};
    const etaSec = Number(args.eta);
    return {
      cancelWindow: {
        etaIso: new Date(etaSec * 1000).toISOString(),
        secondsRemaining: Math.max(0, etaSec - Math.floor(this.opts.now() / 1000)),
      },
    };
  }
}
