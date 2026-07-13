import assert from "node:assert/strict";
import { test } from "node:test";
import { hashCanonicalJson } from "@untch/canon";
import {
  buildPausePolicy,
  buildRegisterPolicy,
  buildResumePolicy,
  buildUpdatePolicy,
  computePolicyHash,
  expiryToUnix,
  type PolicyRules,
} from "../lib/chain/policy-tx";
import { POLICY_REGISTRY } from "../lib/chain/contracts";

const RULES: PolicyRules = {
  budgets: { daily: 25, token: "USDT" },
  perCallCap: 10,
  onPerCallCapExceeded: "BLOCK",
  escalateAbove: 5,
  categories: { allow: ["market-data", "security", "research"], deny: [] },
  recipients: { allow: [], deny: [] },
  agents: { allowWorkerIds: [], denyWorkerIds: [] },
  duplicates: { ttlMin: 60, keys: ["taskHash", "endpoint", "paramsHash"] },
  cooldowns: { sameServiceMin: 5 },
  rateLimit: { callsPerHour: 40 },
  expiry: "2027-01-31T00:00:00Z",
};

const AGENT = "0x000000000000000000000000000000000000A9E7" as const;

test("computePolicyHash matches @untch/canon and is deterministic", () => {
  const direct = hashCanonicalJson(RULES as unknown as Record<string, unknown>);
  assert.equal(computePolicyHash(RULES), direct);
  assert.equal(computePolicyHash(RULES), computePolicyHash(RULES));
});

test("editing a rule changes the hash", () => {
  const edited: PolicyRules = { ...RULES, budgets: { daily: 50, token: "USDT" } };
  assert.notEqual(computePolicyHash(edited), computePolicyHash(RULES));
});

test("buildRegisterPolicy targets the real registry with the canon hash and unix expiry", () => {
  const { request, policyHash } = buildRegisterPolicy({ agent: AGENT, rules: RULES });
  assert.equal(request.address, POLICY_REGISTRY);
  assert.equal(request.functionName, "registerPolicy");
  assert.deepEqual(request.args, [AGENT, policyHash, expiryToUnix(RULES)]);
  assert.equal(policyHash, hashCanonicalJson(RULES as unknown as Record<string, unknown>));
});

test("expiryToUnix converts ISO to uint64 seconds", () => {
  assert.equal(expiryToUnix({ ...RULES, expiry: "2027-01-31T00:00:00Z" }), BigInt(Date.parse("2027-01-31T00:00:00Z") / 1000));
});

test("update carries the policyId and the new hash", () => {
  const { request, policyHash } = buildUpdatePolicy({ policyId: 42n, rules: RULES });
  assert.equal(request.functionName, "updatePolicy");
  assert.deepEqual(request.args, [42n, policyHash, expiryToUnix(RULES)]);
});

test("pause and resume carry only the policyId", () => {
  assert.deepEqual(buildPausePolicy(42n).args, [42n]);
  assert.equal(buildPausePolicy(42n).functionName, "pausePolicy");
  assert.deepEqual(buildResumePolicy(7n).args, [7n]);
  assert.equal(buildResumePolicy(7n).functionName, "resumePolicy");
});
