/**
 * Health-gate a Solana RPC before it is trusted with money.
 *
 *   pnpm solana:rpc-gate
 *
 * This lives in `scripts/` rather than a scratch directory because it is not a one-off. Every time
 * the Solana endpoint changes, or a proof is about to spend, this is the thing that says whether the
 * RPC can actually do the six jobs a settlement needs. A check that only exists in someone's shell
 * history is a check that stops being run.
 *
 * CREDENTIAL HANDLING
 *
 * Alchemy and every comparable provider put the API key IN THE PATH, so the endpoint is a secret and
 * a log line containing it is a leaked key. The URL is redacted once, at the top, and only the host
 * is ever printed. Doing it here rather than at each call site means a later edit cannot reintroduce
 * a leak by forgetting to redact.
 *
 * WHY VERSIONED TRANSACTIONS ARE A GATE AND NOT A DETAIL
 *
 * The official x402 SVM client builds a v0 (versioned) message. An RPC that cannot return one cannot
 * be used to verify Untch's own settlements, which makes it useless for exactly the moment it matters
 * most: deciding, after an ambiguous response, whether money already moved.
 */

/**
 * Marks this file a MODULE rather than a global script.
 *
 * Without it, a file that imports nothing shares the global scope with every other such file under
 * `scripts/`, and its top-level `main` collides with theirs. The collision is a real signal rather
 * than a quirk: two functions of the same name in one scope is ambiguous, and the fix is to give this
 * file its own scope rather than to rename around the problem.
 */
export {};

const URL_RAW = process.env.CONSUMER_SOLANA_RPC_URL?.trim() ?? "";
if (!URL_RAW) {
  console.error("CONSUMER_SOLANA_RPC_URL is not set. There is no endpoint to check.");
  process.exit(2);
}

/** Host only. The key lives in the path and never reaches stdout. */
const HOST = URL_RAW.replace(/^https?:\/\//, "").split("/")[0] ?? "(unparseable)";
const IS_PUBLIC = URL_RAW.includes("api.mainnet-beta.solana.com");

const TREASURY = "HsTvSTrXn1HeDzUJTbH4ETXEKTTf2ifEXaQGGEEQ2XUy";
const TREASURY_ATA = "4C5JJbFTZFRYPM3264mVWu1UqNkC7kos8tWvWfiHrhXo";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

/** Untch's first Solana settlement. Used as a known-good historical fixture. */
const PRIOR_SIG =
  "SgxsTgwVZnmKfj3mkQyGMaAicBR7xmqhi11t9XUYXFdJw1cE42etbTkTRA9DDuJfo373GRNbwL4VxQpfB8kc3pQ";

let failed = false;
const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const bad = (s: string): void => {
  console.log(`  \x1b[31m✗\x1b[0m ${s}`);
  failed = true;
};

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(URL_RAW, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/** Run one check, turning any throw into a named failure rather than a stack trace. */
async function check(label: string, fn: () => Promise<string>): Promise<void> {
  try {
    ok(`${label}: ${await fn()}`);
  } catch (e) {
    bad(`${label}: ${(e as Error).message}`);
  }
}

async function main(): Promise<void> {
  console.log("\n\x1b[1mSolana RPC health gate\x1b[0m");
  console.log(`     host                     ${HOST}`);
  console.log("     credentials              redacted (the key is in the path and is never logged)");

  if (IS_PUBLIC) {
    bad("this is the PUBLIC mainnet-beta endpoint, not a dedicated RPC");
  } else {
    ok("not the public mainnet-beta endpoint");
  }

  await check("getHealth", async () => {
    const h = await rpc("getHealth", []);
    if (h !== "ok") throw new Error(String(h));
    return "ok";
  });

  await check("getGenesisHash", async () => {
    const g = (await rpc("getGenesisHash", [])) as string;
    if (g !== MAINNET_GENESIS) throw new Error(`${g} is NOT Solana mainnet`);
    return "Solana mainnet";
  });

  await check("getLatestBlockhash", async () => {
    const b = (await rpc("getLatestBlockhash", [{ commitment: "confirmed" }])) as {
      value?: { blockhash?: string; lastValidBlockHeight?: number };
    };
    if (!b.value?.blockhash) throw new Error("no blockhash returned");
    return `valid through height ${b.value.lastValidBlockHeight}`;
  });

  await check("getTokenAccountBalance", async () => {
    const t = (await rpc("getTokenAccountBalance", [TREASURY_ATA])) as {
      value?: { uiAmountString?: string; decimals?: number };
    };
    if (!t.value?.uiAmountString) throw new Error("empty result");
    return `${t.value.uiAmountString} USDC (${t.value.decimals} dp)`;
  });

  /**
   * The method the public endpoint sheds under load, with a 503, mid-proof.
   *
   * The derived-ATA fallback stays regardless of this passing. A fallback that exists only because one
   * RPC was unreliable is still the correct shape: deriving the address is deterministic, and not
   * depending on an index scan is strictly better than depending on one.
   */
  await check("getTokenAccountsByOwner", async () => {
    const o = (await rpc("getTokenAccountsByOwner", [
      TREASURY,
      { mint: USDC_MINT },
      { encoding: "jsonParsed" },
    ])) as { value?: unknown[] };
    const n = o.value?.length ?? 0;
    if (n === 0) throw new Error("no USDC token account found for the treasury");
    return `${n} account(s)`;
  });

  await check("getSignatureStatuses", async () => {
    const s = (await rpc("getSignatureStatuses", [
      [PRIOR_SIG],
      { searchTransactionHistory: true },
    ])) as { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] };
    const st = s.value?.[0];
    if (!st) throw new Error("the prior settlement signature was not found");
    return `${st.confirmationStatus}, err ${JSON.stringify(st.err)}`;
  });

  let versionSeen: unknown = "(not read)";
  await check("getTransaction", async () => {
    const tx = (await rpc("getTransaction", [
      PRIOR_SIG,
      { maxSupportedTransactionVersion: 0, commitment: "confirmed", encoding: "jsonParsed" },
    ])) as {
      version?: unknown;
      slot?: number;
      meta?: { err?: unknown; preTokenBalances?: unknown[]; postTokenBalances?: unknown[] };
    } | null;
    if (!tx) throw new Error("the prior settlement was not returned");
    versionSeen = tx.version;
    const pre = tx.meta?.preTokenBalances?.length ?? 0;
    const post = tx.meta?.postTokenBalances?.length ?? 0;
    if (pre === 0 || post === 0) throw new Error("no pre/post token balances, so no delta can be proven");
    return `slot ${tx.slot}, err ${JSON.stringify(tx.meta?.err)}, token balances pre ${pre} post ${post}`;
  });

  if (versionSeen === 0) ok("versioned (v0) transaction parsing confirmed");
  else bad(`expected a v0 versioned transaction, saw ${JSON.stringify(versionSeen)}`);

  if (failed) {
    console.log("\n\x1b[31mRPC GATE: FAIL\x1b[0m");
    console.log("Do not run a paid proof against this endpoint.\n");
    process.exit(1);
  }
  console.log("\n\x1b[32mRPC GATE: PASS\x1b[0m\n");
}

main().catch((e) => {
  console.error(`gate error: ${(e as Error).message}`);
  process.exit(1);
});
