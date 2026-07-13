import assert from "node:assert/strict";
import { test } from "node:test";
import { checkChallengeBinding } from "../src/binding";
import type { BindingField, ChallengeBinding } from "../src/types";

/**
 * Adversarial fuzz of the Challenge Binding Check (PRD §14).
 *
 * The property under test: given an AUTHORIZED binding, tampering ANY single field of the presented
 * challenge — not just the obviously-malicious ones — is caught as a terminal failure, with the right
 * field flagged and the right code (nonce/expiry ⇒ BLOCKED_REPLAY, everything else ⇒ REJECTED_BINDING).
 * Every field is swapped independently and every case asserted.
 */

const AUTHORIZED: ChallengeBinding = {
  recipient: "0x1111111111111111111111111111111111111111",
  token: "0x2222222222222222222222222222222222222222",
  amount: "50000",
  resourceUrl: "https://api.vendor.example/v1/market-data?symbol=OKB",
  endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
  method: "POST",
  nonce: "0x00000000000000000000000000000000000000000000000000000000deadbeef",
  expiry: "1893456000",
  taskHash: "0x" + "a".repeat(64),
  intentHash: "0x" + "b".repeat(64),
  policyId: "42",
  metadataHash: "0x" + "c".repeat(64),
};

/** For each field: a set of independently-tampered variants + the code each must raise. */
const TAMPERS: ReadonlyArray<{
  field: BindingField;
  code: "BLOCKED_REPLAY" | "REJECTED_BINDING";
  variants: ReadonlyArray<Partial<ChallengeBinding>>;
}> = [
  {
    field: "recipient",
    code: "REJECTED_BINDING",
    variants: [
      { recipient: "0x9999999999999999999999999999999999999999" }, // fund redirection
      { recipient: "0x1111111111111111111111111111111111111112" }, // off-by-one last nibble
      { recipient: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef" },
    ],
  },
  {
    field: "token",
    code: "REJECTED_BINDING",
    variants: [
      { token: "0x3333333333333333333333333333333333333333" }, // swap settlement token
      { token: "0x2222222222222222222222222222222222222223" },
    ],
  },
  {
    field: "amount",
    code: "REJECTED_BINDING",
    variants: [
      { amount: "50001" }, // +1 base unit overcharge
      { amount: "500000" }, // 10x
      { amount: "0" },
      { amount: "49999" },
      { amount: "50000.0" }, // no numeric coercion: distinct string
    ],
  },
  {
    field: "resourceUrl",
    code: "REJECTED_BINDING",
    variants: [
      { resourceUrl: "https://api.vendor.example/v1/market-data?symbol=ETH" }, // param swap
      { resourceUrl: "https://api.attacker.example/v1/market-data?symbol=OKB" }, // host swap
      { resourceUrl: "https://api.vendor.example/v1/premium-data?symbol=OKB" }, // path swap
    ],
  },
  {
    field: "endpoint",
    code: "REJECTED_BINDING",
    variants: [
      { endpoint: "https://api.vendor.example/v1/market-data?symbol=DOGE" },
      { endpoint: "https://api.vendor.example/v2/market-data?symbol=OKB" },
    ],
  },
  {
    field: "method",
    code: "REJECTED_BINDING",
    variants: [{ method: "GET" }, { method: "PUT" }, { method: "DELETE" }],
  },
  {
    field: "nonce",
    code: "BLOCKED_REPLAY",
    variants: [
      { nonce: "0x00000000000000000000000000000000000000000000000000000000deadbeff" }, // reused/altered
      { nonce: "0x" + "0".repeat(64) },
      { nonce: "1" },
    ],
  },
  {
    field: "expiry",
    code: "BLOCKED_REPLAY",
    variants: [
      { expiry: "9999999999" }, // extended expiry → widened replay window
      { expiry: "1893456001" }, // +1s
      { expiry: "1000000000" }, // shortened
    ],
  },
  {
    field: "taskHash",
    code: "REJECTED_BINDING",
    variants: [{ taskHash: "0x" + "d".repeat(64) }, { taskHash: "0x" + "a".repeat(63) + "0" }],
  },
  {
    field: "intentHash",
    code: "REJECTED_BINDING",
    variants: [{ intentHash: "0x" + "e".repeat(64) }],
  },
  {
    field: "policyId",
    code: "REJECTED_BINDING",
    variants: [{ policyId: "43" }, { policyId: "420" }, { policyId: "4" }],
  },
  {
    field: "metadataHash",
    code: "REJECTED_BINDING",
    variants: [{ metadataHash: "0x" + "f".repeat(64) }],
  },
];

test("happy path: an identical presented binding passes", () => {
  const r = checkChallengeBinding(AUTHORIZED, { ...AUTHORIZED });
  assert.equal(r.ok, true);
});

test("adversarial: every field independently tampered is caught with the right field + code", () => {
  for (const { field, code, variants } of TAMPERS) {
    for (const variant of variants) {
      const presented = { ...AUTHORIZED, ...variant };
      const r = checkChallengeBinding(AUTHORIZED, presented);
      assert.equal(
        r.ok,
        false,
        `tampering ${field} with ${JSON.stringify(variant)} MUST fail but passed`,
      );
      if (!r.ok) {
        assert.equal(r.field, field, `wrong field flagged for tamper ${JSON.stringify(variant)}`);
        assert.equal(r.code, code, `wrong code for ${field} tamper ${JSON.stringify(variant)}`);
      }
    }
  }
});

test("adversarial: exhaustive coverage — every ChallengeBinding field appears in the tamper matrix", () => {
  const covered = new Set(TAMPERS.map((t) => t.field));
  const allFields: BindingField[] = [
    "recipient", "token", "amount", "resourceUrl", "endpoint", "method",
    "nonce", "expiry", "taskHash", "intentHash", "policyId", "metadataHash",
  ];
  for (const f of allFields) {
    assert.ok(covered.has(f), `field ${f} is not independently fuzzed`);
  }
});

test("optional-field presence attacks: injecting or dropping a bound field is caught", () => {
  // Drop an authorized taskHash.
  const dropped = { ...AUTHORIZED };
  delete (dropped as { taskHash?: string }).taskHash;
  const r1 = checkChallengeBinding(AUTHORIZED, dropped);
  assert.equal(r1.ok, false);
  if (!r1.ok) assert.equal(r1.field, "taskHash");

  // Inject a metadataHash that was never authorized.
  const authNoMeta = { ...AUTHORIZED };
  delete (authNoMeta as { metadataHash?: string }).metadataHash;
  const injected = { ...authNoMeta, metadataHash: "0x" + "1".repeat(64) };
  const r2 = checkChallengeBinding(authNoMeta, injected);
  assert.equal(r2.ok, false);
  if (!r2.ok) assert.equal(r2.field, "metadataHash");

  // Inject an intentHash that was never authorized.
  const authNoIntent = { ...AUTHORIZED };
  delete (authNoIntent as { intentHash?: string }).intentHash;
  const injected2 = { ...authNoIntent, intentHash: "0x" + "2".repeat(64) };
  const r3 = checkChallengeBinding(authNoIntent, injected2);
  assert.equal(r3.ok, false);
  if (!r3.ok) assert.equal(r3.field, "intentHash");
});

test("both-absent optionals bind fine", () => {
  const minimal: ChallengeBinding = { ...AUTHORIZED };
  for (const k of ["taskHash", "intentHash", "policyId", "metadataHash"] as const) {
    delete (minimal as unknown as Record<string, unknown>)[k];
  }
  const r = checkChallengeBinding(minimal, { ...minimal });
  assert.equal(r.ok, true);
});

test("normalization does not produce false REJECTs (case-only representation differences)", () => {
  const presented: ChallengeBinding = {
    ...AUTHORIZED,
    recipient: AUTHORIZED.recipient.toUpperCase().replace("0X", "0x"), // checksum/upper address
    token: AUTHORIZED.token.toUpperCase().replace("0X", "0x"),
    method: "post", // lowercase method
    resourceUrl: "https://API.VENDOR.EXAMPLE:443/v1/market-data?symbol=OKB", // default port + host case
    endpoint: "https://api.vendor.example/v1/market-data?symbol=OKB",
    taskHash: AUTHORIZED.taskHash!.toUpperCase().replace("0X", "0x"),
  };
  const r = checkChallengeBinding(AUTHORIZED, presented);
  assert.equal(r.ok, true, JSON.stringify(r));
});

test("but a genuinely different path/query survives normalization and is rejected", () => {
  const presented = {
    ...AUTHORIZED,
    resourceUrl: "https://api.vendor.example/v1/market-data?symbol=okb", // lowercased query VALUE differs
  };
  const r = checkChallengeBinding(AUTHORIZED, presented);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.field, "resourceUrl");
});

test("required field missing on the presented side fails closed", () => {
  const presented = { ...AUTHORIZED, nonce: "" };
  const r = checkChallengeBinding(AUTHORIZED, presented);
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.field, "nonce");
    assert.equal(r.code, "BLOCKED_REPLAY");
  }
});
