import assert from "node:assert/strict";
import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { describe, test } from "node:test";
import { verifyDiscordSignatureWorkers, readRawBodyOnce, DISCORD_RAW_BODY_CONSUMED } from "../src/workers/discord-signature";
import { verifyDiscordSignature } from "../src/consumer/discord-interactions";

/**
 * The Workers Ed25519 path, and the property that matters more than either implementation: that it
 * agrees with the Node one.
 *
 * Two signature checkers that disagree about which requests are valid is worse than one, because the
 * disagreement is invisible until a real interaction lands on the wrong host. So every case below is
 * asserted against BOTH, and the verdicts must match.
 *
 * Signatures are produced with real Ed25519 keys via `node:crypto`, so nothing here is a fixture that
 * could drift from what Discord actually sends.
 */

function keypair(): { publicKeyHex: string; signFor: (timestamp: string, body: Uint8Array) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  // The last 32 bytes of an Ed25519 SPKI blob are the key itself.
  const publicKeyHex = raw.subarray(raw.length - 32).toString("hex");
  return {
    publicKeyHex,
    signFor(timestamp, body) {
      const signed = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(body)]);
      return nodeSign(null, signed, privateKey).toString("hex");
    },
  };
}

const NOW = 1_786_000_000_000;
const TS = String(Math.floor(NOW / 1000));
const BODY = new TextEncoder().encode(JSON.stringify({ type: 3, data: { custom_id: "v1:APPROVE:aref_x" } }));

/** Run a case through both implementations and require the same verdict. */
async function bothAgree(args: {
  publicKeyHex: string;
  signatureHex: string | undefined;
  timestamp: string | undefined;
  rawBody: Uint8Array;
  nowMs: number;
}): Promise<{ ok: boolean; refusal: string | null }> {
  const workers = await verifyDiscordSignatureWorkers(args);
  const node = verifyDiscordSignature({ ...args, rawBody: Buffer.from(args.rawBody) });

  assert.equal(workers.ok, node.ok, "the Workers and Node verifiers must agree on validity");
  if (!workers.ok && !node.ok) {
    assert.equal(workers.refusal, node.refusal, "and must agree on WHY they refused");
  }
  return { ok: workers.ok, refusal: workers.ok ? null : workers.refusal };
}

describe("the Workers Ed25519 verifier agrees with the Node one, case for case", () => {
  test("a genuine Discord signature verifies", async () => {
    const k = keypair();
    const out = await bothAgree({
      publicKeyHex: k.publicKeyHex,
      signatureHex: k.signFor(TS, BODY),
      timestamp: TS,
      rawBody: BODY,
      nowMs: NOW,
    });
    assert.equal(out.ok, true);
  });

  test("a signature over DIFFERENT bytes is refused — this is why the raw body must survive", async () => {
    const k = keypair();
    const signature = k.signFor(TS, BODY);
    // The same JSON, re-serialised with different key order. A body parser would produce exactly this.
    const reserialised = new TextEncoder().encode(JSON.stringify({ data: { custom_id: "v1:APPROVE:aref_x" }, type: 3 }));
    const out = await bothAgree({
      publicKeyHex: k.publicKeyHex,
      signatureHex: signature,
      timestamp: TS,
      rawBody: reserialised,
      nowMs: NOW,
    });
    assert.equal(out.ok, false);
    assert.equal(out.refusal, "SIGNATURE_INVALID");
  });

  test("a signature from another application's key is refused", async () => {
    const mine = keypair();
    const attacker = keypair();
    const out = await bothAgree({
      publicKeyHex: mine.publicKeyHex,
      signatureHex: attacker.signFor(TS, BODY),
      timestamp: TS,
      rawBody: BODY,
      nowMs: NOW,
    });
    assert.equal(out.refusal, "SIGNATURE_INVALID");
  });

  test("a missing signature or timestamp is refused before anything is parsed", async () => {
    const k = keypair();
    assert.equal((await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: undefined, timestamp: TS, rawBody: BODY, nowMs: NOW })).refusal, "SIGNATURE_MISSING");
    assert.equal((await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: k.signFor(TS, BODY), timestamp: undefined, rawBody: BODY, nowMs: NOW })).refusal, "SIGNATURE_MISSING");
  });

  test("a malformed signature or public key is refused rather than thrown", async () => {
    const k = keypair();
    assert.equal((await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: "not-hex", timestamp: TS, rawBody: BODY, nowMs: NOW })).refusal, "SIGNATURE_MALFORMED");
    assert.equal((await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: "ab".repeat(10), timestamp: TS, rawBody: BODY, nowMs: NOW })).refusal, "SIGNATURE_MALFORMED");
    assert.equal((await bothAgree({ publicKeyHex: "zz".repeat(32), signatureHex: k.signFor(TS, BODY), timestamp: TS, rawBody: BODY, nowMs: NOW })).refusal, "PUBLIC_KEY_MALFORMED");
  });

  test("a captured but valid request goes stale after five minutes", async () => {
    const k = keypair();
    const signature = k.signFor(TS, BODY);
    const fresh = await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: signature, timestamp: TS, rawBody: BODY, nowMs: NOW + 4 * 60_000 });
    assert.equal(fresh.ok, true, "four minutes old is still accepted");

    const stale = await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: signature, timestamp: TS, rawBody: BODY, nowMs: NOW + 6 * 60_000 });
    assert.equal(stale.refusal, "TIMESTAMP_STALE", "six minutes old is refused, signature notwithstanding");
  });

  test("a non-numeric timestamp is refused", async () => {
    const k = keypair();
    const out = await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: k.signFor("nope", BODY), timestamp: "nope", rawBody: BODY, nowMs: NOW });
    assert.equal(out.refusal, "TIMESTAMP_MALFORMED");
  });

  test("an empty body still verifies when that is what was signed", async () => {
    const k = keypair();
    const empty = new Uint8Array(0);
    const out = await bothAgree({ publicKeyHex: k.publicKeyHex, signatureHex: k.signFor(TS, empty), timestamp: TS, rawBody: empty, nowMs: NOW });
    assert.equal(out.ok, true);
  });
});

