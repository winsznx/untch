/**
 * Create a REAL production Consumer policy, through the anchored path that already exists.
 *
 *   pnpm consumer:policy:create --profile purch-shop-search-proof [--dry-run]
 *
 * WHY THIS IS A CLI AND NOT A NEW ROUTE
 *
 * Production's preflight refuses with `POLICY_NOT_FOUND` because policy 9001 — the literal the old local
 * smoke script carried in-process — has never existed in the production policy store. The obvious fix
 * would be an authenticated operator route that writes a policy row. It would also be wrong.
 *
 * Every `StoredPolicy` carries a `policyHash` and an `onchainRef`, `ConsumerOrchestrator.runPolicy` binds
 * that hash onto the intent, and `projectConsumerIntent` commits to it in the §8.1 struct that the
 * decision is evaluated against. The hash is anchored on X Layer mainnet by `PolicyRegistry.registerPolicy`,
 * whose owner is `msg.sender` — so the stored owner is read from the confirmed `PolicyRegistered` event
 * and cannot be claimed. A route that minted a row without that anchor would produce a policy whose hash
 * commits to nothing, and would quietly reduce every policy in the store to "as trustworthy as whoever
 * holds the operator token". The anchor is the point.
 *
 * So nothing new is built. The existing surface is driven end to end:
 *
 *   POST /create_spend_policy        canonicalise + hash the rules, return UNSIGNED calldata (key-free)
 *   sign + submit registerPolicy     with a dedicated wallet, which thereby becomes the on-chain owner
 *   wait for PolicyRegistered        the event is what decides the policyId and the owner
 *   POST /sync_policy_registration   the ASP reads the confirmed event and stores the row itself
 *   GET  preflight                   confirm production now resolves the policy as ACTIVE
 *
 * WHICH WALLET SIGNS, AND WHY IT IS NOT THE ONE WITH THE MOST GAS
 *
 * `registerPolicy` has no access control: `contracts/src/PolicyRegistry.sol` takes `msg.sender` as the
 * owner and increments that sender's own nonce. Any wallet can register a policy, and registering one
 * grants no authority over anything else. So the correct signer is the LEAST privileged wallet available,
 * not the most convenient one — and this command refuses the privileged keys by name. `ADMIN_PRIVATE_KEY`
 * happens to hold the most OKB on X Layer; that is a reason to leave it alone, not a reason to use it.
 * A dedicated `CONSUMER_POLICY_OWNER_PRIVATE_KEY` whose only power is over its own policies keeps the
 * blast radius of that key equal to the thing it was created for.
 *
 * WHAT THE POLICY ACTUALLY ENFORCES
 *
 * Stated precisely, because a policy profile is the easiest place in this repository to write a claim
 * nothing checks. The deterministic engine reads a documented slice of the ruleset and IGNORES the rest,
 * while `@untch/canon` hashes ALL of it. So:
 *
 *   ENFORCED BY THE ENGINE   the capability, through `categories.allow` / `categories.deny` — the
 *                            projection sets `category` to `consumer.<action>`, so allowing
 *                            `consumer.shop.search` while denying quote, purchase, track and the vault
 *                            capabilities is a real, evaluated control.
 *                            The funding-token per-call cap and daily budget. The duplicate window. The
 *                            same-service cooldown. The calls-per-hour limit. The expiry.
 *
 *   NOT ENFORCED BY THE ENGINE   the provider's IDENTITY. There is no provider rule. `purch only` is
 *                            enforced by the production registry, by `CONSUMER_PROVIDER_PURCH_ENABLED`,
 *                            and by the one-shot proof gate's `providerId` — three controls outside the
 *                            policy. The allowlist is recorded in the ruleset because the hash should
 *                            cover the operator's full stated intent, and it is labelled in the metadata
 *                            as recorded rather than enforced. Claiming otherwise would describe a
 *                            control that does not exist.
 *
 * TWO CEILINGS, IN TWO DIFFERENT CURRENCIES
 *
 * `perCallCap` and `budgets.daily` are DISPLAY units of the FUNDING token (X Layer USDT0), because the
 * projection denominates `amount` in what the user parts with. The `0.020000 USDC` figure is the
 * SETTLEMENT ceiling and is not expressible here at all: it is carried by the operator route's
 * `maxProviderAmount`, the proof gate's `CONSUMER_SOLANA_PROOF_MAX_USDC`, and the payment capability the
 * treasury router mints. Both ceilings are real; neither substitutes for the other.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  decodeFunctionData,
  formatEther,
  formatGwei,
  http,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hashCanonicalJson } from "../packages/canon/src/index";
import { activeChain, activeRpcUrl } from "../packages/shared/src/chains";
import { POLICY_REGISTRY_ABI } from "../packages/policy-store/src/registry";
import { resolvePolicyRegistry } from "../packages/policy-store/src/config";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
const dim = (s: string): string => `\x1b[2m${s}\x1b[0m`;

/**
 * Where the redacted inspection record lands.
 *
 * Gitignored, because it names a wallet and a chain state at an instant rather than anything anyone
 * needs in the repository. It exists so the inspection that preceded a mainnet transaction can be read
 * back afterwards, which a terminal scrollback cannot be relied on for.
 */
