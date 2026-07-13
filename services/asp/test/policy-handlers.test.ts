import assert from "node:assert/strict";
import { test } from "node:test";
import { X_LAYER_TESTNET_ID } from "@untch/shared";
import { hashCanonicalJson } from "@untch/canon";
import {
  InMemoryPolicyRepo,
  POLICY_REGISTRY_ABI,
  PolicyRegistrationService,
  PolicyService,
  type MutateResult,
  type OnchainPolicy,
  type OnchainRegistration,
  type PolicyRegistryChain,
  type RegisterCall,
  type RegisterResult,
} from "@untch/policy-store";
import { encodeFunctionData, encodePacked, getAddress, keccak256, type Address, type Hex } from "viem";
import {
  handleCreateSpendPolicy,
  handlePausePolicy,
  handleResumePolicy,
  handleSyncPolicyRegistration,
  handleUpdatePolicy,
  type PolicyToolDeps,
} from "../src/policy-handlers";

/**
 * Unit tests for the operator policy tools. A fake PolicyRegistry reproduces the real §10.1 behaviour
 * (keccak-derived policyId, per-CALLER nonce, owner-gating) with no RPC. This is where Part 1 is pinned:
 * `create_spend_policy` no longer signs — it returns unsigned calldata; `sync_policy_registration` records
 * the row with the owner read from the confirmed event; two distinct callers end up as two distinct owners.
 */

const OPERATOR = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
const AGENT = getAddress("0x000000000000000000000000000000000000A9E7");
const CALLER_A = getAddress("0xaAAa000000000000000000000000000000000001");
const CALLER_B = getAddress("0xBbbB000000000000000000000000000000000002");

function deriveId(owner: Address, nonce: bigint): bigint {
  return BigInt(keccak256(encodePacked(["address", "uint256"], [getAddress(owner), nonce])));
}

interface Row {
  hash: Hex;
  expiry: bigint;
  version: number;
  status: number;
  owner: Address;
  agent: Address;
}

class FakeChain implements PolicyRegistryChain {
  readonly ownerAddress = OPERATOR;
  readonly registryAddress = getAddress("0xe1d74c90801db0fa806c72eb818b7671b8233532");
  readonly chainId = X_LAYER_TESTNET_ID;
  private block = 100;
  private readonly nonces = new Map<string, bigint>();
  private readonly rows = new Map<string, Row>();
  private readonly registrations = new Map<Hex, OnchainRegistration>();
  readonly notOwned = new Set<string>();

  private tx(tag: string): Hex {
    return keccak256(encodePacked(["string", "uint256"], [tag, BigInt(this.block)]));
  }
  private nonceOf(owner: Address): bigint {
    return this.nonces.get(getAddress(owner)) ?? 0n;
  }
  async nextPolicyId(): Promise<bigint> {
    return deriveId(this.ownerAddress, this.nonceOf(this.ownerAddress));
  }
  buildRegister(agent: Address, policyHash: Hex, expiry: bigint): RegisterCall {
    const args = [getAddress(agent), policyHash, expiry] as const;
    return {
      to: this.registryAddress,
      abi: POLICY_REGISTRY_ABI,
      functionName: "registerPolicy",
      args,
      calldata: encodeFunctionData({ abi: POLICY_REGISTRY_ABI, functionName: "registerPolicy", args }),
      chainId: this.chainId,
    };
  }
  /** Model a CALLER's own wallet submitting the unsigned call — caller becomes owner. */
  submitRegister(caller: Address, agent: Address, policyHash: Hex, expiry: bigint): Hex {
    const owner = getAddress(caller);
    const nonce = this.nonceOf(owner);
    const id = deriveId(owner, nonce);
    this.nonces.set(owner, nonce + 1n);
    this.block += 1;
    const txHash = this.tx(`reg:${id}`);
    this.rows.set(id.toString(), { hash: policyHash, expiry, version: 1, status: 1, owner, agent: getAddress(agent) });
    this.registrations.set(txHash, {
      policyId: id,
      owner,
      agent: getAddress(agent),
      policyHash,
      expiry,
      version: 1,
      txHash,
      blockNumber: this.block,
    });
    return txHash;
  }
  async getRegistrationFromReceipt(txHash: Hex): Promise<OnchainRegistration> {
    const reg = this.registrations.get(txHash);
    if (!reg) throw new Error(`tx ${txHash} has no PolicyRegistered event`);
    return reg;
  }
  async register(agent: Address, policyHash: Hex, expiry: bigint): Promise<RegisterResult> {
    const txHash = this.submitRegister(this.ownerAddress, agent, policyHash, expiry);
    const reg = await this.getRegistrationFromReceipt(txHash);
    return { policyId: reg.policyId, txHash, blockNumber: reg.blockNumber, version: 1 };
  }
  private owned(policyId: bigint): Row {
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
    return { owner: row.owner, agent: row.agent, policyHash: row.hash, status: row.status, expiry: row.expiry, version: row.version };
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

function makeDeps(): { deps: PolicyToolDeps; chain: FakeChain; repo: InMemoryPolicyRepo } {
  const repo = new InMemoryPolicyRepo();
  const chain = new FakeChain();
  const deps: PolicyToolDeps = {
    registration: new PolicyRegistrationService(repo, chain),
    service: new PolicyService(repo, chain),
  };
  return { deps, chain, repo };
}

// ── create_spend_policy — now BUILDS unsigned calldata (breaking change) ─────────

test("create_spend_policy: valid → 200 unsignedTx {registerPolicy calldata, policyHash}, NO tx/owner", async () => {
  const { deps } = makeDeps();
  const res = await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules() }, deps);
  assert.equal(res.status, 200);
  const body = res.body as {
    policyHash: string;
    unsignedTx: { functionName: string; calldata: string; args: string[]; to: string };
    signer: string;
    policyId?: string;
    tx?: string;
  };
  assert.equal(body.unsignedTx.functionName, "registerPolicy");
  assert.equal(body.policyHash, hashCanonicalJson(baseRules()));
  assert.equal(getAddress(body.unsignedTx.args[0] as Address), AGENT);
  assert.match(body.unsignedTx.calldata, /^0x[0-9a-f]+$/);
  assert.equal(body.signer, "CALLER");
  assert.equal(body.policyId, undefined, "no policyId until the caller submits + syncs");
  assert.equal(body.tx, undefined, "the backend broadcast nothing");
});

