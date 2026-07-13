import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import {
  InMemoryPolicyRepo,
  PolicyService,
  type MutateResult,
  type OnchainPolicy,
  type PolicyRegistryChain,
  type RegisterResult,
} from "@untch/policy-store";
import { encodePacked, getAddress, keccak256, type Address, type Hex } from "viem";
import {
  handleCreateSpendPolicy,
  handlePausePolicy,
  handleResumePolicy,
  handleUpdatePolicy,
} from "../src/policy-handlers";

/**
 * Unit tests for the operator policy tools. A fake PolicyRegistry reproduces the real §10.1 behaviour
 * (keccak-derived policyId, per-owner nonce, owner-gating, pause/resume reverts) with no RPC, so the
 * real PolicyService logic (canon hashing + Postgres sync) is exercised end-to-end offline.
 */

const OWNER = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
const AGENT = getAddress("0x000000000000000000000000000000000000A9E7");

function deriveId(owner: Address, nonce: bigint): bigint {
  return BigInt(keccak256(encodePacked(["address", "uint256"], [owner, nonce])));
}

class FakeChain implements PolicyRegistryChain {
  readonly ownerAddress = OWNER;
  readonly registryAddress = getAddress("0xe1d74c90801db0fa806c72eb818b7671b8233532");
  readonly chainId = 1952;
  private nonce = 0n;
  private block = 100;
  private readonly rows = new Map<string, { hash: Hex; expiry: bigint; version: number; status: number }>();
  readonly notOwned = new Set<string>();

  private tx(tag: string): Hex {
    return keccak256(encodePacked(["string", "uint256"], [tag, BigInt(this.block)]));
  }
  async nextPolicyId(): Promise<bigint> {
    return deriveId(this.ownerAddress, this.nonce);
  }
  async register(_agent: Address, policyHash: Hex, expiry: bigint): Promise<RegisterResult> {
    const id = deriveId(this.ownerAddress, this.nonce);
    this.nonce += 1n;
    this.block += 1;
    this.rows.set(id.toString(), { hash: policyHash, expiry, version: 1, status: 1 });
    return { policyId: id, txHash: this.tx(`reg:${id}`), blockNumber: this.block, version: 1 };
  }
  private owned(policyId: bigint) {
    const key = policyId.toString();
    if (this.notOwned.has(key)) throw new Error(`NotPolicyOwner(${key})`);
    const row = this.rows.get(key);
    if (!row) throw new Error(`PolicyNotFound(${key})`);
    return row;
  }
  async update(policyId: bigint, hash: Hex, expiry: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    row.hash = hash;
    row.expiry = expiry;
    row.version += 1;
    this.block += 1;
    return { txHash: this.tx(`upd:${policyId}`), blockNumber: this.block, version: row.version };
  }
  async pause(policyId: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    if (row.status !== 1) throw new Error(`PolicyNotActive(${policyId})`);
    row.status = 2;
    this.block += 1;
    return { txHash: this.tx(`pause:${policyId}`), blockNumber: this.block, version: row.version };
  }
  async resume(policyId: bigint): Promise<MutateResult> {
    const row = this.owned(policyId);
    if (row.status !== 2) throw new Error(`PolicyNotPaused(${policyId})`);
    row.status = 1;
    this.block += 1;
    return { txHash: this.tx(`resume:${policyId}`), blockNumber: this.block, version: row.version };
  }
  async getPolicy(policyId: bigint): Promise<OnchainPolicy> {
    const row = this.owned(policyId);
    return { owner: OWNER, agent: AGENT, policyHash: row.hash, status: row.status, expiry: row.expiry, version: row.version };
  }
}

function baseRules(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    budgets: { daily: 25, token: "USDT" },
    perCallCap: 1.0,
    onPerCallCapExceeded: "ESCALATE",
    escalateAbove: 5.0,
    categories: { allow: ["market-data"], deny: [] },
    recipients: { allow: [], deny: [] },
    agents: { allowWorkerIds: [], denyWorkerIds: [] },
    duplicates: { ttlMin: 60, keys: ["taskHash"] },
    cooldowns: { sameServiceMin: 5 },
    rateLimit: { callsPerHour: 40 },
    expiry: "2026-12-31T00:00:00Z",
    ...overrides,
  };
}

function makeDeps(): { service: PolicyService; chain: FakeChain; repo: InMemoryPolicyRepo } {
  const repo = new InMemoryPolicyRepo();
  const chain = new FakeChain();
  return { service: new PolicyService(repo, chain), chain, repo };
}

// ── create_spend_policy ───────────────────────────────────────────────────────

