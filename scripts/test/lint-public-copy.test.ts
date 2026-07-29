import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lintText, proseOf } from "../lint/public-copy";
import { proofEmail } from "../untch-authored-copy";

const md = (text: string) => lintText(text, "test.md", ".md");
const tsx = (text: string) => lintText(text, "test.tsx", ".tsx");
const ids = (vs: readonly { ruleId: string }[]) => vs.map((v) => v.ruleId);

describe("public-copy lint — what it must catch", () => {
  test("an em dash", () => {
    // #given prose joined with an em dash
    const violations = md("Untch paid the provider — the message was delivered.");
    // #then it is reported as an em dash
    assert.deepEqual(ids(violations), ["em-dash"]);
  });

  test("a semicolon in prose", () => {
    const violations = md("The policy approved the spend; the treasury funded it.");
    assert.deepEqual(ids(violations), ["semicolon"]);
  });

  test("the \"X is not Y. It is Z.\" construction", () => {
    const violations = md("Untch is not a wallet. It is a decision layer.");
    assert.ok(ids(violations).includes("negation-reveal"), `got ${ids(violations).join(",")}`);
  });

  test("\"not another\"", () => {
    const violations = md("This is not another payments startup.");
    assert.ok(ids(violations).includes("not-another"));
  });

  test("generic launch filler", () => {
    assert.ok(ids(md("We are thrilled to announce our new release.")).includes("thrilled"));
    assert.ok(ids(md("A revolutionary approach to payments.")).includes("revolutionary"));
    assert.ok(ids(md("Seamless settlement across every rail.")).includes("seamless"));
    assert.ok(ids(md("Unlock the power of your treasury.")).includes("unlock"));
    assert.ok(ids(md("We empower builders everywhere.")).includes("empower"));
    assert.ok(ids(md("The future of money movement.")).includes("future-of"));
    assert.ok(ids(md("In today's rapidly evolving landscape.")).includes("rapidly-evolving"));
    assert.ok(ids(md("At its core, Untch decides.")).includes("at-its-core"));
    assert.ok(ids(md("This is not just a payment tool.")).includes("not-just"));
    assert.ok(ids(md("It is more than a wallet.")).includes("more-than-a"));
    assert.ok(ids(md("A game-changing release.")).includes("game-changing"));
  });

  test("\"agentic\" with no action named", () => {
    // #given a sentence that uses the word as decoration
    const decoration = md("Untch is agentic infrastructure for the modern stack.");
    // #then it is flagged
    assert.ok(ids(decoration).includes("agentic-without-action"));
  });

  test("a disable comment with no reason is itself a violation", () => {
    const violations = md("<!-- copy-lint-disable-next-line -->\nA seamless experience.");
    assert.ok(ids(violations).includes("disable-needs-reason"));
  });
});

describe("public-copy lint — what it must leave alone", () => {
  test("a transaction hash", () => {
    assert.deepEqual(md("Settled in 0x9c4570ca2369a296eaaa3d705bfd933059755c8a8ade4946def61d22072f625f."), []);
  });

  test("an address and a machine-readable code", () => {
    assert.deepEqual(md("The treasury 0x0e79371813e88F31c2B60C80bad391a952039095 reported PAYMENT_AMBIGUOUS."), []);
  });

  test("a URL, even one containing a semicolon", () => {
    assert.deepEqual(md("See https://basescan.org/tx/0xabc123def456?a=1;b=2 for the settlement."), []);
  });

  test("a fenced code block, whatever it contains", () => {
    const text = ["Run the command.", "", "```ts", "const a = 1; const b = 2; // seamless — unlock", "```", "", "It prints two."].join("\n");
    assert.deepEqual(md(text), []);
  });

  test("an inline code span", () => {
    assert.deepEqual(md("Pass `--max-usdc 1.10; --first-run` to raise the ceiling."), []);
  });

  test("ordinary technical prose", () => {
    const text = [
      "Untch paid StableEmail 0.02 USDC on Base. The message was delivered.",
      "",
      "The policy approved the spend before any money moved. The ledger balanced and the receipt",
      "is non-null. Delivery was confirmed against the subject hash bound before payment.",
    ].join("\n");
    assert.deepEqual(md(text), []);
  });

  test("\"agentic\" next to a real action", () => {
    assert.deepEqual(md("In an agentic flow the agent proposes a purchase and Untch decides whether to fund it."), []);
  });

  test("a quoted provider description, when the quotation is declared", () => {
    const text = [
      "<!-- copy-lint-disable-next-line quoting StableEmail's own endpoint description verbatim -->",
      "\"Buy an inbox on stableemail.dev ($1, 30 days) — seamless programmatic mailboxes.\"",
    ].join("\n");
    assert.deepEqual(md(text), []);
  });

  test("component code that is not copy", () => {
    const text = [
      'import { cn } from "@/lib/utils";',
      'export const Card = () => <div className="flex items-center gap-2; rounded-md" />;',
    ].join("\n");
    assert.deepEqual(tsx(text), []);
  });

  test("visible JSX text is still checked", () => {
    const violations = tsx("<p>A seamless way to pay providers.</p>");
    assert.ok(ids(violations).includes("seamless"));
  });
});