test("create_spend_policy: no store configured → 503 POLICY_STORE_NOT_CONFIGURED", async () => {
  const res = await handleCreateSpendPolicy(
    { agent: AGENT, rules: baseRules() },
    { registration: null, service: null },
  );
  assert.equal(res.status, 503);
  assert.equal((res.body as { code: string }).code, "POLICY_STORE_NOT_CONFIGURED");
});

test("create_spend_policy: missing agent → 400 AGENT_REQUIRED", async () => {
  const { deps } = makeDeps();
  const res = await handleCreateSpendPolicy({ rules: baseRules() }, deps);
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "AGENT_REQUIRED");
});

test("create_spend_policy: missing rules → 400 RULES_REQUIRED", async () => {
  const { deps } = makeDeps();
  const res = await handleCreateSpendPolicy({ agent: AGENT }, deps);
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "RULES_REQUIRED");
});

test("create_spend_policy: malformed rules → 400 POLICY_RULES_MALFORMED", async () => {
  const { deps } = makeDeps();
  const res = await handleCreateSpendPolicy({ agent: AGENT, rules: baseRules({ perCallCap: "lots" }) }, deps);
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "POLICY_RULES_MALFORMED");
});

// ── sync_policy_registration — records the row from the caller's confirmed tx ─────

test("sync_policy_registration: records the row with the owner from the confirmed event", async () => {
  const { deps, chain } = makeDeps();
  const rules = baseRules();
  const built = (await handleCreateSpendPolicy({ agent: AGENT, rules }, deps)).body as { policyHash: Hex; expiry: number };
  const txHash = chain.submitRegister(CALLER_A, AGENT, built.policyHash, BigInt(built.expiry));

  const res = await handleSyncPolicyRegistration({ txHash, rules }, deps);
  assert.equal(res.status, 200);
  const body = res.body as { policyId: string; owner: string; tx: string; alreadyStored: boolean };
  assert.equal(getAddress(body.owner as Address), CALLER_A);
  assert.equal(body.policyId, deriveId(CALLER_A, 0n).toString());
  assert.equal(body.tx, txHash);
  assert.equal(body.alreadyStored, false);
});

test("two DIFFERENT callers each create a policy → two DIFFERENT on-chain owners (not the same wallet twice)", async () => {
  const { deps, chain, repo } = makeDeps();
  const rules = baseRules();
  const built = (await handleCreateSpendPolicy({ agent: AGENT, rules }, deps)).body as { policyHash: Hex; expiry: number };

  const txA = chain.submitRegister(CALLER_A, AGENT, built.policyHash, BigInt(built.expiry));
  const txB = chain.submitRegister(CALLER_B, AGENT, built.policyHash, BigInt(built.expiry));
  const a = (await handleSyncPolicyRegistration({ txHash: txA, rules }, deps)).body as { policyId: string; owner: string };
  const b = (await handleSyncPolicyRegistration({ txHash: txB, rules }, deps)).body as { policyId: string; owner: string };

  assert.equal(getAddress(a.owner as Address), CALLER_A);
  assert.equal(getAddress(b.owner as Address), CALLER_B);
  assert.notEqual(getAddress(a.owner as Address), getAddress(b.owner as Address));
  assert.notEqual(a.policyId, b.policyId);
  // durable rows carry the real, distinct owners
  assert.equal(getAddress((await repo.getById(a.policyId))!.owner), CALLER_A);
  assert.equal(getAddress((await repo.getById(b.policyId))!.owner), CALLER_B);
});

