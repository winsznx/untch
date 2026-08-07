import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import {
  MissingBindingError,
  assertBindings,
  environmentOf,
  publicBaseUrl,
  REQUIRED_BINDINGS,
  REQUIRED_VARS,
  type WorkerEnv,
} from "../src/workers/env";
import { __resetSchemaCache, buildWorker, healthBody, verifySchemaCached } from "../src/workers/entry";
import { writerGate } from "../src/workers/writer-gate";
import { armingState } from "../src/workers/arming";
import type { Route } from "../src/workers/router";

/**
 * The entry module: bindings, environment separation, response hygiene and the three handlers.
 */

const SCHEMA_OK = { ok: true as const, applied: 35, head: "035_wallet_scope_downgrade.sql" };

function env(over: Partial<WorkerEnv> = {}): WorkerEnv {
  return {
    HYPERDRIVE: { connectionString: "postgres://u@h/db" },
    APPROVAL_DELIVERY: { async send() {}, async sendBatch() {} },
    PAY_TO_ADDRESS: "0xD9eD4D474B0D01031d10d637546450F39ed6a5ba",
    ...over,
  } as WorkerEnv;
}

function pool() {
  const statements: string[] = [];
  const record = async (sql: string): Promise<{ rows: unknown[] }> => {
    statements.push(sql.trim().split("\n")[0]!.trim());
    if (sql.includes("schema_migrations")) return { rows: [{ name: "001_init.sql" }] };
    if (sql.includes("pg_try_advisory_xact_lock")) return { rows: [{ locked: true }] };
    return { rows: [] };
  };
  return { pool: { query: record, async connect() { return { query: record, release() {} }; } } as never, statements };
}

const okRoute = (over: Partial<Route> = {}): Route => ({
  method: "GET",
  pattern: "/healthz",
  bodyMode: "none",
  handler: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ...over,
});

beforeEach(() => __resetSchemaCache());

describe("bindings are checked before anything uses one", () => {
  test("a missing required binding is named", () => {
    for (const name of REQUIRED_BINDINGS) {
      const partial = { ...env() } as Record<string, unknown>;
      delete partial[name];
      assert.throws(() => assertBindings(partial as Partial<WorkerEnv>), MissingBindingError, `${name} must be required`);
    }
  });

  test("a complete set passes", () => {
    assert.doesNotThrow(() => assertBindings(env()));
  });

  /**
   * A required VAR is checked the same way a binding is.
   *
   * `PAY_TO_ADDRESS` earns this because the x402 document names a payee and there is no safe default
   * for one — a zero address would publish "send USDT0 into a burn". Refusing to serve is the correct
   * answer; serving a document that misdirects money is not.
   */
  test("a missing required var is named, not defaulted", () => {
    for (const name of REQUIRED_VARS) {
      const partial = { ...env() } as Record<string, unknown>;
      delete partial[name];
      assert.throws(() => assertBindings(partial as Partial<WorkerEnv>), MissingBindingError, `${name} must be required`);
    }
  });

  test("a required var present but blank is still missing", () => {
    assert.throws(() => assertBindings(env({ PAY_TO_ADDRESS: "   " })), MissingBindingError);
  });

  test("an optional binding may be absent", () => {
    assert.doesNotThrow(() => assertBindings(env({ BACKUPS: undefined })));
  });
});

describe("a preview Worker can never claim the production endpoint", () => {
  /**
   * THE PROPERTY THAT KEEPS A PREVIEW OUT OF PUBLIC DISCOVERY.
   *
   * A catalog, OpenAPI document or x402 descriptor published by a preview claiming asp.untch.xyz
   * would tell a reviewer or a marketplace validator that the preview IS the listed endpoint.
   */
  test("a preview refuses to advertise the production hostname", () => {
    assert.throws(
      () => publicBaseUrl({ UNTCH_ENVIRONMENT: "preview", ASP_PUBLIC_URL: "https://asp.untch.xyz" }),
      /must not advertise/,
    );
  });

  test("a preview defaults to its workers.dev URL", () => {
    const url = publicBaseUrl({ UNTCH_ENVIRONMENT: "preview", ASP_PUBLIC_URL: undefined });
    assert.match(url, /workers\.dev/);
  });

  test("production refuses to advertise a workers.dev URL", () => {
    assert.throws(
      () => publicBaseUrl({ UNTCH_ENVIRONMENT: "production", ASP_PUBLIC_URL: "https://x.workers.dev" }),
      /must not advertise a workers\.dev URL/,
    );
  });

  test("production defaults to the listed endpoint", () => {
    assert.equal(publicBaseUrl({ UNTCH_ENVIRONMENT: "production", ASP_PUBLIC_URL: undefined }), "https://asp.untch.xyz");
  });

  /** Anything that is not exactly "production" is a preview. Defaulting the other way is unsafe. */
  test("an unset or unrecognised environment is a preview", () => {
    for (const v of [undefined, "", "prod", "PRODUCTION", "staging"]) {
      assert.equal(environmentOf({ UNTCH_ENVIRONMENT: v }), "preview", `${JSON.stringify(v)} must not be production`);
    }
    assert.equal(environmentOf({ UNTCH_ENVIRONMENT: "production" }), "production");
  });
});

