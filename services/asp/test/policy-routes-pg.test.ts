import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, getAddress, verifyMessage, type Address, type Hex } from "viem";
import { hashCanonicalJson } from "@untch/canon";
import { PgAccountStore, createPool, runMigrations, type Pool } from "@untch/consumer-core";
import {
  PgPolicyRepo,
  PolicyProvider,
  PolicyRegistrationService,
  POLICY_REGISTRY_ABI,
  type OnchainRegistration,
  type RegisterCall,
  type RegistryReader,
} from "@untch/policy-store";
import { runMigrations as runPolicyMigrations, createPool as createPolicyPool } from "@untch/policy-store";
import { makeAccountRoutesDeps, registerAccountRoutes } from "../src/consumer/account-routes";
import { registerPolicyRoutes } from "../src/consumer/policy-routes";
import { buildLinkMessage } from "../src/consumer/account-auth";
import type { SiweVerifier } from "../src/consumer/auth";
import type { HandlerResult } from "../src/handlers";

/**
 * The policy journey end to end, against real Postgres and a real signature.
 *
 * WHAT IS FAKED, AND WHY EXACTLY THAT
 *
 * The CHAIN is faked and nothing else. `FakeRegistry` answers `getRegistrationFromReceipt` from a table
 * this test controls, which is the only way to exercise the interesting cases at all — a registration
 * whose owner is a stranger, a receipt whose anchored hash disagrees with the draft. Both of those are
 * transactions nobody can produce on demand against a real registry, and neither can be reached by a
 * test that only ever registers correctly.
 *
 * Everything else is real: real Postgres and real constraints, real SIWE signatures verified by viem's
 * own recovery, the real `PolicyRegistrationService`, the real canonicaliser, and the real calldata
 * encoder — so the transaction this suite asserts on is byte-identical to the one a wallet would be
 * asked to send.
 *
 * REQUIRES a throwaway Postgres in TEST_DATABASE_URL. Skipped, loudly, when absent. DESTRUCTIVE.
 */

const TEST_DB = process.env.TEST_DATABASE_URL?.trim();
const DOMAIN = "asp.untch.xyz";
const SECRET = "test-policy-session-secret-value";
const REGISTRY = "0x1111111111111111111111111111111111111111" as Address;
const AGENT = "0x2222222222222222222222222222222222222222" as Address;
const CHAIN_ID = 196;

const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const STRANGER = privateKeyToAccount("0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba");

const LOCAL_VERIFIER: SiweVerifier = {
  async verify({ message, signature }) {
    for (const a of [OWNER, STRANGER]) {
      if (await verifyMessage({ address: a.address, message, signature: signature as Hex })) return true;
    }
    return false;
  },
};

/**
 * A registry whose confirmed registrations this test writes by hand.
 *
 * `buildRegister` is the REAL encoding — same ABI, same function, same argument order — so a wallet
 * handed this calldata would produce exactly the registration the sync path then expects.
 */
class FakeRegistry implements RegistryReader {
  readonly registryAddress = REGISTRY;
  readonly chainId = CHAIN_ID;
  private readonly confirmed = new Map<string, OnchainRegistration>();
  private nextId = 9000n;

  buildRegister(agent: Address, policyHash: Hex, expiry: bigint): RegisterCall {
    return {
      to: REGISTRY,
      functionName: "registerPolicy",
      args: [agent, policyHash, expiry.toString()],
      calldata: encodeFunctionData({
        abi: POLICY_REGISTRY_ABI,
        functionName: "registerPolicy",
        args: [agent, policyHash, expiry],
      }),
      chainId: CHAIN_ID,
    };
  }

  /** Record what a confirmed registerPolicy transaction would have emitted. */
  confirm(args: { txHash: Hex; owner: Address; policyHash: Hex; expiry: number }): string {
    const policyId = this.nextId++;
    this.confirmed.set(args.txHash.toLowerCase(), {
      policyId,
      owner: args.owner,
      agent: AGENT,
      policyHash: args.policyHash,
      expiry: BigInt(args.expiry),
      version: 1,
      txHash: args.txHash,
      blockNumber: 100,
    });
    return policyId.toString();
  }

