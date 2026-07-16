import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Abi, Log, PublicClient } from "viem";
import type { Channel, ChannelSendResult, GovernanceAlert } from "@untch/escalation";
import { renderGovernanceText } from "@untch/escalation";
import { GovernanceWatcher, MemoryCursor, type WatchTarget } from "../src/index";

/**
 * The log fixtures are REAL: read off the deployed X Layer testnet UntchReceipts with eth_getLogs, not
 * hand-authored. So these tests prove decoding against bytes the real contract actually emitted, which
 * is the only way to know the ABI decode path matches production rather than matching my own fixture.
 */
const FIX = JSON.parse(
  readFileSync(fileURLToPath(new URL("./real-testnet-logs.json", import.meta.url)), "utf8"),
) as { logs: Array<Record<string, string | string[]>> };

const RECEIPTS_ABI = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("../../../contracts/out/UntchReceipts.sol/UntchReceipts.json", import.meta.url)), "utf8"),
  ) as { abi: Abi }
).abi;

const RECEIPTS_ADDR = "0x0C64997277b7D94d2999DEa22A123cac56334863" as const;

const asLogs = (raw: typeof FIX.logs): Log[] =>
  raw.map((l) => ({
    ...l,
    blockNumber: BigInt(l.blockNumber as string),
    logIndex: Number(l.logIndex),
    transactionIndex: Number(l.transactionIndex),
    removed: false,
  })) as unknown as Log[];

/** Retry backoff is real time; tests must not actually sleep through it. */
const noSleep = async () => {};

const target = (): WatchTarget => ({ name: "UntchReceipts", address: RECEIPTS_ADDR, abi: RECEIPTS_ABI });

/** A client whose getLogs returns the real fixture logs that fall inside the requested range. */
function fakeClient(logs: Log[], head = 35236737n): { client: PublicClient; ranges: Array<[bigint, bigint]> } {
  const ranges: Array<[bigint, bigint]> = [];
  const client = {
    getBlockNumber: async () => head,
    getLogs: async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => {
      ranges.push([fromBlock, toBlock]);
      return logs.filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock);
    },
  } as unknown as PublicClient;
  return { client, ranges };
}

class CapturingChannel implements Channel {
  readonly name = "capture";
  readonly got: GovernanceAlert[] = [];
  constructor(private readonly ok = true) {}
  async send(): Promise<ChannelSendResult> {
    return { ok: true };
  }
  async notify(alert: GovernanceAlert): Promise<ChannelSendResult> {
    this.got.push(alert);
    return this.ok ? { ok: true } : { ok: false, detail: "simulated channel outage" };
  }
  async startReceiving() {
    return { stop: async () => {} };
  }
}

/** An approval-only channel, like DashboardChannel: no notify(). */
class NoNotifyChannel implements Channel {
  readonly name = "approval-only";
  async send(): Promise<ChannelSendResult> {
    return { ok: true };
  }
  async startReceiving() {
    return { stop: async () => {} };
  }
}

test("decodes the REAL OpProposed emitted by the deployed testnet contract", async () => {
  const ch = new CapturingChannel();
  const { client } = fakeClient(asLogs(FIX.logs));
  const w = new GovernanceWatcher({
    client,
    chainId: 1952,
    targets: [target()],
    channels: [ch],
    cursor: new MemoryCursor(),
    now: () => 1_783_695_000_000,
    sleepImpl: noSleep,
  });

  const res = await w.scanRange(35236666n, 35236666n);
  assert.equal(res.alerts.length, 1);
  const a = res.alerts[0]!;
  assert.equal(a.kind, "OpProposed");
  assert.equal(a.contract, "UntchReceipts");
  assert.equal(a.severity, "critical");
  // The real proposal was ADD_WRITER for the real provisioned writer, eta 1783695563.
  assert.equal(a.fields.kind, "ADD_WRITER (1)");
  assert.equal(a.fields.target, "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5");
  assert.equal(a.fields.eta, "1783695563");
  assert.ok(a.cancelWindow, "OpProposed must carry a cancel window — that is the point of the alert");
  assert.equal(a.cancelWindow!.etaIso, new Date(1783695563 * 1000).toISOString());
});

