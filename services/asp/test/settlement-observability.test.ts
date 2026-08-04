import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import {
  fingerprint,
  observeSettlements,
  type SettlementObservation,
} from "../src/settlement-observability";

/**
 * The observer that would have made a 0.05 USDT0 transfer a query instead of an investigation.
 *
 * Two properties matter and both are tested as refusals rather than as features: it must never carry a
 * redeemable value into a log line, and it must never be able to affect the request it is watching.
 */

const ROUTE = "/preflight_payment";

describe("settlement observability records without leaking or interfering", () => {
  let server: Server;
  let url: string;
  const seen: SettlementObservation[] = [];

  before(async () => {
    const app = express();
    app.use(express.json());
    app.use(observeSettlements([ROUTE], (o) => seen.push(o)));

    app.post(ROUTE, (req, res) => {
      const body = req.body as Record<string, unknown>;
      if (body.simulate === "settled") {
        res.setHeader(
          "payment-response",
          Buffer.from(
            JSON.stringify({ success: true, status: "success", transaction: "0xdeadbeef", paymentId: "pay_123" }),
          ).toString("base64"),
        );
        res.status(200).json({ outcome: "APPROVED" });
        return;
      }
      if (body.simulate === "pending") {
        res.setHeader(
          "payment-response",
          Buffer.from(
            JSON.stringify({ success: true, status: "pending", transaction: "0xpending", paymentId: "pay_p" }),
          ).toString("base64"),
        );
        res.status(200).json({ outcome: "APPROVED" });
        return;
      }
      res.status(503).json({ outcome: "APPROVAL_PATH_NOT_READY" });
    });

    url = await new Promise<string>((resolve) => {
      server = app.listen(0, () => {
        const a = server.address();
        resolve(`http://127.0.0.1:${typeof a === "object" && a !== null ? a.port : 0}`);
      });
    });
  });

  after(() => server?.close());

  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    seen.length = 0;
    const res = await fetch(`${url}${ROUTE}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    await res.text();
    /** `finish` fires just after the response resolves. */
    await new Promise((r) => setTimeout(r, 20));
    return res;
  };

  const authHeader = (nonce: string) =>
    Buffer.from(
      JSON.stringify({
        accepted: { amount: "50000", payTo: "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba" },
        payload: { authorization: { nonce, from: "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64" } },
      }),
    ).toString("base64");

  test("a settled request records the transaction, paymentId and confirmed status", async () => {
    await post({ simulate: "settled", idempotencyKey: "k-1" }, { "payment-signature": authHeader("0xnonce-1") });
    const o = seen[0]!;
    assert.equal(o.handlerStatus, 200);
    assert.equal(o.processSettlementInvoked, true);
    assert.equal(o.transactionHash, "0xdeadbeef");
    assert.equal(o.paymentId, "pay_123");
    assert.equal(o.facilitatorConfirmedStatus, "success");
    assert.equal(o.settlementHeaderPresent, true);
  });

  /**
   * The distinction the whole settlement boundary rests on. `processSettlement` reports pending as
   * success, so an observer that collapsed the two would log a confirmation that never happened.
   */
  test("a pending settlement is recorded as pending, never as confirmed", async () => {
    await post({ simulate: "pending", idempotencyKey: "k-2" }, { "payment-signature": authHeader("0xnonce-2") });
    const o = seen[0]!;
    assert.equal(o.facilitatorAcceptedStatus, "accepted");
    assert.notEqual(o.facilitatorConfirmedStatus, "success");
    assert.equal(o.facilitatorConfirmedStatus, "pending");
  });

  test("a 503 records that settlement was never reached", async () => {
    await post({ simulate: "gate", idempotencyKey: "k-3" }, { "payment-signature": authHeader("0xnonce-3") });
    const o = seen[0]!;
    assert.equal(o.handlerStatus, 503);
    assert.equal(
      o.processSettlementInvoked,
      false,
      "this is the 503 property, now observable in production rather than argued from the library",
    );
    assert.equal(o.transactionHash, null);
  });

  test("the nonce and idempotency key are recorded only as fingerprints", async () => {
    await post({ simulate: "gate", idempotencyKey: "secret-key" }, { "payment-signature": authHeader("0xsecret-nonce") });
    const line = JSON.stringify(seen[0]);
    assert.ok(!line.includes("0xsecret-nonce"), "a raw nonce in a log is a correlatable payment identifier");
    assert.ok(!line.includes("secret-key"));
    assert.equal(seen[0]!.authorizationNonceFingerprint, fingerprint("0xsecret-nonce"));
    assert.equal(seen[0]!.idempotencyKeyFingerprint, fingerprint("secret-key"));
  });

  test("no complete authorization or signature reaches the record", async () => {
    const header = authHeader("0xnonce-5");
    await post({ simulate: "settled", idempotencyKey: "k-5" }, { "payment-signature": header });
    const line = JSON.stringify(seen[0]);
    assert.ok(!line.includes(header), "the presented authorization must never be logged whole");
    assert.ok(!line.includes("payload"), "no inner authorization structure is copied through");
  });

  test("an unwatched route is not observed at all", async () => {
    seen.length = 0;
    await fetch(`${url}/not-priced`, { method: "POST" }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(seen.length, 0);
  });

  test("a sink that throws cannot break the request", async () => {
    const app = express();
    app.use(express.json());
    app.use(
      observeSettlements([ROUTE], () => {
        throw new Error("sink exploded");
      }),
    );
    app.post(ROUTE, (_req, res) => res.status(200).json({ ok: true }));
    const s = app.listen(0);
    try {
      const a = s.address();
      const port = typeof a === "object" && a !== null ? a.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}${ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      assert.equal(res.status, 200, "an observer that can break a request is worse than a missing line");
    } finally {
      s.close();
    }
  });

  test("every request carries a correlatable id", async () => {
    const res = await post({ simulate: "gate", idempotencyKey: "k-id" });
    assert.ok(res.headers.get("x-untch-request-id"), "the id is what ties a log line to a caller report");
    assert.equal(seen[0]!.requestId, res.headers.get("x-untch-request-id"));
  });
});