const RECORD_DIR = "internal/policy-registration";
const field = (k: string, v: string): void => console.log(`     ${k.padEnd(24)} ${v}`);
const step = (n: number, s: string): void => console.log(`\n\x1b[1m${String(n).padStart(2)}. ${s}\x1b[0m`);
const warn = (s: string): void => console.log(`  \x1b[33m!\x1b[0m ${s}`);

function stop(code: number, why: string): never {
  console.error(`\n\x1b[31mREFUSED\x1b[0m ${why}`);
  process.exit(code);
}

const arg = (n: string): string | null => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && i + 1 < process.argv.length ? (process.argv[i + 1] ?? null) : null;
};
const has = (n: string): boolean => process.argv.includes(`--${n}`);

/**
 * Wallets that hold protocol authority, DERIVED from the environment rather than written down.
 *
 * An earlier version listed six addresses as literals. Deriving them is better on three counts.
 *
 * It is STRONGER: any private key present in the environment contributes its own derived address, so the
 * check covers keys nobody thought to enumerate — including one added to `.env` next year. A literal list
 * only ever refuses what its author remembered.
 *
 * It cannot ROT: a rotated oracle or writer wallet updates itself, whereas a stale literal would quietly
 * stop refusing the key it was written for.
 *
 * And it keeps six 40-character hex strings out of the file. They are public addresses rather than
 * secrets, but they are the shape a scanner matches on, and a false finding still has to be triaged.
 *
 * Compared on the derived ADDRESS in every case, so renaming a variable cannot smuggle a privileged key
 * past the check.
 */
const PRIVILEGED_KEY_VARS: Readonly<Record<string, string>> = {
  ADMIN_PRIVATE_KEY: "the admin / payTo wallet",
  OPERATOR_PRIVATE_KEY: "the operator wallet that signs policy mutations",
  INTENT_WRITER_PRIVATE_KEY: "the on-chain intent writer",
  ORACLE_PRIVATE_KEY: "the oracle signer",
  CONSUMER_TREASURY_BASE_PRIVATE_KEY: "the Base settlement treasury",
  CONSUMER_TEST_FUNDER_PRIVATE_KEY: "the consumer test funder",
};

const PRIVILEGED_ADDRESS_VARS: Readonly<Record<string, string>> = {
  PAY_TO_ADDRESS: "the x402 payTo address",
  MAINNET_WRITER_ADDRESS: "the mainnet intent writer",
  MAINNET_ORACLE_ADDRESS: "the mainnet oracle",
  OPS_WALLET_ADDRESS: "the operations wallet",
};

/** Address -> what it is, for every privileged wallet this environment can name. */
function privilegedAddresses(env: NodeJS.ProcessEnv): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, role] of Object.entries(PRIVILEGED_KEY_VARS)) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    try {
      const derived = privateKeyToAccount((raw.startsWith("0x") ? raw : `0x${raw}`) as Hex);
      out.set(derived.address.toLowerCase(), `${role} (${name})`);
    } catch {
      // A malformed key names no wallet. It cannot be the signer either, so nothing is lost by skipping it.
    }
  }
  for (const [name, role] of Object.entries(PRIVILEGED_ADDRESS_VARS)) {
    const raw = env[name]?.trim();
    if (raw && /^0x[0-9a-fA-F]{40}$/.test(raw)) out.set(raw.toLowerCase(), `${role} (${name})`);
  }
  return out;
}

/**
 * A policy profile: the ruleset, plus an honest note on which layer enforces which part of it.
 *
 * `expiryHours` rather than a fixed instant, so a profile does not rot into one that registers a policy
 * born expired — `registerPolicy` reverts on `expiry <= block.timestamp`, which would be a confusing way
 * to learn that a constant is a year old.
 */
