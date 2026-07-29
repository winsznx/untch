/**
 * Run the live provider smoke against PRODUCTION storage from an operator's machine.
 *
 *   railway run --service untch-asp -- \
 *     node --import tsx --env-file=.env scripts/live-smoke-via-proxy.ts \
 *       --provider stableemail --to you@example.com --first-run
 *
 * Why this exists at all: a live run that proves nothing about the receipt path is a live run that
 * has not proven what it claims. `consumer-smoke-live.ts` degrades to an in-memory store without
 * DATABASE_URL and reports `receiptId: null`, and the §7.4 receipt writer additionally needs Redis.
 * Both live in Railway's private network, so a local process cannot reach them by their deployed
 * names — `postgres.railway.internal` does not resolve outside the deployment.
 *
 * The fix is a HOST REWRITE, not a second set of credentials. Railway's TCP proxy fronts the same
 * database with the same user and password, so the only thing that changes is where the socket
 * points. Rewriting the host keeps the secret handling identical to production: the URL arrives in
 * the environment from `railway run`, is edited in memory, and is never written to a file, echoed,
 * or logged. This module prints hosts, never credentials.
 *
 * Everything else is unchanged. The smoke script is imported, not reimplemented, so the run
 * exercises exactly the controls a normal run exercises.
 */

const PROXY_HOST = process.env.RAILWAY_TCP_PROXY_DOMAIN?.trim() || "hayabusa.proxy.rlwy.net";

/** Repoint a private URL at the public TCP proxy, preserving user, password, path and query. */
function viaProxy(raw: string | undefined, internalHost: string, proxyPort: string): string | null {
  if (!raw || raw.trim() === "") return null;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.hostname !== internalHost) return url.toString();
  url.hostname = PROXY_HOST;
  url.port = proxyPort;
  return url.toString();
}

function describe(name: string, value: string | null): void {
  if (value === null) {
    console.log(`  ${name.padEnd(13)} (unset — the run will degrade and say so)`);
    return;
  }
  // Host and port only. The credentials in the URL are never rendered.
  const u = new URL(value);
  console.log(`  ${name.padEnd(13)} ${u.protocol}//…@${u.host}${u.pathname}`);
}

async function main(): Promise<void> {
  const pgPort = process.env.CONSUMER_PG_PROXY_PORT?.trim() || "18483";
  const redisPort = process.env.CONSUMER_REDIS_PROXY_PORT?.trim() || "21110";

  const database = viaProxy(process.env.DATABASE_URL, "postgres.railway.internal", pgPort);
  const redis = viaProxy(process.env.REDIS_URL, "redis.railway.internal", redisPort);

  console.log("\n\x1b[1mProduction storage, reached over the Railway TCP proxy\x1b[0m");
  describe("DATABASE_URL", database);
  describe("REDIS_URL", redis);

  if (database === null) {
    console.error(
      "\n\x1b[31mNo DATABASE_URL in the environment. Run this under `railway run --service untch-asp`,\n" +
        "which injects the deployed service's variables.\x1b[0m",
    );
    process.exit(2);
  }

  process.env.DATABASE_URL = database;
  if (redis !== null) process.env.REDIS_URL = redis;

  // The live-smoke driver refuses to run unless BOTH of these are set, and the deployed service
  // sets CONSUMER_LIVE_SMOKE_ENABLED=false on purpose. Turning it on is the operator's act of
  // invoking this file, and it applies to this process only — the deployment is untouched.
  process.env.CONSUMER_LIVE_SMOKE_ENABLED = "1";

  /**
   * `--max-usdc` is the only way to raise this run's ceiling, and it exists because a shell export
   * cannot.
   *
   * `railway run` injects the DEPLOYED service's variables into the child, and the deployment sets
   * CONSUMER_LIVE_SMOKE_MAX_USDC deliberately low. Those injected values win over anything exported
   * before the command, so a run that needed a higher ceiling silently kept the low one and stopped
   * at the challenge-validation gate — correctly, but for a reason that looked like the provider had
   * changed its price. The ceiling now comes from an explicit argument, which is also the right
   * shape for an approval: a human types the number they authorised.
   */
  const i = process.argv.indexOf("--max-usdc");
  const maxUsdc = i >= 0 ? process.argv[i + 1]?.trim() : undefined;
  if (maxUsdc) {
    if (!/^\d+(\.\d{1,6})?$/.test(maxUsdc)) {
      console.error(`\n\x1b[31m--max-usdc ${JSON.stringify(maxUsdc)} is not an exact USDC decimal.\x1b[0m`);
      process.exit(2);
    }
    process.env.CONSUMER_LIVE_SMOKE_MAX_USDC = maxUsdc;
    console.log(`  ${"spend ceiling".padEnd(13)} ${maxUsdc} USDC (from --max-usdc, overriding the deployment)`);
  }

  if (!process.env.CONSUMER_LIVE_SMOKE_MAX_USDC?.trim()) {
    console.error("\n\x1b[31mCONSUMER_LIVE_SMOKE_MAX_USDC is not set — a live spend needs an explicit ceiling.\x1b[0m");
    process.exit(2);
  }

  await import("./consumer-smoke-live");
}

main().catch((err: unknown) => {
  console.error(`\n\x1b[31mproxy runner failed: ${(err as Error).message}\x1b[0m`);
  process.exit(1);
});
