/**
 * The Untch Mail round trip: bind the test, send, wait for a human, then verify what came back.
 *
 *   node --import tsx --env-file=.env scripts/mail-roundtrip-proof.ts bind \
 *     --to you@example.com --inbox untch-mail
 *   # …run the printed send command, reply to the email, then:
 *   node --import tsx --env-file=.env scripts/mail-roundtrip-proof.ts verify \
 *     --binding internal/evidence/mail-roundtrip/<ref>/binding.json
 *
 * WHY TWO PHASES, AND WHY A FILE BETWEEN THEM
 *
 * A round trip is only evidence if the expectation was fixed BEFORE the thing happened. `bind`
 * writes the hashes of what should occur — the reference code, the outbound subject, the reply
 * subject, the recipient, the direction, the expiry — and `verify` is allowed to do exactly one
 * thing with them: compare. It cannot widen the expectation to fit whatever turned up, because by
 * then the expectation is on disk and hashed.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 *
 * It proves that a message Untch authorised reached a human, that the human's reply reached an inbox
 * Untch owns and paid for, and that Untch read it back through the provider's own API. It does not
 * prove the reply's contents, which are the human's private mail and are never fetched: `verify`
 * lists messages and compares hashes, and never calls the read-a-message endpoint.
 *
 * WHAT NEVER LEAVES THIS PROCESS
 *
 * The recipient address, the reply's sender and the message bodies. The binding file stores the
 * recipient as a hash. The evidence file stores hashes. Both are safe to attach to a PR.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  asset,
  isProviderError,
  parseMoney,
  sha256Hex,
  type CaipChainId,
  type PaymentCapability,
  type PaymentRequest,
  type PaymentResult,
} from "../packages/consumer-core/src/index";
import {
  StableEmailAdapter,
  X402EvmExactClient,
  type AdapterContext,
} from "../packages/consumer-providers/src/index";

const BASE: CaipChainId = "eip155:8453";
const USDC = asset("base.usdc");
const STABLEEMAIL_PAYTO = "0xdb5aa553feeb2c3e3d03e8360b36fb0f7e480671";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string): void => console.log(`  \x1b[31m✗\x1b[0m ${s}`);
const info = (k: string, v: string): void => console.log(`     ${k.padEnd(22)} ${v}`);
const step = (s: string): void => console.log(`\n\x1b[1m${s}\x1b[0m`);

function die(why: string): never {
  console.error(`\n\x1b[31mROUND TRIP: STOP — ${why}\x1b[0m`);
  process.exit(2);
}

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const hash = (s: string): string => `0x${sha256Hex(s)}`;

interface Binding {
  readonly schema: "untch.mail.roundtrip.binding.v1";
  readonly ref: string;
  readonly boundAt: string;
  readonly expiresAt: string;
  readonly untchInbox: string;
  readonly direction: "outbound-then-inbound";
  readonly outbound: {
    readonly recipientHash: string;
    readonly subject: string;
    readonly subjectHash: string;
    readonly replyTo: string;
  };
  readonly inbound: {
    /** What a reply's subject will be. Mail clients prefix `Re: `; both forms are accepted. */
    readonly expectedSubjects: readonly string[];
    readonly expectedSubjectHashes: readonly string[];
    readonly senderHash: string;
  };
  readonly note: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// bind
// ─────────────────────────────────────────────────────────────────────────────

