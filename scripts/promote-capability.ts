/**
 * `pnpm promote:capability` — move one capability's execution trust, with its evidence attached.
 *
 *   pnpm promote:capability --provider purch --capability shop.search --to verified \
 *     --evidence "2026-07-29: 0.010000 USDC settled ..." [--write]
 *
 * WHY THIS IS A SCRIPT AND NOT AN UPDATE STATEMENT
 *
 * Maturity is the one field that decides whether a capability can move money, and the ASP treats it as
 * OPERATOR state rather than seed state: `initConsumerWiring` inserts a provider when absent and then
 * never overwrites maturity, precisely so a promotion earned by a real settlement is not demoted by the
 * next deploy, and so a provider disabled during an incident is not silently re-enabled.
 *
 * That design makes the database authoritative, which means promotion is a manual act. A manual act on
 * the field that authorises spending should be repeatable, reviewable and refuse to run without a
 * reason, none of which an ad-hoc UPDATE typed into a shell offers.
 *
 * WHAT IT REFUSES
 *
 * Promoting a capability above its provider, because `effectiveMaturity` takes the lower of the two and
 * the row would state something the registry discards. Promoting to `verified` without evidence text,
 * because `verified` is a claim about observed reality and the provenance field is where that claim has
 * to be checkable later. Writing anything at all without `--write`.
 */

export {};

import { execFileSync } from "node:child_process";
import { createPool, type ProviderMaturity } from "../packages/consumer-core/src/index";

const MATURITIES: readonly string[] = ["verified", "sandbox", "experimental", "disabled"];

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
};

const providerId = arg("provider");
const capability = arg("capability");
const to = arg("to");
const evidence = arg("evidence");
const alsoProvider = process.argv.includes("--also-provider");
const write = process.argv.includes("--write");

function die(why: string): never {
  console.error(`\n\x1b[31mREFUSED\x1b[0m ${why}\n`);
  process.exit(2);
}

if (!providerId || !capability || !to) {
  die("usage: --provider <id> --capability <name> --to <maturity> [--also-provider] --evidence <text> [--write]");
}
if (!MATURITIES.includes(to)) die(`--to must be one of ${MATURITIES.join(", ")}`);

/**
 * Re-bound as non-null after validation.
 *
 * The checks above already exit on a missing value, but the compiler cannot carry that through a
 * `never`-returning helper across module scope, and silencing it with a non-null assertion would remove
 * the only mechanical guarantee that the validation above still runs.
 */
const PROVIDER_ID: string = providerId;
const CAPABILITY: string = capability;
const TO: string = to;
if (to === "verified" && (!evidence || evidence.trim().length < 40)) {
  die("promoting to 'verified' needs --evidence describing the settlement and delivery that was observed");
}

/**
 * The production database, reached the way an operator reaches it.
 *
 * DATABASE_URL names an internal Railway host, so it is read from the service and its host is swapped
 * for the Postgres TCP proxy. The credential is never printed.
 */