test("sync_policy_registration: missing txHash → 400 TX_HASH_REQUIRED", async () => {
  const { deps } = makeDeps();
  const res = await handleSyncPolicyRegistration({ rules: baseRules() }, deps);
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "TX_HASH_REQUIRED");
});

test("sync_policy_registration: rules not matching the anchored hash → 400 RULES_HASH_MISMATCH", async () => {
  const { deps, chain } = makeDeps();
  const rules = baseRules();
  const built = (await handleCreateSpendPolicy({ agent: AGENT, rules }, deps)).body as { policyHash: Hex; expiry: number };
  const txHash = chain.submitRegister(CALLER_A, AGENT, built.policyHash, BigInt(built.expiry));

  const res = await handleSyncPolicyRegistration({ txHash, rules: baseRules({ perCallCap: 9 }) }, deps);
  assert.equal(res.status, 400);
  assert.equal((res.body as { code: string }).code, "RULES_HASH_MISMATCH");
});

// ── update_policy / pause_policy / resume_policy — still operator-signed (unchanged) ─────

/** Seed an operator-owned policy directly (the legacy server-signing path) so update/pause have a target. */
async function seedOperatorPolicy(deps: PolicyToolDeps): Promise<string> {
  const created = await deps.service!.createPolicy({ agent: AGENT, rules: baseRules() });
  return created.policyId;
}

test("update_policy: valid → 200 with a version bump", async () => {
  const { deps } = makeDeps();
  const policyId = await seedOperatorPolicy(deps);
  const res = await handleUpdatePolicy({ policyId, rules: baseRules({ perCallCap: 3.0 }) }, deps);
  assert.equal(res.status, 200);
  const body = res.body as { version: number; policyHash: string };
  assert.equal(body.version, 2);
  assert.equal(body.policyHash, hashCanonicalJson(baseRules({ perCallCap: 3.0 })));
});

test("update_policy: no signer configured → 503 POLICY_SIGNER_NOT_CONFIGURED", async () => {
  const { deps } = makeDeps();
  const policyId = await seedOperatorPolicy(deps);
  const res = await handleUpdatePolicy({ policyId, rules: baseRules() }, { registration: deps.registration, service: null });
  assert.equal(res.status, 503);
  assert.equal((res.body as { code: string }).code, "POLICY_SIGNER_NOT_CONFIGURED");
});

test("update_policy: unknown policyId → 404 POLICY_NOT_FOUND", async () => {
  const { deps } = makeDeps();
  const res = await handleUpdatePolicy({ policyId: "424242", rules: baseRules() }, deps);
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "POLICY_NOT_FOUND");
});

test("update_policy: operator does not own the policy → 502 ONCHAIN_ERROR (NotPolicyOwner)", async () => {
  const { deps, chain } = makeDeps();
  const policyId = await seedOperatorPolicy(deps);
  chain.notOwned.add(policyId);
  const res = await handleUpdatePolicy({ policyId, rules: baseRules({ perCallCap: 9 }) }, deps);
  assert.equal(res.status, 502);
  assert.equal((res.body as { code: string }).code, "ONCHAIN_ERROR");
  assert.match((res.body as { message: string }).message, /NotPolicyOwner/);
});

test("pause_policy: valid → 200 PAUSED; double pause → 502 ONCHAIN_ERROR (PolicyNotActive)", async () => {
  const { deps } = makeDeps();
  const policyId = await seedOperatorPolicy(deps);
  const paused = await handlePausePolicy({ policyId }, deps);
  assert.equal(paused.status, 200);
  assert.equal((paused.body as { status: string }).status, "PAUSED");

  const again = await handlePausePolicy({ policyId }, deps);
  assert.equal(again.status, 502);
  assert.match((again.body as { message: string }).message, /PolicyNotActive/);
});

test("resume_policy: PAUSED → 200 ACTIVE", async () => {
  const { deps } = makeDeps();
  const policyId = await seedOperatorPolicy(deps);
  await handlePausePolicy({ policyId }, deps);
  const res = await handleResumePolicy({ policyId }, deps);
  assert.equal(res.status, 200);
  assert.equal((res.body as { status: string }).status, "ACTIVE");
});

test("pause_policy: unknown policyId → 404 POLICY_NOT_FOUND", async () => {
  const { deps } = makeDeps();
  const res = await handlePausePolicy({ policyId: "999" }, deps);
  assert.equal(res.status, 404);
  assert.equal((res.body as { code: string }).code, "POLICY_NOT_FOUND");
});
