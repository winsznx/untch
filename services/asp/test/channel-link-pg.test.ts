import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import {
  CHANNEL_LINK_TOKEN_VERSION,
  consumeChannelLink,
  createPool,
  linkTokenFingerprint,
  mintChannelLinkToken,
  newLinkCodeId,
  newLinkNonce,
  readChannelLinkToken,
  type ChannelLinkClaims,
  type LinkChannel,
  type LinkScope,
  type PlatformSubject,
  type Pool,
} from "@untch/consumer-core";

/**
 * The link flow, driven through the SAME functions production uses.
 *
 * `readChannelLinkToken` and `consumeChannelLink` are not re-implemented here and there is no test-only
 * bypass. What the tests supply is the PlatformSubject — the thing Telegram or Discord would have told
 * us — because standing up either platform is not what makes these properties true. Everything after
 * that point is the production path.
 *
 * The properties under test are all refusals, because a link flow that works is easy and a link flow
 * that cannot be tricked is the whole point.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_channel_link";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_channellinktestacct01abcde";
const OTHER = "acct_channellinkotheracct01abcd";
const SECRET = "channel-link-test-secret";
const ACCOUNT_REF = "arh_channel_link_test";
const OTHER_REF = "arh_channel_link_other";

describe("linking a channel proves who holds it", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  let pool: Pool;
  let seq = 0;

  before(async () => {
    const admin = createPool(TEST_DB!);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
      await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
    } finally {
      await admin.end();
    }
    const u = new URL(TEST_DB!);
    u.pathname = `/${OWN_DATABASE}`;
    pool = createPool(u.toString());
    for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith(".sql")).sort()) {
      await pool.query(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    for (const [id, addr] of [[ACCOUNT, "0xaaaa"], [OTHER, "0xbbbb"]] as const) {
      await pool.query(
        `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,'ACTIVE', now(),'t', now(),'t') ON CONFLICT DO NOTHING`,
        [id],
      );
      await pool.query(
        `INSERT INTO untch_wallet_bindings (binding_id, account_id, chain_kind, address, proof_kind, role, status,
           verified_at, scopes, created_at, created_by, updated_at, updated_by)
         VALUES ($1,$2,'evm',$3,'siwe','primary','ACTIVE', now(), ARRAY['identity','policy-authority'],
                 now(),'t', now(),'t') ON CONFLICT DO NOTHING`,
        [`wbnd_link_${id.slice(-6)}`, id, `${addr}${"0".repeat(36)}`.slice(0, 42)],
      );
    }
  });

  after(async () => {
    await pool?.end();
  });

  /** A link request, stored the way the route stores it: fingerprint only, never the token. */
  const issue = async (
    channel: LinkChannel,
    opts: { scopes?: LinkScope[]; account?: string; accountRef?: string; ttlMs?: number } = {},
  ): Promise<{ token: string; claims: ChannelLinkClaims }> => {
    seq += 1;
    const codeId = newLinkCodeId();
    const scopes = opts.scopes ?? (["notify", "policy-approval"] as LinkScope[]);
    const issuedAt = Date.now();
    const expiresAt = issuedAt + (opts.ttlMs ?? 30 * 60_000);
    const claims: ChannelLinkClaims = {
      v: CHANNEL_LINK_TOKEN_VERSION,
      codeId,
      accountRefHash: opts.accountRef ?? ACCOUNT_REF,
      channel,
      scopes,
      nonce: newLinkNonce(),
      issuedAt,
      expiresAt,
    };
    const token = mintChannelLinkToken(SECRET, claims);
    await pool.query(
      `INSERT INTO untch_channel_bind_codes
         (code_id, account_id, channel, code_hash, status, expires_at, created_at, created_by,
          requested_scopes, nonce, account_ref_hash, token_fingerprint)
       VALUES ($1,$2,$3,$4,'PENDING',$5::timestamptz, now(),'t',$6,$7,$8,$9)`,
      [
        codeId,
        opts.account ?? ACCOUNT,
        channel,
        linkTokenFingerprint(token),
        new Date(expiresAt).toISOString(),
        scopes,
        claims.nonce,
        claims.accountRefHash,
        linkTokenFingerprint(token).slice(0, 16),
      ],
    );
    return { token, claims };
  };

  const subject = (id: string, method = "telegram_start_callback"): PlatformSubject => ({
    externalSubjectId: id,
    deliveryTargetId: id,
    workspaceRef: null,
    displayLabel: "@someone",
    verificationMethod: method,
  });

  const consume = async (
    token: string,
    claims: ChannelLinkClaims,
    subj: PlatformSubject,
  ): Promise<Awaited<ReturnType<typeof consumeChannelLink>>> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await consumeChannelLink(client, {
        claims,
        tokenFingerprint: linkTokenFingerprint(token),
        subject: subj,
        nowMs: Date.now(),
      });
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  };

  // ── the happy path, and what it produces ───────────────────────────────────

  test("a completed Telegram link creates one verified binding with approval scope", async () => {
    const { token, claims } = await issue("telegram");
    const out = await consume(token, claims, subject("tg-user-1"));
    assert.equal(out.ok, true);

    const { rows } = await pool.query<Record<string, unknown>>(
      `SELECT * FROM untch_channel_bindings WHERE binding_id = $1`,
      [out.ok === true ? out.bindingId : ""],
    );
    const b = rows[0]!;
    assert.equal(b.status, "ACTIVE");
    assert.equal(b.can_decide, true);
    assert.equal(b.verification_method, "telegram_start_callback", "the row records what actually happened");
    assert.ok((b.scopes as string[]).includes("policy-approval"));
    assert.ok(b.verified_at, "a decider must have been verified");
  });

  test("a notify-only link produces a binding that cannot decide", async () => {
    const { token, claims } = await issue("telegram", { scopes: ["notify"] });
    const out = await consume(token, claims, subject("tg-user-notify"));
    assert.equal(out.ok, true);
    const { rows } = await pool.query<{ can_decide: boolean; scopes: string[] }>(
      `SELECT can_decide, scopes FROM untch_channel_bindings WHERE binding_id = $1`,
      [out.ok === true ? out.bindingId : ""],
    );
    assert.equal(rows[0]!.can_decide, false);
    assert.ok(!rows[0]!.scopes.includes("policy-approval"));
  });

  test("a Discord link records the OAuth method it actually used", async () => {
    const { token, claims } = await issue("discord");
    const out = await consume(token, claims, subject("dc-user-1", "discord_oauth_identify"));
    assert.equal(out.ok, true);
    const { rows } = await pool.query<{ verification_method: string }>(
      `SELECT verification_method FROM untch_channel_bindings WHERE binding_id = $1`,
      [out.ok === true ? out.bindingId : ""],
    );
    assert.equal(rows[0]!.verification_method, "discord_oauth_identify");
  });

  // ── the refusals ───────────────────────────────────────────────────────────

  test("a replayed link is refused", async () => {
    const { token, claims } = await issue("telegram");
    await consume(token, claims, subject("tg-replay"));
    const again = await consume(token, claims, subject("tg-replay"));
    assert.equal(again.ok, false);
    assert.equal(again.ok === false && again.refusal, "ALREADY_CONSUMED");
  });

  test("an expired link is refused by the token and by the store", async () => {
    const { token, claims } = await issue("telegram", { ttlMs: -1000 });
    const read = readChannelLinkToken(SECRET, token, { channel: "telegram", nowMs: Date.now() });
    assert.equal(read.ok === false && read.refusal, "EXPIRED");
    const out = await consume(token, claims, subject("tg-expired"));
    assert.equal(out.ok === false && out.refusal, "EXPIRED", "the store refuses independently of the token");
  });

  test("a Telegram token cannot be used on the Discord callback", () => {
    const claims: ChannelLinkClaims = {
      v: CHANNEL_LINK_TOKEN_VERSION, codeId: "clnk_x", accountRefHash: ACCOUNT_REF,
      channel: "telegram", scopes: ["notify"], nonce: "n", issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const token = mintChannelLinkToken(SECRET, claims);
    const read = readChannelLinkToken(SECRET, token, { channel: "discord", nowMs: Date.now() });
    assert.equal(read.ok === false && read.refusal, "WRONG_CHANNEL");
  });

  test("a token signed with another secret is refused", () => {
    const claims: ChannelLinkClaims = {
      v: CHANNEL_LINK_TOKEN_VERSION, codeId: "clnk_y", accountRefHash: ACCOUNT_REF,
      channel: "telegram", scopes: ["notify"], nonce: "n", issuedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    };
    const forged = mintChannelLinkToken("not-the-secret", claims);
    const read = readChannelLinkToken(SECRET, forged, { channel: "telegram", nowMs: Date.now() });
    assert.equal(read.ok === false && read.refusal, "BAD_SIGNATURE");
  });

  test("a link that asks for more scope than it was issued is refused", async () => {
    const { token, claims } = await issue("telegram", { scopes: ["notify"] });
    /** A tampered claim set. The signature would fail first in the route, so this drives consume directly. */
    const widened: ChannelLinkClaims = { ...claims, scopes: ["notify", "policy-approval"] };
    const out = await consume(token, widened, subject("tg-widened"));
    assert.equal(out.ok === false && out.refusal, "SCOPE_CHANGED");
  });

  test("a changed nonce is refused", async () => {
    const { token, claims } = await issue("telegram");
    const out = await consume(token, { ...claims, nonce: "different" }, subject("tg-nonce"));
    assert.equal(out.ok === false && out.refusal, "NONCE_CHANGED");
  });

  test("a link whose accountRefHash was swapped is refused", async () => {
    const { token, claims } = await issue("telegram");
    const out = await consume(token, { ...claims, accountRefHash: OTHER_REF }, subject("tg-acct"));
    assert.equal(out.ok === false && out.refusal, "WRONG_ACCOUNT");
  });

  test("a callback with no platform identity is refused", async () => {
    const { token, claims } = await issue("telegram");
    const out = await consume(token, claims, { ...subject(""), externalSubjectId: "" });
    assert.equal(out.ok === false && out.refusal, "NO_PLATFORM_SUBJECT");
  });

  test("a platform identity already bound to another account is refused", async () => {
    const theirs = await issue("telegram", { account: OTHER, accountRef: OTHER_REF });
    const first = await consume(theirs.token, theirs.claims, subject("tg-shared"));
    assert.equal(first.ok, true);
    const mine = await issue("telegram");
    const second = await consume(mine.token, mine.claims, subject("tg-shared"));
    assert.equal(second.ok === false && second.refusal, "IDENTITY_BOUND_ELSEWHERE");
  });

  test("re-linking the same identity supersedes the old binding rather than editing it", async () => {
    const first = await issue("telegram");
    const a = await consume(first.token, first.claims, subject("tg-relink"));
    const second = await issue("telegram");
    const b = await consume(second.token, second.claims, subject("tg-relink"));
    assert.equal(b.ok, true);
    assert.equal(b.ok === true && b.supersededBindingId, a.ok === true ? a.bindingId : null);
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM untch_channel_bindings WHERE binding_id = $1`,
      [a.ok === true ? a.bindingId : ""],
    );
    assert.equal(rows[0]!.status, "SUPERSEDED", "the old row keeps its own provenance");
  });

  test("approval scope is refused when the wallet authority is gone", async () => {
    await pool.query(`UPDATE untch_wallet_bindings SET status = 'REVOKED', revoked_at = now() WHERE account_id = $1`, [OTHER]);
    const { token, claims } = await issue("discord", { account: OTHER, accountRef: OTHER_REF });
    const out = await consume(token, claims, subject("dc-revoked", "discord_oauth_identify"));
    assert.equal(out.ok === false && out.refusal, "WALLET_AUTHORITY_INACTIVE");
    await pool.query(`UPDATE untch_wallet_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE account_id = $1`, [OTHER]);
  });

  test("the raw token is never stored, only its fingerprint", async () => {
    const { token, claims } = await issue("telegram");
    const { rows } = await pool.query<{ code_hash: string; token_fingerprint: string }>(
      `SELECT code_hash, token_fingerprint FROM untch_channel_bind_codes WHERE code_id = $1`,
      [claims.codeId],
    );
    assert.notEqual(rows[0]!.code_hash, token, "a stored token would be redeemable from a database dump");
    assert.equal(rows[0]!.code_hash, linkTokenFingerprint(token));
    const all = JSON.stringify(rows[0]);
    assert.ok(!all.includes(token), "no column holds the token itself");
  });

  test("an unused link creates nothing at all", async () => {
    const before = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_channel_bindings`);
    await issue("telegram");
    const after = await pool.query<{ n: string }>(`SELECT count(*)::text n FROM untch_channel_bindings`);
    assert.equal(after.rows[0]!.n, before.rows[0]!.n, "asking for a link is a question, not a binding");
  });

  test("a rolled-back callback leaves no binding and does not consume the link", async () => {
    const { token, claims } = await issue("telegram");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await consumeChannelLink(client, {
        claims,
        tokenFingerprint: linkTokenFingerprint(token),
        subject: subject("tg-rollback"),
        nowMs: Date.now(),
      });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    const { rows: codes } = await pool.query<{ status: string }>(
      `SELECT status FROM untch_channel_bind_codes WHERE code_id = $1`, [claims.codeId]);
    assert.equal(codes[0]!.status, "PENDING", "the link is still usable");
    const { rows: bindings } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_channel_bindings WHERE channel_user_id = 'tg-rollback'`);
    assert.equal(Number(bindings[0]!.n), 0);
  });

  test("two callbacks racing the same link produce exactly one binding", async () => {
    const { token, claims } = await issue("telegram");
    const results = await Promise.allSettled([
      consume(token, claims, subject("tg-race")),
      consume(token, claims, subject("tg-race")),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled" && r.value.ok === true);
    assert.equal(ok.length, 1, "single-use is enforced by the UPDATE predicate, not by a status read");
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*)::text n FROM untch_channel_bindings WHERE channel_user_id = 'tg-race'`);
    assert.equal(Number(rows[0]!.n), 1);
  });
});
