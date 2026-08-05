import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { approvalDigest, type ApprovalSubject } from "../src/index";

/**
 * WHAT THESE TESTS ARE ABOUT
 *
 * `approvalDigest` encodes a null field as a sentinel that no caller-supplied string can be written as
 * in ordinary source: one 0x00 byte followed by `null`. That byte used to sit in `approvals.ts` as a
 * LITERAL, which made Git classify the file as binary — no diff, no review, no blame on the one function
 * whose output every stored approval is compared against.
 *
 * Writing it as `\u0000` fixes the tooling. The risk in that fix is the entire point of these tests: the
 * digest is a commitment to values already sitting in production, so an encoding change that looked
 * cosmetic and was not would hand a real person DIGEST_MISMATCH on a decision nothing about which
 * changed. The frozen vectors below are what makes that impossible to do silently, whatever the reason.
 */

const FROZEN: ApprovalSubject = {
  intentId: "int_frozen",
  quoteHash: "qh_frozen",
  amount: "6.00",
  asset: "USDT0",
  provider: "purch",
  capability: "mail.send",
  recipient: "ops@example.test",
  policyId: "pol_frozen",
  policyVersion: 4,
  nonce: "00112233445566778899aabbccddeeff",
  expiresAt: "2026-08-05T18:00:00.000Z",
};

const FROZEN_REQUESTER = {
  requesterPrincipalKind: "untch_account",
  requesterPrincipalNamespace: "untch-account",
  requesterPrincipalRef: "acct_frozen",
  accountRefHash: "arh_frozen",
  walletAuthorityRef: "wal_frozen",
  quoteDigest: "qd_frozen",
} as const;

const FROZEN_V3 = {
  serviceCallId: "svc_frozen",
  decisionId: "apdc_frozen",
  intentHash: "ih_frozen",
  policyHash: "ph_frozen",
  policySnapshotHash: "psh_frozen",
  chain: "eip155:196",
  taskHash: "th_frozen",
  acceptanceHash: "ah_frozen",
  requestExpiresAt: "2026-08-05T19:00:00.000Z",
} as const;

const FROZEN_REQUOTE = {
  quoteLineageId: "qln_frozen",
  quoteVersion: 2,
  previousQuoteDigest: "qd_frozen",
  supersedesApprovalRequestId: "aprq_frozen",
  supersedesReservationId: "resv_frozen",
} as const;

/**
 * Captured from the pre-cleanup module — the one with the literal 0x00 in source — and asserted against
 * the post-cleanup module. Every version is present because each is a separate encoding that separate
 * rows in production were hashed under, and a change that only preserved the newest would still break
 * the oldest pending decision.
 */
const GOLDEN: ReadonlyArray<readonly [string, ApprovalSubject, string]> = [
  ["v1", FROZEN, "apd_8c9704e95ab35bfbe7f803793a59f757e034171b197edde2cdf9c0b49a8fcf9e"],
  [
    "v1 with a null recipient",
    { ...FROZEN, recipient: null },
    "apd_0fb91e227d0315250b2e9a5d2140c386b9ab0e6dba3e52c56a6a31471acba1bb",
  ],
  [
    "v2",
    { ...FROZEN, requester: FROZEN_REQUESTER },
    "apd_af6b1c39afb1397cbd81c5b8914f097bd7a22b2551427a268195e2513093c190",
  ],
  [
    "v2 with a null recipient",
    { ...FROZEN, recipient: null, requester: FROZEN_REQUESTER },
    "apd_46103e8797c631d57f5378cf2d52344adad33710d8d1059a711fdbd2c3d27de8",
  ],
  [
    "v3",
    { ...FROZEN, requester: FROZEN_REQUESTER, v3: FROZEN_V3 },
    "apd_4f508f5aff9876ee66aead70386a5b8d809fcc908820465dfe3b8c7ac14ecc5e",
  ],
  [
    "v3 with a null recipient",
    { ...FROZEN, recipient: null, requester: FROZEN_REQUESTER, v3: FROZEN_V3 },
    "apd_8ab9046f51a28a7f27cad4f8172bdb45dce09009dc735317f162f0d3da9a9966",
  ],
  [
    "v4",
    { ...FROZEN, requester: FROZEN_REQUESTER, v3: FROZEN_V3, requote: FROZEN_REQUOTE },
    "apd_d43dd31c3e22354fda24716f6351d8df8562d9c4de935c103e8901c3c319f876",
  ],
  [
    "v4 with a predecessor that held no reservation",
    {
      ...FROZEN,
      requester: FROZEN_REQUESTER,
      v3: FROZEN_V3,
      requote: { ...FROZEN_REQUOTE, supersedesReservationId: null },
    },
    "apd_37b0a3e845b48f48347eec189eebba2fb7d0517945a13516f338faaee8c6176b",
  ],
];

describe("the null sentinel survives being written as an escape", () => {
  for (const [name, subject, digest] of GOLDEN) {
    test(`${name} hashes to the value it hashed to before the cleanup`, () => {
      assert.equal(approvalDigest(subject), digest);
    });
  }

  /**
   * The claim the cleanup rests on, stated as bytes rather than inferred from the digests above: the two
   * source spellings of the sentinel are the same string at runtime. If a future editor "helpfully"
   * replaces the escape with a space — which is what the literal byte LOOKS like in most editors — this
   * fails on the bytes before anything downstream fails on a mismatch.
   */
  test("the escape and the literal byte are the same string at runtime", () => {
    assert.deepEqual(Buffer.from("\u0000null", "utf8"), Buffer.from("\x00null", "utf8"));
    assert.equal(Buffer.from("\u0000null", "utf8").toString("hex"), "006e756c6c");
    assert.notEqual("\u0000null", " null");
  });

  /**
   * A null field and an empty-string field are different facts, and the sentinel is what keeps them
   * apart. Asserted directly because the golden vectors above would still pass if the sentinel were
   * changed to some OTHER constant — they pin the output, this pins the reason.
   */
  test("null, empty string and the word null are three different approvals", () => {
    const nulled = approvalDigest({ ...FROZEN, recipient: null });
    const empty = approvalDigest({ ...FROZEN, recipient: "" });
    const word = approvalDigest({ ...FROZEN, recipient: "null" });
    assert.equal(new Set([nulled, empty, word]).size, 3);
  });
});

/**
 * The regression that stops the byte coming back.
 *
 * A digest test cannot catch this: a literal 0x00 and the escape produce identical digests, which is the
 * whole reason the original went unnoticed. What it costs is reviewability — Git treats the file as
 * binary, so the diff, the blame and the review of the most safety-critical function in the package all
 * disappear. That is a property of the FILE, so it is checked on the file.
 */
describe("source that a reviewer can actually read", () => {
  const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    encoding: "utf8",
  }).trim();

  const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.sql", "*.json", "*.md", "*.yml"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((f) => f.length > 0);

  test("git tracks enough source for this check to mean something", () => {
    assert.ok(tracked.length > 100, `only ${tracked.length} tracked source files were enumerated`);
  });

  test("no tracked source file carries a NUL byte", () => {
    const offenders = tracked.filter((file) => readFileSync(path.join(repoRoot, file)).includes(0x00));
    assert.deepEqual(
      offenders,
      [],
      `these files contain a literal NUL and Git will treat them as binary: ${offenders.join(", ")}`,
    );
  });
});
