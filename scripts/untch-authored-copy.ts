/**
 * Copy that Untch itself writes and a person then reads.
 *
 * It lives in one module for two reasons. The first is that it is lintable here: this file is in the
 * public-copy linter's scope, so the rules in internal/public-copy-standard.md apply to it the same
 * way they apply to a web page. The second is that copy embedded in a driver script gets rewritten
 * by whoever is debugging the driver, at the moment they are least interested in how it reads.
 *
 * Everything here is prose for a human. Machine-readable values are passed in.
 */

export interface ProofEmailInput {
  /** Short, greppable, quotable. Not a timestamp. */
  readonly ref: string;
  /** Where a reply should land, when the message expects one. */
  readonly replyTo: string | null;
  /** The public receipt link, once one exists. */
  readonly receiptUrl: string | null;
}

export interface ProofEmail {
  readonly subject: string;
  readonly text: string;
}

/**
 * The Untch Mail delivery proof.
 *
 * One job: let a reader confirm in five seconds that what they are holding was authorised before it
 * was paid for. The earlier version explained the architecture over three paragraphs, which is the
 * wrong length for a proof and the wrong register for an email.
 *
 * The reference code carries uniqueness so the subject does not have to. A subject that is mostly an
 * ISO timestamp is unreadable to a person, and a reference is what a reply carries back.
 */
export function proofEmail(input: ProofEmailInput): ProofEmail {
  const lines = [
    "Untch authorised this email before payment.",
    "",
    "Policy: approved",
    "Provider: StableEmail",
    "Payment: 0.02 USDC on Base",
    "Delivery: confirmed",
    `Ref: ${input.ref}`,
    "",
    "The recipient and message body are excluded from the public receipt.",
  ];

  if (input.replyTo !== null) {
    lines.push("", `Reply to this message to complete the round trip: ${input.replyTo}`);
  }
  if (input.receiptUrl !== null) {
    lines.push("", "Receipt:", input.receiptUrl);
  }

  return { subject: `Untch Mail delivery proof ${input.ref}`, text: lines.join("\n") };
}