describe("schema verification is read-only and cached", () => {
  test("it issues only a SELECT", async () => {
    const { pool: p, statements } = pool();
    await verifySchemaCached(p, ["001_init.sql"]);
    for (const s of statements) {
      assert.ok(!/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)/i.test(s), `runtime issued DDL/DML: ${s}`);
    }
  });

  test("a second call inside the TTL does not re-query", async () => {
    const { pool: p, statements } = pool();
    await verifySchemaCached(p, ["001_init.sql"], 1_000);
    const after = statements.length;
    await verifySchemaCached(p, ["001_init.sql"], 1_500);
    assert.equal(statements.length, after, "a health check must not add a round trip per request");
  });

  test("past the TTL it re-checks, so a migration is noticed", async () => {
    const { pool: p, statements } = pool();
    await verifySchemaCached(p, ["001_init.sql"], 1_000);
    const after = statements.length;
    await verifySchemaCached(p, ["001_init.sql"], 1_000 + 61_000);
    assert.ok(statements.length > after);
  });
});

describe("health reports the posture without leaking anything", () => {
  const ctx = {
    pool: null as never,
    env: env({ UNTCH_ENVIRONMENT: "preview" }),
    arming: armingState({ attested: false, schema: SCHEMA_OK, armedFlag: undefined }),
    gate: writerGate(undefined),
    baseUrl: "https://untch-asp-preview.timjosh507.workers.dev",
    schema: SCHEMA_OK,
  };

  test("the pre-cutover posture is visible", () => {
    const body = healthBody(ctx);
    assert.deepEqual(body.posture, {
      financiallyArmed: false,
      productionWriter: "elsewhere",
      scheduledMutations: "disabled",
      queueMutations: "disabled",
    });
    assert.deepEqual(body.armingRefusals, ["UNATTESTED", "NOT_ARMED"]);
  });

  test("an unattested build says so rather than inventing a commit", () => {
    const body = healthBody(ctx);
    assert.equal(body.attested, false);
    assert.equal(body.commit, null);
  });

  test("health carries no secret", () => {
    const text = JSON.stringify(
      healthBody({
        ...ctx,
        env: env({
          UNTCH_ENVIRONMENT: "preview",
          OKX_SECRET_KEY: "sk_live_do_not_leak",
          CONSUMER_SESSION_SECRET: "session_do_not_leak",
        }),
      }),
    );
    for (const secret of ["sk_live_do_not_leak", "session_do_not_leak", "postgres://", "connectionString"]) {
      assert.ok(!text.includes(secret), `health must not contain ${secret}`);
    }
  });
});

describe("the fetch handler", () => {
  const worker = (routes: readonly Route[]) =>
    buildWorker({
      makePool: () => pool().pool,
      expectedMigrations: ["001_init.sql"],
      jobDeps: () => ({}) as never,
      routes: () => routes,
      log: () => {},
    });

  test("every response carries a request id and security headers", async () => {
    const res = await worker([okRoute()]).fetch(new Request("https://x/healthz"), env());
    assert.ok(res.headers.get("x-request-id"));
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  });

  test("a preflight is answered without running a route", async () => {
    let ran = false;
    const res = await worker([okRoute({ handler: () => { ran = true; return new Response("{}"); } })])
      .fetch(new Request("https://x/healthz", { method: "OPTIONS", headers: { origin: "https://untch.xyz" } }), env());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://untch.xyz");
    assert.equal(ran, false);
  });

  /** Credentials are never allowed: an action is authorised by a token, never by an ambient cookie. */
  test("CORS never allows credentials", async () => {
    const res = await worker([okRoute()]).fetch(
      new Request("https://x/healthz", { headers: { origin: "https://evil.example" } }),
      env(),
    );
    assert.equal(res.headers.get("access-control-allow-credentials"), null);
  });

  test("a handler throwing does not leak its message to the caller", async () => {
    const res = await worker([
      okRoute({ handler: () => { throw new Error("connection postgres://user:pw@host/db failed"); } }),
    ]).fetch(new Request("https://x/healthz"), env());

    assert.equal(res.status, 500);
    const text = await res.text();
    assert.ok(!text.includes("postgres://"), "an unhandled error must not echo a connection string");
    assert.match(text, /INTERNAL_ERROR/);
    assert.ok(text.includes(res.headers.get("x-request-id") ?? " "), "the id ties the response to the log line");
  });

  test("a missing binding refuses to serve rather than failing deep in a handler", async () => {
    const broken = { ...env() } as Record<string, unknown>;
    delete broken.HYPERDRIVE;
    const res = await worker([okRoute()]).fetch(new Request("https://x/healthz"), broken as WorkerEnv);
    assert.equal(res.status, 503);
    assert.match(await res.text(), /DEPLOYMENT_NOT_READY/);
  });

  /**
   * The build-time guard runs on every request path. A parsing route able to claim the Discord path
   * would consume the bytes the signature covers, so the entry refuses to serve at all.
   */
  test("a route table that could shadow the raw Discord path refuses to serve", async () => {
    const res = await worker([
      { method: "POST", pattern: "/consumer/approvals/action/discord/interactions", bodyMode: "raw", handler: () => new Response("{}") },
      { method: "POST", pattern: "/consumer/approvals/action/discord/:kind", bodyMode: "json", handler: () => new Response("{}") },
    ]).fetch(new Request("https://x/healthz"), env());

    assert.equal(res.status, 503, "an unsafe route table is a deployment defect, not a request error");
    assert.match(await res.text(), /DEPLOYMENT_NOT_READY/);
  });
});
