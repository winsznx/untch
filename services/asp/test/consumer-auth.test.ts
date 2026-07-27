import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createSiweMessage } from "viem/siwe";
import type { Address, Hex } from "viem";
import type { PolicyProvider, StoredPolicy } from "@untch/policy-store";
import {
  InMemoryNonceStore,
  authenticateSiwe,
  describeAuthMode,
  loadConsumerAuthConfig,
  openSession,
  resolveScope,
  sealSession,
  tenantForPolicy,
  type ConsumerAuthConfig,
  type SiweVerifier,
} from "../src/consumer/auth";

/**
 * The hole these tests exist for.
 *
 * Tenant scope came from `?policyId=`, justified by the fact that a policy id is bound to an owner
 * wallet on chain. The binding is real; it was never CHECKED. A policy id is public on-chain data,
 * so anyone who read one off the explorer could pass it and receive that tenant's intent amounts,
 * provider, decisions, and — through SSE — their whole lifecycle live.
 *
 * Every test below asserts something an attacker would try.
 */

const OWNER = "0x0e79371813e88F31c2B60C80bad391a952039095" as Address;
const STRANGER = "0x1111111111111111111111111111111111111111" as Address;
const DOMAIN = "asp.untch.xyz";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const SECRET = "test-secret-not-a-real-key";
const SIG = `0x${"ab".repeat(65)}` as Hex;

const config = (over: Partial<ConsumerAuthConfig> = {}): ConsumerAuthConfig => ({
  secret: SECRET,
  domain: DOMAIN,
  required: false,
  ...over,
});

/** Accepts everything. Signature validity is viem's job and is not what these tests are about. */
const alwaysValid: SiweVerifier = { async verify() { return true; } };
const neverValid: SiweVerifier = { async verify() { return false; } };

function policyProvider(owner: Address | null): PolicyProvider {
  return {
    async loadStored(policyId: string): Promise<StoredPolicy | null> {
      if (owner === null) return null;
      return { id: policyId, owner, version: 1, policyHash: `0x${"0".repeat(64)}` } as unknown as StoredPolicy;
    },
    async load() {
      return null;
    },
  } as unknown as PolicyProvider;
}

function siwe(over: {
  address?: Address;
  nonce: string;
  domain?: string;
  chainId?: number;
  policyId?: string | null;
  agentId?: string;
  expirationTime?: Date;
  notBefore?: Date;
}): string {
  const resources: string[] = [];
  if (over.policyId !== null) resources.push(`untch:policy:${over.policyId ?? "9001"}`);
  if (over.agentId) resources.push(`untch:agent:${over.agentId}`);
  return createSiweMessage({
    address: over.address ?? OWNER,
    chainId: over.chainId ?? 196,
    domain: over.domain ?? DOMAIN,
    nonce: over.nonce,
    uri: `https://${over.domain ?? DOMAIN}/consumer/auth/verify`,
    version: "1",
    statement: "Sign in to Untch to read your governed consumer intents.",
    issuedAt: new Date(NOW),
    ...(over.expirationTime ? { expirationTime: over.expirationTime } : {}),
    ...(over.notBefore ? { notBefore: over.notBefore } : {}),
    ...(resources.length > 0 ? { resources } : {}),
  });
}

async function deps(over: { owner?: Address | null; verifier?: SiweVerifier; cfg?: ConsumerAuthConfig } = {}) {
  const nonces = new InMemoryNonceStore();
  const { nonce } = await nonces.issue(null, NOW);
  return {
    nonce,
    d: {
      config: over.cfg ?? config(),
      nonces,
      verifier: over.verifier ?? alwaysValid,
      policyProvider: policyProvider(over.owner === undefined ? OWNER : over.owner),
      now: () => NOW,
    },
  };
}

describe("SIWE ownership — the happy path binds everything it claims to", () => {
  test("a policy owner's signature over a server nonce mints a session bound to that policy", async () => {
    // #given a nonce this server issued
    const { nonce, d } = await deps();

    // #when the POLICY OWNER signs it, naming the policy and an agent
    const r = await authenticateSiwe(
      { message: siwe({ nonce, policyId: "9001", agentId: "untch-live-smoke" }), signature: SIG },
      d,
    );

    // #then the session carries every binding, and the tenant is derived, never declared
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.session.address, OWNER);
    assert.equal(r.session.policyId, "9001");
    assert.equal(r.session.agentId, "untch-live-smoke");
    assert.equal(r.session.tenantId, tenantForPolicy("9001"));
    assert.ok(r.session.expiresAt > NOW);
  });

  test("the minted token opens to the same session and nothing else", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce }), signature: SIG }, d);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(openSession(SECRET, r.token, NOW), r.session);
  });
});