test("decodes the REAL WriterAdded + OpExecuted pair from the execute tx", async () => {
  const ch = new CapturingChannel();
  const { client } = fakeClient(asLogs(FIX.logs));
  const w = new GovernanceWatcher({ client, chainId: 1952, targets: [target()], channels: [ch], cursor: new MemoryCursor(), sleepImpl: noSleep });

  const res = await w.scanRange(35236737n, 35236737n);
  assert.deepEqual(
    res.alerts.map((a) => a.kind).sort(),
    ["OpExecuted", "WriterAdded"],
  );
  const writerAdded = res.alerts.find((a) => a.kind === "WriterAdded")!;
  assert.equal(writerAdded.fields.writer, "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5");
  // Only OpProposed opens a cancel window; a WriterAdded is already done.
  assert.equal(writerAdded.cancelWindow, undefined);
});

test("never alerts twice for the same log, even across overlapping rescans", async () => {
  const ch = new CapturingChannel();
  const { client } = fakeClient(asLogs(FIX.logs));
  const w = new GovernanceWatcher({ client, chainId: 1952, targets: [target()], channels: [ch], cursor: new MemoryCursor(), sleepImpl: noSleep });

  await w.scanRange(35236666n, 35236737n);
  const first = ch.got.length;
  assert.equal(first, 3);
  await w.scanRange(35236666n, 35236737n); // same range again — a restart or retry
  assert.equal(ch.got.length, first, "a rescan must not re-alert the operator");
});

test("chunks getLogs to the RPC's 100-block cap, which X Layer enforces", async () => {
  const ch = new CapturingChannel();
  const { client, ranges } = fakeClient([], 1000n);
  const w = new GovernanceWatcher({ client, chainId: 1952, targets: [target()], channels: [ch], cursor: new MemoryCursor(), sleepImpl: noSleep });

  await w.scanRange(1n, 250n);
  assert.deepEqual(ranges, [
    [1n, 100n],
    [101n, 200n],
    [201n, 250n],
  ]);
  for (const [from, to] of ranges) {
    assert.ok(to - from + 1n <= 100n, `range ${from}..${to} exceeds the RPC cap and would be rejected`);
  }
});

test("does NOT advance the cursor when an alert reaches no channel", async () => {
  const failing = new CapturingChannel(false);
  const cursor = new MemoryCursor(35236665n);
  const { client } = fakeClient(asLogs(FIX.logs), 35236666n);
  const w = new GovernanceWatcher({ client, chainId: 1952, targets: [target()], channels: [failing], cursor, sleepImpl: noSleep });

  const res = await w.tick();
  assert.equal(res!.alerts.length, 1);
  assert.equal(res!.delivered, false);
  assert.equal(await cursor.read(), 35236665n, "cursor advanced past an undelivered alert — event lost forever");
});

test("advances the cursor once an alert is delivered", async () => {
  const ok = new CapturingChannel(true);
  const cursor = new MemoryCursor(35236665n);
  const { client } = fakeClient(asLogs(FIX.logs), 35236666n);
  const w = new GovernanceWatcher({ client, chainId: 1952, targets: [target()], channels: [ok], cursor, sleepImpl: noSleep });

  const res = await w.tick();
  assert.equal(res!.delivered, true);
  assert.equal(await cursor.read(), 35236666n);
});

test("refuses to start when no channel can carry a notification", () => {
  const { client } = fakeClient([]);
  assert.throws(
    () =>
      new GovernanceWatcher({
        client,
        chainId: 1952,
        targets: [target()],
        channels: [new NoNotifyChannel()],
        cursor: new MemoryCursor(),
        sleepImpl: noSleep,
      }),
    /tell nobody/,
    "a watcher with nowhere to alert must fail loudly at construction, not run silently",
  );
});

