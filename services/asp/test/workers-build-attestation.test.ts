import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DeploymentLifecycle, type BuildAttestation } from "../src/deployment-info";
import { BUNDLED_ATTESTATION, bundledAttestation, isAttestedForArming } from "../src/workers/build-attestation";

/**
 * The Workers attestation path.
 *
 * The property under test is not "a field is populated". It is that a deployment which cannot prove
 * which commit it is says so, rather than guessing — because on 2026-07-29 a build failed, an older
 * container kept serving, and spending authority was granted on the assumption that new code was live.
 */

const DISARMED: NodeJS.ProcessEnv = {};

const ATTESTED: BuildAttestation = {
  commit: "a".repeat(40),
  branch: "main",
  builtAt: "2026-08-06T12:00:00.000Z",
  source: "clean-git-export",
};

describe("the Workers lifecycle reads its attestation from the bundle, never from disk", () => {
  test("an attested bundle reports its commit, branch and build time truthfully", () => {
    const lifecycle = new DeploymentLifecycle(DISARMED, "2026-08-06T12:00:01.000Z", undefined, () => ATTESTED);
    const info = lifecycle.snapshot();

    assert.equal(info.attested, true);
    assert.equal(info.commit, ATTESTED.commit);
    assert.equal(info.commitShort, "aaaaaaa");
    assert.equal(info.branch, "main");
    assert.equal(info.builtAt, "2026-08-06T12:00:00.000Z");
  });

  test("an unattested bundle says so rather than inventing a commit", () => {
    const lifecycle = new DeploymentLifecycle(DISARMED, "2026-08-06T12:00:01.000Z", undefined, () => null);
    const info = lifecycle.snapshot();

    assert.equal(info.attested, false);
    assert.equal(info.commit, null, "an absent attestation must never be filled in with a guess");
    assert.equal(info.commitShort, null);
    assert.equal(info.branch, null);
    assert.equal(info.builtAt, null);
  });

  /**
   * The source is a function, so nothing in the Worker path can reach a filesystem. If this ever
   * regressed to the fs walk, the Worker would throw on the first health check instead of answering.
   */
  test("the injected source is consulted and the filesystem walk is not", () => {
    let calls = 0;
    const lifecycle = new DeploymentLifecycle(DISARMED, undefined, undefined, () => {
      calls += 1;
      return ATTESTED;
    });
    lifecycle.snapshot();
    lifecycle.snapshot();
    assert.equal(calls, 2, "every snapshot asks the bundle, and only the bundle");
  });

  test("the health answer stays truthful while the process is still starting", () => {
    const lifecycle = new DeploymentLifecycle(DISARMED, undefined, undefined, () => ATTESTED);
    assert.equal(lifecycle.snapshot().phase, "STARTING");
    assert.equal(lifecycle.isReady(), false, "an attested build is still not a ready one");

    lifecycle.recordSchema("035_wallet_scope_downgrade.sql", true);
    lifecycle.markReady("2026-08-06T12:00:05.000Z");

    const ready = lifecycle.snapshot();
    assert.equal(ready.phase, "READY");
    assert.equal(ready.migrationVersion, "035_wallet_scope_downgrade.sql");
    assert.equal(ready.readyAt, "2026-08-06T12:00:05.000Z");
  });

  test("a failed gate stays failed even if something later marks it ready", () => {
    const lifecycle = new DeploymentLifecycle(DISARMED, undefined, undefined, () => ATTESTED);
    lifecycle.markFailed("schema behind the bundle");
    lifecycle.markReady();

    const info = lifecycle.snapshot();
    assert.equal(info.phase, "FAILED");
    assert.equal(info.failureReason, "schema behind the bundle");
    assert.equal(lifecycle.isReady(), false);
  });
});

describe("the committed placeholder is unattested, and arming depends on it", () => {
  /**
   * If this ever fails, somebody committed a real attestation to the branch. That value describes one
   * deployment, so on the branch it is a claim about code that is no longer running anywhere.
   */
  test("the checked-in bundle carries no attestation", () => {
    assert.equal(BUNDLED_ATTESTATION, null, "a real attestation must never be committed");
    assert.equal(bundledAttestation(), null);
  });

  test("an unattested bundle is refused arming, which is a separate question from health", () => {
    assert.equal(isAttestedForArming(), false);

    // Health is still answerable — the Worker serves; it just cannot prove which commit it is.
    const lifecycle = new DeploymentLifecycle(DISARMED, undefined, undefined, bundledAttestation);
    lifecycle.markReady();
    assert.equal(lifecycle.isReady(), true, "unattested and healthy are compatible");
    assert.equal(lifecycle.snapshot().attested, false, "and the snapshot still says it cannot prove itself");
  });
});
