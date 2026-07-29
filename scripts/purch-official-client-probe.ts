/**
 * Purch, through Purch's OWN documented client. A diagnostic oracle, not an Untch code path.
 *
 *   CONSUMER_SOLANA_EXECUTION_ENABLED=1 \
 *     node --import tsx --env-file=.env scripts/purch-official-client-probe.ts --max-usdc 0.02
 *
 * WHY THIS EXISTS
 *
 * Untch's own rail builds a valid partially-signed Solana transaction and Purch rejects it with a
 * bare 402 and an empty body. With no diagnostic from the provider, the question "is our payload
 * wrong or is their verifier unhappy" cannot be answered from our side alone. So this probe removes
 * Untch from the loop entirely: it drives `@x402/fetch` and `@x402/svm`, the packages Purch's own
 * documentation names, and lets THEM produce the payload and choose the retry header.
 *
 * If the official client succeeds, our envelope is wrong and the difference is the answer.
 * If the official client fails identically, the blocker is on Purch's side and no amount of local
 * protocol work will move it.
 *
 * THE VERSION POINT
 *
 * Untch's rail was built against `x402@1.2.0`. Purch serves `x402Version: 2`, and the v2 line ships
 * as `@x402/core@2.20.0` with `@x402/fetch` and `@x402/svm` on top. Those are different packages,
 * not a newer release of the same one. Using a v1-era client to answer a v2 challenge is a real
 * candidate cause, and this probe is what distinguishes it from the alternatives.
 *
 * SAFETY
 *
 * One attempt. One capped ceiling. No automatic retry, ever: a second attempt with different bytes
 * against a provider that has already been sent a signed transaction is how one authorisation
 * becomes two settlements. The secret is never printed and the signed payload is recorded only as a
 * hash.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { decodeBase58 } from "../packages/consumer-core/src/index";

const SEARCH_URL = "https://api.purch.xyz/x402/search?q=usb%20c%20cable";
const PURCH_PAYTO = "8LiXrHC61irY8qwj6qevoiRXxYfrTgSaHVbm8rav6HT2";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const info = (k: string, v: string): void => console.log(`     ${k.padEnd(24)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n\x1b[1m${String(n).padStart(2)}. ${s}\x1b[0m`);
const warn = (s: string): void => console.log(`  \x1b[33m!\x1b[0m ${s}`);

function stop(why: string): never {
  console.error(`\n\x1b[31mPROBE: STOP — ${why}\x1b[0m`);
  console.error("No payment was attempted.");
  process.exit(2);
}

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const sha = (s: string): string => `0x${createHash("sha256").update(s, "utf8").digest("hex")}`;

interface Attempt {
  readonly headerName: string;
  readonly payloadHash: string;
  readonly payloadBytes: number;
  readonly declaredNetwork: string | null;
  readonly declaredScheme: string | null;
  readonly x402Version: number | null;
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mPurch, through its own documented client\x1b[0m");
  console.log("\x1b[31mThis may spend REAL USDC on Solana. One attempt, no retry.\x1b[0m");

  step(1, "Arm switches");
  if (process.env.CONSUMER_SOLANA_EXECUTION_ENABLED?.trim() !== "1") {
    stop("CONSUMER_SOLANA_EXECUTION_ENABLED is not 1");
  }
  const capRaw = arg("max-usdc");
  if (!capRaw || !/^\d+(\.\d{1,6})?$/.test(capRaw)) stop("--max-usdc is required, as an exact decimal");
  const ceilingAtomic = BigInt(Math.round(Number(capRaw) * 1e6));
  if (ceilingAtomic <= 0n) stop("the ceiling must be positive");
  ok(`ceiling ${capRaw} USDC (${ceilingAtomic} atomic)`);

  const secret = process.env.CONSUMER_TREASURY_SOLANA_SECRET_KEY?.trim();
  if (!secret) stop("CONSUMER_TREASURY_SOLANA_SECRET_KEY is not set");
  const rpcUrl = process.env.CONSUMER_SOLANA_RPC_URL?.trim() || "https://api.mainnet-beta.solana.com";

  step(2, "Loading the official v2 client");
  const [{ createKeyPairSignerFromBytes }, svm, fetchExt, core] = await Promise.all([
    import("@solana/kit"),
    import("@x402/svm"),
    import("@x402/fetch"),
    import("@x402/core"),
  ]);
  info("@x402/svm", "2.20.0");
  info("@x402/fetch", "2.20.0");
  info("@x402/core", "2.20.0");

  const bytes = decodeBase58(secret);
  if (bytes === null || bytes.length !== 64) stop("the Solana secret key is not a base58 64-byte keypair");
  const signer = await createKeyPairSignerFromBytes(bytes);
  info("treasury", signer.address);
  ok("signer loaded, secret not printed");

  step(3, "The live challenge, read fresh");
  const unpaid = await fetch(SEARCH_URL);
  const header = unpaid.headers.get("payment-required");
  if (unpaid.status !== 402 || !header) stop(`expected a 402 with payment-required, got ${unpaid.status}`);
  const challenge = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
    x402Version: number;
    accepts: { network: string; amount: string; asset: string; payTo: string }[];
  };
  const option = challenge.accepts.find((a) => a.network.startsWith("solana:"));
  if (!option) stop("the challenge names no Solana option");

  info("x402Version", String(challenge.x402Version));
  info("network", option.network);
  info("amount", `${option.amount} atomic`);
  info("payTo", option.payTo);

  step(4, "Validating before anything is signed");
  if (challenge.x402Version !== 2) stop(`this probe answers x402 v2 only, got v${challenge.x402Version}`);
  ok("challenge is x402 v2");
  if (option.asset !== USDC_MINT) stop(`mint ${option.asset} is not canonical USDC`);
  ok("mint is canonical USDC");
  if (option.payTo !== PURCH_PAYTO) stop(`payTo ${option.payTo} is not the recorded Purch recipient`);
  ok("recipient is the recorded Purch payTo");
  if (BigInt(option.amount) > ceilingAtomic) stop(`Purch asks ${option.amount}, over the ceiling`);
  ok("price is within the ceiling");

  step(5, "One attempt, driven entirely by the official client");
  const attempts: Attempt[] = [];

  /**
   * A fetch wrapper that OBSERVES what the official client sends without altering it.
   *
   * This is the whole point of the probe: the header name, the envelope and the payload are the
   * client's choices, not ours, and recording them is how the difference from Untch's own attempt
   * becomes visible. It records and forwards. It never rewrites.
   */
  const observing: typeof fetch = async (input, init) => {
    const req = new Request(input as never, init);
    for (const [name, value] of req.headers.entries()) {
      if (!/payment/i.test(name) || name.toLowerCase() === "payment-required") continue;
      let declaredNetwork: string | null = null;
      let declaredScheme: string | null = null;
      let x402Version: number | null = null;
      try {
        const decoded = JSON.parse(Buffer.from(value, "base64").toString("utf8")) as Record<string, unknown>;
        declaredNetwork = typeof decoded.network === "string" ? decoded.network : null;
        declaredScheme = typeof decoded.scheme === "string" ? decoded.scheme : null;
        x402Version = typeof decoded.x402Version === "number" ? decoded.x402Version : null;
      } catch {
        // Not base64 JSON. Recording that fact is itself informative.
      }
      attempts.push({
        headerName: name,
        payloadHash: sha(value),
        payloadBytes: value.length,
        declaredNetwork,
        declaredScheme,
        x402Version,
      });
    }
    return fetch(req);
  };

  // `x402Client` lives in @x402/fetch, and the scheme is attached with `register`. Both were read
  // off the package rather than assumed: a probe that guesses its own oracle's API proves nothing.
  const scheme = new svm.ExactSvmScheme(signer, { rpcUrl });
  /**
   * Both signatures were read off the package's own declarations rather than assumed.
   *
   * `SelectPaymentRequirements` is `(x402Version, requirements) => requirements`, and `register` is
   * `(network, client)`. Guessing either produced a confusing "cannot read properties of undefined"
   * from inside the client, which is the failure mode this probe exists to avoid: a probe that
   * mis-drives its own oracle proves nothing about the provider.
   */
  const client = new fetchExt.x402Client(
    (_x402Version: number, requirements: { network?: string }[]) =>
      (requirements.find((r) => r.network?.startsWith("solana:")) ?? requirements[0]) as never,
  );
  client.register(option.network as never, scheme as never);
  void core;

  const paidFetch = fetchExt.wrapFetchWithPayment(observing, client);

  let status = 0;
  let body = "";
  let responseHeaders: Record<string, string> = {};
  try {
    const res = await paidFetch(SEARCH_URL);
    status = res.status;
    body = (await res.text()).slice(0, 2000);
    responseHeaders = Object.fromEntries([...res.headers.entries()]);
  } catch (err) {
    warn(`the official client threw: ${(err as Error).message}`);
    body = `THREW: ${(err as Error).message}`;
  }

  for (const a of attempts) {
    info("retry header", a.headerName);
    info("  payload bytes", String(a.payloadBytes));
    info("  declared network", a.declaredNetwork ?? "(unreadable)");
    info("  declared scheme", a.declaredScheme ?? "(unreadable)");
    info("  x402Version", a.x402Version === null ? "(unreadable)" : String(a.x402Version));
    info("  payload hash", a.payloadHash);
  }
  if (attempts.length === 0) warn("the official client sent NO payment header at all");

  info("response status", String(status));
  console.log(`     response body           ${body.slice(0, 200)}`);

  const succeeded = status >= 200 && status < 300;
  if (succeeded) ok("PURCH ACCEPTED the official client's payment");
  else warn("Purch rejected the official client's payment too");

  step(6, "Diagnostic report");
  const dir = join(process.cwd(), "internal", "evidence", "purch", "official-client-probe");
  mkdirSync(dir, { recursive: true });
  const report = {
    schema: "untch.purch.official-client-probe.v1",
    generatedAt: new Date().toISOString(),
    purpose:
      "Drive Purch through the client its own documentation names, so a rejection can be attributed " +
      "to Untch's envelope or to Purch's verifier rather than left ambiguous.",
    officialClient: { "@x402/core": "2.20.0", "@x402/fetch": "2.20.0", "@x402/svm": "2.20.0" },
    untchClientForComparison: { x402: "1.2.0", note: "the v1-era line, used by X402SolanaExactClient" },
    challenge: {
      x402Version: challenge.x402Version,
      network: option.network,
      asset: option.asset,
      amount: option.amount,
      payTo: option.payTo,
      carriedIn: "payment-required response header",
    },
    attempts,
    response: { status, headers: responseHeaders, bodyPreview: body },
    settled: succeeded,
    redaction:
      "No secret key and no signed payload appears here. Each payload is represented by a SHA-256 " +
      "hash and a byte count.",
  };
  writeFileSync(join(dir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  ok("report written to internal/evidence/purch/official-client-probe/report.json");

  console.log(
    succeeded
      ? "\n\x1b[1m\x1b[32mPROBE: PURCH ACCEPTED THE OFFICIAL CLIENT\x1b[0m\n" +
          "  Untch's envelope is the difference. Compare the recorded header name and payload shape."
      : "\n\x1b[1m\x1b[33mPROBE: PURCH REJECTED THE OFFICIAL CLIENT TOO\x1b[0m\n" +
          "  The blocker is not Untch's envelope. Stop local protocol experimentation and escalate.",
  );
}

main().catch((err: unknown) => {
  console.error(`\n\x1b[31mPROBE: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
