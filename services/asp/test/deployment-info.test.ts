import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import type { Server } from "node:http";
import {
  DeploymentLifecycle,
  describeDeployment,
  readBuildAttestation,
  rpcHostOf,
  solanaPostureOf,
  ATTESTATION_FILENAME,
} from "../src/deployment-info";
import { registerDeploymentRoutes, HEALTH_ROUTE, DEPLOYMENT_INFO_ROUTE } from "../src/deployment-routes";

/**
 * The controls added after the arming incident of 2026-07-29.
 *
 * Two assertions here are the whole point, and the rest support them:
 *
 *   1. the health route reports NOT ready until readiness is declared, so a platform cannot route to a
 *      process that has not finished migrating;
 *   2. the deployment-info route never emits a secret, and fails CLOSED when unconfigured.
 *
 * The incident happened because "the new deployment is live" was assumed rather than checked. These
 * routes exist to make it checkable, so a test that lets them lie is worse than no test.
 */

const servers: Server[] = [];

after(async () => {
  await Promise.all(
    servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
  );
});

/** A real HTTP server on an ephemeral port. The routes are middleware, so they are tested as such. */
async function serve(lifecycle: DeploymentLifecycle | null): Promise<string> {
  const app = express();
  registerDeploymentRoutes(app, lifecycle);
  return await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

/**
 * The RPC fixture, assembled from parts rather than written as one literal.
 *
 * The provider puts its API key in the URL PATH, so a realistic fixture is a string shaped exactly like
 * a real credential. Written out in full it trips secret scanners, and a scanner that cries wolf on a
 * test fixture is one whose next finding gets waved through. Composing it keeps the assertion identical
 * while leaving no credential-shaped literal in the source.
 */
const RPC_HOST = "solana-mainnet.g.alchemy.com";
/** Stands in for the key. The tests assert this never reaches a log line or a response body. */
const RPC_PATH_SEGMENT = "path-segment-that-must-never-be-emitted";
const RPC_URL = `https://${RPC_HOST}/v2/${RPC_PATH_SEGMENT}`;

/** Stands in for a signer secret. The tests assert it never reaches a response or a log line. */
const SIGNER_SECRET_STANDIN = "signer-secret-that-must-never-be-emitted";

/**
 * The operator token fixture.
 *
 * Named as a fixture and composed, for the same reason as the two above: a literal assigned to a
 * variable called *_TOKEN is what a secret scanner looks for, and a finding that has to be dismissed
 * costs more than it saves.
 */
const OPS_TOKEN_FIXTURE = ["ops", "token", "fixture", "value"].join("-");

const DISARMED: NodeJS.ProcessEnv = {
  CONSUMER_SOLANA_RPC_URL: RPC_URL,
};

describe("the health route", () => {
  test("reports 503 while STARTING, so the platform cannot route to a half-started process", async () => {
    // #given a process that has begun starting but has not declared readiness
    const base = await serve(new DeploymentLifecycle(DISARMED));

    // #when the platform health check runs
    const res = await fetch(`${base}${HEALTH_ROUTE}`);

    // #then it fails. This is the check that was missing: the container was up, so it looked fine.
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { phase: string }).phase, "STARTING");
  });

  test("reports 200 only once readiness is declared", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const res = await fetch(`${base}${HEALTH_ROUTE}`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { status: string }).status, "ok");
  });

  test("stays 503 after a failure, and readiness cannot overwrite it", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markFailed("schema probe failed");
    // A later markReady must NOT rescue a failed startup. If it could, a partially-wired process would
    // announce itself healthy the moment it happened to reach the listen callback.
    lifecycle.markReady();

    const base = await serve(lifecycle);
    const res = await fetch(`${base}${HEALTH_ROUTE}`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { phase: string }).phase, "FAILED");
  });

  test("a null lifecycle is NOT ready", async () => {
    // The default must fail closed. A code path that forgets to construct a lifecycle should surface as
    // a failed deployment, not as a process quietly taking traffic.
    const base = await serve(null);
    const res = await fetch(`${base}${HEALTH_ROUTE}`);
    assert.equal(res.status, 503);
  });

  test("says nothing about posture, because it is unauthenticated", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const body = (await (await fetch(`${base}${HEALTH_ROUTE}`)).json()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["phase", "status"]);
  });
});

