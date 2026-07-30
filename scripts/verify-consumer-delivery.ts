/**
 * Re-run delivery verification for one completed intent, from production's own evidence.
 *
 *   pnpm consumer:delivery:verify --intent-id ci_… [--confirm]
 *
 * WHY THIS COMMAND HOLDS NOTHING
 *
 * It reads the same three variables the proof controller reads and nothing else. The verification runs
 * INSIDE production, over production's store; this process only asks for it and prints the answer. That
 * matters for the same reason the proof controller is keyless: a local process holding a database
 * credential could have written the record itself, and then the record would be evidence about this
 * machine rather than about production.
 *
 * It cannot pay. The route it calls reaches no adapter method that takes a payment capability, mints no
 * capability and loads no signer — and this process could not do any of it either.
 *
 * `--confirm` is required for the write, separately from running the command. Without it the command
 * prints what it would ask for and stops, so a mistyped intent id costs nothing.
 */

export {};

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

const green = (s: string): string => `\x1b[32m${s}\x1b[0m`;
const red = (s: string): string => `\x1b[31m${s}\x1b[0m`;
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;
const field = (k: string, v: string): void => console.log(`     ${k.padEnd(24)} ${v}`);

/** The credentials whose presence would make this process able to write the record itself. */
const FORBIDDEN = [
  "DATABASE_URL",
  "CONSUMER_TREASURY_SOLANA_SECRET_KEY",
  "CONSUMER_SOLANA_PROOF_SECRET_KEY",
  "CONSUMER_TREASURY_BASE_PRIVATE_KEY",
] as const;

function stop(code: number, why: string, detail: readonly string[] = []): never {
  console.error(`\n${red("REFUSED")} ${why}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(code);
}

async function main(): Promise<void> {
  const present = FORBIDDEN.filter((n) => (process.env[n]?.trim() ?? "") !== "");
  if (present.length > 0) {
    stop(2, "this process holds credentials that would let it write the record directly", [
      ...present.map((n) => `${n} is set`),
      "Run it with these scrubbed: the record is only evidence about production if this side could not have written it.",
    ]);
  }

  const aspUrl = (process.env.UNTCH_ASP_URL?.trim() ?? "").replace(/\/+$/, "");
  const token = process.env.INTERNAL_OPS_TOKEN?.trim() ?? "";
  const intentId = arg("intent-id") ?? "";
  if (aspUrl === "") stop(2, "UNTCH_ASP_URL is not set");
  if (token === "") stop(2, "INTERNAL_OPS_TOKEN is not set");
  if (!/^ci_[0-9a-f]{24}$/.test(intentId)) stop(2, "--intent-id must be a canonical ci_<24 hex> id");

  console.log(`\n\x1b[1mDELIVERY VERIFICATION REDRIVE\x1b[0m  ${has("confirm") ? red("LIVE") : dim("dry run — pass --confirm")}`);
  field("asp", aspUrl);
  field("intent", intentId);
  field("this process holds", "no database credential, no signer, no provider credential");

  if (!has("confirm")) {
    console.log(
      `\n  ${dim("Dry run.")} With --confirm this would ask production to re-verify the persisted\n` +
        "  evidence for that intent and append an immutable verification record. It would make no\n" +
        "  provider request, load no signer, submit no transaction and spend nothing.",
    );
    return;
  }

  const res = await fetch(`${aspUrl}/internal/consumer/intents/${intentId}/verify-delivery`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "user-agent": "untch-delivery-verify/1.0" },
  });
  const text = await res.text();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    stop(3, `production answered ${res.status} with a non-JSON body`, [text.slice(0, 300)]);
  }

  if (res.status !== 200) {
    stop(3, `production refused: ${String(parsed.code)}`, [
      String(parsed.message ?? ""),
      `receiptAltered: ${String(parsed.receiptAltered)} · recordWritten: ${String(parsed.recordWritten)}`,
    ]);
  }

  const v = parsed.verification as Record<string, unknown>;
  console.log(`\n\x1b[1mRESULT\x1b[0m`);
  field("verified", String(v.verified));
  field("method", String(v.method));
  field("verifierVersion", String(v.verifierVersion));
  field("verificationId", String(v.verificationId));
  field("evidenceDigest", String(v.evidenceDigest));
  field("resultHash", String(v.resultHash));
  field("settlementTx", String(v.settlementTx));
  field("settledAmount", String(v.settledAmount));
  field("originalReceiptId", String(v.originalReceiptId));
  field("alreadyRecorded", String(parsed.alreadyRecorded));
  field("delivery projection", JSON.stringify(parsed.deliveryProjection));
  field("public receipt", String(parsed.publicReceiptUrl));
  console.log(dim(`\n     paid=${String(parsed.paid)} providerCalled=${String(parsed.providerCalled)} signerLoaded=${String(parsed.signerLoaded)}`));

  const refusals = (v.refusals ?? []) as { code: string; detail: string }[];
  if (refusals.length > 0) {
    console.log(`\n  ${red("NOT VERIFIED")} — production could not support the claim:`);
    for (const r of refusals) console.log(`     ${r.code}: ${r.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n  ${green("VERIFIED")} ${String(v.detail)}`);
}

main().catch((err: unknown) => {
  console.error(`\n${red("FAILED")} ${(err as Error).message}`);
  process.exit(1);
});
