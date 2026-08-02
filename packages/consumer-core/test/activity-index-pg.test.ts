import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { createPool, runMigrations, type Pool } from "../src/db";
import {
  PgActivityIndex,
  netRevenue,
  passThrough,
  publicTimeline,
  type RawChainEvent,
  type RevenueAllocation,
} from "../src/activity-index";

/**
 * The activity index against real Postgres.
 *
 * Everything worth asserting here is a property of concurrency, keys or constraints: that a backfill
 * CONVERGES rather than accumulates, that a reorg marks rather than deletes, that mainnet and testnet
 * cannot be mixed by a query that forgot to filter, and that no single column can be mistaken for
 * revenue. None of those live in TypeScript.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_activity_index";

const MAINNET = "eip155:196";
const TESTNET = "eip155:1952";
const BASE = "eip155:8453";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

const hash = (seed: string): string => `0x${seed.padEnd(64, "0").slice(0, 64)}`;

function logAt(over: Partial<RawChainEvent> = {}): RawChainEvent {
  return {
    network: MAINNET,
    txHash: hash("aa"),
    logIndex: 0,
    blockNumber: 100,
    blockHash: hash("bb"),
    blockTime: "2026-08-01T00:00:00.000Z",
    address: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
    topics: [hash("cc")],
    data: "0x",
    ...over,
  };
}

describe("the activity index", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let index: PgActivityIndex;

  before(async () => {
    const admin = createPool(TEST_DB as string);
    try {
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
        if ((err as { code?: string }).code !== "42P04") throw err;
      });
    } finally {
      await admin.end();
    }
    pool = createPool(ownDatabaseUrl());
    await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
    await pool.query("CREATE SCHEMA public");
    await runMigrations(pool);
    index = new PgActivityIndex(pool);
  });

  after(async () => {
    await pool.end();
  });

  // ── ingest ────────────────────────────────────────────────────────────────

  test("a backfill converges: re-running inserts nothing new", async () => {
    const events = [logAt({ txHash: hash("01") }), logAt({ txHash: hash("01"), logIndex: 1 })];

    const first = await index.ingestEvents(events);
    assert.equal(first.inserted, 2);

    // The property that makes a backfill safe to re-run after a crash: keyed by what the CHAIN
    // determines, so the second pass recognises the same rows rather than adding more.
    const second = await index.ingestEvents(events);
    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 0);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM raw_chain_events WHERE tx_hash = $1",
      [hash("01")],
    );
    assert.equal(rows[0]?.count, "2");
  });

  test("mainnet and testnet cannot be mixed, even by an identical transaction hash", async () => {
    const shared = hash("dd");
    await index.ingestEvents([logAt({ network: MAINNET, txHash: shared })]);
    await index.ingestEvents([logAt({ network: TESTNET, txHash: shared })]);

    const { rows } = await pool.query<{ network: string }>(
      "SELECT network FROM raw_chain_events WHERE tx_hash = $1 ORDER BY network",
      [shared],
    );
    // Two rows, not one. The network is part of the KEY, so a rehearsal cannot land on top of a real
    // event and a total cannot silently include one.
    assert.deepEqual(rows.map((r) => r.network), [TESTNET, MAINNET].sort());
  });

  test("a reorg marks rather than deletes, and re-ingesting brings the survivors back", async () => {
    const kept = hash("10");
    const reorged = hash("11");
    await index.ingestEvents([
      logAt({ txHash: kept, blockNumber: 200, blockHash: hash("b200") }),
      logAt({ txHash: reorged, blockNumber: 201, blockHash: hash("b201") }),
    ]);

    const marked = await index.markReorg({ network: MAINNET, survivingBlock: 200 });
    assert.equal(marked.events, 1);

    const orphaned = await pool.query<{ status: string; orphaned_at: Date | null }>(
      "SELECT status, orphaned_at FROM raw_chain_events WHERE network = $1 AND tx_hash = $2",
      [MAINNET, reorged],
    );
    // Marked, not gone. A receipt built on this event has to be able to say what happened.
    assert.equal(orphaned.rows[0]?.status, "ORPHANED");
    assert.ok(orphaned.rows[0]?.orphaned_at, "an orphaned event must say when");

    const survivor = await pool.query<{ status: string }>(
      "SELECT status FROM raw_chain_events WHERE network = $1 AND tx_hash = $2",
      [MAINNET, kept],
    );
    assert.equal(survivor.rows[0]?.status, "LIVE", "a block below the reorg point is untouched");

    // The replacement chain includes the same log again: it comes back to LIVE.
    await index.ingestEvents([logAt({ txHash: reorged, blockNumber: 201, blockHash: hash("c201") })]);
    const restored = await pool.query<{ status: string; block_hash: string }>(
      "SELECT status, block_hash FROM raw_chain_events WHERE network = $1 AND tx_hash = $2",
      [MAINNET, reorged],
    );
    assert.equal(restored.rows[0]?.status, "LIVE");
    assert.equal(restored.rows[0]?.block_hash, hash("c201"), "the new block hash replaces the old one");
  });

  test("the raw log survives the decoder, so a decoder bug is not permanent", async () => {
    const tx = hash("20");
    await index.ingestEvents([logAt({ txHash: tx, data: "0xdeadbeef" })]);
    await index.recordDecoded({
      network: MAINNET,
      txHash: tx,
      logIndex: 0,
      decoderVersion: "policy-registered@1",
      decoded: { policyId: "9001" },
    });

    const { rows } = await pool.query<{ data: string; decoder_version: string; decoded: Record<string, unknown> }>(
      "SELECT data, decoder_version, decoded FROM raw_chain_events WHERE network = $1 AND tx_hash = $2",
      [MAINNET, tx],
    );
    assert.equal(rows[0]?.data, "0xdeadbeef", "the input is what a re-run needs");
    assert.equal(rows[0]?.decoder_version, "policy-registered@1");
    assert.deepEqual(rows[0]?.decoded, { policyId: "9001" });
  });

  test("a cursor cannot claim finality for a height nobody has read", async () => {
    await index.registerSource({
      sourceId: "src-policy-registry",
      network: MAINNET,
      kind: "contract",
      address: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
      label: "PolicyRegistry",
      startBlock: 10,
    });
    await index.advanceCursor({
      sourceId: "src-policy-registry",
      lastReadBlock: 120,
      // Deliberately ahead. Claiming finality for unread data is how a reorg goes unnoticed.
      finalizedBlock: 999,
      lastReadHash: hash("b120"),
    });
    const cursor = await index.cursor("src-policy-registry");
    assert.equal(cursor?.lastReadBlock, 120);
    assert.equal(cursor?.finalizedBlock, 120);
  });

  test("one address is watched once per network", async () => {
    await index.registerSource({
      sourceId: "src-dupe-a",
      network: BASE,
      kind: "treasury",
      address: "0x0e79371813e88F31c2B60C80bad391a952039095",
      label: "Base treasury",
    });
    // A second row for the same address would double every total computed from its transfers.
    await assert.rejects(
      () =>
        index.registerSource({
          sourceId: "src-dupe-b",
          network: BASE,
          kind: "treasury",
          address: "0x0e79371813e88F31c2B60C80bad391a952039095",
          label: "Base treasury again",
        }),
      /chain_sources_unique_address/,
    );
  });

  // ── the uncomfortable states ──────────────────────────────────────────────

  test("a watched-address transaction nobody claims is UNRECONCILED, and is findable", async () => {
    const tx = hash("30");
    await index.ingestTransaction({
      network: MAINNET,
      txHash: tx,
      blockNumber: 300,
      blockHash: hash("b300"),
      blockTime: "2026-08-01T00:00:00.000Z",
      fromAddress: "0x1111111111111111111111111111111111111111",
      toAddress: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
      valueWei: "0",
      gasUsed: "21000",
      gasPriceWei: "1000000000",
      success: true,
    });

    const open = await index.unreconciled(MAINNET);
    // "Something moved money and this system cannot say why" is a query, not a suspicion.
    assert.ok(open.some((t) => t.txHash === tx && t.reconciliation === "UNRECONCILED"));
  });

  test("a transaction shaped like an execution that reconciles to nothing is SHADOW_EXECUTION", async () => {
    const tx = hash("31");
    await index.ingestTransaction({
      network: BASE,
      txHash: tx,
      blockNumber: 310,
      blockHash: hash("b310"),
      blockTime: null,
      fromAddress: "0x0e79371813e88F31c2B60C80bad391a952039095",
      toAddress: "0x2222222222222222222222222222222222222222",
      valueWei: "0",
      gasUsed: "50000",
      gasPriceWei: "1000000",
      success: true,
    });
    await index.classify({ network: BASE, txHash: tx, reconciliation: "SHADOW_EXECUTION" });

    const open = await index.unreconciled(BASE);
    assert.ok(open.some((t) => t.txHash === tx && t.reconciliation === "SHADOW_EXECUTION"));
  });

  test("ignoring a transaction requires saying why", async () => {
    const tx = hash("32");
    await index.ingestTransaction({
      network: MAINNET,
      txHash: tx,
      blockNumber: 320,
      blockHash: hash("b320"),
      blockTime: null,
      fromAddress: null,
      toAddress: null,
      valueWei: "0",
      gasUsed: null,
      gasPriceWei: null,
      success: true,
    });
    // "We looked and decided it does not matter" must be distinguishable from "nobody looked".
    await assert.rejects(
      () => index.classify({ network: MAINNET, txHash: tx, reconciliation: "IGNORED" }),
      /must carry the reason/,
    );
    await index.classify({
      network: MAINNET,
      txHash: tx,
      reconciliation: "IGNORED",
      note: "gas top-up between our own addresses; no counterparty",
    });
    assert.equal((await index.unreconciled(MAINNET)).some((t) => t.txHash === tx), false);
  });

  // ── the case ──────────────────────────────────────────────────────────────

  test("an intent has exactly one case, however many times a projection runs", async () => {
    const first = await index.openCase({
      network: MAINNET,
      kind: "spend",
      title: "Gift order",
      intentId: "intent-case-1",
    });
    const second = await index.openCase({
      network: MAINNET,
      kind: "spend",
      title: "Gift order",
      intentId: "intent-case-1",
    });
    // Two cases for one intent would report its money twice, and the second would look as legitimate
    // as the first.
    assert.equal(second.caseId, first.caseId);
  });

  test("a chain event appended twice appears once on the timeline", async () => {
    const c = await index.openCase({ network: MAINNET, kind: "spend", title: "Idempotent", intentId: "intent-idem" });
    const event = {
      caseId: c.caseId,
      network: MAINNET,
      kind: "settlement",
      source: "chain" as const,
      occurredAt: "2026-08-01T00:00:00.000Z",
      summary: "Settled 4.00 USDC",
      txHash: hash("40"),
      logIndex: 2,
    };
    assert.equal((await index.appendEvent(event)).appended, true);
    // A backfill re-run must not append a duplicate to every timeline it touched.
    assert.equal((await index.appendEvent(event)).appended, false);
    assert.equal((await index.timeline(c.caseId)).length, 1);
  });

  test("a case timeline carries internal AND on-chain evidence, in one order", async () => {
    const c = await index.openCase({
      network: MAINNET,
      kind: "spend",
      title: "Under-threshold gift",
      intentId: "intent-timeline",
      policyId: "9001",
      accountId: null,
    });

    await index.appendEvent({
      caseId: c.caseId,
      network: MAINNET,
      kind: "policy-decision",
      source: "outbox",
      occurredAt: "2026-08-01T10:00:00.000Z",
      summary: "APPROVED_AUTOMATIC — 4.00 is at or below the 5.00 threshold",
      publicDetail: { decision: "APPROVED_AUTOMATIC", amount: "4.00" },
      privateDetail: { buyerAddress: "0x1111111111111111111111111111111111111111" },
    });
    await index.appendEvent({
      caseId: c.caseId,
      network: MAINNET,
      kind: "receipt-anchor",
      source: "chain",
      occurredAt: "2026-08-01T10:00:30.000Z",
      summary: "Decision receipt anchored",
      txHash: hash("50"),
      logIndex: 0,
      publicDetail: { anchored: true },
    });

    const timeline = await index.timeline(c.caseId);
    assert.deepEqual(timeline.map((e) => e.kind), ["policy-decision", "receipt-anchor"]);
    assert.deepEqual(timeline.map((e) => e.source), ["outbox", "chain"]);

    // The public projection DROPS the private half rather than filtering it: a redaction applied at
    // read time means every new caller is one forgotten call away from publishing an address.
    const shared = publicTimeline(timeline);
    const serialised = JSON.stringify(shared);
    assert.equal(serialised.includes("0x1111111111111111111111111111111111111111"), false);
    assert.equal(serialised.includes("privateDetail"), false);
    assert.ok(serialised.includes("APPROVED_AUTOMATIC"));
  });

  test("linking a transaction to a case reconciles it", async () => {
    const tx = hash("60");
    await index.ingestTransaction({
      network: MAINNET,
      txHash: tx,
      blockNumber: 600,
      blockHash: hash("b600"),
      blockTime: null,
      fromAddress: null,
      toAddress: null,
      valueWei: "0",
      gasUsed: null,
      gasPriceWei: null,
      success: true,
    });
    const c = await index.openCase({ network: MAINNET, kind: "spend", title: "Linked", intentId: "intent-link" });

    await index.link({ network: MAINNET, txHash: tx, caseId: c.caseId, method: "intent-hash" });
    assert.equal((await index.unreconciled(MAINNET)).some((t) => t.txHash === tx), false);

    // Linking twice is not a second link.
    await index.link({ network: MAINNET, txHash: tx, caseId: c.caseId, method: "intent-hash" });
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM reconciliation_links WHERE network = $1 AND tx_hash = $2",
      [MAINNET, tx],
    );
    assert.equal(rows[0]?.count, "1");
  });

  // ── money ─────────────────────────────────────────────────────────────────

  test("provider principal is never revenue — the 105/100/5 case", async () => {
    const c = await index.openCase({
      network: MAINNET,
      kind: "marketplace-order",
      title: "Marketplace order",
      intentId: "intent-money",
    });
    const allocation: RevenueAllocation = {
      network: MAINNET,
      caseId: c.caseId,
      asset: "USDC",
      marketplaceGross: "105",
      providerPrincipal: "100",
      untchServiceFee: "5",
      providerFee: "0",
      networkGas: "0.01",
      refund: "0",
      treasuryFunding: "0",
      bondMovement: "0",
      status: "RECOGNIZED",
    };
    await index.allocate(allocation);

    // The number that must never be reported as income is 105, and the one that must never be
    // reported as income is also 100. Only the fee less gas is revenue.
    assert.equal(netRevenue(allocation), "4.99");
    assert.equal(passThrough(allocation), "100");

    const totals = await index.totals(MAINNET, "USDC");
    assert.equal(totals.marketplaceGross, "105");
    assert.equal(totals.providerPrincipal, "100");
    assert.equal(totals.recognisedRevenue, "4.99");
  });

  test("a provisional split is not counted as recognised revenue", async () => {
    const c = await index.openCase({
      network: TESTNET,
      kind: "marketplace-order",
      title: "Quoted but unsettled",
      intentId: "intent-provisional",
    });
    await index.allocate({
      network: TESTNET,
      caseId: c.caseId,
      asset: "USDC",
      marketplaceGross: "21",
      providerPrincipal: "20",
      untchServiceFee: "1",
      providerFee: "0",
      networkGas: "0",
      refund: "0",
      treasuryFunding: "0",
      bondMovement: "0",
      // Computed from a quote. Money has not moved, so counting it would report income for nothing.
      status: "PROVISIONAL",
    });
    const totals = await index.totals(TESTNET, "USDC");
    assert.equal(totals.recognisedRevenue, "0");
    assert.equal(totals.provisionalRevenue, "1");
  });

  test("an unsettled allocation is a liability, not revenue", async () => {
    const c = await index.openCase({
      network: TESTNET,
      kind: "marketplace-order",
      title: "Owed to a provider",
      intentId: "intent-unsettled",
    });
    await index.allocate({
      network: TESTNET,
      caseId: c.caseId,
      asset: "USDC",
      marketplaceGross: "0",
      providerPrincipal: "12",
      untchServiceFee: "0",
      providerFee: "0.5",
      networkGas: "0",
      refund: "0",
      treasuryFunding: "0",
      bondMovement: "0",
      status: "UNSETTLED",
    });
    const totals = await index.totals(TESTNET, "USDC");
    assert.equal(totals.unsettledLiability, "12.5");
    assert.equal(totals.recognisedRevenue, "0");
  });

  test("a refund reduces revenue rather than being netted into gross", async () => {
    const a: RevenueAllocation = {
      network: MAINNET,
      caseId: "case-x",
      asset: "USDC",
      marketplaceGross: "105",
      providerPrincipal: "100",
      untchServiceFee: "5",
      providerFee: "0",
      networkGas: "0.01",
      refund: "5",
      treasuryFunding: "0",
      bondMovement: "0",
      status: "RECOGNIZED",
    };
    // The fee was returned; the gross is still what arrived. Netting the refund into gross would make
    // the marketplace's own record disagree with this one.
    assert.equal(netRevenue(a), "-0.01");
  });

  test("amounts are decimal strings, and the database refuses anything else", async () => {
    const c = await index.openCase({ network: MAINNET, kind: "treasury", title: "Bad amount" });
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO revenue_allocations (allocation_id, network, case_id, asset, marketplace_gross)
           VALUES ('ralc_bad', $1, $2, 'USDC', '1e6')`,
          [MAINNET, c.caseId],
        ),
      /revenue_amounts_decimal/,
    );
  });

  test("a totals query for one network never reaches another's rows", async () => {
    const mainnet = await index.totals(MAINNET, "USDC");
    const testnet = await index.totals(TESTNET, "USDC");
    assert.notEqual(mainnet.marketplaceGross, testnet.marketplaceGross);
    assert.equal(mainnet.marketplaceGross, "105");
  });

  // ── failures ──────────────────────────────────────────────────────────────

  test("an indexer failure is a row, not a log line", async () => {
    await index.recordFailure({
      network: MAINNET,
      sourceId: "src-policy-registry",
      stage: "decode",
      blockNumber: 700,
      txHash: hash("70"),
      message: "unknown topic0",
      detail: { topic0: hash("cc") },
    });
    // A log line disappears when the log rotates; a gap that cannot be counted cannot be closed.
    assert.equal(await index.openFailures(MAINNET), 1);
  });

  test("a service order joins a marketplace purchase to the intent it produced", async () => {
    const c = await index.openCase({
      network: MAINNET,
      kind: "marketplace-order",
      title: "OKX order",
      intentId: "intent-order",
    });
    await pool.query(
      `INSERT INTO service_orders
         (service_order_id, network, marketplace, marketplace_order_ref, task_ref, intent_id, case_id,
          marketplace_payment_amount, marketplace_payment_asset)
       VALUES ('sord_1', $1, 'okx', 'order-7', 'task-9', 'intent-order', $2, '105', 'USDC')`,
      [MAINNET, c.caseId],
    );
    // The reconciliation that was impossible before an account existed to hang both ends off.
    await assert.rejects(
      () =>
        pool.query(
          `INSERT INTO service_orders (service_order_id, network, marketplace, marketplace_order_ref)
           VALUES ('sord_2', $1, 'okx', 'order-7')`,
          [MAINNET],
        ),
      /service_orders_unique_ref/,
    );
  });
});
