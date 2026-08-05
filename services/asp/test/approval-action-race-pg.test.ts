import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
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
  projectDeliveries,
  type Pool,
} from "@untch/consumer-core";
import { persistEscalatedApproval } from "../src/consumer/escalated-approval";
import { parseVerifiedPaymentAuthorization } from "../src/consumer/payment-authorization";
import { registerApprovalActionRoutes, webActionCsrfToken } from "../src/consumer/approval-action-routes";
import { mintAccountSession } from "../src/consumer/account-auth";

/**
 * Two replicas, two channels, one answer.
 *
 * WHAT THIS PROVES THAT THE STORE TESTS DO NOT
 *
 * `approval-action-pg` races `actOnApproval` against itself across two pools, which proves the WRITE is
 * serialised. It does not prove that the two HTTP surfaces in front of it are, and those surfaces do more
 * than call the store: each one opens its own transaction, resolves a reference, mints a token, burns the
 * reference and only then decides. Every one of those steps is a place where two processes could both
 * believe they won.
 *
 * So this runs the REAL routes, on TWO Express apps, each holding its OWN connection pool. Nothing in
 * either process can see the other's state, which is the point: if correctness rested on a promise chain,
 * a module-level Map or any other in-process coordination, it would hold in one app and fail here.
 *
 * The two apps are the two channels as well as the two replicas. A Discord confirm and a web act are the
 * pair most likely to arrive together in real life — the owner presses the chat link, the dashboard tab
 * is still open — and they reach the same terminal function by different routes.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const OWN_DATABASE = "untch_test_action_race";
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, "..", "..", "..", "packages", "consumer-core", "migrations");

const ACCOUNT = "acct_actionraceowneraaaaaaaaaaa";
const CHAIN = "eip155:196";
const TOKEN = "0x779ded0c9e1022225f8e0630b35a9b54be713736";
const PAYER = "0x5a2c16c74e9e15cf74add824f2ef97d6b3fbab64";
const PAY_TO = "0xd9ed4d474b0d01031d10d637546450f39ed6a5ba";
const SECRET = "action-race-test-secret";
const OWNER_SUBJECT = "discord-subject-race-owner";
const OWNER_ADDRESS = "0x3333333333333333333333333333333333333333";
const DISCORD_BINDING = "cbnd_race_discord";
const WEB_BINDING = "cbnd_race_web";

/** How many independent requests the race is run over. One lucky interleaving is not evidence. */
const ROUNDS = 8;

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

interface Replica {
  readonly pool: Pool;
  readonly server: Server;
  readonly base: string;
}