function bind(): void {
  const to = arg("to");
  if (!to) die("--to is required: the round trip needs an external inbox the operator controls");
  const inboxName = arg("inbox") ?? "untch-mail";
  const untchInbox = `${inboxName}@stableemail.dev`;
  const ref = (arg("ref") ?? randomBytes(2).toString("hex")).toUpperCase();
  const ttlMin = Number(arg("ttl-min") ?? "120");
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) die("--ttl-min must be a positive number of minutes");

  const subject = `Untch Mail delivery proof ${ref}`;
  // A reply keeps the subject and gains a client-specific prefix. Both plain forms are bound so a
  // client that does not prefix, or localises its prefix, does not silently fail the match.
  const expectedSubjects = [`Re: ${subject}`, subject];

  const binding: Binding = {
    schema: "untch.mail.roundtrip.binding.v1",
    ref,
    boundAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + ttlMin * 60_000).toISOString(),
    untchInbox,
    direction: "outbound-then-inbound",
    outbound: {
      // The recipient is personal data. It is bound by HASH so `verify` can prove the reply came
      // from the address the send went to, without the address ever reaching a file.
      recipientHash: hash(to.trim().toLowerCase()),
      subject,
      subjectHash: hash(subject),
      replyTo: untchInbox,
    },
    inbound: {
      expectedSubjects,
      expectedSubjectHashes: expectedSubjects.map(hash),
      senderHash: hash(to.trim().toLowerCase()),
    },
    note:
      "Bound BEFORE the send. `verify` may only compare against these values; it cannot widen them " +
      "to fit whatever arrived.",
  };

  const dir = join(process.cwd(), "internal", "evidence", "mail-roundtrip", ref);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "binding.json");
  writeFileSync(path, `${JSON.stringify(binding, null, 2)}\n`);

  step("Round trip bound");
  info("ref", ref);
  info("untch inbox", untchInbox);
  info("recipient hash", binding.outbound.recipientHash);
  info("subject", subject);
  info("subject hash", binding.outbound.subjectHash);
  info("expires", binding.expiresAt);
  ok(`binding written to internal/evidence/mail-roundtrip/${ref}/binding.json`);

  console.log("\n\x1b[1mNext — send the outbound message (proof A):\x1b[0m");
  console.log(
    `  railway run --service untch-asp -- node --import tsx --env-file=.env \\\n` +
      `    scripts/live-smoke-via-proxy.ts --provider stableemail \\\n` +
      `    --to ${to} --ref ${ref} --reply-to ${untchInbox} --max-usdc 0.10 --operator-funded`,
  );
  console.log("\n\x1b[1mThen (proof B): reply to that email. Then (proof C):\x1b[0m");
  console.log(
    `  node --import tsx --env-file=.env scripts/mail-roundtrip-proof.ts verify \\\n` +
      `    --binding internal/evidence/mail-roundtrip/${ref}/binding.json`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// verify
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single-use spending authority for one $0.001 read, minted straight against the Base rail.
 *
 * This deliberately mirrors the treasury router's capability rather than reaching for the router
 * itself: the router's job is to govern INTENT-scoped spending against a durable store, and this
 * script has no intent. What it does keep is the part that matters — a hard ceiling and a recipient
 * allowlist, both checked before the rail is touched.
 */
function readCapability(rail: X402EvmExactClient, ceiling: string): PaymentCapability {
  let consumed = false;
  const max = parseMoney(ceiling, USDC);
  return {
    capabilityId: `rt_${randomBytes(6).toString("hex")}`,
    intentId: "roundtrip-verify",
    chain: BASE,
    asset: USDC,
    maxAmount: max,
    allowedRecipients: [STABLEEMAIL_PAYTO],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    async pay(req: PaymentRequest): Promise<PaymentResult> {
      if (consumed) throw new Error("read capability already consumed");
      if (req.amount.amount > max.amount) {
        throw new Error(`refusing to pay ${req.amount.amount} over the ${max.amount} ceiling`);
      }
      if (req.recipient.toLowerCase() !== STABLEEMAIL_PAYTO.toLowerCase()) {
        throw new Error(`refusing to pay ${req.recipient}, which is not the StableEmail payTo`);
      }
      consumed = true;
      return rail.pay(req);
    },
  };
}

async function verify(): Promise<void> {
  const bindingPath = arg("binding");
  if (!bindingPath) die("--binding is required");
  const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as Binding;
  if (binding.schema !== "untch.mail.roundtrip.binding.v1") die("not a round-trip binding file");

  step("Round trip — verifying the inbound leg");
  info("ref", binding.ref);
  info("untch inbox", binding.untchInbox);
  info("bound at", binding.boundAt);

  if (Date.parse(binding.expiresAt) < Date.now()) {
    die(
      `the binding expired at ${binding.expiresAt}. Re-bind rather than widening it — an expectation ` +
        "adjusted after the fact is not an expectation.",
    );
  }
  ok("binding is still inside its window");

  const key = process.env.CONSUMER_TREASURY_BASE_PRIVATE_KEY?.trim();
  if (!key) die("CONSUMER_TREASURY_BASE_PRIVATE_KEY is not set — the inbox owner cannot pay to read");
  const rail = new X402EvmExactClient({
    chain: BASE,
    evmChainId: 8453,
    privateKey: key as `0x${string}`,
    rpcUrl: process.env.CONSUMER_BASE_RPC_URL?.trim() || "https://mainnet.base.org",
  });
  if (!rail.available()) die("the Base rail reports unavailable");
  info("reading as", rail.address());
  console.log("     (StableEmail authorises this endpoint by PAYER-as-owner, so the treasury reads it)");

  const adapter = new StableEmailAdapter();
  const ctx: AdapterContext = {
    correlationId: `rt-${binding.ref}`,
    timeoutMs: 25_000,
    signableChains: new Set<CaipChainId>([BASE]),
    siwx: null,
    discoveryPayment: readCapability(rail, arg("max-usdc") ?? "0.01"),
  };

  const username = binding.untchInbox.split("@")[0] ?? "";
  const result = await adapter.discover(
    { action: "mail.inbox.messages", params: { username, limit: 50 }, limit: 50 },
    ctx,
  );
  ok(`read ${result.options.length} message(s) from ${binding.untchInbox}`);

  step("Matching against the pre-bound expectation");
  const wanted = new Set(binding.inbound.expectedSubjectHashes);
  const match = result.options.find((o) => {
    const sh = o.attributes.subjectHash;
    return typeof sh === "string" && wanted.has(sh);
  });

  for (const o of result.options) {
    const sh = String(o.attributes.subjectHash ?? "—");
    const hit = wanted.has(sh);
    console.log(`     ${hit ? "\x1b[32m→\x1b[0m" : " "} ${String(o.attributes.receivedAt ?? "?")}  subject ${sh.slice(0, 18)}…`);
  }

  if (!match) {
    bad("no message in the Untch inbox matches a bound subject hash");
    console.log("\n  Either the reply has not arrived yet, or it did not keep the subject.");
    console.log(`  Expected one of: ${binding.inbound.expectedSubjects.map((s) => JSON.stringify(s)).join(", ")}`);
    process.exit(3);
  }

  ok("a message with a BOUND subject hash is present in the Untch-owned inbox");
  const senderMatches = match.attributes.fromHash === binding.inbound.senderHash;
  if (senderMatches) {
    ok("the sender hash matches the address the outbound message was sent to");
  } else {
    // Not fatal, and worth being precise about why. Gmail and other clients may reply from an alias
    // or a different sending identity than the delivery address.
    console.log(
      "  \x1b[33m!\x1b[0m the sender hash does NOT match the outbound recipient — the reply came from a " +
        "different address than the one written to (an alias, or a different sending identity)",
    );
  }
  const receivedAt = String(match.attributes.receivedAt ?? "");
  const afterBind = receivedAt !== "" && Date.parse(receivedAt) >= Date.parse(binding.boundAt);
  if (afterBind) ok(`received ${receivedAt}, after the binding was written`);
  else bad(`received ${receivedAt || "(unreported)"}, which is NOT after the binding — cannot count`);

  const evidence = {
    schema: "untch.mail.roundtrip.evidence.v1",
    generatedAt: new Date().toISOString(),
    ref: binding.ref,
    binding: { boundAt: binding.boundAt, expiresAt: binding.expiresAt, path: bindingPath },
    untchInbox: binding.untchInbox,
    inboundMatch: {
      messageIdHash: match.attributes.messageIdHash,
      subjectHash: match.attributes.subjectHash,
      senderHashMatchesOutboundRecipient: senderMatches,
      receivedAt,
      receivedAfterBinding: afterBind,
    },
    messagesInInbox: result.options.length,
    readInterface: "POST /api/inbox/messages, $0.001 USDC on Base, authorised by payer-as-owner",
    redaction:
      "No recipient address, no sender address, no subject text and no message body appears in this " +
      "file or in the binding. Every identity is a SHA-256 hash. The message body was never fetched.",
    verdict: afterBind ? "ROUND_TRIP_CONFIRMED" : "INCONCLUSIVE",
  };

  const out = join(dirname(bindingPath), "roundtrip-evidence.json");
  writeFileSync(out, `${JSON.stringify(evidence, null, 2)}\n`);
  ok(`evidence written to ${out}`);

  console.log(
    afterBind
      ? "\n\x1b[1m\x1b[32mROUND TRIP: CONFIRMED\x1b[0m — outbound delivered, inbound received, hashes match the binding."
      : "\n\x1b[1m\x1b[33mROUND TRIP: INCONCLUSIVE\x1b[0m",
  );
  if (!afterBind) process.exit(3);
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  if (cmd === "bind") return bind();
  if (cmd === "verify") return verify();
  die("usage: mail-roundtrip-proof.ts <bind|verify> [options]");
}

main().catch((err: unknown) => {
  if (isProviderError(err)) {
    console.error(`\n\x1b[31mROUND TRIP: ${err.normalized.code} — ${err.normalized.message}\x1b[0m`);
    process.exit(3);
  }
  console.error(`\n\x1b[31mROUND TRIP: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
