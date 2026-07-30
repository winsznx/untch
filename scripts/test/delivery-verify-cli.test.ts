import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";

/**
 * The redrive command, run as a real child process with a scrubbed environment.
 *
 * The property worth proving is an ABSENCE: this process cannot write the verification record itself.
 * That matters because the record's whole value is as evidence about PRODUCTION. A local process holding
 * a database credential could have written any row it liked, and then the record would be evidence about
 * a laptop.
 *
 * So the command is spawned for real rather than imported. An imported module would inherit this test
 * runner's environment, and "it refused because DATABASE_URL was set" is only meaningful when the
 * environment is one the test controls completely.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CLI = resolve(REPO_ROOT, "scripts/verify-consumer-delivery.ts");
const INTENT = "ci_e58174e549f6a21c591eacfa";
const TOKEN = "an-operator-token-that-is-never-logged";

interface Run {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: REPO_ROOT,
      // Only what is passed. Nothing inherited, so a variable present in the run is one this test put there.
      env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

/** A server that records every request, so "it made no request" is checkable rather than assumed. */
async function recordingServer(body: unknown, status = 200): Promise<{ url: string; hits: string[]; close: () => Promise<void> }> {
  const hits: string[] = [];
  const server: Server = createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const OK_BODY = {
  intentId: INTENT,
  verification: {
    verificationId: "dv_0011223344",
    verifierVersion: "purch-paid-read/1.0.0",
    method: "PAID_READ_RESULT_BINDING",
    verified: true,
    detail: "the paid search returned 5 schema-valid products bound to the authorised request",
    evidenceDigest: `0x${"f".repeat(64)}`,
    resultHash: `0x${"2".repeat(64)}`,
    settlementTx: "63cbzAEuDkMFs41TwuGKjYC3YWz3e8FeYbQVfrt2WGmvWotdUMmiJCf3yzyd8EypPDikfQjWAxWGUa5rDTJLrhVK",
    settledAmount: "10000",
    originalReceiptId: null,
    refusals: [],
  },
  alreadyRecorded: false,
  deliveryProjection: { untchVerified: true, method: "PAID_READ_RESULT_BINDING" },
  publicReceiptUrl: `https://asp.untch.xyz/consumer/receipt/${INTENT}`,
  paid: false,
  providerCalled: false,
  signerLoaded: false,
};

describe("the redrive command refuses to hold anything that could write the record", () => {
  /**
   * A database credential is the one that matters most.
   *
   * With it, this process could have written the verification row directly — and a record it could have
   * forged is not evidence about production.
   */
  test("a DATABASE_URL in the environment stops it before any network call", async () => {
    // #given a server that would answer, and a credential that must not be tolerated
    const server = await recordingServer(OK_BODY);
    try {
      // #when the command runs
      const r = await run(["--intent-id", INTENT, "--confirm"], {
        UNTCH_ASP_URL: server.url,
        INTERNAL_OPS_TOKEN: TOKEN,
        DATABASE_URL: "postgresql://someone@somewhere/untch",
      });
      // #then it refused, and never reached the server
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /REFUSED/);
      assert.match(r.stderr, /DATABASE_URL is set/);
      assert.deepEqual(server.hits, [], "it must refuse before opening a connection");
    } finally {
      await server.close();
    }
  });

  test("any treasury or proof signing key stops it too", async () => {
    for (const name of [
      "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
      "CONSUMER_SOLANA_PROOF_SECRET_KEY",
      "CONSUMER_TREASURY_BASE_PRIVATE_KEY",
    ]) {
      const r = await run(["--intent-id", INTENT, "--confirm"], {
        UNTCH_ASP_URL: "https://asp.untch.xyz",
        INTERNAL_OPS_TOKEN: TOKEN,
        [name]: "not-a-real-key",
      });
      assert.equal(r.code, 2, `${name} must be refused`);
      assert.match(r.stderr, new RegExp(`${name} is set`));
    }
  });

  test("the refusal never prints the credential it objected to", async () => {
    const secret = "postgresql://user:hunter2@db.internal/untch";
    const r = await run(["--intent-id", INTENT, "--confirm"], {
      UNTCH_ASP_URL: "https://asp.untch.xyz",
      INTERNAL_OPS_TOKEN: TOKEN,
      DATABASE_URL: secret,
    });
    assert.equal(r.stderr.includes("hunter2"), false);
    assert.equal(r.stdout.includes("hunter2"), false);
  });
});