describe(
  "two replicas answering at once converge on one decision",
  { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" },
  () => {
    /** The fixture/assertion connection. Deliberately a THIRD pool, so it observes rather than participates. */
    let control: Pool;
    let store: PgServiceCallStore;
    let discordReplica: Replica;
    let webReplica: Replica;
    let seq = 0;

    const dbUrl = (): string => {
      const u = new URL(TEST_DB!);
      u.pathname = `/${OWN_DATABASE}`;
      return u.toString();
    };

    const startReplica = async (): Promise<Replica> => {
      const pool = createPool(dbUrl());
      const app = express();
      registerApprovalActionRoutes(app, {
        pool,
        secret: SECRET,
        publicBaseUrl: "https://asp.test",
        discord: {
          applicationId: "race-app-id",
          redirectUri: "https://asp.test/return",
          exchangeCode: async () => ({ subject: OWNER_SUBJECT }),
        },
        resolvePolicy: async () => ({ status: "ACTIVE", expiresAtMs: null, dailyLimit: "1000.00" }),
      });
      const server = createServer(app);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const addr = server.address();
      assert.ok(addr && typeof addr === "object");
      return { pool, server, base: `http://127.0.0.1:${addr.port}` };
    };

    const stopReplica = async (r: Replica): Promise<void> => {
      await new Promise<void>((resolve) => r.server.close(() => resolve()));
      await r.pool.end();
    };

    before(async () => {
      const admin = createPool(TEST_DB!);
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${OWN_DATABASE}`);
        await admin.query(`CREATE DATABASE ${OWN_DATABASE}`);
      } finally {
        await admin.end();
      }
      control = createPool(dbUrl());
      for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
        await control.query(readFileSync(join(MIGRATIONS, file), "utf8"));
      }
      await control.query(
        `INSERT INTO untch_accounts (account_id, status, created_at, created_by, updated_at, updated_by)
         VALUES ($1,'ACTIVE', now(),'test', now(),'test')`,
        [ACCOUNT],
      );
      await control.query(
        `INSERT INTO untch_wallet_bindings
           (binding_id, account_id, address, chain_kind, role, proof_kind, verified_at, status, scopes,
            created_at, created_by, updated_at, updated_by)
         VALUES ('wb_race',$1,$2,'evm','primary','siwe', now(),'ACTIVE',ARRAY['identity','policy-authority'],
                 now(),'test', now(),'test')`,
        [ACCOUNT, OWNER_ADDRESS],
      );
      for (const [bindingId, channel, subject, method] of [
        [DISCORD_BINDING, "discord", OWNER_SUBJECT, "discord_oauth_identify"],
        [WEB_BINDING, "web", ACCOUNT, "siwe"],
      ] as const) {
        await control.query(
          `INSERT INTO untch_channel_bindings
             (binding_id, account_id, channel, channel_user_id, can_decide, status, verified_at, scopes,
              verification_method, account_ref_hash, created_at, created_by, updated_at, updated_by)
           VALUES ($1,$2,$3,$4,true,'ACTIVE', now(), ARRAY['notify','policy-approval'], $5,'arh_race',
                   now(),'test', now(),'test')`,
          [bindingId, ACCOUNT, channel, subject, method],
        );
      }
      store = new PgServiceCallStore(control);
      discordReplica = await startReplica();
      webReplica = await startReplica();
    });

    after(async () => {
      if (discordReplica) await stopReplica(discordReplica);
      if (webReplica) await stopReplica(webReplica);
      await control?.end();
    });

    const inTx = async <T,>(fn: (tx: never) => Promise<T>): Promise<T> => {
      const client = await control.connect();
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

    const pendingRequest = async (): Promise<{
      approvalRequestId: string;
      discord: Record<"APPROVE" | "DENY", string>;
      web: Record<"APPROVE" | "DENY", string>;
    }> => {
      seq += 1;
      const nonce = `0xrace${String(seq).padStart(4, "0")}${"d".repeat(51)}`;
      const auth = parseVerifiedPaymentAuthorization(presentedHeader(nonce), { chainId: 196 });
      assert.ok(auth);
      const record = await inTx((tx) =>
        persistEscalatedApproval(tx, store, auth, {
          route: "/preflight_payment",
          accountId: ACCOUNT,
          idempotencyKey: `race-idem-${seq}`,
          provider: "untch",
          capability: "owned_work.demo",
          amount: "6.00",
          asset: "USDT0",
          deadline: "2026-08-04T12:00:00.000Z",
          chain: CHAIN,
          recipient: PAY_TO,
          decisionId: `dec_race_${seq}`,
          intentHash: `0xraceintent${seq}`,
          quoteDigest: `qd_race_${seq}`,
          policySnapshotHash: `0xsnap${seq}`,
          policyId: "780001",
          policyHash: "0xpolicyhash",
          policyVersion: 1,
          intentNonce: `inonce_race_${seq}`,
          taskHash: "0xtask",
          acceptanceHash: "0xacceptance",
          requesterPrincipalKind: "ACCOUNT",
          requesterPrincipalNamespace: "untch",
          requesterPrincipalRef: `req_race_${seq}`,
          accountRefHash: "arh_race",
          walletAuthorityRef: `wa_race_${seq}`,
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
            transactionHash: `0xtxrace${seq}`,
            paymentId: null,
            terms: { authorizationNonce: nonce, payer: PAYER, token: TOKEN, amount: "50000", payTo: PAY_TO, chain: CHAIN },
          },
        }),
      );
      const mint = (bindingId: string) =>
        inTx((tx) =>
          ensureActionReferences(tx, {
            approvalRequestId: record.approvalRequestId,
            accountId: ACCOUNT,
            accountRefHash: "arh_race",
            channelBindingId: bindingId,
            approvalDigest: record.approvalDigest,
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          }),
        );
      return {
        approvalRequestId: record.approvalRequestId,
        discord: await mint(DISCORD_BINDING),
        web: await mint(WEB_BINDING),
      };
    };

    /**
     * Deliveries created the way production creates them — an outbox event, then the projector — rather
     * than by hand. A hand-written row could carry a shape the projector never produces, and the claim
     * being tested is about what acting does to REAL deliveries.
     */
    const enqueueDeliveries = async (approvalRequestId: string): Promise<number> => {
      await control.query(
        `INSERT INTO untch_approval_outbox (event_id, approval_request_id, name)
         VALUES ($1,$2,'approval.request.ready.v1') ON CONFLICT DO NOTHING`,
        [`aoev_race_${approvalRequestId.slice(-12)}`, approvalRequestId],
      );
      await projectDeliveries(control, { limit: 10 });
      const { rows } = await control.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM untch_approval_deliveries WHERE approval_request_id = $1`,
        [approvalRequestId],
      );
      return Number(rows[0]!.n);
    };

    /** The real round trip: start, take the state the server issued, redeem it at the fixed callback. */
    const actorCookie = async (replica: Replica, ref: string): Promise<string> => {
      const started = await fetch(`${replica.base}/consumer/approvals/action/${ref}/start`, { redirect: "manual" });
      assert.equal(started.status, 302);
      const state = new URL(started.headers.get("location") ?? "").searchParams.get("state");
      assert.ok(state);
      const res = await fetch(
        `${replica.base}/consumer/approvals/action/discord/callback?code=c&state=${encodeURIComponent(state)}`,
        { redirect: "manual" },
      );
      assert.equal(res.status, 303);
      const setCookie = res.headers.get("set-cookie");
      assert.ok(setCookie);
      return setCookie.split(";")[0]!;
    };

    const sessionToken = (): string =>
      mintAccountSession({
        secret: SECRET,
        accountId: ACCOUNT,
        address: OWNER_ADDRESS as `0x${string}`,
        bindingId: "wb_race",
        scopes: ["identity", "policy-authority"] as never,
        nowMs: Date.now(),
      }).token;

    interface Observed {
      readonly decisions: number;
      readonly nonces: number;
      readonly activeReservations: number;
      readonly reservations: number;
      readonly liveRefs: number;
      readonly state: string;
      readonly liveDeliveries: number;
      readonly actedDeliveries: number;
    }

    const observe = async (approvalRequestId: string): Promise<Observed> => {
      const one = async (sql: string): Promise<number> => {
        const { rows } = await control.query<{ n: string }>(sql, [approvalRequestId]);
        return Number(rows[0]!.n);
      };
      const { rows: state } = await control.query<{ state: string }>(
        `SELECT state FROM untch_approval_requests WHERE approval_request_id = $1`,
        [approvalRequestId],
      );
      return {
        decisions: await one(
          `SELECT count(*)::text AS n FROM untch_approval_decisions WHERE approval_request_id = $1`,
        ),
        nonces: await one(
          `SELECT count(*)::text AS n FROM untch_approval_action_nonces WHERE approval_request_id = $1`,
        ),
        activeReservations: await one(
          `SELECT count(*)::text AS n FROM untch_budget_reservations
            WHERE approval_request_id = $1 AND status = 'ACTIVE'`,
        ),
        reservations: await one(
          `SELECT count(*)::text AS n FROM untch_budget_reservations WHERE approval_request_id = $1`,
        ),
        liveRefs: await one(
          `SELECT count(*)::text AS n FROM untch_approval_action_refs
            WHERE approval_request_id = $1 AND consumed_at IS NULL AND invalidated_at IS NULL`,
        ),
        /** Still pressable: neither the channel that answered nor one that was told to stop. */
        liveDeliveries: await one(
          `SELECT count(*)::text AS n FROM untch_approval_deliveries
            WHERE approval_request_id = $1 AND status NOT IN ('ACTED','INVALIDATED')`,
        ),
        actedDeliveries: await one(
          `SELECT count(*)::text AS n FROM untch_approval_deliveries
            WHERE approval_request_id = $1 AND status = 'ACTED'`,
        ),
        state: state[0]!.state,
      };
    };

    test(`a Discord confirm and a web act fired together resolve once, over ${ROUNDS} independent requests`, async () => {
      const outcomes: Array<{ discord: number; web: number }> = [];

      for (let round = 0; round < ROUNDS; round += 1) {
        const r = await pendingRequest();
        const deliveries = await enqueueDeliveries(r.approvalRequestId);
        assert.ok(deliveries >= 2, `round ${round}: both channels must have a delivery to invalidate`);
        const cookie = await actorCookie(discordReplica, r.discord.APPROVE);
        const token = sessionToken();

        /**
         * Both requests are constructed BEFORE either is sent, so the only thing between them is the
         * network and the database. Awaiting one to build the other would serialise the race away.
         */
        const discordPost = (): Promise<Response> =>
          fetch(`${discordReplica.base}/consumer/approvals/action/${r.discord.APPROVE}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, r.discord.APPROVE, OWNER_SUBJECT) }),
          });
        const webPost = (): Promise<Response> =>
          fetch(`${webReplica.base}/consumer/approvals/${r.approvalRequestId}/act`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
              action: "APPROVE",
              csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
            }),
          });

        const [discordRes, webRes] = await Promise.all([discordPost(), webPost()]);
        const discordBody = (await discordRes.json()) as Record<string, unknown>;
        const webBody = (await webRes.json()) as Record<string, unknown>;
        outcomes.push({ discord: discordRes.status, web: webRes.status });

        const winners = [discordRes.status, webRes.status].filter((s) => s === 200);
        const losers = [
          [discordRes.status, discordBody] as const,
          [webRes.status, webBody] as const,
        ].filter(([s]) => s !== 200);

        assert.equal(winners.length, 1, `round ${round}: expected exactly one winner`);
        assert.equal(losers.length, 1, `round ${round}: expected exactly one loser`);

        /** The loser must say so in the vocabulary a caller can act on, not merely fail. */
        const [loserStatus, loserBody] = losers[0]!;
        assert.equal(loserStatus, 409, `round ${round}: the losing action must be a conflict`);
        assert.ok(
          loserBody.outcome === "ALREADY_RESOLVED" ||
            loserBody.code === "ACTION_ALREADY_CONSUMED" ||
            loserBody.code === "ACTION_REQUEST_NOT_PENDING" ||
            loserBody.code === "ACTION_INVALIDATED",
          `round ${round}: the loser said ${JSON.stringify(loserBody)}`,
        );

        const seen = await observe(r.approvalRequestId);
        assert.equal(seen.decisions, 1, `round ${round}: exactly one ApprovalDecision`);
        assert.equal(seen.nonces, 1, `round ${round}: exactly one consumed nonce family`);
        assert.ok(seen.activeReservations <= 1, `round ${round}: at most one reservation may be held`);
        assert.equal(seen.activeReservations, 1, `round ${round}: the winning approval holds its authority`);
        assert.equal(seen.reservations, 1, `round ${round}: the loser created no second reservation`);
        assert.equal(seen.state, "APPROVED", `round ${round}: the request is terminal`);
        assert.equal(seen.liveRefs, 0, `round ${round}: every sibling action reference is burned`);
        assert.equal(seen.liveDeliveries, 0, `round ${round}: every sibling delivery is invalidated`);
        assert.equal(
          seen.actedDeliveries,
          1,
          `round ${round}: exactly one channel is recorded as the one that answered`,
        );
      }

      /**
       * Which channel wins is genuinely a race, and this does not assert a distribution — a run where one
       * side wins every time is still correct. What it does assert is that the outcome was never "both"
       * and never "neither", which the per-round checks already enforce and this restates once.
       */
      assert.equal(outcomes.length, ROUNDS);
      assert.ok(outcomes.every((o) => (o.discord === 200) !== (o.web === 200)));
    });

    test("a denial raced against an approval still produces exactly one decision and one reservation at most", async () => {
      for (let round = 0; round < ROUNDS; round += 1) {
        const r = await pendingRequest();
        const cookie = await actorCookie(discordReplica, r.discord.DENY);
        const token = sessionToken();

        const [denyRes, approveRes] = await Promise.all([
          fetch(`${discordReplica.base}/consumer/approvals/action/${r.discord.DENY}/confirm`, {
            method: "POST",
            headers: { "content-type": "application/json", cookie },
            body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, r.discord.DENY, OWNER_SUBJECT) }),
          }),
          fetch(`${webReplica.base}/consumer/approvals/${r.approvalRequestId}/act`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
            body: JSON.stringify({
              action: "APPROVE",
              csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
            }),
          }),
        ]);

        const winners = [denyRes.status, approveRes.status].filter((s) => s === 200);
        assert.equal(winners.length, 1, `round ${round}: one of deny and approve must win`);

        const seen = await observe(r.approvalRequestId);
        assert.equal(seen.decisions, 1);
        assert.equal(seen.nonces, 1);
        /**
         * The asymmetry that matters. If DENY won, no authority may exist; if APPROVE won, exactly one
         * hold may. A race that produced a reservation beside a denial would be authority nobody granted.
         */
        if (denyRes.status === 200) {
          assert.equal(seen.state, "REJECTED");
          assert.equal(seen.reservations, 0, `round ${round}: a denial created a reservation`);
        } else {
          assert.equal(seen.state, "APPROVED");
          assert.equal(seen.activeReservations, 1);
        }
      }
    });

    /**
     * The durability half. Both replicas above shared this database but not each other's memory; a THIRD
     * process that never saw either request must reach the same answer, because the terminal result is a
     * row rather than a fact one of them remembers.
     */
    test("a replica started after the fact refuses to re-decide what was already decided", async () => {
      const r = await pendingRequest();
      const cookie = await actorCookie(discordReplica, r.discord.APPROVE);
      const first = await fetch(
        `${discordReplica.base}/consumer/approvals/action/${r.discord.APPROVE}/confirm`,
        {
          method: "POST",
          headers: { "content-type": "application/json", cookie },
          body: JSON.stringify({ csrf: webActionCsrfToken(SECRET, r.discord.APPROVE, OWNER_SUBJECT) }),
        },
      );
      assert.equal(first.status, 200);
      const settled = await observe(r.approvalRequestId);

      const restarted = await startReplica();
      try {
        const again = await fetch(
          `${restarted.base}/consumer/approvals/${r.approvalRequestId}/act`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken()}` },
            body: JSON.stringify({
              action: "APPROVE",
              csrf: webActionCsrfToken(SECRET, r.approvalRequestId, ACCOUNT),
            }),
          },
        );
        assert.ok(again.status >= 400, "a fresh process must not re-decide a settled request");
        assert.deepEqual(await observe(r.approvalRequestId), settled, "the restart changed the record");
      } finally {
        await stopReplica(restarted);
      }
    });

    /**
     * The claim stated as a property of the deployment rather than of the test: the two apps above hold
     * DIFFERENT pools. Nothing either process could put in memory is visible to the other, so whatever
     * serialises the decision is in Postgres.
     */
    test("the replicas share a database and nothing else", async () => {
      assert.notEqual(discordReplica.pool, webReplica.pool);
      assert.notEqual(discordReplica.base, webReplica.base);

      const pidOf = async (p: Pool): Promise<number> => {
        const { rows } = await p.query<{ pid: number }>(`SELECT pg_backend_pid()::int AS pid`);
        return rows[0]!.pid;
      };
      const [a, b] = await Promise.all([pidOf(discordReplica.pool), pidOf(webReplica.pool)]);
      assert.notEqual(a, b, "the two replicas must not be sharing one backend connection");
    });
  },
);
