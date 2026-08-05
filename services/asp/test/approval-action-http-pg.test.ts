import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import express, { type Express } from "express";
import {
  PgServiceCallStore,
  createPool,
  ensureActionReferences,
  finalizeSettlement,
  invalidateActionRefs,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import {
  APPROVAL_ACTION_CONFIRM_ROUTE,
  APPROVAL_ACTION_CALLBACK_ROUTE,
  APPROVAL_ACTION_START_ROUTE,
  WEB_APPROVAL_ACTION_ROUTE,
  registerApprovalActionRoutes,
  mintOAuthSmokeUrl,
  sealActionStateForTest,
  webActionCsrfToken,
} from "../src/consumer/approval-action-routes";
import { mintAccountSession } from "../src/consumer/account-auth";

/**
 * The approval action surface, driven over real HTTP.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE STORE TESTS
 *
 * `bound-approval-action-pg` proves what the STORE refuses. It reaches `resolveActionRef` and
 * `actOnApproval` directly, which is the right level for "the database will not be talked into a bad
 * write" — and it is the wrong level for the property this surface actually rests on:
 *
 *   NO GET WRITES FINANCIAL STATE.
 *
 * That is a claim about four Express handlers, their methods, their body parsers and their ordering, and
 * every one of those is a thing a store-level test cannot see. Discord unfurls links; browsers prefetch;
 * scanners follow URLs in transit. If the OAuth callback decided, then POSTING THE MESSAGE would approve
 * the payment. So the GETs here are exercised as GETs, against a real server, and inertness is measured
 * as row counts before and after rather than asserted in a comment.
 *
 * WHAT IS REAL AND WHAT IS SUBSTITUTED
 *
 * Real: the handlers, the migrations, Postgres, `resolveActionRef`, `actOnApproval`, the reservation
 * writer, the CSRF derivation, the sealed actor cookie, the account session verifier.
 *
 * Substituted: `discord.exchangeCode`, which is the one dependency that would otherwise place a network
 * call to Discord. It is a PRODUCTION seam on `ApprovalActionDeps`, not a test hatch, and substituting
 * it does not weaken the identity check: the subject it returns is still verified against the live
 * `channel_user_id` on the exact ChannelBinding by the same resolver production uses. Nothing here skips
 * a subject comparison, and no route is given a test-only way past one.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_action_http";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_actionhttpowneraaaaaaaaaaa";
const OTHER_ACCOUNT = "acct_actionhttpotherbbbbbbbbbbb";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "action-http-test-secret";
const OWNER_SUBJECT = "discord-subject-http-owner";
const STRANGER_SUBJECT = "discord-subject-http-stranger";
const OWNER_ADDRESS = "0x1111111111111111111111111111111111111111";
const OTHER_ADDRESS = "0x2222222222222222222222222222222222222222";

const DISCORD_BINDING = "cbnd_http_discord";
const WEB_BINDING = "cbnd_http_web";
const OTHER_WEB_BINDING = "cbnd_http_web_other";

function presentedHeader(nonce: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      accepted: { scheme: "exact", network: CHAIN, asset: TOKEN, amount: "50000", payTo: PAY_TO },
      payload: {
        signature: "0xsignaturethatmustnevertravel",
        authorization: { from: PAYER, to: PAY_TO, value: "50000", validAfter: "0", validBefore: "99999999999", nonce },
      },
    }),
    "utf8",
  ).toString("base64");
}

describe(
  "the approval action surface over HTTP",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    let pool: Pool;
    let store: PgServiceCallStore;
    let server: Server;
    let base: string;
    let seq = 0;

    /**
     * What the substituted OAuth exchange will claim. Set per test, so a test that wants a stranger's
     * identity gets one WITHOUT any route being told it is a test.
     */
    let exchangeSubject: string | null = OWNER_SUBJECT;
    let exchangeCalls = 0;
    /** Records the redirect URI production hands the exchanger, so it can be compared to the authorize URL. */
    let exchangeRedirectSink: ((redirectUri: string) => void) | null = null;

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
      for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
        await pool.query(readFileSync(join(MIGRATIONS, file), "utf8"));
      }

      for (const [id, address] of [
        [ACCOUNT, OWNER_ADDRESS],
        [OTHER_ACCOUNT, OTHER_ADDRESS],
      ] as const) {
        await pool.query(
          `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
           VALUES ($1,'ACTIVE', now(),'test', now(),'test') ON CONFLICT DO NOTHING`,
          [id],
        );
        await pool.query(
          `INSERT INTO untch_wallet_bindings
             (binding_id, account_id, address, chain_kind, role, proof_kind, verified_at, status, scopes,
              created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,'evm','primary','siwe', now(),'ACTIVE',ARRAY['identity','policy-authority'],
                   now(),'test', now(),'test')
           ON CONFLICT DO NOTHING`,
          [`wb_${id.slice(-8)}`, id, address],
        );
      }

      const channelBinding = async (
        bindingId: string,
        accountId: string,
        channel: string,
        channelUserId: string,
      ): Promise<void> => {
        await pool.query(
          `INSERT INTO untch_channel_bindings
             (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
              verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,true,'ACTIVE', now(), ARRAY['notify','policy-approval'],
                   $5, $6, now(),'test', now(),'test')
           ON CONFLICT DO NOTHING`,
          [
            bindingId,
            accountId,
            channel,
            channelUserId,
            channel === "discord" ? "discord_oauth_identify" : "siwe",
            `arh_${accountId.slice(-8)}`,
          ],
        );
      };
      await channelBinding(DISCORD_BINDING, ACCOUNT, "discord", OWNER_SUBJECT);
      await channelBinding(WEB_BINDING, ACCOUNT, "web", ACCOUNT);
      await channelBinding(OTHER_WEB_BINDING, OTHER_ACCOUNT, "web", OTHER_ACCOUNT);

      store = new PgServiceCallStore(pool);

      const app: Express = express();
      registerApprovalActionRoutes(app, {
        pool,
        secret: SECRET,
        publicBaseUrl: "https://asp.test",
        discord: {
          applicationId: "app-id-for-test",
          redirectUri: "https://asp.test/consumer/approvals/action/discord/callback",
          exchangeCode: async (_code: string, redirectUri: string) => {
            exchangeCalls += 1;
            exchangeRedirectSink?.(redirectUri);
            return exchangeSubject === null ? null : { subject: exchangeSubject };
          },
        },
        resolvePolicy: async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "100.00" }),
      });

      server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      base = `http://127.0.0.1:${addr.port}`;
    });

    after(async () => {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      await pool?.end();
    });

    const inTx = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(client as never);
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    };

    /**
     * The whole paid lifecycle up to PENDING, exactly the way production reaches it: an escalated
     * approval persisted against a real service call, then a confirmed settlement that activates it.
     */
    const pendingRequest = async (
      over: { amount?: string; bindings?: readonly string[] } = {},
    ): Promise<{
      approvalRequestId: string;
      serviceCallId: string;
      digest: string;
      refs: Record<string, Record<"APPROVE" | "DENY", string>>;
    }> => {
      seq += 1;
      const nonce = `0xhttp${String(seq).padStart(4, "0")}${"c".repeat(51)}`;
      const auth = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
      assert.ok(auth);
      const record = await inTx((tx) =>
        persistEscalatedApproval(tx, store, auth, {
          route: "/preflight_payment",
          accountId: ACCOUNT,
          idempotencyKey: `http-idem-${seq}`,
          provider: "untch",
          capability: "owned_work.demo",
          amount: over.amount ?? "6.00",
          asset: "USDT0",
          deadline: "2026-08-04T12:00:00.000Z",
          chain: CHAIN,
          recipient: PAY_TO,
          decisionId: `dec_http_${seq}`,
          intentHash: `0xhttpintent${seq}`,
          quoteDigest: `qd_http_${seq}`,
          policySnapshotHash: `0xsnap${seq}`,
          policyId: "779001",
          policyHash: "0xpolicyhash",
          policyVersion: 1,
          intentNonce: `inonce_http_${seq}`,
          taskHash: "0xtask",
          acceptanceHash: "0xacceptance",
          requesterPrincipalKind: "ACCOUNT",
          requesterPrincipalNamespace: "untch",
          requesterPrincipalRef: `req_http_${seq}`,
          accountRefHash: `arh_${ACCOUNT.slice(-8)}`,
          walletAuthorityRef: `wa_http_${seq}`,
          reason: "ESCALATED_THRESHOLD",
          approvalExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );
      await inTx((tx) =>
        finalizeSettlement(tx, {
          serviceCallId: record.serviceCallId,
          evidence: {
            kind: "CONFIRMED",
            source: "facilitator_settle_status",
            transactionHash: `0xtxhttp${seq}`,
            paymentId: null,
            terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN },
          },
        }),
      );

      const refs: Record<string, Record<"APPROVE" | "DENY", string>> = {};
      for (const bindingId of over.bindings ?? [DISCORD_BINDING, WEB_BINDING]) {
        refs[bindingId] = await inTx((tx) =>
          ensureActionReferences(tx, {
            approvalRequestId: record.approvalRequestId,
            accountId: ACCOUNT,
            accountRefHash: `arh_${ACCOUNT.slice(-8)}`,
            channelBindingId: bindingId,
            approvalDigest: record.approvalDigest,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      }
      return {
        approvalRequestId: record.approvalRequestId,
        serviceCallId: record.serviceCallId,
        digest: record.approvalDigest,
        refs,
      };
    };

    /** Every table a decision could possibly touch, counted in one shot. */
    const counts = async (): Promise<Record<string, number>> => {
      const tables = [
        "untch_approval_decisions",
        "untch_budget_reservations",
        "untch_approval_action_nonces",
        "untch_approval_action_refs",
        "untch_approval_requests",
      ];
      const out: Record<string, number> = {};
      for (const t of tables) {
        const { rows } = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${t}`);
        out[t] = Number(rows[0]!.n);
      }
      const { rows: consumed } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_action_refs WHERE consumed_at IS NOT NULL`,
      );
      out["consumed_refs"] = Number(consumed[0]!.n);
      const { rows: states } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_requests WHERE state <> 'PENDING'`,
      );
      out["non_pending_requests"] = Number(states[0]!.n);
      return out;
    };

    /**
     * The state the START route actually issued, read out of the authorize URL it redirected to.
     *
     * Taken from the redirect rather than minted in the test, so every callback below is exercising a
     * state this server produced through the real path — which is the only way the two halves can be
     * shown to agree about the fixed callback.
     */
    const startAndTakeState = async (ref: string): Promise<{ state: string; redirectUri: string }> => {
      const res = await fetch(`${base}/consumer/approvals/action/${ref}/start`, { redirect: "manual" });
      assert.equal(res.status, 302, `start should redirect, got ${res.status}`);
      const authorize = new URL(res.headers.get("location") ?? "");
      const state = authorize.searchParams.get("state");
      assert.ok(state, "the authorize URL must carry state");
      return { state, redirectUri: authorize.searchParams.get("redirect_uri") ?? "" };
    };

    const callback = async (state: string, code = "oauth-code"): Promise<Response> =>
      fetch(`${base}/consumer/approvals/action/discord/callback?code=${code}&state=${encodeURIComponent(state)}`, {
        redirect: "manual",
      });

    const actorCookie = async (ref: string, subject: string): Promise<string> => {
      exchangeSubject = subject;
      const { state } = await startAndTakeState(ref);
      const res = await callback(state);
      assert.equal(res.status, 303, `expected a redirect to the confirmation page, got ${res.status}`);
      const setCookie = res.headers.get("set-cookie");
      assert.ok(setCookie, "the OAuth callback must seal an actor cookie");
      return setCookie.split(";")[0]!;
    };

    // ── §1 the links themselves ───────────────────────────────────────────────

    describe("an opaque link tells a reader nothing", () => {
      test("the URL carries no request id, digest, account, amount, recipient, token or nonce", async () => {
        const r = await pendingRequest({ amount: "6.00" });
        const refs = r.refs[DISCORD_BINDING]!;
        const { rows } = await pool.query<{ nonce: string; account_ref_hash: string }>(
          `SELECT nonce, account_ref_hash FROM untch_approval_action_refs WHERE action_reference_id = $1`,
          [refs.APPROVE],
        );
        const secretsThatMustNotAppear = [
          r.approvalRequestId,
          r.serviceCallId,
          r.digest,
          ACCOUNT,
          rows[0]!.nonce,
          rows[0]!.account_ref_hash,
          "6.00",
          PAY_TO,
          "USDT0",
          SECRET,
        ];
        for (const url of [refs.APPROVE, refs.DENY]) {
          for (const secret of secretsThatMustNotAppear) {
            assert.ok(
              !url.includes(secret),
              `the action reference leaked ${JSON.stringify(secret)}`,
            );
          }
        }
        /** Two different actions must not be derivable from one another either. */
        assert.notEqual(refs.APPROVE, refs.DENY);
        assert.match(refs.APPROVE, /^[A-Za-z0-9_-]{20,}$/);
      });
    });

    // ── §2 every GET is inert ─────────────────────────────────────────────────

    describe("no GET writes financial state", () => {
      test("the start link redirects into OAuth and changes nothing", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const before = await counts();

        const res = await fetch(`${base}/consumer/approvals/action/${ref}/start`, { redirect: "manual" });
        assert.equal(res.status, 302);
        assert.match(res.headers.get("location") ?? "", /^https:\/\/discord\.com\/oauth2\/authorize\?/);
        assert.equal(res.headers.get("cache-control"), "no-store");

        assert.deepEqual(await counts(), before);
      });

      test("repeated GETs stay inert however many times the link is opened", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const before = await counts();

        for (let i = 0; i < 5; i += 1) {
          const res = await fetch(`${base}/consumer/approvals/action/${ref}/start`, { redirect: "manual" });
          assert.equal(res.status, 302);
        }
        assert.deepEqual(await counts(), before);
      });

      /**
       * The subtle half. This GET arrives with a code Discord supplied and completes a real identity
       * proof — and completing an identity proof is not consent. A prefetched callback must produce a
       * page and nothing else.
       */
      test("the OAuth callback proves identity and still decides nothing", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const before = await counts();
        exchangeSubject = OWNER_SUBJECT;

        const { state } = await startAndTakeState(ref);
        const res = await callback(state);
        assert.equal(res.status, 303);
        assert.match(res.headers.get("location") ?? "", /\/confirm$/);

        assert.deepEqual(await counts(), before);
      });

      test("a browser prefetch of every link leaves the request answerable", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        const before = await counts();

        /** What a prefetching browser actually sends. */
        for (const ref of [refs.APPROVE, refs.DENY]) {
          for (const headers of [
            { purpose: "prefetch" },
            { "sec-purpose": "prefetch;prerender" },
            { "x-moz": "prefetch" },
          ]) {
            const res = await fetch(`${base}/consumer/approvals/action/${ref}/start`, { headers, redirect: "manual" });
            assert.equal(res.status, 302);
          }
        }
        assert.deepEqual(await counts(), before);

        const { rows } = await pool.query<{ state: string }>(
          `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(rows[0]!.state, "PENDING", "a prefetch must leave the request answerable");
      });

      test("a link preview unfurl decides nothing", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        const before = await counts();

        for (const agent of [
          "Discordbot/2.0 (+https://discordapp.com)",
          "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
          "Twitterbot/1.0",
          "WhatsApp/2.19",
          "facebookexternalhit/1.1",
        ]) {
          for (const ref of [refs.APPROVE, refs.DENY]) {
            const res = await fetch(`${base}/consumer/approvals/action/${ref}/start`, {
              headers: { "user-agent": agent },
              redirect: "manual",
            });
            assert.equal(res.status, 302);
          }
        }
        assert.deepEqual(await counts(), before);
      });

      /**
       * Stated on its own because it is the property the nonce family exists for: an action nonce is the
       * thing that makes a decision unrepeatable, and a GET that consumed one would burn the human's
       * only chance to answer.
       */
      test("no GET consumes an action nonce or burns a reference", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        exchangeSubject = OWNER_SUBJECT;

        await fetch(`${base}/consumer/approvals/action/${refs.APPROVE}/start`, { redirect: "manual" });
        await callback((await startAndTakeState(refs.APPROVE)).state, "c1");
        await fetch(`${base}/consumer/approvals/action/${refs.DENY}/start`, { redirect: "manual" });
        await callback((await startAndTakeState(refs.DENY)).state, "c2");

        const { rows: nonces } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_approval_action_nonces WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(Number(nonces[0]!.n), 0, "a GET consumed an action nonce");

        const { rows: live } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_approval_action_refs
            WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
          [r.approvalRequestId],
        );
        assert.equal(Number(live[0]!.n), 4, "a GET burned an action reference");
      });

      test("no GET creates a decision or a reservation", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        exchangeSubject = OWNER_SUBJECT;

        for (const ref of [refs.APPROVE, refs.DENY]) {
          await fetch(`${base}/consumer/approvals/action/${ref}/start`, { redirect: "manual" });
          await callback((await startAndTakeState(ref)).state, "c3");
        }

        const { rows: d } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_approval_decisions WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        const { rows: res } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_budget_reservations WHERE intent_hash = $1`,
          [`0xhttpintent${seq}`],
        );
        assert.equal(Number(d[0]!.n), 0);
        assert.equal(Number(res[0]!.n), 0);
      });
    });

    // ── §3 who the callback will and will not believe ─────────────────────────

    describe("the OAuth subject is checked against the binding, not the URL", () => {
      test("the correct Discord subject reaches a confirmation page stating the exact obligation", async () => {
        const r = await pendingRequest({ amount: "6.00" });
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const cookie = await actorCookie(ref, OWNER_SUBJECT);

        const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
          headers: { cookie },
          redirect: "manual",
        });
        assert.equal(res.status, 200);
        const html = await res.text();

        assert.match(html, /6\.00/);
        assert.match(html, /USDT0/);
        assert.match(html, /Approve this payment\?/);
        assert.match(html, /<form method="POST"/);
        assert.ok(!/<a [^>]*href[^>]*confirm/i.test(html), "no link may decide; only the form may");
        assert.match(html, /noindex/);

        /** The page a person reads must not carry anything redeemable. */
        assert.ok(!html.includes(SECRET));
        assert.ok(!html.includes(ACCOUNT));
        assert.ok(!html.includes(r.serviceCallId));
        assert.ok(!html.includes(PAY_TO), "the full recipient must be truncated, not pasted");
      });

      test("a stranger completing the round trip reaches a refusal, not a confirmation", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = STRANGER_SUBJECT;
        const before = await counts();

        const res = await callback(state);
        assert.equal(res.status, 403);
        const body = (await res.json()) as { code: string; wroteNothing?: boolean };
        assert.equal(body.code, "ACTION_SUBJECT_MISMATCH");
        assert.equal(body.wroteNothing, true);
        assert.deepEqual(await counts(), before);
      });

      test("an OAuth round trip Discord did not confirm is refused", async () => {
        const r = await pendingRequest();
        const { state } = await startAndTakeState(r.refs[DISCORD_BINDING]!.APPROVE);
        exchangeSubject = null;

        const res = await callback(state);
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, "NO_PLATFORM_SUBJECT");
      });

      test("a callback with no code never reaches the exchange at all", async () => {
        const r = await pendingRequest();
        const { state } = await startAndTakeState(r.refs[DISCORD_BINDING]!.APPROVE);
        exchangeSubject = OWNER_SUBJECT;
        const callsBefore = exchangeCalls;

        const res = await fetch(
          `${base}/consumer/approvals/action/discord/callback?state=${encodeURIComponent(state)}`,
          { redirect: "manual" },
        );
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, "OAUTH_CODE_REQUIRED");
        assert.equal(exchangeCalls, callsBefore);
      });

      test("a revoked binding refuses even while the reference is otherwise live", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = OWNER_SUBJECT;
        await pool.query(`UPDATE untch_channel_bindings SET status = 'REVOKED' WHERE binding_id = $1`, [
          DISCORD_BINDING,
        ]);
        try {
          const res = await callback(state);
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as { code: string }).code, "ACTION_BINDING_NOT_ACTIVE");
        } finally {
          await pool.query(`UPDATE untch_channel_bindings SET status = 'ACTIVE' WHERE binding_id = $1`, [
            DISCORD_BINDING,
          ]);
        }
      });

      /**
       * The column and the grant are two statements of one fact, and 029 makes them agree in the schema:
       * `can_decide = false OR 'policy-approval' = ANY(scopes)`. So withdrawing the grant from a decider
       * is not a state the database will hold — which is the strongest version of this guarantee, and
       * worth asserting directly rather than assuming.
       */
      test("a decider cannot have its policy-approval grant withdrawn behind the route's back", async () => {
        await assert.rejects(
          () =>
            pool.query(`UPDATE untch_channel_bindings SET scopes = ARRAY['notify'] WHERE binding_id = $1`, [
              DISCORD_BINDING,
            ]),
          /untch_channel_decider_scoped/,
          "the column and the scope must not be allowed to disagree",
        );
      });

      test("a notify-only binding refuses at the callback", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = OWNER_SUBJECT;
        const before = await counts();

        /** Dropped TOGETHER, which is the only way the schema permits it. */
        await pool.query(
          `UPDATE untch_channel_bindings SET can_decide = false, scopes = ARRAY['notify'] WHERE binding_id = $1`,
          [DISCORD_BINDING],
        );
        try {
          const res = await callback(state);
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as { code: string }).code, "ACTION_BINDING_CANNOT_DECIDE");
          assert.deepEqual(await counts(), before);
        } finally {
          await pool.query(
            `UPDATE untch_channel_bindings SET can_decide = true, scopes = ARRAY['notify','policy-approval']
              WHERE binding_id = $1`,
            [DISCORD_BINDING],
          );
        }
      });

      test("an expired reference refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = OWNER_SUBJECT;
        await pool.query(
          `UPDATE untch_approval_action_refs SET expires_at = now() - interval '1 minute'
            WHERE action_reference_id = $1`,
          [ref],
        );
        const res = await callback(state);
        assert.equal(res.status, 410);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_EXPIRED");
      });

      test("a superseded reference refuses on both the start and the callback", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        const { state } = await startAndTakeState(refs.APPROVE);
        exchangeSubject = OWNER_SUBJECT;
        await inTx((tx) => invalidateActionRefs(tx, r.approvalRequestId, "superseded by a requote"));

        const start = await fetch(`${base}/consumer/approvals/action/${refs.APPROVE}/start`, { redirect: "manual" });
        assert.equal(start.status, 409);
        assert.equal(((await start.json()) as { code: string }).code, "ACTION_INVALIDATED");

        const back = await callback(state);
        assert.equal(back.status, 409);
        assert.equal(((await back.json()) as { code: string }).code, "ACTION_INVALIDATED");
      });

      test("an unknown reference is refused without disclosing whether it ever existed", async () => {
        const res = await fetch(`${base}/consumer/approvals/action/aref_doesnotexist000000000000/start`, {
          redirect: "manual",
        });
        assert.equal(res.status, 404);
        const body = (await res.json()) as { code: string; message: string };
        assert.equal(body.code, "ACTION_NOT_FOUND");
        assert.ok(!body.message.includes("consumed") && !body.message.includes("expired"));
      });
    });

    // ── §3b the state itself ──────────────────────────────────────────────────

    describe("the callback trusts the state only after it has checked it", () => {
      /**
       * The property the whole redesign rests on. If the authorize URL and the code exchange named
       * different redirect URIs, or either named a per-reference one, Discord would refuse the exchange
       * and the flow could not complete — which is precisely the defect this replaced.
       */
      test("the authorize URL and the code exchange name the same fixed callback", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        exchangeSubject = OWNER_SUBJECT;

        const seen: string[] = [];
        exchangeRedirectSink = (uri) => seen.push(uri);
        try {
          for (const ref of [refs.APPROVE, refs.DENY]) {
            const { state, redirectUri } = await startAndTakeState(ref);
            assert.equal(redirectUri, "https://asp.test/consumer/approvals/action/discord/callback");
            assert.ok(!redirectUri.includes(ref), "the registered callback must not carry the reference");
            const res = await callback(state);
            assert.equal(res.status, 303);
          }
        } finally {
          exchangeRedirectSink = null;
        }
        assert.deepEqual(seen, [
          "https://asp.test/consumer/approvals/action/discord/callback",
          "https://asp.test/consumer/approvals/action/discord/callback",
        ]);
      });

      test("no dynamic callback path is generated for any reference", async () => {
        const r = await pendingRequest();
        for (const ref of Object.values(r.refs[DISCORD_BINDING]!)) {
          const { redirectUri } = await startAndTakeState(ref);
          assert.equal(new URL(redirectUri).pathname, "/consumer/approvals/action/discord/callback");
        }
      });

      test("a missing, malformed, unsigned or foreign-signed state refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = OWNER_SUBJECT;
        const before = await counts();

        const cases: ReadonlyArray<readonly [string, string | null]> = [
          ["ACTION_STATE_REQUIRED", null],
          ["ACTION_STATE_MALFORMED", "not-a-state"],
          ["ACTION_STATE_SIGNATURE", `${state.split(".")[0]}.deadbeef`],
          ["ACTION_STATE_MALFORMED", `${Buffer.from("{}", "utf8").toString("base64url")}.x`],
        ];
        for (const [code, raw] of cases) {
          const url =
            raw === null
              ? `${base}/consumer/approvals/action/discord/callback?code=c`
              : `${base}/consumer/approvals/action/discord/callback?code=c&state=${encodeURIComponent(raw)}`;
          const res = await fetch(url, { redirect: "manual" });
          assert.ok(res.status === 400 || res.status === 410, `${code} should refuse, got ${res.status}`);
          const body = (await res.json()) as { code: string };
          assert.ok(body.code.startsWith("ACTION_STATE_"), `expected a state refusal, got ${body.code}`);
        }
        assert.deepEqual(await counts(), before);
      });

      test("a state signed for another purpose refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        exchangeSubject = OWNER_SUBJECT;
        const forged = sealActionStateForTest(SECRET, {
          purpose: "channel_link_v1" as never,
          actionReferenceId: ref,
          channelBindingId: DISCORD_BINDING,
          action: "APPROVE",
          nonce: "nonce-wrong-purpose",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        });
        const res = await callback(forged);
        assert.equal(res.status, 400);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_STATE_PURPOSE");
      });

      test("an expired state refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        exchangeSubject = OWNER_SUBJECT;
        const stale = sealActionStateForTest(SECRET, {
          purpose: "approval_action_v1",
          actionReferenceId: ref,
          channelBindingId: DISCORD_BINDING,
          action: "APPROVE",
          nonce: "nonce-expired",
          issuedAt: Date.now() - 1_200_000,
          expiresAt: Date.now() - 600_000,
        });
        const res = await callback(stale);
        assert.equal(res.status, 410);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_STATE_EXPIRED");
      });

      /**
       * The reason the nonce is spent in the database rather than merely signed. A browser back button,
       * a refresh, a shared URL or a proxy retry all present the same signed state again.
       */
      test("a replayed state refuses, and issues no second actor session", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const { state } = await startAndTakeState(ref);
        exchangeSubject = OWNER_SUBJECT;

        const first = await callback(state);
        assert.equal(first.status, 303);
        assert.ok(first.headers.get("set-cookie"));

        const before = await counts();
        const second = await callback(state);
        assert.equal(second.status, 409);
        assert.equal(((await second.json()) as { code: string }).code, "ACTION_STATE_REPLAYED");
        assert.equal(second.headers.get("set-cookie"), null, "a replay must not mint a second session");
        assert.deepEqual(await counts(), before);
      });

      test("a state whose reference or binding was swapped refuses", async () => {
        const r = await pendingRequest();
        const other = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        exchangeSubject = OWNER_SUBJECT;

        /** Same signature, different reference: the row says one thing and the state another. */
        const swappedRef = sealActionStateForTest(SECRET, {
          purpose: "approval_action_v1",
          actionReferenceId: other.refs[DISCORD_BINDING]!.DENY,
          channelBindingId: DISCORD_BINDING,
          action: "APPROVE",
          nonce: "nonce-swapped-ref",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        });
        const a = await callback(swappedRef);
        assert.equal(a.status, 409);
        assert.equal(((await a.json()) as { code: string }).code, "ACTION_STATE_MISMATCH");

        const swappedBinding = sealActionStateForTest(SECRET, {
          purpose: "approval_action_v1",
          actionReferenceId: ref,
          channelBindingId: WEB_BINDING,
          action: "APPROVE",
          nonce: "nonce-swapped-binding",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 600_000,
        });
        const b = await callback(swappedBinding);
        assert.equal(b.status, 409);
        assert.equal(((await b.json()) as { code: string }).code, "ACTION_STATE_MISMATCH");
      });

      test("the callback creates no financial state, however many times it is reached", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        exchangeSubject = OWNER_SUBJECT;
        const before = await counts();

        for (let i = 0; i < 3; i += 1) {
          const { state } = await startAndTakeState(ref);
          await callback(state);
        }

        const after = await counts();
        assert.equal(after["untch_approval_decisions"], before["untch_approval_decisions"]);
        assert.equal(after["untch_budget_reservations"], before["untch_budget_reservations"]);
        assert.equal(after["untch_approval_action_nonces"], before["untch_approval_action_nonces"]);
        assert.equal(after["consumed_refs"], before["consumed_refs"]);
        assert.equal(after["non_pending_requests"], before["non_pending_requests"]);
      });

      test("the confirmation GET is inert and refuses without an actor session", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const before = await counts();

        const bare = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, { redirect: "manual" });
        assert.equal(bare.status, 401);
        assert.equal(((await bare.json()) as { code: string }).code, "ACTION_ACTOR_REQUIRED");

        const cookie = await actorCookie(ref, OWNER_SUBJECT);
        for (const headers of [{ cookie }, { cookie, purpose: "prefetch" }, { cookie, "user-agent": "Discordbot/2.0" }]) {
          const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, { headers, redirect: "manual" });
          assert.equal(res.status, 200);
        }
        assert.deepEqual(await counts(), before);
      });
    });

    // ── §4 the POST, which is the only thing that decides ─────────────────────

    describe("only an authenticated POST decides", () => {
      test("a POST with no actor cookie refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const before = await counts();

        const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ csrf: "anything" }),
        });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_ACTOR_REQUIRED");
        assert.deepEqual(await counts(), before);
      });

      test("a POST with a valid actor and a missing or wrong CSRF token refuses", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const cookie = await actorCookie(ref, OWNER_SUBJECT);
        const before = await counts();

        for (const body of [{}, { csrf: "" }, { csrf: "not-the-token" }, { csrf: 42 }, { csrf: null }]) {
          const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify(body),
          });
          assert.equal(res.status, 403, `body ${JSON.stringify(body)} should have been refused`);
          assert.equal(((await res.json()) as { code: string }).code, "CSRF_REFUSED");
        }
        assert.deepEqual(await counts(), before);
      });

      /**
       * The cookie is bound to ONE reference. A person who legitimately authenticated for the Approve
       * link must not thereby be able to press Deny — or anything else — without proving identity again.
       */
      test("an actor cookie sealed for one reference cannot confirm another", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        const cookie = await actorCookie(refs.APPROVE, OWNER_SUBJECT);

        const res = await fetch(`${base}/consumer/approvals/action/${refs.DENY}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, refs.DENY, OWNER_SUBJECT) }),
        });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_ACTOR_REQUIRED");
      });

      test("an authenticated Approve POST records one decision and one ACTIVE reservation", async () => {
        const r = await pendingRequest({ amount: "6.00" });
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const cookie = await actorCookie(ref, OWNER_SUBJECT);

        const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, ref, OWNER_SUBJECT) }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.outcome, "APPROVED");
        assert.equal(body.channel, "discord");
        assert.equal(body.paid, false);
        assert.equal(body.providerExecuted, false);
        assert.equal(body.economicClassification, "RESERVED_AUTHORITY_NOT_SPEND");

        const { rows: decisions } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_approval_decisions WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(Number(decisions[0]!.n), 1);

        const { rows: reservations } = await pool.query<{ n: string; status: string }>(
          `SELECT count(*)::text AS n, min(status) AS status FROM untch_budget_reservations
            WHERE reservation_id = $1`,
          [String(body.reservationId)],
        );
        assert.equal(Number(reservations[0]!.n), 1);
        assert.equal(reservations[0]!.status, "ACTIVE");

        const { rows: state } = await pool.query<{ state: string }>(
          `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(state[0]!.state, "APPROVED");
      });

      test("an authenticated Deny POST records one decision and no reservation", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.DENY;
        const cookie = await actorCookie(ref, OWNER_SUBJECT);

        const res = await fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, ref, OWNER_SUBJECT) }),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.outcome, "DENIED");
        assert.equal(body.reservationId, null);
        assert.equal(body.economicClassification, "NO_AUTHORITY_GRANTED");

        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_budget_reservations WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(Number(rows[0]!.n), 0);
      });

      test("pressing the same link twice returns ALREADY_RESOLVED and writes nothing the second time", async () => {
        const r = await pendingRequest();
        const ref = r.refs[DISCORD_BINDING]!.APPROVE;
        const cookie = await actorCookie(ref, OWNER_SUBJECT);
        const csrf = webActionCsrfToken(SECRET, ref, OWNER_SUBJECT);
        const post = (): Promise<Response> =>
          fetch(`${base}/consumer/approvals/action/${ref}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf }),
          });

        const first = await post();
        assert.equal(first.status, 200);
        const after = await counts();

        const second = await post();
        assert.equal(second.status, 409);
        const body = (await second.json()) as { code?: string; outcome?: string };
        assert.ok(
          body.outcome === "ALREADY_RESOLVED" || body.code === "ACTION_ALREADY_CONSUMED",
          `expected an already-resolved refusal, got ${JSON.stringify(body)}`,
        );
        assert.deepEqual(await counts(), after);
      });

      test("the sibling link stops working once its partner has decided", async () => {
        const r = await pendingRequest();
        const refs = r.refs[DISCORD_BINDING]!;
        const approveCookie = await actorCookie(refs.APPROVE, OWNER_SUBJECT);
        const approve = await fetch(`${base}/consumer/approvals/action/${refs.APPROVE}/confirm`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: approveCookie },
          body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, refs.APPROVE, OWNER_SUBJECT) }),
        });
        assert.equal(approve.status, 200);

        const start = await fetch(`${base}/consumer/approvals/action/${refs.DENY}/start`, { redirect: "manual" });
        assert.ok(start.status >= 400, "the Deny link must stop resolving once Approve won");
      });
    });

    // ── §5 the web actor ──────────────────────────────────────────────────────

    describe("the web actor derives authority rather than assuming it", () => {
      const session = (accountId: string, address: string, scopes: readonly string[], bindingId: string): string =>
        mintAccountSession({
          secret: SECRET,
          accountId,
          address: address as `0x${string}`,
          bindingId,
          scopes: scopes as never,
          nowMs: Date.now(),
        }).token;

      const webPost = async (
        approvalRequestId: string,
        token: string,
        body: Record<string, unknown>,
      ): Promise<Response> =>
        fetch(`${base}/consumer/approvals/${approvalRequestId}/act`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });

      test("no session at all refuses", async () => {
        const r = await pendingRequest();
        const res = await fetch(`${base}/consumer/approvals/${r.approvalRequestId}/act`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "APPROVE", csrf: "x" }),
        });
        assert.equal(res.status, 401);
        assert.equal(((await res.json()) as { code: string }).code, "ACCOUNT_SESSION_REQUIRED");
      });

      /**
       * The distinction this whole route exists to make. Proving you own the wallet proves WHO you are.
       * It does not prove you may commit that account's policy budget, and a surface that conflated the
       * two would let an identity-only session spend.
       */
      test("an identity-only session is refused with AUTHORITY_NOT_DERIVABLE", async () => {
        const r = await pendingRequest();
        await pool.query(`UPDATE untch_wallet_bindings SET scopes = ARRAY['identity'] WHERE account_id = $1`, [
          ACCOUNT,
        ]);
        try {
          const res = await webPost(r.approvalRequestId, session(ACCOUNT, OWNER_ADDRESS, ["identity"], "wb_x"), {
            action: "APPROVE",
            csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
          });
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as { code: string }).code, "AUTHORITY_NOT_DERIVABLE");
        } finally {
          await pool.query(
            `UPDATE untch_wallet_bindings SET scopes = ARRAY['identity','policy-authority'] WHERE account_id = $1`,
            [ACCOUNT],
          );
        }
      });

      test("an inactive wallet binding refuses even with a live session token", async () => {
        const r = await pendingRequest();
        await pool.query(`UPDATE untch_wallet_bindings SET status = 'REVOKED', revoked_at = now() WHERE account_id = $1`, [ACCOUNT]);
        try {
          const res = await webPost(
            r.approvalRequestId,
            session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x"),
            { action: "APPROVE", csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT) },
          );
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as { code: string }).code, "WALLET_AUTHORITY_INACTIVE");
        } finally {
          await pool.query(`UPDATE untch_wallet_bindings SET status = 'ACTIVE', revoked_at = NULL WHERE account_id = $1`, [ACCOUNT]);
        }
      });

      test("an invalid CSRF token refuses before any authority is read", async () => {
        const r = await pendingRequest();
        const token = session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x");
        const before = await counts();
        for (const csrf of [undefined, "", "wrong", webActionCsrfToken(SECRET, "another-request", ACCOUNT)]) {
          const res = await webPost(r.approvalRequestId, token, { action: "APPROVE", csrf });
          assert.equal(res.status, 403);
          assert.equal(((await res.json()) as { code: string }).code, "CSRF_REFUSED");
        }
        assert.deepEqual(await counts(), before);
      });

      test("another account's session cannot act on this request", async () => {
        const r = await pendingRequest();
        const token = session(OTHER_ACCOUNT, OTHER_ADDRESS, ["identity", "policy-authority"], "wb_other");
        const before = await counts();

        const res = await webPost(r.approvalRequestId, token, {
          action: "APPROVE",
          csrf: webActionCsrfToken(SECRET, r.approvalRequestId, OTHER_ACCOUNT),
        });
        assert.equal(res.status, 404);
        assert.equal(((await res.json()) as { code: string }).code, "ACTION_NOT_FOUND");
        assert.deepEqual(await counts(), before);
      });

      test("a GET on the web action route does not act", async () => {
        const r = await pendingRequest();
        const before = await counts();
        const res = await fetch(`${base}/consumer/approvals/${r.approvalRequestId}/act`, { redirect: "manual" });
        assert.ok(res.status === 404 || res.status === 405, `a GET must not be routed here, got ${res.status}`);
        assert.deepEqual(await counts(), before);
      });

      test("a session with policy-authority approves, creating exactly one reservation", async () => {
        const r = await pendingRequest({ amount: "6.00" });
        const token = session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x");

        const res = await webPost(r.approvalRequestId, token, {
          action: "APPROVE",
          csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as Record<string, unknown>;
        assert.equal(body.outcome, "APPROVED");
        assert.equal(body.channel, "web");
        assert.equal(body.paid, false);

        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_budget_reservations WHERE approval_request_id = $1 AND status = 'ACTIVE'`,
          [r.approvalRequestId],
        );
        assert.equal(Number(rows[0]!.n), 1);
      });

      test("a web denial creates a decision and no reservation", async () => {
        const r = await pendingRequest();
        const token = session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x");

        const res = await webPost(r.approvalRequestId, token, {
          action: "DENY",
          csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
        });
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as { outcome: string }).outcome, "DENIED");

        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM untch_budget_reservations WHERE approval_request_id = $1`,
          [r.approvalRequestId],
        );
        assert.equal(Number(rows[0]!.n), 0);
      });

      test("an action that is neither APPROVE nor DENY is refused before anything is read", async () => {
        const r = await pendingRequest();
        const token = session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x");
        for (const action of [undefined, "", "MAYBE", "approve; drop table", 1]) {
          const res = await webPost(r.approvalRequestId, token, {
            action,
            csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
          });
          assert.equal(res.status, 400);
          assert.equal(((await res.json()) as { code: string }).code, "ACTION_REQUIRED");
        }
      });

      /**
       * The claim that makes the two channels one system rather than two. Both responses are produced by
       * `actOnReference`, so they carry the same terminal vocabulary — and a future edit that forked the
       * web path into its own decision writer would change one shape and not the other.
       */
      test("Discord and web answers come out of the same terminal implementation", async () => {
        const viaDiscord = await pendingRequest();
        const discordRef = viaDiscord.refs[DISCORD_BINDING]!.APPROVE;
        const cookie = await actorCookie(discordRef, OWNER_SUBJECT);
        const discordBody = (await (
          await fetch(`${base}/consumer/approvals/action/${discordRef}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, discordRef, OWNER_SUBJECT) }),
          })
        ).json()) as Record<string, unknown>;

        const viaWeb = await pendingRequest();
        const webBody = (await (
          await webPost(
            viaWeb.approvalRequestId,
            session(ACCOUNT, OWNER_ADDRESS, ["identity", "policy-authority"], "wb_x"),
            { action: "APPROVE", csrf: webActionCsrfToken(SECRET, viaWeb.approvalRequestId, ACCOUNT) },
          )
        ).json()) as Record<string, unknown>;

        assert.deepEqual(Object.keys(discordBody).sort(), Object.keys(webBody).sort());
        assert.equal(discordBody.outcome, webBody.outcome);
        assert.equal(discordBody.paid, webBody.paid);
        assert.equal(discordBody.providerExecuted, webBody.providerExecuted);
        assert.equal(discordBody.economicClassification, webBody.economicClassification);
        assert.notEqual(discordBody.channel, webBody.channel);
      });
    });

    // ── §5b the non-financial probe ───────────────────────────────────────────

    describe("the smoke probe proves a sign-in and cannot reach a payment", () => {
      const mint = (bindingId = DISCORD_BINDING) =>
        mintOAuthSmokeUrl(
          {
            secret: SECRET,
            discord: {
              applicationId: "app-id-for-test",
              redirectUri: "https://asp.test/consumer/approvals/action/discord/callback",
              exchangeCode: async () => null,
            },
          },
          bindingId,
        );

      test("the probe URL names the same fixed callback and carries no action reference", () => {
        const minted = mint();
        assert.ok(!("refusal" in minted));
        const authorize = new URL(minted.url);
        assert.equal(authorize.origin + authorize.pathname, "https://discord.com/oauth2/authorize");
        assert.equal(authorize.searchParams.get("scope"), "identify");
        assert.equal(
          authorize.searchParams.get("redirect_uri"),
          "https://asp.test/consumer/approvals/action/discord/callback",
        );
        const state = JSON.parse(
          Buffer.from(authorize.searchParams.get("state")!.split(".")[0]!, "base64url").toString("utf8"),
        ) as { purpose: string; actionReferenceId: string };
        assert.equal(state.purpose, "approval_oauth_smoke_v1");
        assert.equal(state.actionReferenceId, "", "a smoke state must name no action reference");
      });

      /**
       * The probe is opened on an operator's schedule, not in the moment of a notification, so its
       * window is longer than an action link's. Asserted because the two clocks being different is a
       * decision rather than an accident.
       */
      test("the probe window is longer than an action window, and still bounded", () => {
        const minted = mint();
        assert.ok(!("refusal" in minted));
        const ms = new Date(minted.expiresAt).getTime() - Date.now();
        assert.ok(ms > 10 * 60_000, "a probe must outlive an action link's ten minutes");
        assert.ok(ms <= 45 * 60_000 + 5_000, "and must still expire");
      });

      test("a completed probe verifies the identity and changes no financial state", async () => {
        await pendingRequest();
        const minted = mint();
        assert.ok(!("refusal" in minted));
        const state = new URL(minted.url).searchParams.get("state")!;
        exchangeSubject = OWNER_SUBJECT;
        const before = await counts();

        const res = await callback(state);
        assert.equal(res.status, 200);
        const html = await res.text();
        assert.match(html, /Discord sign-in verified/);
        assert.match(html, /Nothing was approved, denied or paid/);
        assert.match(html, /noindex/);

        assert.deepEqual(await counts(), before, "the probe must move nothing");
      });

      test("a stranger completing the probe is refused", async () => {
        const minted = mint();
        assert.ok(!("refusal" in minted));
        exchangeSubject = STRANGER_SUBJECT;
        const before = await counts();

        const res = await callback(new URL(minted.url).searchParams.get("state")!);
        assert.equal(res.status, 403);
        assert.equal(((await res.json()) as { code: string }).code, "SMOKE_SUBJECT_MISMATCH");
        assert.deepEqual(await counts(), before);
      });

      test("a probe cannot be replayed", async () => {
        const minted = mint();
        assert.ok(!("refusal" in minted));
        const state = new URL(minted.url).searchParams.get("state")!;
        exchangeSubject = OWNER_SUBJECT;

        assert.equal((await callback(state)).status, 200);
        const again = await callback(state);
        assert.equal(again.status, 409);
        assert.equal(((await again.json()) as { code: string }).code, "ACTION_STATE_REPLAYED");
      });

      /**
       * The safety claim stated as SQL rather than as a promise about the handler. 033 refuses a smoke
       * row that names a reference, so a code path that aimed one at an approval could not record it.
       */
      test("the database refuses a smoke round trip that names an approval", async () => {
        await assert.rejects(
          () =>
            pool.query(
              `INSERT INTO untch_approval_oauth_states
                 (state_nonce, purpose, action_reference_id, channel_binding_id, action, issued_at, expires_at)
               VALUES ('n_smoke_bad','approval_oauth_smoke_v1','aref_something',$1,'APPROVE', now(), now() + interval '1 hour')`,
              [DISCORD_BINDING],
            ),
          /untch_oauth_state_smoke_is_bare/,
          "a smoke state that named an approval would be a smoke state that could reach one",
        );
      });

      test("an unknown or inactive binding refuses", async () => {
        exchangeSubject = OWNER_SUBJECT;
        const unknown = mint("cbnd_does_not_exist");
        assert.ok(!("refusal" in unknown));
        const a = await callback(new URL(unknown.url).searchParams.get("state")!);
        assert.equal(a.status, 404);
        assert.equal(((await a.json()) as { code: string }).code, "SMOKE_BINDING_NOT_FOUND");

        const live = mint();
        assert.ok(!("refusal" in live));
        await pool.query(`UPDATE untch_channel_bindings SET status = 'REVOKED' WHERE binding_id = $1`, [
          DISCORD_BINDING,
        ]);
        try {
          const b = await callback(new URL(live.url).searchParams.get("state")!);
          assert.equal(b.status, 403);
          assert.equal(((await b.json()) as { code: string }).code, "SMOKE_BINDING_NOT_ACTIVE");
        } finally {
          await pool.query(`UPDATE untch_channel_bindings SET status = 'ACTIVE' WHERE binding_id = $1`, [
            DISCORD_BINDING,
          ]);
        }
      });

      test("a deployment with no Discord application refuses to mint a probe", () => {
        const minted = mintOAuthSmokeUrl(
          { secret: SECRET, discord: { applicationId: null, redirectUri: null, exchangeCode: async () => null } },
          DISCORD_BINDING,
        );
        assert.deepEqual(minted, { refusal: "DISCORD_NOT_CONFIGURED" });
      });
    });

    // ── §6 the unwired instance ───────────────────────────────────────────────

    describe("an instance with no action surface refuses rather than half-serving", () => {
      test("every route answers 503 and none of them writes", async () => {
        const bare = express();
        registerApprovalActionRoutes(bare, null);
        const s = createServer(bare);
        await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
        const addr = s.address();
        assert.ok(addr && typeof addr === "object");
        const url = `http://127.0.0.1:${addr.port}`;
        try {
          for (const [method, path] of [
            ["GET", "/consumer/approvals/action/anything/start"],
            ["GET", "/consumer/approvals/action/discord/callback"],
            ["GET", "/consumer/approvals/action/anything/confirm"],
            ["POST", "/consumer/approvals/action/anything/confirm"],
            ["POST", "/consumer/approvals/anything/act"],
          ] as const) {
            const res = await fetch(`${url}${path}`, { method, redirect: "manual" });
            assert.equal(res.status, 503, `${method} ${path}`);
            assert.equal(((await res.json()) as { code: string }).code, "APPROVAL_ACTIONS_UNAVAILABLE");
          }
        } finally {
          await new Promise<void>((resolve) => s.close(() => resolve()));
        }
      });
    });

    /** The route constants are part of the contract the gateway builds links against. */
    test("the routes are mounted at the paths the message links point to", () => {
      assert.equal(APPROVAL_ACTION_START_ROUTE, "/consumer/approvals/action/:actionReferenceId/start");
      assert.equal(APPROVAL_ACTION_CALLBACK_ROUTE, "/consumer/approvals/action/discord/callback");
      assert.equal(APPROVAL_ACTION_CONFIRM_ROUTE, "/consumer/approvals/action/:actionReferenceId/confirm");
      assert.equal(WEB_APPROVAL_ACTION_ROUTE, "/consumer/approvals/:approvalRequestId/act");
    });
  },
);