interface PolicyProfile {
  readonly name: string;
  readonly description: string;
  readonly expiryHours: number;
  readonly rules: (expiryIso: string) => Record<string, unknown>;
}

const PROFILES: Readonly<Record<string, PolicyProfile>> = {
  "purch-shop-search-proof": {
    name: "purch-shop-search-proof",
    description: "one bounded Purch shop.search settled on Solana mainnet in canonical USDC",
    expiryHours: 24,
    rules: (expiryIso) => ({
      expiry: expiryIso,

      // ── enforced by the deterministic engine ──
      budgets: {
        // DISPLAY units of the FUNDING token (X Layer USDT0). A 0.010000 USDC provider charge funds at
        // roughly 0.01005 with the disclosed 50 bps cross-rail spread, so this bounds the run about
        // twentyfold above the expected figure and far below anything that could matter.
        daily: 0.25,
        token: "USDT0",
      },
      perCallCap: 0.1,
      onPerCallCapExceeded: "BLOCK",
      escalateAbove: 0.1,
      categories: {
        // The projection sets `category` to `consumer.<action>`, so this IS the capability control.
        allow: ["consumer.shop.search"],
        deny: [
          "consumer.shop.quote",
          "consumer.shop.purchase",
          "consumer.shop.track",
          "consumer.vault.deposit",
          "consumer.vault.withdraw",
          "consumer.vault.purchase",
          "consumer.domains.register",
          "consumer.domains.renew",
          "consumer.travel.book",
          "consumer.gifts.order",
          "consumer.mail.send",
        ],
      },
      // Empty allow means "any recipient". The recipient is read from the provider's own live payment
      // challenge at execution time and is not knowable when a policy is written, so pinning it here
      // would pin a guess. It is bounded instead by the payment capability's recipient allowlist, which
      // the treasury router mints from the challenge that was actually presented.
      recipients: { allow: [], deny: [] },
      agents: { allowWorkerIds: [], denyWorkerIds: [] },
      duplicates: { ttlMin: 1440, keys: ["taskHash", "paramsHash"] },
      cooldowns: { sameServiceMin: 60 },
      rateLimit: { callsPerHour: 1 },

      /**
       * Recorded in the hash, NOT read by the engine.
       *
       * Kept because the anchored hash should cover the operator's whole stated intent rather than the
       * subset the engine happens to read, and labelled so nobody later mistakes it for a control. The
       * `enforcedBy` values name the code that actually refuses.
       */
      untchProofScope: {
        note:
          "Recorded for the anchored hash. The deterministic policy engine reads categories, budgets, " +
          "perCallCap, duplicates, cooldowns, rateLimit and expiry. It does not read the fields below.",
        providerAllowlist: ["purch"],
        providerAllowlistEnforcedBy: [
          "the production provider registry",
          "CONSUMER_PROVIDER_PURCH_ENABLED",
          "the Solana one-shot proof gate providerId",
        ],
        capabilityAllowlist: ["shop.search"],
        capabilityAllowlistEnforcedBy: ["categories.allow in this ruleset (evaluated)"],
        settlementChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        settlementAsset: "USDC",
        settlementCeiling: "0.020000 USDC",
        settlementCeilingEnforcedBy: [
          "the operator route maxProviderAmount",
          "CONSUMER_SOLANA_PROOF_MAX_USDC",
          "the payment capability the treasury router mints",
        ],
        fundingMode: "operator-funded",
        actionCount: 1,
        actionCountEnforcedBy: ["rateLimit.callsPerHour in this ruleset (evaluated)", "the proof gate's single-use claim"],
      },
    }),
  },
};

