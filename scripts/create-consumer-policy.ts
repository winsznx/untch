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
import { createPublicClient, createWalletClient, http, decodeEventLog, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, activeRpcUrl } from "../packages/shared/src/chains";
import { POLICY_REGISTRY_ABI } from "../packages/policy-store/src/registry";
import { resolvePolicyRegistry } from "../packages/policy-store/src/config";

const ok = (s: string): void => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
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
  field("gas balance", `${gas} wei`);
  if (gas === 0n) stop(2, `${account.address} holds no gas on chain ${chain.id}; fund it before registering`);

  // ── 2. build the unsigned call through the ASP ──────────────────────────────
  step(2, "BUILD — the ASP canonicalises and hashes the rules. It never signs.");
  const expiryIso = new Date(Date.now() + profile.expiryHours * 3_600_000).toISOString();
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

  const localHash = `0x${createHash("sha256").update(JSON.stringify(rules)).digest("hex")}`;
  field("local rules digest", `${localHash.slice(0, 18)}… (not the canonical hash; a change detector only)`);

  if (dryRun) {
    step(3, "DRY RUN — nothing was signed, submitted or stored.");
    console.log(JSON.stringify({ agent, policyHash, expiry: buildBody.expiry, rules }, null, 2));
    return;
  }

  // ── 3. sign and submit ─────────────────────────────────────────────────────
  step(3, "REGISTER — this wallet signs, so this wallet becomes the on-chain owner.");
  const expiry = BigInt(String(buildBody.expiry));
  const txHash = await walletClient.writeContract({
    address: registry,
    abi: POLICY_REGISTRY_ABI,
    functionName: "registerPolicy",
    args: [agent, policyHash, expiry],
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
  step(4, "SYNC — the ASP reads the confirmed event and stores the row with the owner it finds there.");
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

  step(5, "VERIFY — production resolves it as ACTIVE, read back through its own preflight.");
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
