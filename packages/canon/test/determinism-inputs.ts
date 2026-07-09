import type { SpendIntent } from "../src/spendIntent";

/**
 * Fixed inputs shared by the determinism test and its child process, so both hash byte-identical
 * values. Not a `*.test.ts` file, so the runner does not collect it as a suite.
 */

export const FIXED_JSON = {
  canonVersion: 1,
  policyId: "12",
  budgets: { daily: "25000000", weekly: "120000000", token: "USDT" },
  categories: { allow: ["market-data", "research", "security"], deny: [] },
  note: "unicode: é 😀 — order/escaping must be stable",
  expiry: "2026-12-31T00:00:00Z",
} as const;

export const FIXED_INTENT: SpendIntent = {
  owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  buyerAgentId: 1001n,
  workerAgentId: 2002n,
  token: "0x1e4a5963abfd975d8c9021ce480b42188849d41d",
  maxAmount: 5000000n,
  taskHash: "0x1a2b3c4d5e6f70819293a4b5c6d7e8f9000102030405060708090a0b0c0d0e0f",
  acceptanceHash: "0xf0e0d0c0b0a0908070605040302010ff112233445566778899aabbccddeeff00",
  schemaHash: "0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
  policyHash: "0xdeadbeefcafebabefeedface0badc0de123456789abcdef00fedcba987654321",
  deadline: 1893456000n,
  nonce: 42n,
};
