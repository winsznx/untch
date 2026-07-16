import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ERC8004_AGENT_REGISTRY,
  ERC8004_REGISTRATION_TYPE,
} from "../src/erc8004/constants";
import { buildRegistrationCard } from "../src/erc8004/registration-card";

test("registration card has required ERC-8004 fields", () => {
  const card = buildRegistrationCard({
    baseUrl: "https://asp.untch.xyz",
    payTo: "0x98F43eABcaD380f4f1F0587aE945Bc8c79E43c0b",
    agentId: null,
  });
  assert.equal(card.type, ERC8004_REGISTRATION_TYPE);
  assert.ok(card.name.length > 0);
  assert.ok(card.description.length > 40);
  assert.match(card.image, /^https:\/\//);
  assert.equal(card.x402Support, true);
  assert.equal(card.active, false);
  assert.deepEqual(card.registrations, []);
  assert.ok(card.services.length >= 6);
  assert.ok(card.services.some((s) => s.name === "OASF"));
  assert.ok(card.services.some((s) => s.endpoint.includes("preflight_payment")));
  assert.ok(card.services.some((s) => s.endpoint.includes("brand_pack")));
  assert.ok(card.supportedTrust.includes("reputation"));
});

test("registration card fills registrations after agentId", () => {
  const card = buildRegistrationCard({
    baseUrl: "https://asp.untch.xyz",
    agentId: 42,
  });
  assert.equal(card.active, true);
  assert.deepEqual(card.registrations, [
    { agentId: 42, agentRegistry: ERC8004_AGENT_REGISTRY },
  ]);
});
