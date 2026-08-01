import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { before, describe, test } from "node:test";
import express from "express";
import { registerJsonErrorBoundary } from "../src/http-errors";

/**
 * The audit finding this closes, stated as a test.
 *
 * `GET /consumer/auth/nonce` returned Express's default HTML 404 — and that route is advertised in
 * `/consumer/catalog` under both `auth.obtain` and `publicRoutes`. Every unmatched path did the same,
 * and any thrown error returned HTML with a stack attached, because no error handler was registered
 * and NODE_ENV is not "production" on this deployment.
 *
 * Two subjects. The CRAWL proves the property for every route the router actually has, rather than for
 * the handful someone remembered to check — it runs in a child process, for reasons the probe fixture
 * explains. The unit tests below it prove the three decisions the boundary makes — publish, redact, or
 * refuse — because a crawl asserting only "the content-type is JSON" would happily pass a body
 * containing a connection string.
 */

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

interface Probe {
  readonly status: number;
  readonly contentType: string;
  readonly allow: string | null;
  readonly body: string;
}

interface CrawlReport {
  readonly targets: number;
  readonly nonJson: readonly string[];
  readonly statuses: Readonly<Record<string, number>>;
  readonly probes: {
    readonly unmatched: Probe;
    readonly advertisedWrongVerb: Probe;
    readonly malformedBody: Probe;
    readonly pricedWithDeadFacilitator: Probe;
  };
  readonly rejectionsSurvived: number;
}

describe("every route answers in JSON, including the ones nobody wrote", () => {
  let report: CrawlReport;

  before(async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      ["--import", "tsx", join(HERE, "fixtures", "route-crawl-probe.mts")],
      { cwd: join(HERE, "..", "..", ".."), maxBuffer: 8 * 1024 * 1024, timeout: 120_000 },
    );
    // The service logs its wiring decisions to stdout at construction; the report is the last line.
    const lines = stdout.trim().split("\n");
    report = JSON.parse(lines[lines.length - 1] ?? "") as CrawlReport;
  });

  test("no route returns HTML, for any method the router accepts", () => {
    assert.ok(report.targets > 40, `expected the full surface, crawled ${report.targets}`);
    assert.deepEqual(report.nonJson, []);
  });

  test("an unmatched path is a JSON 404 that points at the catalog", () => {
    const p = report.probes.unmatched;
    assert.equal(p.status, 404);
    assert.match(p.contentType, /application\/json/);
    const body = JSON.parse(p.body) as { code: string; message: string; retryable: boolean };
    assert.equal(body.code, "ROUTE_NOT_FOUND");
    assert.equal(body.retryable, false);
    assert.match(body.message, /\/catalog/);
  });

  /**
   * The exact request the audit made. It is advertised, it is POST-only, and it used to answer HTML.
   * A 404 here would also be wrong — it would send the caller looking for a typo in a correct path.
   */
  test("an advertised path with the wrong verb is a JSON 405 naming the verb that works", () => {
    const p = report.probes.advertisedWrongVerb;
    assert.equal(p.status, 405);
    assert.match(p.contentType, /application\/json/);
    assert.match(p.allow ?? "", /POST/);
    const body = JSON.parse(p.body) as { code: string; message: string };
    assert.equal(body.code, "METHOD_NOT_ALLOWED");
    assert.match(body.message, /POST/);
  });

  test("a malformed JSON body is still the named envelope, not a parser page", () => {
    const p = report.probes.malformedBody;
    assert.equal(p.status, 400);
    assert.equal((JSON.parse(p.body) as { code: string }).code, "BODY_NOT_JSON");
  });

  /**
   * A regression this suite discovered on its first run.
   *
   * `/preflight_payment` is one of the two services OKX rejected. With the facilitator unreachable it
   * answered an HTML page carrying a stack trace that named the x402 package's internal modules — to
   * an unauthenticated caller, on the service's most public route.
   */
  test("a paid route whose facilitator is unreachable answers JSON, not a stack trace", () => {
    const p = report.probes.pricedWithDeadFacilitator;
    assert.equal(p.status, 500);
    assert.match(p.contentType, /application\/json/);
    const body = JSON.parse(p.body) as Record<string, unknown>;
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.match(String(body.correlationId), /^err_[0-9a-f]{16}$/);
    assert.ok(!p.body.includes("x402ResourceServer"), "served body named an internal module");
    assert.ok(!p.body.includes("node_modules"), "served body carried a filesystem path");
  });

  /**
   * The claim `installUnhandledRejectionGuard` exists to make.
   *
   * The x402 middleware leaks a rejection when the facilitator is unreachable, and Node's default for
   * an unhandled rejection is to TERMINATE. Without the guard, an OKX outage would not merely fail the
   * paid routes — it would restart the container, taking the free routes, the receipt status poll and
   * the health endpoint with them. The probe waits past the middleware's retry budget before exiting,
   * so a report arriving at all is evidence the process was still alive when the rejection landed.
   */
  test("a leaked rejection is recorded, and does not take the process down", () => {
    assert.ok(
      report.rejectionsSurvived > 0,
      "the probe did not provoke the rejection it is meant to survive — has the middleware changed?",
    );
  });
});