test("create_spend_policy: valid → 200 {policyId, policyHash, tx}", async () => {
  const { service } = makeDeps();
  const res = await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service });
  assert.equal(res.status, 200);
  const body = res.body as { policyId: string; policyHash: string; tx: string; version: number };
  assert.equal(body.policyId, deriveId(OWNER, 0n).toString());
  assert.equal(body.policyHash, hashCanonicalJson(baseRules()));
  assert.match(body.tx, /^0x[0-9a-f]{64}$/);
  assert.equal(body.version, 1);
});

test("create_spend_policy: no signer configured → 503", async () => {
  const res = await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service: null });
  assert.equal(res.status, 503);
  assert.equal((res.body as { code: string }).code, "POLICY_SIGNER_NOT_CONFIGURED");
});

test("create_spend_policy: missing agent → 400 AGENT_REQUIRED", async () => {
  const { service } = makeDeps();
  const res = await handleCreateSpendPolicy({ rules: baseRules() }, { service });
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "AGENT_REQUIRED");
});

test("create_spend_policy: missing rules → 400 RULES_REQUIRED", async () => {
  const { service } = makeDeps();
  const res = await handleCreateSpendPolicy({ agent: AGENT }, { service });
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "RULES_REQUIRED");
});

test("create_spend_policy: malformed rules → 400 POLICY_RULES_MALFORMED", async () => {
  const { service } = makeDeps();
  const res = await handleCreateSpendPolicy(
    { agent: AGENT, rules: baseRules({ perCallCap: "lots" }) },
    { service },
  );
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_RULES_MALFORMED");
});

// ── update_policy ─────────────────────────────────────────────────────────────

test("update_policy: valid → 200 with a version bump", async () => {
  const { service } = makeDeps();
  const created = (await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service })).body as { policyId: string };
  const res = await handleUpdatePolicy(
    { policyId: created.policyId, rules: baseRules({ perCallCap: 3.0 }) },
    { service },
  );
  assert.equal(res.status, 200);
  const body = res.body as { version: number; policyHash: string };
  assert.equal(body.version, 2);
  assert.equal(body.policyHash, hashCanonicalJson(baseRules({ perCallCap: 3.0 })));
});

test("update_policy: unknown policyId → 404 POLICY_NOT_FOUND", async () => {
  const { service } = makeDeps();
  const res = await handleUpdatePolicy({ policyId: "424242", rules: baseRules() }, { service });
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "POLICY_NOT_FOUND");
});

test("update_policy: operator does not own the policy → 502 ONCHAIN_ERROR (NotPolicyOwner)", async () => {
  const { service, chain } = makeDeps();
  const created = (await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service })).body as { policyId: string };
  chain.notOwned.add(created.policyId);
  const res = await handleUpdatePolicy({ policyId: created.policyId, rules: baseRules({ perCallCap: 9 }) }, { service });
  assert.equal(res.status, 502);
  assert.equal((res.body as { code: string }).code, "ONCHAIN_ERROR");
  assert.match((res.body as { message: string }).message, /NotPolicyOwner/);
});

test("update_policy: missing policyId → 400 POLICY_ID_REQUIRED", async () => {
  const { service } = makeDeps();
  const res = await handleUpdatePolicy({ rules: baseRules() }, { service });
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_ID_REQUIRED");
});

// ── pause_policy / resume_policy ──────────────────────────────────────────────

test("pause_policy: valid → 200 PAUSED; double pause → 502 ONCHAIN_ERROR (PolicyNotActive)", async () => {
  const { service } = makeDeps();
  const created = (await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service })).body as { policyId: string };

  const paused = await handlePausePolicy({ policyId: created.policyId }, { service });
  assert.equal(paused.status, 200);
  assert.equal((paused.body as { status: string }).status, "PAUSED");

  const again = await handlePausePolicy({ policyId: created.policyId }, { service });
  assert.equal(again.status, 502);
  assert.match((again.body as { message: string }).message, /PolicyNotActive/);
});

test("resume_policy: PAUSED → 200 ACTIVE", async () => {
  const { service } = makeDeps();
  const created = (await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, { service })).body as { policyId: string };
  await handlePausePolicy({ policyId: created.policyId }, { service });
  const res = await handleResumePolicy({ policyId: created.policyId }, { service });
  assert.equal(res.status, 200);
  assert.equal((res.body as { status: string }).status, "ACTIVE");
});

test("pause_policy: unknown policyId → 404 POLICY_NOT_FOUND", async () => {
  const { service } = makeDeps();
  const res = await handlePausePolicy({ policyId: "999" }, { service });
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "POLICY_NOT_FOUND");
});