describe("proseOf — the stripper the rules depend on", () => {
  test("strips hashes, URLs and codes but keeps the sentence around them", () => {
    const out = proseOf("The tx 0xdeadbeefcafe1234 at https://x.test/a returned PAYMENT_FAILED quickly.", ".md");
    assert.ok(out.includes("returned"), out);
    assert.ok(!out.includes("0xdeadbeef"), out);
    assert.ok(!out.includes("https://"), out);
    assert.ok(!out.includes("PAYMENT_FAILED"), out);
  });

  test("keeps a markdown link's label and drops its target", () => {
    const out = proseOf("See [the settlement](https://basescan.org/tx/0xabc) for proof.", ".md");
    assert.ok(out.includes("the settlement"), out);
    assert.ok(!out.includes("basescan"), out);
  });
});

describe("the Untch-authored proof email", () => {
  test("passes the standard it is held to", () => {
    const mail = proofEmail({ ref: "462F", replyTo: "untch-mail@stableemail.dev", receiptUrl: null });
    assert.deepEqual(lintText(`${mail.subject}\n${mail.text}`, "proof-email", ".md"), []);
  });

  test("carries the reference in the subject rather than a timestamp", () => {
    const mail = proofEmail({ ref: "462F", replyTo: null, receiptUrl: null });
    assert.equal(mail.subject, "Untch Mail delivery proof 462F");
    assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(mail.subject), "a timestamp must not be the visible subject");
  });

  test("names the reply address only when a reply is expected", () => {
    assert.ok(!proofEmail({ ref: "A1", replyTo: null, receiptUrl: null }).text.includes("Reply to this message"));
    assert.ok(proofEmail({ ref: "A1", replyTo: "x@y.dev", receiptUrl: null }).text.includes("x@y.dev"));
  });

  test("includes the receipt link once one exists", () => {
    const mail = proofEmail({ ref: "A1", replyTo: null, receiptUrl: "https://asp.untch.xyz/consumer/receipt/ci_1" });
    assert.ok(mail.text.includes("Receipt:"));
    assert.ok(mail.text.includes("https://asp.untch.xyz/consumer/receipt/ci_1"));
  });
});

describe("public-copy lint — table cells that hold data, not prose", () => {
  test("a lone dash in a cell is a not-applicable marker, not punctuation", () => {
    assert.deepEqual(md("| Is this vendor one we trust? | — |"), []);
  });

  test("prose elsewhere in the same row is still checked", () => {
    const violations = md("| Receipts | A seamless flow — every time | — |");
    assert.ok(ids(violations).includes("em-dash"), ids(violations).join(","));
    assert.ok(ids(violations).includes("seamless"));
  });
});

describe("public-copy lint — markup and proper nouns are not prose", () => {
  test("an HTML entity's semicolon belongs to the encoding, not the sentence", () => {
    assert.deepEqual(md("Check the merchant&apos;s own order surface for that reference."), []);
    assert.deepEqual(md("Policies &amp; receipts are read from the same store."), []);
  });

  test("a real semicolon on the same line is still caught", () => {
    const violations = md("Check the merchant&apos;s surface; then open the intent.");
    assert.ok(ids(violations).includes("semicolon"));
  });

  test("\"Agentic Wallet\" is OKX's product name, not a claim about behaviour", () => {
    assert.deepEqual(md("- A replacement for OKX settlement, escrow, or Agentic Wallet."), []);
  });

  test("but \"agentic\" as decoration is still caught on the same line", () => {
    const violations = md("Unlike Agentic Wallet, this is agentic infrastructure for everyone.");
    assert.ok(ids(violations).includes("agentic-without-action"));
  });
});
