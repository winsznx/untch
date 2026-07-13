import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import { getAddress, type Address } from "viem";
import { InMemoryPolicyRepo } from "../src/repo-memory";
import { PolicyRegistrationService } from "../src/registration";
import { PolicyValidationError } from "../src/rules";
import { derivePolicyId, FakeChain, sampleRules } from "./helpers";

/**
 * Per-caller `create_spend_policy` — the point of Part 1: the backend NEVER signs. `buildCreate` returns
 * unsigned calldata; the caller's OWN wallet submits it; `syncRegistration` records the row with `owner`
 * taken from the confirmed on-chain event. Two distinct callers therefore end up as two distinct owners —
 * proven here with a fake chain (no RPC) that models per-caller nonces + submission.
 */

const AGENT: Address = getAddress("0x000000000000000000000000000000000000A9E7");
const CALLER_A: Address = getAddress("0xaaaa000000000000000000000000000000000001");
const CALLER_B: Address = getAddress("0xBBBb000000000000000000000000000000000002");

function makeService(): { service: PolicyRegistrationService; chain: FakeChain; repo: InMemoryPolicyRepo } {
  const repo = new InMemoryPolicyRepo();
  const chain = new FakeChain();
  return { service: new PolicyRegistrationService(repo, chain), chain, repo };
}

test("buildCreate returns UNSIGNED registerPolicy calldata + the canonical hash — never signs", async () => {
  // #given a registration service (holds no key)
  const { service } = makeService();
  const rules = sampleRules();

  // #when the tool builds a create
  const built = service.buildCreate({ agent: AGENT, rules });

  // #then it is the unsigned registerPolicy call, hash = canon over the rules, no tx / no owner
  assert.equal(built.unsignedTx.functionName, "registerPolicy");
  assert.equal(getAddress(built.unsignedTx.to), getAddress(built.registry));
  assert.equal(built.policyHash, hashCanonicalJson(rules));
  assert.equal(getAddress(built.unsignedTx.args[0]), AGENT);
  assert.equal(built.unsignedTx.args[1], built.policyHash);
  assert.match(built.unsignedTx.calldata, /^0x[0-9a-f]+$/);
  assert.equal(built.unsignedTx.value, "0x0");
  assert.equal((built as unknown as { owner?: unknown }).owner, undefined, "no owner exists yet");
});

test("two distinct callers → two distinct on-chain owners (synced from the event, not assumed)", async () => {
  // #given a built create for the same agent + rules
  const { service, chain, repo } = makeService();
  const rules = sampleRules();
  const built = service.buildCreate({ agent: AGENT, rules });
  const expiry = BigInt(built.expiry);

  // #when caller A signs+submits with its OWN wallet, then syncs
  const txA = chain.submitRegister(CALLER_A, AGENT, built.policyHash, expiry);
  const a = await service.syncRegistration({ txHash: txA, rules });

  // #and caller B does the same with a DIFFERENT wallet
  const txB = chain.submitRegister(CALLER_B, AGENT, built.policyHash, expiry);
  const b = await service.syncRegistration({ txHash: txB, rules });

  // #then each ends up as the genuine, DISTINCT owner it submitted with — not the same wallet twice
  assert.equal(getAddress(a.owner), CALLER_A);
  assert.equal(getAddress(b.owner), CALLER_B);
  assert.notEqual(getAddress(a.owner), getAddress(b.owner));

  // #and the policyIds are the on-chain-derived keccak(owner,nonce) for each distinct owner
  assert.equal(a.policyId, derivePolicyId(CALLER_A, 0n).toString());
  assert.equal(b.policyId, derivePolicyId(CALLER_B, 0n).toString());
  assert.notEqual(a.policyId, b.policyId);

  // #and the durable rows carry the real owners
  assert.equal(getAddress((await repo.getById(a.policyId))!.owner), CALLER_A);
  assert.equal(getAddress((await repo.getById(b.policyId))!.owner), CALLER_B);
});

test("syncRegistration rejects rules that don't hash to the anchored policyHash (binding integrity)", async () => {
  // #given a policy registered with one ruleset
  const { service, chain } = makeService();
  const rules = sampleRules();
  const built = service.buildCreate({ agent: AGENT, rules });
  const txA = chain.submitRegister(CALLER_A, AGENT, built.policyHash, BigInt(built.expiry));

  // #when a caller tries to sync DIFFERENT rules against that tx
  const tampered = sampleRules({ perCallCap: 999 });

  // #then it is rejected — the stored ruleset must match what the chain committed
  await assert.rejects(
    () => service.syncRegistration({ txHash: txA, rules: tampered }),
    (err: unknown) => err instanceof PolicyValidationError && err.code === "RULES_HASH_MISMATCH",
  );
});

test("syncRegistration is idempotent — a re-sync returns alreadyStored without duplicating", async () => {
  // #given a synced registration
  const { service, chain } = makeService();
  const rules = sampleRules();
  const built = service.buildCreate({ agent: AGENT, rules });
  const txA = chain.submitRegister(CALLER_A, AGENT, built.policyHash, BigInt(built.expiry));
  const first = await service.syncRegistration({ txHash: txA, rules });
  assert.equal(first.alreadyStored, false);

  // #when the same tx is synced again
  const again = await service.syncRegistration({ txHash: txA, rules });

  // #then it is a no-op that reports the row already existed
  assert.equal(again.alreadyStored, true);
  assert.equal(again.policyId, first.policyId);
  assert.equal(getAddress(again.owner), CALLER_A);
});