async function main(): Promise<void> {
  const profileName = arg("profile") ?? "purch-shop-search-proof";
  const profile = PROFILES[profileName];
  if (!profile) {
    stop(2, `unknown --profile ${JSON.stringify(profileName)}; known: ${Object.keys(PROFILES).join(", ")}`);
  }
  const dryRun = has("dry-run");
  const confirmed = has("confirm");
  const aspUrl = (process.env.UNTCH_ASP_URL?.trim() || "https://asp.untch.xyz").replace(/\/+$/, "");

  step(1, "THE SIGNER");
  const rawKey = process.env.CONSUMER_POLICY_OWNER_PRIVATE_KEY?.trim();
  if (!rawKey) {
    stop(
      2,
      "CONSUMER_POLICY_OWNER_PRIVATE_KEY is not set.\n" +
        "  `registerPolicy` takes msg.sender as the owner and has no access control, so the right signer " +
        "is a DEDICATED\n  wallet whose only authority is over its own policies. Generate one, fund it " +
        "with a few thousandths of\n  OKB for gas, and set it. Do not reuse the admin, operator, writer, " +
        "oracle or treasury keys: this command\n  refuses them by derived address.",
    );
  }
  const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);
  const privileged = privilegedAddresses(process.env).get(account.address.toLowerCase());
  if (privileged) {
    stop(
      2,
      `CONSUMER_POLICY_OWNER_PRIVATE_KEY derives ${account.address}, which is ${privileged}.\n` +
        "  Registering a policy grants no authority, so it needs none: use a dedicated wallet whose " +
        "compromise costs\n  nothing beyond its own policies.",
    );
  }
  const knownPrivileged = privilegedAddresses(process.env);
  ok(
    `policy owner ${account.address} holds no other protocol authority ` +
      `(checked against ${knownPrivileged.size} privileged wallet(s) this environment can name)`,
  );

  const chain = activeChain(process.env);
  const rpcUrl = activeRpcUrl(process.env);
  const registry = resolvePolicyRegistry(chain.id, process.env.POLICY_REGISTRY);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });

  field("chain", `${chain.name} (${chain.id})`);
  field("PolicyRegistry", registry);
  field("profile", `${profile.name} — ${profile.description}`);

  const gas = await publicClient.getBalance({ address: account.address });
  field("gas balance", `${formatEther(gas)} OKB`);
  /**
   * An empty wallet is fine for a DRY RUN, and refusing here was the wrong order.
   *
   * The whole point of the rehearsal is to inspect the calldata, the canonical hash and the fee estimate
   * BEFORE deciding to fund anything. A balance check at this point forced funding first, which inverts
   * the sequence: money moves before the thing it is meant to pay for has been read. The check now sits
   * where it belongs, immediately before the broadcast, and compares against the real estimate rather
   * than against zero.
   */
  if (gas === 0n) {
    warn(`${account.address} holds no gas yet. Fine for a dry run; required before a broadcast.`);
  }

  // ── 2. build the unsigned call through the ASP ──────────────────────────────
  step(2, "BUILD — the ASP canonicalises and hashes the rules. It never signs.");
  /**
   * The expiry is PINNABLE, and pinning it is what makes the rehearsal meaningful.
   *
   * It defaults to `now + profile.expiryHours`, which means two runs minutes apart produce different
   * rulesets and therefore different canonical hashes. That is fatal to the one cross-check worth having:
   * "the hash the chain anchored is the hash the dry run showed me". So the dry run prints the exact flag
   * to reuse, and the broadcast run takes it, so both hash the identical ruleset.
   *
   * Validated rather than trusted: a past expiry would revert on chain, and an unbounded one would defeat
   * the point of a bounded proof policy.
   */
  const pinnedExpiry = arg("expires-at");
  const expiryIso =
    pinnedExpiry === null
      ? new Date(Date.now() + profile.expiryHours * 3_600_000).toISOString()
      : new Date(Date.parse(pinnedExpiry)).toISOString();
  if (pinnedExpiry !== null && Number.isNaN(Date.parse(pinnedExpiry))) {
    stop(2, `--expires-at ${JSON.stringify(pinnedExpiry)} is not a parseable instant`);
  }
  const rules = profile.rules(expiryIso);
  /**
   * The `agent` the policy governs.
   *
   * `registerPolicy` refuses the zero address, and the field is part of the anchored record, so it has to
   * name something real. The policy owner's own address is the honest answer for an operator-funded proof:
   * the wallet that owns the policy is the party the policy governs. A fabricated third address would put
   * an unowned identity into a permanent on-chain record.
   */
  const agent: Address = account.address;

  const buildRes = await fetch(`${aspUrl}/create_spend_policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent, rules }),
  });
  const buildBody = (await buildRes.json()) as Record<string, unknown>;
  if (buildRes.status !== 200) {
    stop(3, `POST /create_spend_policy answered ${buildRes.status}: ${JSON.stringify(buildBody).slice(0, 500)}`);
  }
  const policyHash = String(buildBody.policyHash) as Hex;
  field("policyHash", policyHash);
  field("registry (ASP)", String(buildBody.registry));
  field("chainId (ASP)", String(buildBody.chainId));
  field("expiry", `${String(buildBody.expiry)} (${expiryIso})`);

  /**
   * The ASP's registry must be the one this command is about to write to.
   *
   * Otherwise the sync step would read a receipt from a chain the ASP does not index, and report a policy
   * that its own reader cannot find. Comparing them is one line and removes a whole class of confusing
   * half-registered state.
   */
  if (String(buildBody.registry).toLowerCase() !== registry.toLowerCase()) {
    stop(
      3,
      `the ASP builds against registry ${String(buildBody.registry)} but this command would submit to ${registry}`,
    );
  }
  if (Number(buildBody.chainId) !== chain.id) {
    stop(3, `the ASP builds for chain ${String(buildBody.chainId)} but this command is on ${chain.id}`);
  }

  /**
   * Recompute the canonical hash LOCALLY, with the same library the ASP uses, and require a match.
   *
   * The previous version hashed `JSON.stringify(rules)` and admitted in its own label that this was a
   * change detector rather than the canonical hash. That is not a verification: it could not have caught
   * an ASP that hashed a different ruleset than the one submitted, which is the single thing worth
   * checking before anchoring a hash on mainnet forever. `hashCanonicalJson` is the function the ASP
   * calls, so computing it here and comparing is an independent confirmation rather than a restatement.
   */
  const localCanonicalHash = hashCanonicalJson(rules as unknown as Record<string, unknown>) as Hex;
  field("local canonical hash", localCanonicalHash);
  if (localCanonicalHash.toLowerCase() !== policyHash.toLowerCase()) {
    stop(
      3,
      `the ASP anchored hash ${policyHash} does not match the locally recomputed canonical hash ` +
        `${localCanonicalHash}. The ASP hashed something other than the ruleset submitted. Refusing.`,
    );
  }
  ok("the ASP hashed exactly the ruleset this command submitted");

  // ── 2b. the calldata, decoded and checked against what it claims to be ──────
  step(3, "CALLDATA — decoded locally, never trusted as returned");
  const calldata = String(buildBody.unsignedTx && (buildBody.unsignedTx as Record<string, unknown>).calldata) as Hex;
  const unsignedTo = String((buildBody.unsignedTx as Record<string, unknown>).to);
  const expectedSelector = toFunctionSelector("registerPolicy(address,bytes32,uint64)");
  const expiry = BigInt(String(buildBody.expiry));

  field("target", unsignedTo);
  field("selector", `${calldata.slice(0, 10)} (registerPolicy = ${expectedSelector})`);
  field("calldata length", `${(calldata.length - 2) / 2} bytes`);
  const calldataHash = `0x${createHash("sha256").update(calldata).digest("hex")}`;
  field("calldata hash", calldataHash);

  /**
   * Decode it and compare every argument, rather than trusting the decoded args the ASP also returned.
   *
   * A route that returned correct-looking `args` alongside calldata encoding something else is exactly
   * the failure a caller cannot see. The bytes are what gets signed, so the bytes are what gets checked.
   */
  const decoded = decodeFunctionData({ abi: POLICY_REGISTRY_ABI, data: calldata });
  const problems: string[] = [];
  if (unsignedTo.toLowerCase() !== registry.toLowerCase()) {
    problems.push(`target ${unsignedTo} is not the production PolicyRegistry ${registry}`);
  }
  if (!calldata.toLowerCase().startsWith(expectedSelector.toLowerCase())) {
    problems.push(`selector ${calldata.slice(0, 10)} is not registerPolicy`);
  }
  if (decoded.functionName !== "registerPolicy") {
    problems.push(`the calldata calls ${decoded.functionName}, not registerPolicy`);
  }
  const args = (decoded.args ?? []) as readonly unknown[];
  if (args.length !== 3) problems.push(`registerPolicy takes 3 arguments; the calldata carries ${args.length}`);
  if (String(args[0]).toLowerCase() !== agent.toLowerCase()) {
    problems.push(`the encoded agent ${String(args[0])} is not this wallet`);
  }
  if (String(args[1]).toLowerCase() !== localCanonicalHash.toLowerCase()) {
    problems.push(`the encoded policy hash ${String(args[1])} is not the locally recomputed hash`);
  }
  if (BigInt(String(args[2])) !== expiry) {
    problems.push(`the encoded expiry ${String(args[2])} is not ${expiry}`);
  }
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  if (expiry <= nowSec) problems.push(`expiry ${expiry} is not in the future`);
  if (expiry > nowSec + 7n * 86_400n) {
    problems.push(`expiry ${expiry} is more than seven days out; a proof policy must be bounded`);
  }
  if (problems.length > 0) {
    stop(3, `the calldata does not match what it claims:\n  ${problems.join("\n  ")}`);
  }
  ok("target, selector, agent, policy hash and expiry all match, decoded from the bytes");
  console.log(
    dim(
      "     registerPolicy takes an agent, a hash and an expiry. It moves no value, approves no token,\n" +
        "     names no treasury, grants no role, calls no arbitrary target and cannot be bundled: the\n" +
        "     decoded argument list above is the entire effect of this transaction.",
    ),
  );

  // ── 2c. what the deterministic engine will and will not enforce ─────────────
  step(4, "RULES — what the engine evaluates, and what it does not");
  const cats = (rules.categories as { allow: string[]; deny: string[] });
  const budgets = rules.budgets as { daily: number; token: string };
  const dup = rules.duplicates as { ttlMin: number; keys: string[] };
  field("category allow", cats.allow.join(", "));
  field("category deny", `${cats.deny.length} denied, incl. ${cats.deny.slice(0, 3).join(", ")}`);
  field("perCallCap", `${String(rules.perCallCap)} ${budgets.token} (FUNDING token display units)`);
  field("onPerCallCapExceeded", String(rules.onPerCallCapExceeded));
  field("daily budget", `${budgets.daily} ${budgets.token}`);
  field("rateLimit", `${String((rules.rateLimit as { callsPerHour: number }).callsPerHour)} call(s)/hour`);
  field("cooldown", `${String((rules.cooldowns as { sameServiceMin: number }).sameServiceMin)} min same-service`);
  field("duplicates", `${dup.ttlMin} min window on ${dup.keys.join(" + ")}`);
  field("expiry", expiryIso);
  field("policy version", "1 (registerPolicy always mints version 1)");
  console.log(
    dim(
      "     ENFORCED by the engine: the category allow/deny lists, the funding-token per-call cap and\n" +
        "     daily budget, the duplicate window, the cooldown, the calls-per-hour limit, the expiry.\n" +
        "     NOT enforced by the engine: the PROVIDER's identity. There is no provider rule. `purch only`\n" +
        "     is enforced by the production registry, by CONSUMER_PROVIDER_PURCH_ENABLED, and by the proof\n" +
        "     gate's providerId. The 0.020000 USDC SETTLEMENT ceiling is likewise not here: it is carried\n" +
        "     by the operator route's maxProviderAmount, CONSUMER_SOLANA_PROOF_MAX_USDC, and the payment\n" +
        "     capability the treasury router mints. Both ceilings are real; neither substitutes for the other.",
    ),
  );

  // ── 2d. gas, estimated against the real chain ──────────────────────────────
  step(5, "COST — estimated against the live chain");
  /**
   * Estimated with a BALANCE OVERRIDE when the wallet is still empty.
   *
   * X Layer's node enforces the sender's balance during `eth_estimateGas`, so an unfunded account cannot
   * price its own transaction — which would force funding before the rehearsal that decides whether to
   * fund. A state override lends the sender a synthetic balance for the simulation only. Nothing else
   * about the call changes: same sender, same nonce, same calldata, so the gas figure is this
   * transaction's, and a revert for any REAL reason still surfaces as a revert.
   *
   * A failed estimate is a REFUSAL rather than a warning. The simulation executes the call, so a revert
   * means this exact transaction would revert on chain — an id collision, a zero hash, an expiry already
   * past. Broadcasting anyway would spend gas to learn what the simulation already said.
   */
  const estimateArgs = {
    address: registry,
    abi: POLICY_REGISTRY_ABI,
    functionName: "registerPolicy" as const,
    args: [agent, localCanonicalHash, expiry] as const,
    account,
  };
  let gasEstimate: bigint | null = null;
  let estimateMode = "direct";
  try {
    gasEstimate = await publicClient.estimateContractGas(estimateArgs);
  } catch (direct) {
    try {
      gasEstimate = await publicClient.estimateContractGas({
        ...estimateArgs,
        stateOverride: [{ address: account.address, balance: 10n ** 16n }],
      });
      estimateMode = "with a simulated balance (this wallet is not yet funded)";
    } catch (overridden) {
      stop(
        5,
        "the gas estimate reverted, so this transaction would revert on chain.\n" +
          `  direct:     ${(direct as Error).message.slice(0, 200)}\n` +
          `  overridden: ${(overridden as Error).message.slice(0, 200)}`,
      );
    }
  }
  const gasPrice = await publicClient.getGasPrice();
  const maxFee = (gasEstimate ?? 0n) * gasPrice;
  field("estimated gas", `${String(gasEstimate)} (${estimateMode})`);
  field("gas price", `${formatGwei(gasPrice)} gwei`);
  field("maximum fee", `${formatEther(maxFee)} OKB`);
  field("owner balance", `${formatEther(gas)} OKB`);
  field("funding needed", gas >= maxFee ? "none" : `${formatEther(maxFee - gas)} OKB`);

  /**
   * A redacted record of exactly what was inspected, written before anything is signed.
   *
   * It holds no key and no signed transaction: a signed transaction on disk is a broadcastable artefact,
   * and the point of this file is to be a record rather than a second way to submit.
   */
  const record = {
    inspectedAt: new Date().toISOString(),
    owner: account.address,
    agent,
    policyHash: localCanonicalHash,
    hashConfirmedIndependently: true,
    registry,
    chainId: chain.id,
    expiry: Number(expiry),
    expiryIso,
    calldataHash,
    calldataBytes: (calldata.length - 2) / 2,
    selector: calldata.slice(0, 10),
    estimatedGas: String(gasEstimate),
    maximumFeeOkb: formatEther(maxFee),
    rulesSummary: {
      categoryAllow: cats.allow,
      categoryDenyCount: cats.deny.length,
      perCallCap: rules.perCallCap,
      dailyBudget: budgets.daily,
      fundingToken: budgets.token,
      callsPerHour: (rules.rateLimit as { callsPerHour: number }).callsPerHour,
      cooldownMin: (rules.cooldowns as { sameServiceMin: number }).sameServiceMin,
      duplicateWindowMin: dup.ttlMin,
    },
  };
  mkdirSync(RECORD_DIR, { recursive: true });
  const recordPath = join(RECORD_DIR, `policy-dry-run-${localCanonicalHash.slice(2, 18)}.json`);
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  field("record", recordPath);

  if (dryRun) {
    step(6, "DRY RUN — nothing was signed, submitted or stored.");
    console.log(JSON.stringify({ agent, policyHash: localCanonicalHash, expiry: Number(expiry), rules }, null, 2));
    console.log(
      `\n  To submit EXACTLY this ruleset and EXACTLY this hash, reuse the pinned expiry:\n` +
        `    pnpm consumer:policy:create --profile ${profile.name} \\\n` +
        `      --expires-at ${expiryIso} --confirm\n\n` +
        `  Without --expires-at the expiry moves, the canonical hash changes, and the hash anchored on\n` +
        `  chain would not be the one inspected above.`,
    );
    return;
  }

  /**
   * An explicit confirmation flag for the broadcast, separate from the absence of --dry-run.
   *
   * Forgetting a flag should not be how a mainnet transaction gets signed. `--dry-run` off means "I am
   * not asking for a rehearsal"; `--confirm` means "I have read the inspection above and I am asking for
   * this exact transaction". Requiring both makes the accidental case a no-op rather than a broadcast.
   */
  if (!confirmed) {
    step(6, "NOT SUBMITTED — every check above passed, and --confirm was not passed.");
    console.log(
      `  Everything is verified and nothing was signed. To submit exactly one transaction:\n` +
        `    pnpm consumer:policy:create --profile ${profile.name} --confirm`,
    );
    return;
  }

  // ── 3. sign and submit ─────────────────────────────────────────────────────
  /**
   * The balance gate, where it can be compared against a real number.
   *
   * Re-read rather than reused: the dry run may have been minutes or hours earlier, and the funding
   * transaction that followed it is exactly the state change this needs to see.
   */
  const balanceNow = await publicClient.getBalance({ address: account.address });
  if (balanceNow < maxFee) {
    stop(
      6,
      `this wallet holds ${formatEther(balanceNow)} OKB, under the ${formatEther(maxFee)} OKB this ` +
        "transaction is estimated to cost. Fund it and re-run.",
    );
  }

  step(7, "REGISTER — this wallet signs, so this wallet becomes the on-chain owner.");
  field("owner balance", `${formatEther(balanceNow)} OKB`);
  const txHash = await walletClient.writeContract({
    address: registry,
    abi: POLICY_REGISTRY_ABI,
    functionName: "registerPolicy",
    // The verified values, not the returned ones. Everything here was decoded from the calldata above.
    args: [agent, localCanonicalHash, expiry],
  });
  field("tx", txHash);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 2 });
  if (receipt.status !== "success") stop(4, `registerPolicy reverted in ${txHash}`);
  ok(`registerPolicy confirmed in block ${receipt.blockNumber}`);

  /**
   * Read the policyId out of the event, not out of an assumption.
   *
   * `previewPolicyId` would predict it from the owner's nonce, and would be wrong the moment two
   * registrations race. The event is what the contract actually committed.
   */
  let policyId: string | null = null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== registry.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: POLICY_REGISTRY_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "PolicyRegistered") {
        policyId = String((decoded.args as { policyId: bigint }).policyId);
      }
    } catch {
      // A log from this address that is not a PolicyRegistered event. Skipped, never guessed at.
    }
  }
  if (policyId === null) stop(4, `no PolicyRegistered event in ${txHash}`);
  field("policyId", policyId);

  // ── 4. sync ────────────────────────────────────────────────────────────────
  step(8, "SYNC — the ASP reads the confirmed event and stores the row with the owner it finds there.");
  const syncRes = await fetch(`${aspUrl}/sync_policy_registration`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash, rules }),
  });
  const syncBody = (await syncRes.json()) as Record<string, unknown>;
  if (syncRes.status !== 200) {
    stop(
      4,
      `POST /sync_policy_registration answered ${syncRes.status}: ${JSON.stringify(syncBody).slice(0, 500)}\n` +
        `  The policy IS registered on chain as ${policyId}. Re-run the sync; do NOT register again.`,
    );
  }
  if (String(syncBody.policyId) !== policyId) {
    stop(4, `the ASP synced policy ${String(syncBody.policyId)} but the chain committed ${policyId}`);
  }
  ok(`production stored policy ${policyId}`);
  field("owner (from chain)", String(syncBody.owner));
  field("version", String(syncBody.version));
  field("alreadyStored", String(syncBody.alreadyStored));

  if (String(syncBody.owner).toLowerCase() !== account.address.toLowerCase()) {
    warn(
      `the stored owner ${String(syncBody.owner)} is not this signer. That should be impossible for a ` +
        "fresh registration — investigate before using this policy.",
    );
  }

  step(9, "VERIFY — production resolves it as ACTIVE, read back through its own preflight.");
  const opsToken = process.env.INTERNAL_OPS_TOKEN?.trim();
  if (!opsToken) {
    warn("INTERNAL_OPS_TOKEN is not set, so the readback was skipped. Verify with the controller instead:");
    console.log(`     pnpm consumer:smoke:live --deployed-worker-only --policy-id ${policyId} --preflight-only …`);
  } else {
    const probe = await fetch(`${aspUrl}/internal/consumer/intents/preflight`, {
      method: "POST",
      headers: { authorization: `Bearer ${opsToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        // A throwaway id. Preflight writes nothing, so this reserves no intent and consumes no key.
        intentId: `ci_${createHash("sha256").update(`policy-readback:${policyId}`).digest("hex").slice(0, 24)}`,
        tenantId: `policy:${policyId}`,
        owner: `operator:policy-readback`,
        provider: "purch",
        capability: "shop.search",
        request: { query: "policy readback" },
        maxProviderAmount: "0.020000",
        expectedSettlementChain: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        expectedSettlementAsset: "USDC",
        fundingMode: "operator-funded",
        idempotencyKey: `policy-readback-${policyId}`,
      }),
    });
    const plan = (await probe.json()) as Record<string, unknown>;
    const path = plan.expectedPolicyPath as { policyId?: string; found?: boolean; status?: string } | undefined;
    field("readinessClass", String(plan.readinessClass));
    field("policy found", String(path?.found));
    field("policy status", String(path?.status));
    if (path?.found === true && path?.status === "ACTIVE") {
      ok("production resolves this policy as ACTIVE through the normal deterministic path");
    } else {
      stop(5, "production did not resolve the new policy as ACTIVE — do not arm anything");
    }
  }

  console.log(`\n\x1b[1mPOLICY ID ${policyId}\x1b[0m`);
  console.log(`  tenant  policy:${policyId}`);
  console.log(`  tx      ${txHash}`);
  console.log(`  owner   ${account.address}`);
  console.log(`  expiry  ${expiryIso}`);
}

main().catch((err: unknown) => {
  console.error(`\n\x1b[31mFAILED\x1b[0m ${(err as Error).message}`);
  process.exit(1);
});
