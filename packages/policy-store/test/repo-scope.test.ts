import assert from "node:assert/strict";
import { test } from "node:test";
import { getAddress, type Address, type Hex } from "viem";
import { InMemoryPolicyRepo } from "../src/repo-memory";
import type { StoredPolicy } from "../src/types";
import { sampleRules } from "./helpers";

/**
 * listByOwner is the dashboard's scoping bridge: a signed-in wallet (the on-chain registrant / `owner`) sees
 * ONLY its own policies, and the match is case-insensitive so a checksummed session address finds a stored
 * lowercased owner and vice versa. Same in-memory semantics the Postgres repo enforces with LOWER(owner).
 */

const OWNER_A = getAddress("0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b");
const OWNER_B = getAddress("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");

function policy(id: string, owner: Address, agentId: Address): StoredPolicy {
  const tx = ("0x" + "11".repeat(32)) as Hex;
  return {
    id,
    owner,
    agentId,
    version: 1,
    status: "ACTIVE",
    policyHash: ("0x" + "ab".repeat(32)) as Hex,
    expiry: 1_900_000_000,
    onchainRef: { chainId: 1952, registry: OWNER_A, registerTx: tx, registerBlock: 1, lastTx: tx, lastBlock: 1 },
    rules: sampleRules() as unknown as StoredPolicy["rules"],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

test("listByOwner returns only the owner's policies, case-insensitively", async () => {
  const repo = new InMemoryPolicyRepo();
  await repo.insert(policy("1", OWNER_A, getAddress("0x00000000000000000000000000000000000000A1")));
  await repo.insert(policy("2", OWNER_A, getAddress("0x00000000000000000000000000000000000000A2")));
  await repo.insert(policy("3", OWNER_B, getAddress("0x00000000000000000000000000000000000000B1")));

  assert.deepEqual((await repo.listByOwner(OWNER_A)).map((p) => p.id).sort(), ["1", "2"]);
  assert.equal((await repo.listByOwner(OWNER_A.toLowerCase())).length, 2);
  assert.deepEqual((await repo.listByOwner(OWNER_B)).map((p) => p.id), ["3"]);
  assert.equal((await repo.listByOwner("0x000000000000000000000000000000000000dEaD")).length, 0);
});
