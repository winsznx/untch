process.env.AUTH_SECRET = "test-secret-do-not-use-in-prod";

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSession,
  issueNonce,
  operatorIdFor,
  readNonce,
  readSession,
} from "../lib/auth/session";

const ADDR = "0xF87E50f83172c2Dace7D274E4C701212CaEB1372" as const;

test("nonce roundtrips and is readable while unexpired", () => {
  const issued = issueNonce("abc123nonce");
  assert.equal(readNonce(issued.cookieValue), "abc123nonce");
});

test("a tampered nonce cookie is rejected", () => {
  const issued = issueNonce("abc123nonce");
  const tampered = issued.cookieValue.slice(0, -2) + "xy";
  assert.equal(readNonce(tampered), null);
});

test("an expired nonce is rejected", () => {
  const now = 1_000_000_000_000;
  const issued = issueNonce("noncey", now);
  assert.equal(readNonce(issued.cookieValue, now + 11 * 60_000), null);
  assert.equal(readNonce(issued.cookieValue, now + 60_000), "noncey");
});

test("session roundtrips with the operator id derived from the wallet", () => {
  const cookie = createSession(ADDR, 1952);
  const session = readSession(cookie);
  assert.ok(session);
  assert.equal(session.address, ADDR);
  assert.equal(session.chainId, 1952);
  assert.equal(session.operatorId, operatorIdFor(ADDR));
  assert.equal(session.operatorId, `op_${ADDR.toLowerCase()}`);
});

test("a tampered session cookie is rejected", () => {
  const cookie = createSession(ADDR, 1952);
  const body = cookie.split(".")[0];
  assert.equal(readSession(`${body}.forgedmac`), null);
});

test("an expired session is rejected", () => {
  const now = 1_000_000_000_000;
  const cookie = createSession(ADDR, 1952, now);
  assert.equal(readSession(cookie, now + 25 * 60 * 60_000), null);
  assert.ok(readSession(cookie, now + 60_000));
});
