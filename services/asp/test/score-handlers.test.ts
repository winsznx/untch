import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MemoryScoreDataSource,
  SCORE_DISCLAIMER,
  type WalletProfileProvider,
} from "@untch/trust-bureau";
import { decisionToUint8 } from "@untch/receipt-writer";
import { keccak256, toHex, type Hex } from "viem";
import { handleScoreVendor, handleScoreBuyer } from "../src/score-handlers";

/**
 * Handler-level tests for the two §12 Bureau tools with the REAL scoring engine + an in-memory data
 * source. No network, no x402 (the payment gate is server-level; these test the handler contract).
 */

const VENDOR_HOST = "api.vendor.example";
const VENDOR_ID = keccak256(toHex(`untch-vendor:${VENDOR_HOST}`));
const AGENT_ID = toHex(3n, { size: 32 });
const APPROVED = decisionToUint8("APPROVED");

const fakeWallet: WalletProfileProvider = {
  async signals(address) {
    return { address, txCount: 120, balanceWei: 1_000_000n, isContract: false };
  },
};

function seededVendor(): MemoryScoreDataSource {
  const ds = new MemoryScoreDataSource();
  for (let i = 0; i < 8; i++) {
    ds.addOrder({
      intentHash: keccak256(toHex(`o${i}`)),
      vendorId: VENDOR_ID,
      agentId: AGENT_ID,
      decision: APPROVED,
      counterparty: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      createdAt: new Date(1_700_000_000_000 + i * 1000).toISOString(),
    });
  }
  for (let i = 0; i < 4; i++) {
    ds.addVerify({
      intentHash: keccak256(toHex(`v${i}`)),
      vendorId: VENDOR_ID,
      agentId: AGENT_ID,
      verifyResult: 1,
      provenance: "store-committed",
      createdAt: new Date(1_700_000_100_000 + i * 1000).toISOString(),
    });
  }
  return ds;
}

const NOW = () => 1_700_100_000_000;

test("score_vendor by vendorId returns a real score with the disclaimer and cold-start tagging", async () => {
  const ds = seededVendor();
  const r = await handleScoreVendor(
    { vendorId: VENDOR_ID },
    { dataSource: ds, walletProvider: fakeWallet, now: NOW },
  );
  assert.equal(r.status, 200);
  const b = r.body as Record<string, unknown>;
  assert.equal(b.subjectKind, "VENDOR");
  assert.equal(b.disclaimer, SCORE_DISCLAIMER);
  assert.ok(typeof b.lcb === "number" && (b.lcb as number) < (b.score as number), "LCB below raw score");
  assert.deepEqual((b.coldStartFeatures as string[]).slice().sort(), [
    "claims_consistency",
    "price_sanity",
    "rating_quality",
  ]);
  const features = b.features as Array<{ key: string; source: string; implemented?: boolean }>;
  const rating = features.find((f) => f.key === "rating_quality")!;
  assert.equal(rating.source, "cold-start-prior");
  assert.equal(rating.implemented, false);
});

test("score_vendor resolves an endpoint host to the same id its receipts were keyed by", async () => {
  const ds = seededVendor();
  const r = await handleScoreVendor(
    { endpoint: `https://${VENDOR_HOST}/v1/data?x=1` },
    { dataSource: ds, walletProvider: fakeWallet, now: NOW },
  );
  assert.equal(r.status, 200);
  assert.equal((r.body as Record<string, unknown>).subjectId, VENDOR_ID);
});

test("score_vendor honestly rejects a listingId (marketplace data unavailable)", async () => {
  const r = await handleScoreVendor(
    { listingId: "okx-listing-123" },
    { dataSource: new MemoryScoreDataSource(), walletProvider: null, now: NOW },
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as Record<string, unknown>).code, "LISTING_ID_UNRESOLVABLE");
});

test("score_vendor 400s when no subject id is provided", async () => {
  const r = await handleScoreVendor(
    {},
    { dataSource: new MemoryScoreDataSource(), walletProvider: null, now: NOW },
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as Record<string, unknown>).code, "VENDOR_ID_REQUIRED");
});

test("score_buyer accepts a uint256 agentId and returns fully-real hygiene", async () => {
  const ds = seededVendor();
  const r = await handleScoreBuyer({ agentId: "3" }, { dataSource: ds, walletProvider: null, now: NOW });
  assert.equal(r.status, 200);
  const b = r.body as Record<string, unknown>;
  assert.equal(b.subjectKind, "BUYER");
  assert.equal((b.coldStartFeatures as string[]).length, 0);
  assert.equal(b.disclaimer, SCORE_DISCLAIMER);
  const features = b.features as Array<{ source: string }>;
  assert.ok(features.every((f) => f.source === "observed"));
});

test("score_buyer honestly rejects an operatorRef (needs the dashboard map)", async () => {
  const r = await handleScoreBuyer(
    { operatorRef: "op_demo" },
    { dataSource: new MemoryScoreDataSource(), walletProvider: null, now: NOW },
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as Record<string, unknown>).code, "OPERATOR_REF_UNRESOLVABLE");
});

test("score_buyer 400s on a malformed agentId", async () => {
  const r = await handleScoreBuyer(
    { agentId: "not-a-number" },
    { dataSource: new MemoryScoreDataSource(), walletProvider: null, now: NOW },
  );
  assert.equal(r.status, 400);
  assert.equal((r.body as Record<string, unknown>).code, "AGENT_ID_REQUIRED");
});

// Silence unused-import lint in strict setups: VENDOR_ID/AGENT_ID types exercised above.
const _typecheck: Hex = VENDOR_ID;
void _typecheck;