  async getRegistrationFromReceipt(txHash: Hex): Promise<OnchainRegistration> {
    const found = this.confirmed.get(txHash.toLowerCase());
    if (!found) throw new Error(`no PolicyRegistered event in ${txHash}`);
    return found;
  }
}

let pool: Pool;
let baseUrl: string;
let registry: FakeRegistry;
const servers: Server[] = [];

function send(res: express.Response, r: HandlerResult): void {
  res.status(r.status).json(r.body);
}


/**
 * This suite's OWN database, for the reason the two-process controller suite established.
 *
 * Node's test runner runs FILES in parallel, and several suites here reset the public schema to build
 * a known starting shape. Sharing one database means they drop it from under each other, which reads
 * as flakiness and is a shared-resource collision. Isolation fixes the class rather than the instance.
 */
const OWN_DATABASE = "untch_test_policy_routes";

function ownDatabaseUrl(): string {
  const url = new URL(TEST_DB as string);
  url.pathname = `/${OWN_DATABASE}`;
  return url.toString();
}

async function createOwnDatabase(): Promise<void> {
  const admin = createPool(TEST_DB as string);
  try {
    // CREATE DATABASE cannot run inside a transaction, and a duplicate is not worth failing on.
    await admin.query(`CREATE DATABASE ${OWN_DATABASE}`).catch((err: unknown) => {
      if ((err as { code?: string }).code !== "42P04") throw err;
    });
  } finally {
    await admin.end();
  }
}

async function boot(): Promise<void> {
  await createOwnDatabase();
  pool = createPool(ownDatabaseUrl());
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  await runMigrations(pool);
  // The policy store owns its own migration directory and shares the same database.
  const policyPool = createPolicyPool(ownDatabaseUrl());
  await runPolicyMigrations(policyPool);
  await policyPool.end();

  registry = new FakeRegistry();
  const repo = new PgPolicyRepo(pool);
  const accountDeps = makeAccountRoutesDeps({
    pool,
    verifier: LOCAL_VERIFIER,
    domain: DOMAIN,
    publicBaseUrl: "https://asp.untch.xyz",
    secret: SECRET,
    allowedReturnOrigins: ["https://www.untch.xyz"],
  });

  const app = express();
  app.use(express.json({ limit: "256kb" }));
  registerAccountRoutes(app, send, accountDeps);
  registerPolicyRoutes(app, send, {
    accounts: new PgAccountStore(pool),
    registration: new PolicyRegistrationService(repo, registry),
    policies: new PolicyProvider(repo),
    secret: SECRET,
  });

  baseUrl = await new Promise<string>((resolve) => {
    const server = app.listen(0, () => {
      servers.push(server);
      const addr = server.address();
      resolve(`http://127.0.0.1:${typeof addr === "object" && addr !== null ? addr.port : 0}`);
    });
  });
}

type Res = { status: number; body: Record<string, unknown> };

async function call(method: string, path: string, body: unknown, token?: string): Promise<Res> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const post = (p: string, b: unknown, t?: string) => call("POST", p, b, t);
const put = (p: string, b: unknown, t?: string) => call("PUT", p, b, t);
const get = (p: string, t?: string) => call("GET", p, undefined, t);

async function signIn(signer: typeof OWNER): Promise<string> {
  const start = await post("/consumer/account/link/start", { requestedScopes: ["identity", "policy-authority"] });
  const nonce = (start.body.walletAction as { nonce: string }).nonce;
  const message = buildLinkMessage({
    domain: DOMAIN,
    uri: `https://${DOMAIN}`,
    address: signer.address,
    chainId: CHAIN_ID,
    nonce,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    scopes: ["identity", "policy-authority"],
  });
  const signature = await signer.signMessage({ message });
  const complete = await post("/consumer/account/link/complete", {
    linkRequestId: start.body.linkRequestId,
    code: start.body.oneTimeCode,
    message,
    signature,
  });
  assert.equal(complete.status, 200, JSON.stringify(complete.body));
  return (complete.body.session as { token: string }).token;
}

