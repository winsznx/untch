import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import { getAddress } from "viem";
import { InMemoryPolicyRepo } from "../src/repo-memory";
import { PolicyNotFoundError, PolicyService } from "../src/service";
import { PolicyValidationError } from "../src/rules";
import { toEnginePolicy } from "../src/repo";
import { derivePolicyId, FakeChain, sampleRules } from "./helpers";

/**
 * Unit tests for PolicyService — real canon hashing + real id derivation + status transitions, with a
 * fake chain (exact §10.1 behaviour) and an in-memory repo. No RPC, no Postgres.
 */

const AGENT = getAddress("0x000000000000000000000000000000000000A9E7");
const OWNER = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");

function makeService(): { service: PolicyService; repo: InMemoryPolicyRepo; chain: FakeChain } {
  const repo = new InMemoryPolicyRepo();
  const chain = new FakeChain(OWNER);
  return { service: new PolicyService(repo, chain), repo, chain };
}

test("createPolicy: policyId IS the on-chain-derived keccak(owner,nonce), not a counter", async () => {
  const { service } = makeService();
  const rules = sampleRules();

  const res = await service.createPolicy({ agent: AGENT, rules });

  // #then the id equals uint256(keccak256(abi.encodePacked(owner, 0))) exactly.
  assert.equal(res.policyId, derivePolicyId(OWNER, 0n).toString());
  // #then the hash is canon's hashCanonicalJson over the submitted rules (reused, not reinvented).
  assert.equal(res.policyHash, hashCanonicalJson(rules));
  assert.equal(res.version, 1);
  assert.match(res.txHash, /^0x[0-9a-f]{64}$/);
});

test("createPolicy: second policy for the same owner uses nonce 1 (ids never collide)", async () => {
  const { service } = makeService();
  const a = await service.createPolicy({ agent: AGENT, rules: sampleRules() });
  const b = await service.createPolicy({ agent: AGENT, rules: sampleRules({ perCallCap: 2 }) });

  assert.equal(a.policyId, derivePolicyId(OWNER, 0n).toString());
  assert.equal(b.policyId, derivePolicyId(OWNER, 1n).toString());
  assert.notEqual(a.policyId, b.policyId);
});

test("createPolicy: stored row round-trips to a usable engine policy (extra §8 fields preserved)", async () => {
  const { service, repo } = makeService();
  // Include an extra §8 field the engine slice does NOT read — it must survive into storage + hash.
  const rules = sampleRules({ anchorIntentsAbove: 2.0, vendors: { deny: ["vendor_x"] } });

  const res = await service.createPolicy({ agent: AGENT, rules });
  const stored = await repo.getById(res.policyId);

  assert.ok(stored);
  assert.equal(stored.status, "ACTIVE");
  assert.equal((stored.rules as unknown as Record<string, unknown>).anchorIntentsAbove, 2.0);
  // #then the hash covers the extra fields (equals canon over the full submitted object).
  assert.equal(stored.policyHash, hashCanonicalJson(rules));
  const engine = toEnginePolicy(stored);
  assert.equal(engine.id, res.policyId);
  assert.equal(engine.status, "ACTIVE");
});

test("createPolicy: malformed rules → PolicyValidationError, nothing registered or stored", async () => {
  const { service, repo, chain } = makeService();
  await assert.rejects(
    () => service.createPolicy({ agent: AGENT, rules: sampleRules({ budgets: { token: "USDT" } }) }),
    (err: unknown) => err instanceof PolicyValidationError && err.code === "POLICY_RULES_MALFORMED",
  );
  // #then no on-chain nonce was consumed and no row was stored.
  assert.equal((await chain.nextPolicyId()).toString(), derivePolicyId(OWNER, 0n).toString());
  assert.equal((await repo.listByAgent(AGENT)).length, 0);
});

test("updatePolicy: bumps version + new hash on-chain and in the store", async () => {
  const { service, repo } = makeService();
  const created = await service.createPolicy({ agent: AGENT, rules: sampleRules() });

  const newRules = sampleRules({ perCallCap: 3.0, categories: { allow: ["logistics"], deny: [] } });
  const upd = await service.updatePolicy({ policyId: created.policyId, rules: newRules });

  assert.equal(upd.version, 2);
  assert.equal(upd.policyHash, hashCanonicalJson(newRules));
  const stored = await repo.getById(created.policyId);
  assert.equal(stored?.version, 2);
  assert.equal(stored?.policyHash, hashCanonicalJson(newRules));
  // #then the update tx is recorded as the row's latest on-chain reference.
  assert.equal(stored?.onchainRef.lastTx, upd.txHash);
});

test("updatePolicy: unknown policyId → PolicyNotFoundError (no chain call)", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.updatePolicy({ policyId: "123456789", rules: sampleRules() }),
    (err: unknown) => err instanceof PolicyNotFoundError,
  );
});

test("updatePolicy: operator does not own the policy → surfaces the on-chain revert", async () => {
  const { service, repo, chain } = makeService();
  const created = await service.createPolicy({ agent: AGENT, rules: sampleRules() });
  // #given the chain now rejects mutations to this id as NotPolicyOwner.
  chain.notOwned.add(created.policyId);

  await assert.rejects(
    () => service.updatePolicy({ policyId: created.policyId, rules: sampleRules({ perCallCap: 9 }) }),
    /NotPolicyOwner/,
  );
  // #then the store was NOT mutated (still version 1) — Postgres only syncs a CONFIRMED change.
  const stored = await repo.getById(created.policyId);
  assert.equal(stored?.version, 1);
});

test("pausePolicy: flips status to PAUSED; the paused policy is no longer engine-active", async () => {
  const { service, repo } = makeService();
  const created = await service.createPolicy({ agent: AGENT, rules: sampleRules() });

  const res = await service.pausePolicy(created.policyId);
  assert.equal(res.status, "PAUSED");
  const stored = await repo.getById(created.policyId);
  assert.equal(stored?.status, "PAUSED");
  // #then the engine mapping reflects PAUSED (which fail-closes preflight to BLOCKED_NO_ACTIVE_POLICY).
  assert.equal(toEnginePolicy(stored!).status, "PAUSED");
});

test("pausePolicy: double pause → on-chain revert (PolicyNotActive)", async () => {
  const { service } = makeService();
  const created = await service.createPolicy({ agent: AGENT, rules: sampleRules() });
  await service.pausePolicy(created.policyId);
  await assert.rejects(() => service.pausePolicy(created.policyId), /PolicyNotActive/);
});

test("pausePolicy: unknown policyId → PolicyNotFoundError", async () => {
  const { service } = makeService();
  await assert.rejects(
    () => service.pausePolicy("999"),
    (err: unknown) => err instanceof PolicyNotFoundError,
  );
});

test("resumePolicy: PAUSED → ACTIVE round-trips", async () => {
  const { service, repo } = makeService();
  const created = await service.createPolicy({ agent: AGENT, rules: sampleRules() });
  await service.pausePolicy(created.policyId);

  const res = await service.resumePolicy(created.policyId);
  assert.equal(res.status, "ACTIVE");
  assert.equal((await repo.getById(created.policyId))?.status, "ACTIVE");
});