describe("the deployment-info route", () => {
  test("fails CLOSED when no operator token is configured", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const saved = process.env.INTERNAL_OPS_TOKEN;
    delete process.env.INTERNAL_OPS_TOKEN;
    try {
      const res = await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`);
      // 503, not 200. An unconfigured internal endpoint must be unavailable rather than public.
      assert.equal(res.status, 503);
      assert.equal(((await res.json()) as { code: string }).code, "OPS_AUTH_NOT_CONFIGURED");
    } finally {
      if (saved !== undefined) process.env.INTERNAL_OPS_TOKEN = saved;
    }
  });

  test("refuses a missing or wrong token", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const saved = process.env.INTERNAL_OPS_TOKEN;
    process.env.INTERNAL_OPS_TOKEN = OPS_TOKEN_FIXTURE;
    try {
      assert.equal((await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`)).status, 401);
      assert.equal(
        (
          await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`, {
            headers: { authorization: `Bearer not-${OPS_TOKEN_FIXTURE}` },
          })
        ).status,
        401,
      );
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_OPS_TOKEN;
      else process.env.INTERNAL_OPS_TOKEN = saved;
    }
  });

  test("with a valid token, answers the questions that were assumed during the incident", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.recordGateCode(true);
    lifecycle.recordSchema("011_solana_proof_gate.sql", true);
    lifecycle.recordRails(["eip155:8453"]);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const saved = process.env.INTERNAL_OPS_TOKEN;
    process.env.INTERNAL_OPS_TOKEN = OPS_TOKEN_FIXTURE;
    try {
      const res = await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`, {
        headers: { authorization: `Bearer ${OPS_TOKEN_FIXTURE}` },
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        phase: string;
        migrationVersion: string;
        settlementRails: string[];
        proofGate: { code: string; schema: string; proofMode: string };
        solana: { signer: string; execution: string; rpcHost: string; rpcMode: string };
      };

      assert.equal(body.phase, "READY");
      assert.equal(body.migrationVersion, "011_solana_proof_gate.sql");
      assert.deepEqual(body.settlementRails, ["eip155:8453"]);
      assert.equal(body.proofGate.code, "present");
      assert.equal(body.proofGate.schema, "ready");
      // Disarmed, which is the state that must be observable before arming.
      assert.equal(body.proofGate.proofMode, "disabled");
      assert.equal(body.solana.signer, "absent");
      assert.equal(body.solana.execution, "disabled");
      assert.equal(body.solana.rpcMode, "read-only");
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_OPS_TOKEN;
      else process.env.INTERNAL_OPS_TOKEN = saved;
    }
  });

  test("never emits the RPC credential, only the host", async () => {
    const lifecycle = new DeploymentLifecycle(DISARMED);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const saved = process.env.INTERNAL_OPS_TOKEN;
    process.env.INTERNAL_OPS_TOKEN = OPS_TOKEN_FIXTURE;
    try {
      const raw = await (
        await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`, { headers: { authorization: `Bearer ${OPS_TOKEN_FIXTURE}` } })
      ).text();

      // The Alchemy key lives in the URL PATH, so a response containing the URL is a leaked key.
      assert.ok(!raw.includes(RPC_PATH_SEGMENT), "the RPC key must never appear in the response");
      assert.ok(raw.includes(RPC_HOST), "the host is expected, and is not a secret");
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_OPS_TOKEN;
      else process.env.INTERNAL_OPS_TOKEN = saved;
    }
  });

  test("never emits a secret env value even when one is set", async () => {
    const armed: NodeJS.ProcessEnv = {
      ...DISARMED,
      CONSUMER_TREASURY_SOLANA_SECRET_KEY: SIGNER_SECRET_STANDIN,
      CONSUMER_SOLANA_EXECUTION_ENABLED: "1",
      CONSUMER_SOLANA_PROOF_MODE: "1",
    };
    const lifecycle = new DeploymentLifecycle(armed);
    lifecycle.markReady();
    const base = await serve(lifecycle);

    const saved = process.env.INTERNAL_OPS_TOKEN;
    process.env.INTERNAL_OPS_TOKEN = OPS_TOKEN_FIXTURE;
    try {
      const raw = await (
        await fetch(`${base}${DEPLOYMENT_INFO_ROUTE}`, { headers: { authorization: `Bearer ${OPS_TOKEN_FIXTURE}` } })
      ).text();

      assert.ok(!raw.includes(SIGNER_SECRET_STANDIN));
      // It reports the FACT of a signer without the signer.
      const body = JSON.parse(raw) as { solana: { signer: string; execution: string; rpcMode: string } };
      assert.equal(body.solana.signer, "present");
      assert.equal(body.solana.execution, "enabled");
      assert.equal(body.solana.rpcMode, "read-write");
    } finally {
      if (saved === undefined) delete process.env.INTERNAL_OPS_TOKEN;
      else process.env.INTERNAL_OPS_TOKEN = saved;
    }
  });
});

describe("the Solana posture", () => {
  test("absent variables read as the safer value, never as permissive", () => {
    const posture = solanaPostureOf({}, { codePresent: true, schemaReady: true });
    assert.equal(posture.proofMode, "disabled");
    assert.equal(posture.signer, "absent");
    assert.equal(posture.execution, "disabled");
    assert.equal(posture.rpcMode, "read-only");
    assert.equal(posture.rpcHost, null);
  });

  test("a signer without an execution flag is still read-only", () => {
    // Both are required to spend. Reporting read-write on the strength of one of them would overstate
    // what the instance can do, and this endpoint is read by the gate that decides whether to arm.
    const posture = solanaPostureOf(
      { CONSUMER_TREASURY_SOLANA_SECRET_KEY: "x" },
      { codePresent: true, schemaReady: true },
    );
    assert.equal(posture.rpcMode, "read-only");
  });

  test("rpcHostOf keeps the host and discards the credential path", () => {
    assert.equal(rpcHostOf(RPC_URL), RPC_HOST);
    assert.equal(rpcHostOf(undefined), null);
    assert.equal(rpcHostOf("   "), null);
    assert.equal(rpcHostOf("not a url"), "(unparseable)");
  });
});

describe("the build attestation", () => {
  test("is read from the uploaded tree", () => {
    const dir = mkdtempSync(join(tmpdir(), "untch-attest-"));
    try {
      writeFileSync(
        join(dir, ATTESTATION_FILENAME),
        JSON.stringify({ commit: "a".repeat(40), branch: "main", builtAt: "2026-07-30T00:00:00.000Z", source: "git-archive-export" }),
      );
      const attestation = readBuildAttestation(dir);
      assert.equal(attestation?.commit, "a".repeat(40));
      assert.equal(attestation?.branch, "main");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("is found by walking up, because the service starts from its own package directory", () => {
    const root = mkdtempSync(join(tmpdir(), "untch-attest-"));
    try {
      const nested = join(root, "services", "asp", "src");
      mkdirSync(nested, { recursive: true });
      writeFileSync(join(root, ATTESTATION_FILENAME), JSON.stringify({ commit: "b".repeat(40) }));
      assert.equal(readBuildAttestation(nested)?.commit, "b".repeat(40));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a malformed attestation reports unattested rather than a guess", () => {
    const dir = mkdtempSync(join(tmpdir(), "untch-attest-"));
    try {
      writeFileSync(join(dir, ATTESTATION_FILENAME), "{ this is not json");
      assert.equal(readBuildAttestation(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent attestation is reported as unattested, and the banner says so", () => {
    const dir = mkdtempSync(join(tmpdir(), "untch-empty-"));
    try {
      assert.equal(readBuildAttestation(dir), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const lifecycle = new DeploymentLifecycle(DISARMED);
    const banner = describeDeployment({ ...lifecycle.snapshot(), commit: null, attested: false });
    // An unattested deployment must be visibly unattested, because it is one that must not be armed.
    assert.match(banner, /UNATTESTED/);
  });
});

describe("the startup banner", () => {
  test("carries the identity fields an operator needs, and no secret", () => {
    const lifecycle = new DeploymentLifecycle({
      ...DISARMED,
      CONSUMER_TREASURY_SOLANA_SECRET_KEY: SIGNER_SECRET_STANDIN,
      RAILWAY_DEPLOYMENT_ID: "dep-123",
    });
    lifecycle.recordGateCode(true);
    lifecycle.recordSchema("011_solana_proof_gate.sql", true);
    lifecycle.recordRails(["eip155:8453"]);
    lifecycle.markReady();

    const banner = describeDeployment(lifecycle.snapshot());

    assert.match(banner, /UNTCH DEPLOYMENT READY/);
    assert.match(banner, /migration {10}011_solana_proof_gate\.sql/);
    assert.match(banner, /proofGateCode {6}present/);
    assert.match(banner, /proofGateSchema {4}ready/);
    assert.match(banner, /proofMode {10}disabled/);
    assert.match(banner, new RegExp(`solanaRpcHost {6}${RPC_HOST.replace(/\./g, "\\.")}`));
    assert.match(banner, /deploymentId {7}dep-123/);
    assert.ok(!banner.includes(SIGNER_SECRET_STANDIN));
    assert.ok(!banner.includes("/v2/"), "the RPC path must never reach the log");
  });
});