const YEAR_AWAY = new Date(Date.now() + 365 * 86_400_000).toISOString();

function draftBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Gifts and small errands",
    currency: "USDC",
    perActionLimit: "8.00",
    dailyLimit: "40.00",
    autoApproveAtOrBelow: "5.00",
    hardCap: "8.00",
    allowedCapabilities: ["gifts.order", "shop.purchase"],
    expiry: YEAR_AWAY,
    ...over,
  };
}

/** Draft, pretend the wallet sent it, and sync — the whole happy path in one helper. */
async function registerPolicy(
  token: string,
  owner: Address,
  over: Record<string, unknown> = {},
): Promise<{ draft: Res; sync: Res; policyId: string }> {
  const draft = await post("/consumer/policies/draft", draftBody(over), token);
  assert.equal(draft.status, 200, JSON.stringify(draft.body));
  const txHash = `0x${Buffer.from(String(draft.body.policyDraftId)).toString("hex").padEnd(64, "0").slice(0, 64)}` as Hex;
  const policyId = registry.confirm({
    txHash,
    owner,
    policyHash: draft.body.policyHash as Hex,
    expiry: Math.floor(Date.parse(String(over.expiry ?? YEAR_AWAY)) / 1000),
  });
  const sync = await post(
    "/consumer/policies/sync",
    { policyDraftId: draft.body.policyDraftId, txHash },
    token,
  );
  return { draft, sync, policyId };
}