describe("no framework or adapter may consume the body before verification", () => {
  /**
   * THE REGRESSION TEST.
   *
   * On Express the bug is a JSON parser mounted above the route. On Workers it is anything calling
   * `.json()` or `.text()` first — a router, a logging wrapper, a validation layer. Either way the
   * one-shot stream is spent and the signed bytes are gone, and every signature fails forever with
   * nothing saying why. This proves the failure is NAMED rather than silent.
   */
  test("an untouched request yields the exact signed bytes", async () => {
    const req = new Request("https://asp.untch.xyz/consumer/approvals/action/discord/interactions", {
      method: "POST",
      body: BODY,
    });
    const out = await readRawBodyOnce(req);
    assert.equal(out.ok, true);
    assert.deepEqual(out.ok && Array.from(out.bytes), Array.from(BODY));
  });

  test("a request whose body was already read refuses by name instead of verifying against nothing", async () => {
    const req = new Request("https://asp.untch.xyz/consumer/approvals/action/discord/interactions", {
      method: "POST",
      body: BODY,
    });
    // Exactly what a JSON-parsing middleware would do before the route ever runs.
    await req.json();

    const out = await readRawBodyOnce(req);
    assert.equal(out.ok, false);
    assert.equal(out.ok === false && out.refusal, DISCORD_RAW_BODY_CONSUMED);
  });

  /**
   * Re-serialising is the tempting "fix" once a parser has eaten the stream, and it does not work.
   *
   * The body here carries insignificant whitespace, which is what an HTTP body is free to contain and
   * what `JSON.stringify` unconditionally discards. The signature covers the bytes, not the value, so
   * a semantically identical re-encoding verifies against nothing. There is no recovery path: the
   * guard refusing by name is the only correct response.
   */
  test("bytes consumed by a parser cannot be recovered, which is why the guard is the only defence", async () => {
    const k = keypair();
    const wireBytes = new TextEncoder().encode('{"type": 3,  "data": {"custom_id": "v1:APPROVE:aref_x"}}');
    const signature = k.signFor(TS, wireBytes);

    const asSent = await verifyDiscordSignatureWorkers({
      publicKeyHex: k.publicKeyHex,
      signatureHex: signature,
      timestamp: TS,
      rawBody: wireBytes,
      nowMs: NOW,
    });
    assert.equal(asSent.ok, true, "the bytes Discord actually sent verify");

    const req = new Request("https://asp.untch.xyz/x", { method: "POST", body: wireBytes });
    const parsed = await req.json();
    const reserialised = new TextEncoder().encode(JSON.stringify(parsed));
    assert.notDeepEqual(Array.from(reserialised), Array.from(wireBytes), "re-encoding changed the bytes");

    const recovered = await verifyDiscordSignatureWorkers({
      publicKeyHex: k.publicKeyHex,
      signatureHex: signature,
      timestamp: TS,
      rawBody: reserialised,
      nowMs: NOW,
    });
    assert.equal(recovered.ok, false, "re-serialised bytes must not verify — recovery is not possible");
  });
});
