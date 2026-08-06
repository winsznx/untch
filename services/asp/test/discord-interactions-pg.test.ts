import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPairSync, sign as ed25519Sign } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import express from "express";
import {
  PgServiceCallStore,
  createPool,
  ensureActionReferences,
  finalizeSettlement,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import {
  DISCORD_INTERACTIONS_ROUTE,
  buildCustomId,
  parseCustomId,
  registerDiscordInteractionRoutes,
  verifyDiscordSignature,
} from "../src/consumer/discord-interactions";

/**
 * Native Discord approvals, driven the way Discord drives them.
 *
 * Every request below is SIGNED with a real Ed25519 key over `timestamp + rawBody`, exactly as Discord
 * signs. That is the whole security model: the identity of whoever pressed a button is something the
 * server verifies from a signature, not something a page asserts after a login. So it is tested as a
 * signature — right key, wrong key, edited body, stale clock — rather than as a happy path with a
 * substituted verifier.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_discord_interactions";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_interactionsowneraaaaaaaaa";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "interactions-test-secret";
const OWNER_SUBJECT = "1322232231682506826";
const STRANGER = "999999999999999999";
const DISCORD_BINDING = "cbnd_ix_discord";
const MESSAGE_ID = "1534672479291965512";

function presentedHeader(nonce: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      accepted: { scheme: "exact", network: CHAIN, asset: TOKEN, amount: "50000", payTo: PAY_TO },
      payload: {
        signature: "0xsig",
        authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "99999999999", nonce },
      },
    }),
    "utf8",
  ).toString("base64");
}

describe("a native Discord button decides, once, and only for the person Discord signed", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let store: PgServiceCallStore;
  let server: Server;
  let base: string;
  let seq = 0;

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");
  const otherKey = generateKeyPairSync("ed25519").privateKey;

  before(async () => {
    const admin = createPool(TEST_DB!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } finally {
      await admin.end();
    }
    const url = new URL(TEST_DB!);
    url.pathname = `/${OWN_DATABASE}`;
    pool = createPool(url.toString());
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    await pool.query(
      `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
       VALUES ($1,'ACTIVE', now(),'t', now(),'t')`, [ACCOUNT]);
    await pool.query(
      `INSERT INTO untch_wallet_bindings (binding_id, account_id, address, chain_kind, role, proof_kind,
         verified_at, status, scopes, created_at, created_by, updated_at, updated_by)
       VALUES ('wbnd_ix',$1,'0x7777777777777777777777777777777777777777','evm','primary','siwe', now(),
               'ACTIVE',ARRAY['identity','policy-authority'], now(),'t', now(),'t')`, [ACCOUNT]);
    await pool.query(
      `INSERT INTO untch_channel_bindings (binding_id, account_id, channel, channel_user_id, can_decide,
         status, verified_at, scopes, verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
       VALUES ($1,$2,'discord',$3,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
               'discord_oauth_identify','arh_ix', now(),'t', now(),'t')`,
      [DISCORD_BINDING, ACCOUNT, OWNER_SUBJECT]);
    store = new PgServiceCallStore(pool);

    const app = express();
    /**
     * Registered BEFORE any global body parser, exactly as production must.
     *
     * The first version of this test mounted `express.json()` first and every signature failed — which
     * is precisely what would have happened in production, where the global parser sits 700 lines above
     * where this route was originally registered. Ordering is the security property, so the test
     * asserts the correct order here and proves the wrong one is refused loudly below.
     */
    registerDiscordInteractionRoutes(app, {
      pool,
      secret: SECRET,
      publicKey: publicKeyHex,
      nativeReady: true,
      resolvePolicy: async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "1000.00" }),
    });
    app.use(express.json());
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    base = `http://127.0.0.1:${addr.port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server?.close(() => r()));
    await pool?.end();
  });

  const inTx = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c as never);
      await c.query("COMMIT");
      return out;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  };

  const pending = async (): Promise<{ id: string; refs: Record<"APPROVE" | "DENY", string> }> => {
    seq += 1;
    const nonce = `0xix${String(seq).padStart(4, "0")}${"a".repeat(53)}`;
    const auth = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
    assert.ok(auth);
    const rec = await inTx((tx) =>
      persistEscalatedApproval(tx, store, auth, {
        route: "/preflight_payment", accountId: ACCOUNT, idempotencyKey: `ix-${seq}`,
        provider: "untch", capability: "owned_work.demo", amount: "6.00", asset: "USDT0",
        deadline: "2026-08-06T12:00:00.000Z", chain: CHAIN, recipient: PAY_TO,
        decisionId: `dec_ix_${seq}`, intentHash: `0xixintent${seq}`, quoteDigest: `qd_ix_${seq}`,
        policySnapshotHash: `0xsnap${seq}`, policyId: "993001", policyHash: "0xph", policyVersion: 1,
        intentNonce: `in_${seq}`, taskHash: "0xt", acceptanceHash: "0xa",
        requesterPrincipalKind: "ACCOUNT", requesterPrincipalNamespace: "untch",
        requesterPrincipalRef: `req_${seq}`, accountRefHash: "arh_ix", walletAuthorityRef: `wa_${seq}`,
        reason: "ESCALATED_THRESHOLD", approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await inTx((tx) =>
      finalizeSettlement(tx, {
        serviceCallId: rec.serviceCallId,
        evidence: { kind: "CONFIRMED", source: "facilitator_settle_status", transactionHash: `0xtxix${seq}`, paymentId: null,
          terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN } },
      }),
    );
    const refs = await inTx((tx) =>
      ensureActionReferences(tx, {
        approvalRequestId: rec.approvalRequestId, accountId: ACCOUNT, accountRefHash: "arh_ix",
        channelBindingId: DISCORD_BINDING, approvalDigest: rec.approvalDigest,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
    );
    await pool.query(
      `INSERT INTO untch_approval_deliveries (delivery_id, approval_request_id, account_id, channel,
         channel_binding_id, outcome, status, external_delivery_id, queued_at, sent_at)
       VALUES ($1,$2,$3,'discord',$4,'SENT','SENT',$5, now(), now())`,
      [`apdl_ix_${seq}`, rec.approvalRequestId, ACCOUNT, DISCORD_BINDING, MESSAGE_ID]);
    return { id: rec.approvalRequestId, refs };
  };

  /** Sign exactly as Discord does: Ed25519 over `timestamp + rawBody`. */
  const post = async (
    body: unknown,
    over: { key?: typeof privateKey; timestamp?: string; tamper?: boolean; signature?: string | null } = {},
  ): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> => {
    const rawBody = JSON.stringify(body);
    const timestamp = over.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signed = Buffer.concat([Buffer.from(timestamp, "utf8"), Buffer.from(rawBody, "utf8")]);
    const sig = ed25519Sign(null, signed, over.key ?? privateKey).toString("hex");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (over.signature !== null) headers["X-Signature-Ed25519"] = over.signature ?? sig;
    headers["X-Signature-Timestamp"] = timestamp;
    const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
      method: "POST", headers,
      /** Tampering AFTER signing is the case a re-serialising parser would hide. */
      body: over.tamper ? `${rawBody} ` : rawBody,
    });
    const text = await res.text();
    let json: Record<string, unknown> | null = null;
    try { json = JSON.parse(text) as Record<string, unknown>; } catch { json = null; }
    return { status: res.status, json, text };
  };

  const componentBody = (customId: string, over: { subject?: string; messageId?: string | null } = {}) => ({
    type: 3,
    data: { custom_id: customId, component_type: 2 },
    member: { user: { id: over.subject ?? OWNER_SUBJECT } },
    message: over.messageId === null ? {} : { id: over.messageId ?? MESSAGE_ID },
  });

  const counts = async (): Promise<Record<string, number>> => {
    const out: Record<string, number> = {};
    for (const t of ["untch_approval_decisions", "untch_budget_reservations", "untch_approval_action_nonces"]) {
      const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM ${t}`);
      out[t] = Number(rows[0]!.n);
    }
    return out;
  };

  // ── the signature ─────────────────────────────────────────────────────────

  describe("the signature is the identity", () => {
    test("a correctly signed PING is answered with PONG", async () => {
      const r = await post({ type: 1 });
      assert.equal(r.status, 200);
      assert.deepEqual(r.json, { type: 1 });
    });

    test("a signature from another key is refused", async () => {
      const r = await post({ type: 1 }, { key: otherKey });
      assert.equal(r.status, 401);
    });

    test("a missing signature is refused", async () => {
      const r = await post({ type: 1 }, { signature: null });
      assert.equal(r.status, 401);
    });

    test("a malformed signature is refused", async () => {
      const r = await post({ type: 1 }, { signature: "not-hex" });
      assert.equal(r.status, 401);
    });

    /** The reason this route takes a raw body: one trailing space breaks the signature. */
    test("a body edited after signing is refused", async () => {
      const r = await post({ type: 1 }, { tamper: true });
      assert.equal(r.status, 401);
    });

    test("a stale timestamp is refused even with a valid signature", async () => {
      const r = await post({ type: 1 }, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) });
      assert.equal(r.status, 401);
    });

    test("the verifier fails closed on every malformed input rather than throwing", () => {
      const raw = Buffer.from("{}");
      const nowMs = Date.now();
      const cases = [
        { publicKeyHex, signatureHex: undefined, timestamp: "1", rawBody: raw, nowMs },
        { publicKeyHex, signatureHex: "aa", timestamp: undefined, rawBody: raw, nowMs },
        { publicKeyHex: "zz", signatureHex: "a".repeat(128), timestamp: String(Math.floor(nowMs / 1000)), rawBody: raw, nowMs },
        { publicKeyHex, signatureHex: "a".repeat(128), timestamp: "not-a-number", rawBody: raw, nowMs },
      ];
      for (const c of cases) assert.equal(verifyDiscordSignature(c).ok, false);
    });

    test("an unsupported interaction type is refused", async () => {
      const r = await post({ type: 2, data: {} });
      assert.equal(r.status, 400);
    });

    test("a malformed body that is validly signed is refused as malformed, not as unsigned", async () => {
      const rawBody = "not json";
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sig = ed25519Sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), privateKey).toString("hex");
      const res = await fetch(`${base}${DISCORD_INTERACTIONS_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": timestamp },
        body: rawBody,
      });
      assert.equal(res.status, 400);
    });
  });

  // ── the custom id ─────────────────────────────────────────────────────────

  describe("the custom id carries a reference and nothing else", () => {
    test("it is version, action and an opaque reference", () => {
      const id = buildCustomId("APPROVE", "aref_CXPhAin9qWat_I9OWz4FmuicTQAa1bAADFDcqn95vGc");
      assert.equal(id, "v1:APPROVE:aref_CXPhAin9qWat_I9OWz4FmuicTQAa1bAADFDcqn95vGc");
      assert.ok(id.length <= 100, "Discord caps a custom id at 100 characters");
      for (const secret of [ACCOUNT, OWNER_SUBJECT, "6.00", PAY_TO, "993001", SECRET]) {
        assert.ok(!id.includes(secret), `the custom id leaked ${secret}`);
      }
    });

    test("a malformed, versionless or foreign custom id is refused", () => {
      for (const bad of [undefined, 42, "", "nope", "v2:APPROVE:aref_xxxxxxxxxxxxxxxxxxxxxx", "v1:MAYBE:aref_xxxxxxxxxxxxxxxxxxxxxx", "v1:APPROVE:not-a-ref"]) {
        assert.equal(parseCustomId(bad).ok, false, `${String(bad)} should be refused`);
      }
    });

    test("an unknown reference updates the message and decides nothing", async () => {
      const before = await counts();
      const r = await post(componentBody("v1:APPROVE:aref_doesnotexist000000000000"));
      assert.equal(r.status, 200);
      assert.equal((r.json as { type: number }).type, 7);
      assert.deepEqual(await counts(), before);
    });
  });

  // ── deciding ──────────────────────────────────────────────────────────────

  describe("one tap decides, through the same terminal path", () => {
    test("a native Approve creates one decision and one ACTIVE reservation", async () => {
      const p = await pending();
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
      assert.equal(r.status, 200);
      const data = (r.json as { type: number; data: Record<string, unknown> });
      assert.equal(data.type, 7, "the message is updated in place");
      assert.match(String(data.data.content), /^Approved/);
      assert.deepEqual(data.data.components, [], "a resolved approval has no button left to press");

      const { rows: d } = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id=$1`, [p.id]);
      assert.equal(d[0]!.n, "1");
      const { rows: rs } = await pool.query<{ n: string; status: string }>(
        `SELECT count(*)::text n, min(status) status FROM untch_budget_reservations WHERE approval_request_id=$1`, [p.id]);
      assert.equal(rs[0]!.n, "1");
      assert.equal(rs[0]!.status, "ACTIVE");
      const { rows: st } = await pool.query<{ state: string }>(
        `SELECT state FROM untch_approval_requests WHERE approval_request_id=$1`, [p.id]);
      assert.equal(st[0]!.state, "APPROVED");
    });

    test("a native Deny creates one decision and no reservation", async () => {
      const p = await pending();
      const r = await post(componentBody(buildCustomId("DENY", p.refs.DENY)));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /^Denied/);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text n FROM untch_budget_reservations WHERE approval_request_id=$1`, [p.id]);
      assert.equal(rows[0]!.n, "0");
    });

    test("a repeated interaction says already resolved and writes nothing", async () => {
      const p = await pending();
      await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
      const before = await counts();
      const again = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
      assert.match(String((again.json as { data: Record<string, unknown> }).data.content), /Already resolved/);
      assert.deepEqual(await counts(), before);
    });

    test("a stranger's press is refused, and decides nothing", async () => {
      const p = await pending();
      const before = await counts();
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE), { subject: STRANGER }));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Refused/);
      assert.deepEqual(await counts(), before);
    });

    /** A button copied out of one message must not answer another. */
    test("an interaction from a message this delivery never sent is refused", async () => {
      const p = await pending();
      const before = await counts();
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE), { messageId: "9999999999" }));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Refused/);
      assert.deepEqual(await counts(), before);
    });

    test("a revoked binding refuses", async () => {
      const p = await pending();
      await pool.query(`UPDATE untch_channel_bindings SET status='REVOKED' WHERE binding_id=$1`, [DISCORD_BINDING]);
      try {
        const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
        assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Refused/);
      } finally {
        await pool.query(`UPDATE untch_channel_bindings SET status='ACTIVE' WHERE binding_id=$1`, [DISCORD_BINDING]);
      }
    });

    test("an expired request reads Expired rather than Refused", async () => {
      const p = await pending();
      await pool.query(
        `UPDATE untch_approval_action_refs SET expires_at = now() - interval '1 minute' WHERE approval_request_id=$1`, [p.id]);
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Expired/);
    });

    test("a superseded request reads Superseded", async () => {
      const p = await pending();
      await pool.query(
        `UPDATE untch_approval_action_refs SET invalidated_at = now(), invalidation_reason='superseded'
          WHERE approval_request_id=$1`, [p.id]);
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Superseded/);
    });

    test("a button whose action does not match its reference is refused", async () => {
      const p = await pending();
      /** The DENY reference presented under an APPROVE label. */
      const r = await post(componentBody(buildCustomId("APPROVE", p.refs.DENY)));
      assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Refused/);
    });

    test("a binding without policy-approval cannot decide", async () => {
      const p = await pending();
      await pool.query(
        `UPDATE untch_channel_bindings SET can_decide=false, scopes=ARRAY['notify'] WHERE binding_id=$1`, [DISCORD_BINDING]);
      try {
        const before = await counts();
        const r = await post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE)));
        assert.match(String((r.json as { data: Record<string, unknown> }).data.content), /Refused/);
        assert.deepEqual(await counts(), before);
      } finally {
        await pool.query(
          `UPDATE untch_channel_bindings SET can_decide=true, scopes=ARRAY['notify','policy-approval'] WHERE binding_id=$1`,
          [DISCORD_BINDING]);
      }
    });

    /**
     * The claim that keeps native Discord from being a second decision implementation: two presses at
     * once converge on one terminal decision, exactly as Discord-versus-web already does.
     */
    test("two concurrent native presses produce exactly one decision", async () => {
      for (let i = 0; i < 4; i += 1) {
        const p = await pending();
        const [a, b] = await Promise.all([
          post(componentBody(buildCustomId("APPROVE", p.refs.APPROVE))),
          post(componentBody(buildCustomId("DENY", p.refs.DENY))),
        ]);
        const verdicts = [a, b].map((r) => String((r.json as { data: Record<string, unknown> }).data.content));
        const winners = verdicts.filter((v) => /^Approved|^Denied/.test(v));
        assert.equal(winners.length, 1, `round ${i}: exactly one press may decide, got ${JSON.stringify(verdicts)}`);
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text n FROM untch_approval_decisions WHERE approval_request_id=$1`, [p.id]);
        assert.equal(rows[0]!.n, "1");
      }
    });
  });

  /**
   * The wiring mistake that would silently disable every native button. It is loud rather than a
   * signature failure, because "Discord keeps sending bad signatures" is the wrong thing to go looking
   * for when the truth is that a parser upstream ate the bytes.
   */
  describe("a body parser above this route is refused by name", () => {
    test("a JSON parser mounted first produces a named refusal, not a signature failure", async () => {
      const wrong = express();
      wrong.use(express.json());
      registerDiscordInteractionRoutes(wrong, {
        pool, secret: SECRET, publicKey: publicKeyHex, nativeReady: true,
        resolvePolicy: async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "1000.00" }),
      });
      const s2 = createServer(wrong);
      await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
      const addr = s2.address();
      assert.ok(addr && typeof addr === "object");
      try {
        const rawBody = JSON.stringify({ type: 1 });
        const timestamp = String(Math.floor(Date.now() / 1000));
        const sig = ed25519Sign(null, Buffer.concat([Buffer.from(timestamp), Buffer.from(rawBody)]), privateKey).toString("hex");
        const res = await fetch(`http://127.0.0.1:${addr.port}${DISCORD_INTERACTIONS_ROUTE}`, {
          method: "POST",
          headers: { "content-type": "application/json", "X-Signature-Ed25519": sig, "X-Signature-Timestamp": timestamp },
          body: rawBody,
        });
        assert.equal(res.status, 500);
        assert.equal(((await res.json()) as { code: string }).code, "DISCORD_RAW_BODY_CONSUMED");
      } finally {
        await new Promise<void>((r) => s2.close(() => r()));
      }
    });
  });

  describe("an instance with no interactions wiring refuses rather than half-serving", () => {
    test("the route answers 503", async () => {
      const bare = express();
      registerDiscordInteractionRoutes(bare, null);
      const s = createServer(bare);
      await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
      const addr = s.address();
      assert.ok(addr && typeof addr === "object");
      try {
        const res = await fetch(`http://127.0.0.1:${addr.port}${DISCORD_INTERACTIONS_ROUTE}`, { method: "POST" });
        assert.equal(res.status, 503);
      } finally {
        await new Promise<void>((r) => s.close(() => r()));
      }
    });
  });
});