describe("the policy journey", { skip: TEST_DB ? false : "TEST_DATABASE_URL is unset" }, () => {
  before(async () => {
    await boot();
  });

  after(async () => {
    for (const s of servers) s.close();
    await pool.end();
  });

  test("a draft returns the exact transaction the wallet will send, and the rules it commits to", async () => {
    const token = await signIn(OWNER);
    const draft = await post("/consumer/policies/draft", draftBody(), token);
    assert.equal(draft.status, 200, JSON.stringify(draft.body));

    // The hash is the one the registry will see, computed by the same canonicaliser.
    const rules = draft.body.canonicalRules as Record<string, unknown>;
    assert.equal(draft.body.policyHash, hashCanonicalJson(rules));

    const tx = draft.body.transaction as Record<string, unknown>;
    assert.equal(tx.to, REGISTRY);
    assert.equal(tx.chainId, CHAIN_ID);
    assert.equal(tx.functionName, "registerPolicy");
    /**
     * The governed agent now defaults to the ACCOUNT'S OWN authority, not to a server address.
     *
     * It used to default to `MAINNET_WRITER_ADDRESS` — the receipt writer. A user drafting without
     * naming an agent would have registered, immutably, a declaration that their spending rules govern
     * Untch's receipt-anchoring key. Nothing enforces `policy.agent` on chain, so no money would have
     * moved wrongly; it would simply have been permanently false.
     */
    assert.equal(
      tx.data,
      encodeFunctionData({
        abi: POLICY_REGISTRY_ABI,
        functionName: "registerPolicy",
        args: [
          getAddress(OWNER.address) as Address,
          draft.body.policyHash as Hex,
          BigInt(Math.floor(Date.parse(YEAR_AWAY) / 1000)),
        ],
      }),
    );
    const roles = draft.body.roles as { governedAgent: { is: string } };
    assert.equal(roles.governedAgent.is.toLowerCase(), OWNER.address.toLowerCase());

    // And it says whose key must send it, which is the property the server structurally cannot supply.
    const mustBeSentBy = draft.body.mustBeSentBy as { addresses: string[]; reason: string };
    assert.deepEqual(mustBeSentBy.addresses, [OWNER.address.toLowerCase()]);
    assert.match(mustBeSentBy.reason, /Untch does not relay it/);
  });

  test("an Untch operational address is refused as the governed agent, even when asked for", async () => {
    const token = await signIn(OWNER);
    // The receipt writer: the exact address the route used to default to.
    const draft = await post(
      "/consumer/policies/draft",
      { ...(draftBody() as Record<string, unknown>), agentId: "0xeeDda7D18A34A93F3A722eb4446A526Af515457A" },
      token,
    );
    assert.equal(draft.status, 409, JSON.stringify(draft.body));
    assert.equal(draft.body.code, "OPERATOR_ADDRESS_REFUSED");
    assert.match(String(draft.body.message), /receipt-writer/);
  });

  test("the derived defaults are shown rather than hidden", async () => {
    const token = await signIn(OWNER);
    const draft = await post("/consumer/policies/draft", draftBody(), token);
    const derived = draft.body.derivedDefaults as Array<{ field: string; value: string; because: string }>;
    const names = derived.map((x) => x.field);
    for (const expected of ["duplicates.ttlMin", "rateLimit.callsPerHour", "onPerCallCapExceeded"]) {
      assert.ok(names.includes(expected), `${expected} was decided but not shown; saw ${names.join(", ")}`);
    }
    // Every default carries the reasoning, so a user can disagree with it on purpose.
    assert.ok(derived.every((x) => x.because.length > 20));
  });

  test("a policy registered by the account's own wallet is linked, and becomes the first default", async () => {
    const token = await signIn(OWNER);
    const { sync, policyId } = await registerPolicy(token, OWNER.address);

    assert.equal(sync.status, 200, JSON.stringify(sync.body));
    assert.equal(sync.body.policyId, policyId);
    assert.equal(String(sync.body.owner).toLowerCase(), OWNER.address.toLowerCase());
    assert.equal(sync.body.becameDefault, true, "an account with one policy and no default fails its next preflight");

    const listed = await get("/consumer/policies", token);
    assert.equal(listed.body.defaultPolicyId, policyId);
    const policies = listed.body.policies as Array<Record<string, unknown>>;
    assert.ok(policies.some((p) => p.policyId === policyId && p.isDefault === true));
  });

  test("a registration whose on-chain owner is a stranger is refused, not adopted", async () => {
    const token = await signIn(OWNER);
    const draft = await post("/consumer/policies/draft", draftBody(), token);
    const txHash = "0xdead0000000000000000000000000000000000000000000000000000000beef01" as Hex;
    // The chain says a DIFFERENT address registered it. Without the owner check, this account would
    // inherit a policy it cannot sign for and could then name as its default.
    registry.confirm({
      txHash,
      owner: STRANGER.address,
      policyHash: draft.body.policyHash as Hex,
      expiry: Math.floor(Date.parse(YEAR_AWAY) / 1000),
    });

    const sync = await post("/consumer/policies/sync", { policyDraftId: draft.body.policyDraftId, txHash }, token);
    assert.equal(sync.status, 403);
    assert.equal(sync.body.code, "NOT_POLICY_OWNER");
    assert.equal(String(sync.body.registeredOwner).toLowerCase(), STRANGER.address.toLowerCase());
  });

  test("a receipt anchoring a different hash than the draft is refused", async () => {
    const token = await signIn(OWNER);
    const draft = await post("/consumer/policies/draft", draftBody(), token);
    const txHash = "0xdead0000000000000000000000000000000000000000000000000000000beef02" as Hex;
    registry.confirm({
      txHash,
      owner: OWNER.address,
      policyHash: "0x9999999999999999999999999999999999999999999999999999999999999999" as Hex,
      expiry: Math.floor(Date.parse(YEAR_AWAY) / 1000),
    });

    const sync = await post("/consumer/policies/sync", { policyDraftId: draft.body.policyDraftId, txHash }, token);
    assert.equal(sync.status, 409);
    // The service refuses before this route's own comparison — the on-chain hash is authoritative.
    assert.match(String(sync.body.message), /hash/i);
  });

  test("one account cannot sync another account's draft", async () => {
    const mine = await signIn(OWNER);
    const theirs = await signIn(STRANGER);
    const draft = await post("/consumer/policies/draft", draftBody(), theirs);

    const stolen = await post(
      "/consumer/policies/sync",
      { policyDraftId: draft.body.policyDraftId, txHash: "0xaa00000000000000000000000000000000000000000000000000000000000001" },
      mine,
    );
    assert.equal(stolen.status, 404);
    assert.equal(stolen.body.code, "DRAFT_NOT_FOUND");
  });

  test("syncing twice is idempotent and does not register a second policy", async () => {
    const token = await signIn(OWNER);
    const draft = await post("/consumer/policies/draft", draftBody(), token);
    const txHash = "0xdead0000000000000000000000000000000000000000000000000000000beef03" as Hex;
    const policyId = registry.confirm({
      txHash,
      owner: OWNER.address,
      policyHash: draft.body.policyHash as Hex,
      expiry: Math.floor(Date.parse(YEAR_AWAY) / 1000),
    });

    const first = await post("/consumer/policies/sync", { policyDraftId: draft.body.policyDraftId, txHash }, token);
    const second = await post("/consumer/policies/sync", { policyDraftId: draft.body.policyDraftId, txHash }, token);
    assert.equal(first.body.policyId, policyId);
    assert.equal(second.body.policyId, policyId);
    assert.equal(second.body.alreadySynced, true);
  });

  test("a default may be changed, and only to a policy this account holds", async () => {
    const token = await signIn(OWNER);
    const first = await registerPolicy(token, OWNER.address);
    const second = await registerPolicy(token, OWNER.address, { name: "Travel" });

    // A second policy does not silently displace the first. Choosing is explicit.
    assert.equal(second.sync.body.becameDefault, false);

    const chosen = await put("/consumer/account/default-policy", { policyId: second.policyId }, token);
    assert.equal(chosen.status, 200);
    assert.equal(chosen.body.defaultPolicyId, second.policyId);

    const stranger = await signIn(STRANGER);
    const refused = await put("/consumer/account/default-policy", { policyId: first.policyId }, stranger);
    assert.equal(refused.status, 404, "another account's policy is not selectable, and not distinguishable");
    assert.equal(refused.body.code, "POLICY_NOT_FOUND");
  });

  test("an expired policy cannot be made the default", async () => {
    const token = await signIn(OWNER);
    const soon = new Date(Date.now() + 2_000).toISOString();
    const { policyId } = await registerPolicy(token, OWNER.address, { expiry: soon, name: "Short-lived" });

    await new Promise((r) => setTimeout(r, 2_500));
    const refused = await put("/consumer/account/default-policy", { policyId }, token);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "POLICY_EXPIRED");
  });

  test("a policy read reports usable=false once expiry has passed, whatever the stored status says", async () => {
    const token = await signIn(OWNER);
    const soon = new Date(Date.now() + 2_000).toISOString();
    const { policyId } = await registerPolicy(token, OWNER.address, { expiry: soon, name: "Also short-lived" });

    await new Promise((r) => setTimeout(r, 2_500));
    const seen = await get(`/consumer/policies/${policyId}`, token);
    assert.equal(seen.status, 200);
    assert.equal(seen.body.status, "ACTIVE", "the stored row is unchanged — expiry is derived, never written");
    assert.equal(seen.body.usable, false, "and the view says what the engine will actually do");
    assert.equal(seen.body.expired, true);
  });

  test("one account cannot read another account's policy, and cannot tell it exists", async () => {
    const mine = await signIn(OWNER);
    const theirs = await signIn(STRANGER);
    const { policyId } = await registerPolicy(theirs, STRANGER.address);

    const refused = await get(`/consumer/policies/${policyId}`, mine);
    assert.equal(refused.status, 404);
    assert.equal(refused.body.code, "POLICY_NOT_FOUND");
  });

  test("every route on this surface refuses without an account session", async () => {
    for (const [method, path] of [
      ["POST", "/consumer/policies/draft"],
      ["POST", "/consumer/policies/sync"],
      ["GET", "/consumer/policies"],
      ["GET", "/consumer/policies/9000"],
      ["PUT", "/consumer/account/default-policy"],
    ] as const) {
      const res = await call(method, path, method === "GET" ? undefined : {});
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.body.code, "ACCOUNT_SESSION_REQUIRED", `${method} ${path}`);
    }
  });

  // ── the refusals about MEANING, not shape ────────────────────────────────

  test("a threshold above the hard cap is refused, because it makes the cap unreachable", async () => {
    const token = await signIn(OWNER);
    const refused = await post(
      "/consumer/policies/draft",
      draftBody({ autoApproveAtOrBelow: "20.00", hardCap: "8.00" }),
      token,
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "POLICY_THRESHOLD_ABOVE_CAP");
  });

  test("a per-action limit above the daily limit is refused, because one action spends the day", async () => {
    const token = await signIn(OWNER);
    const refused = await post(
      "/consumer/policies/draft",
      draftBody({ perActionLimit: "50.00", dailyLimit: "40.00", hardCap: "60.00" }),
      token,
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "POLICY_PER_ACTION_ABOVE_DAILY");
  });

  test("a policy that permits nothing is refused", async () => {
    const token = await signIn(OWNER);
    const refused = await post("/consumer/policies/draft", draftBody({ allowedCapabilities: [] }), token);
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "POLICY_NO_CAPABILITIES");
  });

  test("an expiry in the past is refused here rather than on chain with gas already spent", async () => {
    const token = await signIn(OWNER);
    const refused = await post(
      "/consumer/policies/draft",
      draftBody({ expiry: "2020-01-01T00:00:00.000Z" }),
      token,
    );
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "POLICY_EXPIRY_PAST");
  });

  test("an amount that is not a decimal string is refused rather than coerced", async () => {
    const token = await signIn(OWNER);
    for (const bad of ["five dollars", "1e6", "-3.00", ""]) {
      const refused = await post("/consumer/policies/draft", draftBody({ perActionLimit: bad }), token);
      assert.equal(refused.status, 400, bad);
      assert.equal(refused.body.code, "POLICY_AMOUNT_INVALID", bad);
    }
  });

  test("the same declared rules produce the same hash on every call", async () => {
    const token = await signIn(OWNER);
    const a = await post("/consumer/policies/draft", draftBody(), token);
    const b = await post("/consumer/policies/draft", draftBody(), token);
    // Reproducibility is what lets anyone holding the declared rules re-derive what was anchored.
    assert.equal(a.body.policyHash, b.body.policyHash);
    assert.notEqual(a.body.policyDraftId, b.body.policyDraftId);
  });

  test("a wallet with only the identity scope cannot draft a policy", async () => {
    // A wallet that proved who it is has not consented to hold spending rules. The two scopes exist
    // so that difference is expressible; this is the route that reads it.
    const start = await post("/consumer/account/link/start", { requestedScopes: ["identity"] });
    const nonce = (start.body.walletAction as { nonce: string }).nonce;
    const identityOnly = privateKeyToAccount(
      "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356",
    );
    const message = buildLinkMessage({
      domain: DOMAIN,
      uri: `https://${DOMAIN}`,
      address: identityOnly.address,
      chainId: CHAIN_ID,
      nonce,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      scopes: ["identity"],
    });
    const signature = await identityOnly.signMessage({ message });
    // This signer is outside LOCAL_VERIFIER, so link/complete refuses — which is itself proof the
    // verifier is real. The scope check is asserted directly against the store instead.
    const complete = await post("/consumer/account/link/complete", {
      linkRequestId: start.body.linkRequestId,
      code: start.body.oneTimeCode,
      message,
      signature,
    });
    assert.equal(complete.status, 401);
    assert.equal(complete.body.code, "SIWE_BAD_SIGNATURE");
  });
});