/**
 * The boundary's decisions, driven directly.
 *
 * Mounted on a bare app rather than the seller: the subject is what the handler does with a thrown
 * error, and routing it through eighty real routes would only make a failure harder to read.
 */
describe("what a thrown error is allowed to say", () => {
  function appThrowing(err: unknown, logs: string[]): express.Express {
    const a = express();
    a.get("/boom", () => {
      throw err;
    });
    registerJsonErrorBoundary(a, { log: (line) => logs.push(line) });
    return a;
  }

  async function callBoom(a: express.Express): Promise<{ status: number; body: Record<string, unknown> }> {
    const server = createServer(a);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    assert.ok(addr && typeof addr === "object");
    const res = await fetch(`http://127.0.0.1:${addr.port}/boom`);
    const body = (await res.json()) as Record<string, unknown>;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return { status: res.status, body };
  }

  test("an unrecognised error publishes a code and an id, and NOTHING it was carrying", async () => {
    // Every category the requirement names, in one message: a DSN, SQL, a provider body, a secret.
    const leaky = new Error(
      "connect ECONNREFUSED postgres://untch:hunter2@db.internal:5432/untch — " +
        "INSERT INTO consumer_intents (id, secret) VALUES ($1, $2) — " +
        'provider said {"apiKey":"sk-live-abcdef","detail":"quota"}',
    );
    const logs: string[] = [];
    const { status, body } = await callBoom(appThrowing(leaky, logs));

    assert.equal(status, 500);
    assert.equal(body.code, "INTERNAL_ERROR");
    assert.match(String(body.correlationId), /^err_[0-9a-f]{16}$/);

    const served = JSON.stringify(body);
    for (const forbidden of ["postgres://", "hunter2", "INSERT INTO", "sk-live-abcdef", "db.internal"]) {
      assert.ok(!served.includes(forbidden), `served body leaked ${forbidden}`);
    }
    assert.ok(!served.includes("at "), "served body carried a stack frame");

    // The cause is not lost — it is moved. The id is what ties the two together.
    assert.equal(logs.length, 1);
    assert.ok(logs[0]?.includes(String(body.correlationId)));
    assert.ok(logs[0]?.includes("hunter2"), "the log must keep what the response refused");
  });

  test("a recognised domain error keeps its structured code and its caller-facing message", async () => {
    class IdempotencyConflictError extends Error {
      constructor() {
        super("idempotency key already used for tenant policy:42");
        this.name = "IdempotencyConflictError";
      }
    }
    const { status, body } = await callBoom(appThrowing(new IdempotencyConflictError(), []));
    assert.equal(status, 409);
    assert.equal(body.code, "IDEMPOTENCY_KEY_REUSED");
    assert.match(String(body.message), /idempotency key already used/);
    assert.equal(body.correlationId, undefined, "a classified error needs no incident id");
  });

  test("a provider failure publishes the classification, not the provider's own words", async () => {
    class ProviderError extends Error {
      constructor() {
        super("PROVIDER_REJECTED: account 88213 is over its monthly quota at internal-billing.example");
        this.name = "ProviderError";
      }
    }
    const { status, body } = await callBoom(appThrowing(new ProviderError(), []));
    assert.equal(status, 502);
    assert.equal(body.code, "PROVIDER_FAILED");
    assert.ok(!String(body.message).includes("88213"));
    assert.ok(!String(body.message).includes("internal-billing.example"));
  });

  test("missing configuration is a 503 that does not map the deployment's variables", async () => {
    class MissingEnvError extends Error {
      constructor() {
        super("Missing required environment variable: CONSUMER_TREASURY_BASE_PRIVATE_KEY");
        this.name = "MissingEnvError";
      }
    }
    const { status, body } = await callBoom(appThrowing(new MissingEnvError(), []));
    assert.equal(status, 503);
    assert.equal(body.code, "SERVICE_NOT_CONFIGURED");
    assert.ok(!String(body.message).includes("CONSUMER_TREASURY_BASE_PRIVATE_KEY"));
  });

  test("a thrown non-Error is handled without becoming a 200", async () => {
    const { status, body } = await callBoom(appThrowing("just a string", []));
    assert.equal(status, 500);
    assert.equal(body.code, "INTERNAL_ERROR");
  });
});