test("skips an approval-only channel but still delivers through a notify-capable one", async () => {
  const ok = new CapturingChannel(true);
  const { client } = fakeClient(asLogs(FIX.logs), 35236666n);
  const w = new GovernanceWatcher({
    client,
    chainId: 1952,
    targets: [target()],
    channels: [new NoNotifyChannel(), ok],
    cursor: new MemoryCursor(),
    sleepImpl: noSleep,
  });
  const res = await w.scanRange(35236666n, 35236666n);
  assert.equal(res.delivered, true);
  assert.equal(ok.got.length, 1);
});

test("governance copy never uses approve/deny grammar and names the real lever", () => {
  const alert: GovernanceAlert = {
    kind: "OpProposed",
    contract: "UntchReceipts",
    contractAddress: RECEIPTS_ADDR,
    chainId: 1952,
    txHash: "0x253c8689af25fe034c5a7515f2af0e1be9d368ab8d597f13d58c4ba793c4e81e",
    blockNumber: "35236666",
    fields: { kind: "ADD_WRITER (1)", target: "0x03e5abfD6AfF41e9766bC1c34F136962404a1ab5" },
    severity: "critical",
    cancelWindow: { etaIso: "2026-07-17T20:17:06.000Z", secondsRemaining: 259200 },
  };
  const text = renderGovernanceText(alert);
  assert.doesNotMatch(text, /\bApprove\b|\bDeny\b|wants to spend/i, "governance copy must not read as a spend approval");
  assert.match(text, /cancel\(kind, target\)/, "the operator's only real lever must be spelled out");
  assert.match(text, /Replying here does nothing/, "must not imply a reply can stop the timelock");
});

test("REGRESSION: an undelivered alert is retried on the next scan, not swallowed as already-seen", async () => {
  // A channel that fails the whole first scan (all attempts), then recovers — a transient outage.
  let healthy = false;
  const got: GovernanceAlert[] = [];
  const flaky: Channel = {
    name: "flaky",
    async send() {
      return { ok: true };
    },
    async notify(alert: GovernanceAlert) {
      if (!healthy) return { ok: false, detail: "simulated transient outage" };
      got.push(alert);
      return { ok: true };
    },
    async startReceiving() {
      return { stop: async () => {} };
    },
  };

  const cursor = new MemoryCursor(35236665n);
  const { client } = fakeClient(asLogs(FIX.logs), 35236666n);
  const w = new GovernanceWatcher({
    client,
    chainId: 1952,
    targets: [target()],
    channels: [flaky],
    cursor,
    sleepImpl: noSleep,
  });

  const first = await w.tick();
  assert.equal(first!.delivered, false);
  assert.equal(got.length, 0);
  assert.equal(await cursor.read(), 35236665n, "cursor must hold");

  // Channel recovers. The SAME range is rescanned — the alert must come through this time.
  healthy = true;
  const second = await w.tick();
  assert.equal(second!.delivered, true, "the retry must actually re-deliver");
  assert.equal(got.length, 1, "the previously-undelivered alert must reach the operator on retry");
  assert.equal(got[0]!.kind, "OpProposed");
  assert.equal(await cursor.read(), 35236666n, "cursor advances only after real delivery");
});

test("REGRESSION: tick() reads a FRESH head, never viem's cached one", async () => {
  // viem caches getBlockNumber for pollingInterval (4s) by default. A cached head makes tick()
  // conclude "cursor >= head, nothing new" while a fresh OpProposed sits one block ahead — the
  // watcher blind, silently, for seconds. The live fork proof caught exactly this.
  let seenArgs: { cacheTime?: number } | undefined;
  const client = {
    getBlockNumber: async (args?: { cacheTime?: number }) => {
      seenArgs = args;
      return 100n;
    },
    getLogs: async () => [],
  } as unknown as PublicClient;

  const w = new GovernanceWatcher({
    client,
    chainId: 196,
    targets: [target()],
    channels: [new CapturingChannel()],
    cursor: new MemoryCursor(99n),
    sleepImpl: noSleep,
  });
  await w.tick();
  assert.equal(seenArgs?.cacheTime, 0, "tick() must bypass viem's block-number cache or it can go blind");
});