describe("the command asks for nothing until it is confirmed", () => {
  /**
   * A dry run by default.
   *
   * `--confirm` is separate from running the command so that a mistyped intent id costs a printed
   * paragraph rather than a row written against the wrong settlement.
   */
  test("without --confirm it describes what it would do and makes no request", async () => {
    const server = await recordingServer(OK_BODY);
    try {
      const r = await run(["--intent-id", INTENT], { UNTCH_ASP_URL: server.url, INTERNAL_OPS_TOKEN: TOKEN });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /Dry run/);
      assert.deepEqual(server.hits, [], "a dry run must not touch production");
    } finally {
      await server.close();
    }
  });

  test("a malformed intent id is refused without a request", async () => {
    const server = await recordingServer(OK_BODY);
    try {
      const r = await run(["--intent-id", "not-an-intent", "--confirm"], {
        UNTCH_ASP_URL: server.url,
        INTERNAL_OPS_TOKEN: TOKEN,
      });
      assert.equal(r.code, 2);
      assert.match(r.stderr, /canonical ci_/);
      assert.deepEqual(server.hits, []);
    } finally {
      await server.close();
    }
  });

  test("a missing ASP url or operator token is refused", async () => {
    const noUrl = await run(["--intent-id", INTENT, "--confirm"], { INTERNAL_OPS_TOKEN: TOKEN });
    assert.equal(noUrl.code, 2);
    assert.match(noUrl.stderr, /UNTCH_ASP_URL/);

    const noToken = await run(["--intent-id", INTENT, "--confirm"], { UNTCH_ASP_URL: "https://asp.untch.xyz" });
    assert.equal(noToken.code, 2);
    assert.match(noToken.stderr, /INTERNAL_OPS_TOKEN/);
  });
});

describe("what it reports back", () => {
  test("a confirmed run posts exactly one verify request and reports the record", async () => {
    const server = await recordingServer(OK_BODY);
    try {
      const r = await run(["--intent-id", INTENT, "--confirm"], { UNTCH_ASP_URL: server.url, INTERNAL_OPS_TOKEN: TOKEN });
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(server.hits, [`POST /internal/consumer/intents/${INTENT}/verify-delivery`]);
      assert.match(r.stdout, /VERIFIED/);
      assert.match(r.stdout, /PAID_READ_RESULT_BINDING/);
      // The posture is printed, so an operator reading the transcript can see nothing was spent.
      assert.match(r.stdout, /paid=false/);
      assert.match(r.stdout, /providerCalled=false/);
      assert.match(r.stdout, /signerLoaded=false/);
    } finally {
      await server.close();
    }
  });

  /**
   * A refusal exits non-zero and NAMES its grounds.
   *
   * An operator who cannot tell "verified" from "could not be verified" at a glance will eventually
   * record the wrong one in an evidence pack.
   */
  test("a refused verification exits non-zero and lists every ground", async () => {
    const refused = {
      ...OK_BODY,
      verification: {
        ...OK_BODY.verification,
        verified: false,
        detail: "verification refused on 1 ground(s): RESULT_NOT_BOUND",
        refusals: [{ code: "RESULT_NOT_BOUND", detail: "the persisted result answers a different query" }],
      },
    };
    const server = await recordingServer(refused);
    try {
      const r = await run(["--intent-id", INTENT, "--confirm"], { UNTCH_ASP_URL: server.url, INTERNAL_OPS_TOKEN: TOKEN });
      assert.equal(r.code, 1);
      assert.match(r.stdout, /NOT VERIFIED/);
      assert.match(r.stdout, /RESULT_NOT_BOUND/);
    } finally {
      await server.close();
    }
  });

  test("a structured refusal from production is reported with its code, not as a stack", async () => {
    const server = await recordingServer(
      { code: "PROTOCOL_NOT_EXECUTABLE", message: "FULFILMENT has no redrive", recordWritten: false, receiptAltered: false },
      422,
    );
    try {
      const r = await run(["--intent-id", INTENT, "--confirm"], { UNTCH_ASP_URL: server.url, INTERNAL_OPS_TOKEN: TOKEN });
      assert.equal(r.code, 3);
      assert.match(r.stderr, /PROTOCOL_NOT_EXECUTABLE/);
      assert.match(r.stderr, /receiptAltered: false/);
      assert.equal(r.stderr.includes("at Object."), false, "never a stack trace");
    } finally {
      await server.close();
    }
  });
});

/**
 * The command's own import graph.
 *
 * It must be unable to reach a store, a signer or a rail even by accident, for the same reason the proof
 * controller must: a process that COULD write the row is not a witness to production having written it.
 */
describe("the command imports nothing that could reach a database, a signer or a rail", () => {
  const source = readFileSync(CLI, "utf8");

  test("it has no static imports at all", () => {
    assert.equal(/^import\s/m.test(source), false, "a static import here is a way to acquire a capability");
  });

  test("it names no store, signer, rail or dotenv module", () => {
    for (const banned of ["@untch/consumer-core", "@untch/consumer-providers", "dotenv", "pg", "@solana/", "viem"]) {
      assert.equal(source.includes(`"${banned}`), false, `the command must not import ${banned}`);
    }
  });
});
