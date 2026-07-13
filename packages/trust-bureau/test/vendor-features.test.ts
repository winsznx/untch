import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliveryConsistency,
  disputeSignal,
  trackRecordDepth,
  walletOperationalProfile,
} from "../src/features/vendor";
import { TRACK_RECORD_SATURATION } from "../src/weights";
import {
  agentIdOf,
  approvedOrder,
  escalation,
  failVerify,
  passVerify,
  vendorIdOf,
} from "./helpers";

const V = vendorIdOf("api.vendor.example");
const A = agentIdOf(1n);

test("track_record_depth is log-scaled and rises with receipted orders", () => {
  const none = trackRecordDepth([]);
  assert.equal(none.value, 0);
  assert.equal(none.n, 0);

  const few = trackRecordDepth([approvedOrder(V, A), approvedOrder(V, A), approvedOrder(V, A)]);
  assert.equal(few.n, 3);
  const expected = (100 * Math.log1p(3)) / Math.log1p(TRACK_RECORD_SATURATION);
  assert.ok(Math.abs(few.value - expected) < 1e-9);

  // Saturated: value approaches 100, and more orders never exceed 100.
  const many = trackRecordDepth(Array.from({ length: 80 }, () => approvedOrder(V, A)));
  assert.ok(many.value <= 100 && many.value > 95);
});

test("delivery_consistency weights store-committed higher than caller-supplied provenance", () => {
  // 1 store-committed PASS + 1 caller-supplied FAIL.
  const mixed = deliveryConsistency([passVerify(V, A, "store-committed"), failVerify(V, A, "caller-supplied")]);
  // passWeight = 1.0 ; totalWeight = 1.0 + 0.5 = 1.5 ⇒ 100·1/1.5 = 66.67, HIGHER than the naive 50%.
  assert.ok(Math.abs(mixed.value - (100 * 1) / 1.5) < 1e-9);
  assert.ok(mixed.value > 50, "a committed pass must outweigh a caller-supplied fail");

  // Flip provenance: caller-supplied PASS + store-committed FAIL ⇒ below 50%.
  const flipped = deliveryConsistency([passVerify(V, A, "caller-supplied"), failVerify(V, A, "store-committed")]);
  assert.ok(flipped.value < 50, "a committed fail must outweigh a caller-supplied pass");

  assert.equal(deliveryConsistency([]).n, 0);
});

test("dispute_signal drops with escalation deny/timeout and verify-fail per 100 orders", () => {
  const orders = Array.from({ length: 10 }, () => approvedOrder(V, A));
  const clean = disputeSignal(orders, [], []);
  assert.equal(clean.value, 100, "no disputes over 10 orders ⇒ full marks");

  const withFails = disputeSignal(orders, [failVerify(V, A), failVerify(V, A)], []);
  assert.ok(withFails.value < 100, "verify fails lower the signal");

  const e = escalation("0xdead", "EXPIRED");
  const withEsc = disputeSignal(orders, [], [e]);
  assert.ok(withEsc.value < 100, "an escalation timeout lowers the signal");
  assert.equal(disputeSignal(orders, [], [escalation("0x1", "APPROVED")]).value, 100, "an approved escalation is not a dispute");
});

test("wallet_operational_profile reads real RPC signals; null ⇒ neutral wide", () => {
  const unknown = walletOperationalProfile(null);
  assert.equal(unknown.value, 50);
  assert.equal(unknown.n, 0);

  const fresh = walletOperationalProfile({ address: "0xabc", txCount: 0, balanceWei: 0n, isContract: false });
  assert.equal(fresh.value, 0, "a brand-new address with no activity or reserve profiles at 0");

  const established = walletOperationalProfile({
    address: "0xabc",
    txCount: 200,
    balanceWei: 1_000_000n,
    isContract: false,
  });
  assert.ok(established.value > fresh.value, "an active, funded address profiles higher");
  assert.equal(established.n, 200);
});