describe("SIWE ownership — what an attacker would try", () => {
  test("REPLAY: the same signed message a second time is refused", async () => {
    // #given a message that already succeeded
    const { nonce, d } = await deps();
    const message = siwe({ nonce });
    const first = await authenticateSiwe({ message, signature: SIG }, d);
    assert.equal(first.ok, true);

    // #when it is presented again, byte for byte
    const second = await authenticateSiwe({ message, signature: SIG }, d);

    // #then the nonce is spent — this is the whole point of a server-issued nonce
    assert.equal(second.ok, false);
    if (second.ok) return;
    assert.equal(second.code, "SIWE_NONCE_REPLAYED");
  });

  test("CROSS-TENANT: a valid signature from a wallet that does not own the policy is refused", async () => {
    // #given a stranger with a perfectly valid signature
    const { nonce, d } = await deps();

    // #when they name someone else's policy — which is public on-chain data they can simply read
    const r = await authenticateSiwe({ message: siwe({ address: STRANGER, nonce }), signature: SIG }, d);

    // #then owning a wallet is not owning a policy. This is the check the query parameter never made.
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "NOT_POLICY_OWNER");
  });

  test("A NONCE THIS SERVER NEVER ISSUED is refused, however well-formed", async () => {
    const { d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce: "deadbeefdeadbeefdeadbeefdeadbeef" }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_NONCE_REPLAYED");
  });

  test("PHISHED SIGNATURE: a message signed for another domain does not work here", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce, domain: "evil.example" }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_WRONG_DOMAIN");
  });

  test("a non-X-Layer chainId is refused", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce, chainId: 1 }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_WRONG_CHAIN");
  });

  test("X Layer testnet is accepted — sign-in is identity, and it is the same key", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce, chainId: 195 }), signature: SIG }, d);
    assert.equal(r.ok, true);
  });

  test("a message with no policy resource cannot mint a session for an unspecified tenant", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe({ message: siwe({ nonce, policyId: null }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_NO_POLICY_RESOURCE");
  });

  test("a message past its own expirationTime is refused", async () => {
    const { nonce, d } = await deps();
    const r = await authenticateSiwe(
      { message: siwe({ nonce, expirationTime: new Date(NOW - 1000) }), signature: SIG },
      d,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_EXPIRED");
  });

  test("a bad signature is refused even when everything else is perfect", async () => {
    const { nonce, d } = await deps({ verifier: neverValid });
    const r = await authenticateSiwe({ message: siwe({ nonce }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "SIWE_BAD_SIGNATURE");
  });

  test("ORACLE DEFENCE: a failed signature still burns the nonce", async () => {
    // Verifying before consuming would let a caller retry a captured message with variations
    // indefinitely against one nonce, using signature verification as a free oracle. Consuming
    // first costs an honest caller one round trip and costs an attacker the whole attempt.
    const nonces = new InMemoryNonceStore();
    const { nonce } = await nonces.issue(null, NOW);
    const d = {
      config: config(),
      nonces,
      verifier: neverValid,
      policyProvider: policyProvider(OWNER),
      now: () => NOW,
    };
    const failed = await authenticateSiwe({ message: siwe({ nonce }), signature: SIG }, d);
    assert.equal(failed.ok, false);

    const retry = await authenticateSiwe(
      { message: siwe({ nonce }), signature: SIG },
      { ...d, verifier: alwaysValid },
    );
    assert.equal(retry.ok, false);
    if (retry.ok) return;
    assert.equal(retry.code, "SIWE_NONCE_REPLAYED", "the nonce must not survive a failed attempt");
  });

  test("an unknown policy is refused rather than minting a session for a tenant that does not exist", async () => {
    const { nonce, d } = await deps({ owner: null });
    const r = await authenticateSiwe({ message: siwe({ nonce }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "POLICY_NOT_FOUND");
  });

  test("without a configured secret no session can be minted at all", async () => {
    const { nonce, d } = await deps({ cfg: config({ secret: null }) });
    const r = await authenticateSiwe({ message: siwe({ nonce }), signature: SIG }, d);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.code, "AUTH_NOT_CONFIGURED");
  });
});

describe("session tokens", () => {
  const session = {
    address: OWNER,
    policyId: "9001",
    agentId: null,
    tenantId: tenantForPolicy("9001"),
    expiresAt: NOW + 60_000,
  };

  test("a tampered payload does not open", async () => {
    const token = sealSession(SECRET, session);
    const [payload, mac] = token.split(".");
    const forged = `${Buffer.from(
      JSON.stringify({ ...session, policyId: "9999" }),
      "utf8",
    ).toString("base64url")}.${mac}`;
    assert.equal(openSession(SECRET, forged, NOW), null);
    assert.ok(payload);
  });

  test("a token signed with a different secret does not open — rotation revokes", async () => {
    assert.equal(openSession("another-secret", sealSession(SECRET, session), NOW), null);
  });

  test("an expired token does not open", async () => {
    assert.equal(openSession(SECRET, sealSession(SECRET, session), NOW + 61_000), null);
  });

  test("garbage does not open and does not throw", async () => {
    for (const junk of ["", "a", "a.b", "....", "notbase64.notbase64"]) {
      assert.equal(openSession(SECRET, junk, NOW), null);
    }
  });
});

describe("scope resolution — a proof always beats a query parameter", () => {
  const token = sealSession(SECRET, {
    address: OWNER,
    policyId: "9001",
    agentId: null,
    tenantId: tenantForPolicy("9001"),
    expiresAt: NOW + 60_000,
  });

  test("a valid bearer yields PROVEN scope from the SIGNATURE, ignoring the query parameter", () => {
    // #given a caller presenting a real session AND a query parameter for someone else's policy
    const r = resolveScope({ authorization: `Bearer ${token}`, queryPolicyId: "8888" }, config(), NOW);

    // #then the signed policy wins — the query parameter cannot widen a proven scope
    assert.equal(r.kind, "PROVEN");
    if (r.kind !== "PROVEN") return;
    assert.equal(r.policyId, "9001");
  });

  test("an invalid bearer is refused outright and does NOT fall back to the query parameter", () => {
    // Falling back would make a bad token strictly better than no token.
    const r = resolveScope({ authorization: "Bearer garbage", queryPolicyId: "9001" }, config(), NOW);
    assert.equal(r.kind, "NONE");
    if (r.kind !== "NONE") return;
    assert.equal(r.code, "SESSION_INVALID");
  });

  test("with auth REQUIRED, a bare query parameter is refused", () => {
    const r = resolveScope({ authorization: undefined, queryPolicyId: "9001" }, config({ required: true }), NOW);
    assert.equal(r.kind, "NONE");
    if (r.kind !== "NONE") return;
    assert.equal(r.code, "AUTH_REQUIRED");
    assert.match(r.reason, /\/consumer\/auth\/nonce/, "the refusal must say how to get a session");
  });

  test("with auth OPTIONAL, a query parameter still works but is labelled UNPROVEN", () => {
    // This is the compatibility path, and the label is what stops it being mistaken for authorisation.
    const r = resolveScope({ authorization: undefined, queryPolicyId: "9001" }, config(), NOW);
    assert.equal(r.kind, "UNPROVEN");
  });

  test("no bearer and no query parameter is a 400-shaped refusal, not a 401", () => {
    const r = resolveScope({ authorization: undefined, queryPolicyId: null }, config(), NOW);
    assert.equal(r.kind, "NONE");
    if (r.kind !== "NONE") return;
    assert.equal(r.code, "SCOPE_REQUIRED");
  });

  test("an expired session is refused rather than silently downgraded", () => {
    const r = resolveScope({ authorization: `Bearer ${token}`, queryPolicyId: "9001" }, config(), NOW + 61_000);
    assert.equal(r.kind, "NONE");
  });
});

describe("configuration is honest about what is live", () => {
  test("no secret is reported as NOT configured, and says the fallback is not authorisation", () => {
    const line = describeAuthMode(config({ secret: null }));
    assert.match(line, /NOT configured/);
    assert.match(line, /not authorisation/);
  });

  test("optional mode names the switch that closes the gap", () => {
    assert.match(describeAuthMode(config()), /CONSUMER_AUTH_REQUIRED=1/);
  });

  test("required mode says the query parameter is refused", () => {
    assert.match(describeAuthMode(config({ required: true })), /refused/);
  });

  test("the domain comes from the public base URL, and a malformed one narrows rather than widens", () => {
    assert.equal(loadConsumerAuthConfig({ CONSUMER_PUBLIC_BASE_URL: "https://asp.untch.xyz" } as NodeJS.ProcessEnv).domain, "asp.untch.xyz");
    assert.equal(loadConsumerAuthConfig({ CONSUMER_PUBLIC_BASE_URL: "not a url" } as NodeJS.ProcessEnv).domain, "asp.untch.xyz");
  });

  test("required is off unless explicitly switched on", () => {
    assert.equal(loadConsumerAuthConfig({} as NodeJS.ProcessEnv).required, false);
    assert.equal(loadConsumerAuthConfig({ CONSUMER_AUTH_REQUIRED: "1" } as NodeJS.ProcessEnv).required, true);
    assert.equal(loadConsumerAuthConfig({ CONSUMER_AUTH_REQUIRED: "yes" } as NodeJS.ProcessEnv).required, false);
  });
});

describe("nonce store — single use under concurrency", () => {
  test("only one of two concurrent consumes wins", async () => {
    const store = new InMemoryNonceStore();
    const { nonce } = await store.issue(null, NOW);
    const [a, b] = await Promise.all([store.consume(nonce, NOW), store.consume(nonce, NOW)]);
    assert.equal([a, b].filter(Boolean).length, 1);
  });

  test("an expired nonce cannot be consumed", async () => {
    const store = new InMemoryNonceStore();
    const { nonce } = await store.issue(null, NOW);
    assert.equal(await store.consume(nonce, NOW + 11 * 60_000), false);
  });

  test("sweeping removes only what is well past expiry", async () => {
    const store = new InMemoryNonceStore();
    await store.issue(null, NOW);
    assert.equal(await store.sweep(NOW), 0);
    assert.equal(await store.sweep(NOW + 60 * 60_000), 1);
  });
});