function productionPool(): ReturnType<typeof createPool> {
  const direct = process.env.DATABASE_URL?.trim();
  if (direct) return createPool(direct);

  const vars = JSON.parse(
    execFileSync("railway", ["variables", "--service", "untch-asp", "--json"], { encoding: "utf8" }),
  ) as Record<string, string>;
  const internal = vars.DATABASE_URL;
  if (!internal) die("DATABASE_URL is absent from the service");

  const proxies = JSON.parse(
    execFileSync("railway", ["tcp-proxy", "list", "--service", "Postgres", "--json"], { encoding: "utf8" }),
  ) as { proxies?: { domain?: string; proxyPort?: number }[] };
  const p = proxies.proxies?.[0];
  if (!p?.domain || !p.proxyPort) die("no Postgres TCP proxy is configured");

  console.log(`  database        via ${p.domain}:${p.proxyPort} (credential not printed)`);
  return createPool(internal.replace(/@[^/]+\//, `@${p.domain}:${p.proxyPort}/`));
}

const ORDER: Record<string, number> = { disabled: 0, experimental: 1, sandbox: 2, verified: 3 };

async function main(): Promise<void> {
  console.log(`\n\x1b[1mCapability promotion\x1b[0m  ${write ? "\x1b[31mWRITE\x1b[0m" : "dry run"}`);
  const pool = productionPool();

  try {
    const prov = await pool.query<{ provider_id: string; maturity: ProviderMaturity; enabled: boolean }>(
      "SELECT provider_id, maturity, enabled FROM consumer_providers WHERE provider_id = $1",
      [providerId],
    );
    const provider = prov.rows[0];
    if (!provider) die(`provider '${providerId}' does not exist`);

    const caps = await pool.query<{ capability: string; maturity: ProviderMaturity }>(
      "SELECT capability, maturity FROM consumer_provider_capabilities WHERE provider_id = $1 ORDER BY capability",
      [providerId],
    );
    const target = caps.rows.find((c) => c.capability === capability);
    if (!target) die(`'${providerId}' declares no capability '${capability}'`);

    console.log(`\n  BEFORE`);
    console.log(`    provider ${provider.provider_id.padEnd(16)} ${provider.maturity} (enabled=${provider.enabled})`);
    for (const c of caps.rows) {
      const mark = c.capability === capability ? "  <-- target" : "";
      console.log(`      ${c.capability.padEnd(16)} ${c.maturity}${mark}`);
    }

    const providerAfter = alsoProvider ? (to as ProviderMaturity) : provider.maturity;
    if ((ORDER[TO] ?? 0) > (ORDER[providerAfter] ?? 0)) {
      die(
        `'${CAPABILITY}' cannot be '${TO}' while provider '${PROVIDER_ID}' is '${providerAfter}'. ` +
          "effectiveMaturity takes the lower of the two, so the row would claim something the registry " +
          "discards. Pass --also-provider if the provider should move too.",
      );
    }

    console.log(`\n  AFTER`);
    console.log(`    provider ${PROVIDER_ID.padEnd(16)} ${providerAfter}`);
    console.log(`      ${CAPABILITY.padEnd(16)} ${TO}`);
    console.log(`\n  Capabilities NOT changed stay exactly as above. Promotion is per capability.`);

    if (!write) {
      console.log("\n\x1b[33mDRY RUN\x1b[0m  nothing was written. Re-run with --write.\n");
      return;
    }

    await pool.query("BEGIN");
    try {
      if (alsoProvider) {
        await pool.query(
          "UPDATE consumer_providers SET maturity = $2, provenance = provenance || $3, updated_at = now() WHERE provider_id = $1",
          [providerId, providerAfter, `\n${evidence ?? ""}`],
        );
      }
      await pool.query(
        "UPDATE consumer_provider_capabilities SET maturity = $3, notes = notes || $4 WHERE provider_id = $1 AND capability = $2",
        [providerId, capability, to, `\n${evidence ?? ""}`],
      );
      await pool.query("COMMIT");
    } catch (err) {
      await pool.query("ROLLBACK");
      throw err;
    }

    // Re-read. A mutation is not confirmed by the absence of an exception.
    const after = await pool.query<{ capability: string; maturity: string }>(
      "SELECT capability, maturity FROM consumer_provider_capabilities WHERE provider_id = $1 ORDER BY capability",
      [providerId],
    );
    const afterProv = await pool.query<{ maturity: string }>(
      "SELECT maturity FROM consumer_providers WHERE provider_id = $1",
      [providerId],
    );
    console.log(`\n  CONFIRMED by re-read`);
    console.log(`    provider ${PROVIDER_ID.padEnd(16)} ${afterProv.rows[0]?.maturity}`);
    for (const c of after.rows) console.log(`      ${c.capability.padEnd(16)} ${c.maturity}`);
    console.log("");
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(`\npromotion failed: ${(e as Error).message}\n`);
  process.exit(1);
});
