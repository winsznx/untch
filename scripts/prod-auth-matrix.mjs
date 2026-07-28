/**
 * The production authentication matrix, run against the live endpoint with real signatures.
 *
 * Every row is something an attacker would actually try. Nothing is mocked: the nonces come from the
 * deployed server, the signatures are produced by freshly generated keys, and the policy id used for
 * the ownership test is a REAL policy in the production store owned by a wallet these keys are not.
 */
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";

const B = "https://asp.untch.xyz";
const DOMAIN = "asp.untch.xyz";
const REAL_POLICY = "54389808679745492838855187618375777761438193813585610814808977617168298065120";
const REAL_INTENT = "ci_82bb2216c02366bc1b839a00";

const results = [];
const rec = (name, expected, got, pass, detail = "") =>
  results.push({ name, expected, got, pass, detail });

const nonce = async () =>
  (await (await fetch(`${B}/consumer/auth/nonce`, {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}",
  })).json()).nonce;

const verify = async (message, signature) => {
  const r = await fetch(`${B}/consumer/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message, signature }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

const stranger = privateKeyToAccount(generatePrivateKey());

const msg = (o) =>
  createSiweMessage({
    address: o.address ?? stranger.address,
    chainId: o.chainId ?? 196,
    domain: o.domain ?? DOMAIN,
    nonce: o.nonce,
    uri: `${B}/consumer/auth/verify`,
    version: "1",
    statement: "Sign in to Untch to read your governed consumer intents.",
    issuedAt: o.issuedAt ?? new Date(),
    ...(o.expirationTime ? { expirationTime: o.expirationTime } : {}),
    ...(o.policy === null ? {} : { resources: [`untch:policy:${o.policy ?? REAL_POLICY}`] }),
  });

// 1. correct SIWE shape from a wallet that is NOT the owner, against a REAL policy
{
  const n = await nonce();
  const m = msg({ nonce: n });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("wrong wallet / cross-tenant (valid signature, real policy, not the owner)", "403 NOT_POLICY_OWNER",
    `${out.status} ${out.body?.code}`, out.status === 403 && out.body?.code === "NOT_POLICY_OWNER",
    out.body?.message ?? "");
}

// 2. replayed nonce — reuse a message that already consumed its nonce
{
  const n = await nonce();
  const m = msg({ nonce: n });
  const sig = await stranger.signMessage({ message: m });
  await verify(m, sig);
  const out = await verify(m, sig);
  rec("replayed nonce (same message + signature twice)", "401 SIWE_NONCE_REPLAYED",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_NONCE_REPLAYED");
}

// 3. forged nonce this server never issued
{
  const m = msg({ nonce: "ffffffffffffffffffffffffffffffff" });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("forged nonce (never issued by this server)", "401 SIWE_NONCE_REPLAYED",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_NONCE_REPLAYED");
}

// 4. wrong domain — a signature phished for another site
{
  const n = await nonce();
  const m = msg({ nonce: n, domain: "evil.example" });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("wrong domain (signature phished for evil.example)", "401 SIWE_WRONG_DOMAIN",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_WRONG_DOMAIN");
}

// 5. wrong chain
{
  const n = await nonce();
  const m = msg({ nonce: n, chainId: 1 });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("wrong chain (Ethereum mainnet chainId 1)", "401 SIWE_WRONG_CHAIN",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_WRONG_CHAIN");
}

// 6. expired message
{
  const n = await nonce();
  const m = msg({ nonce: n, expirationTime: new Date(Date.now() - 60_000) });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("expired message (expirationTime in the past)", "401 SIWE_EXPIRED",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_EXPIRED");
}

// 7. malformed signature
{
  const n = await nonce();
  const m = msg({ nonce: n });
  const out = await verify(m, `0x${"11".repeat(65)}`);
  rec("malformed / garbage signature", "401 SIWE_BAD_SIGNATURE",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_BAD_SIGNATURE");
}

// 8. no policy resource
{
  const n = await nonce();
  const m = msg({ nonce: n, policy: null });
  const out = await verify(m, await stranger.signMessage({ message: m }));
  rec("no untch:policy resource in the message", "401 SIWE_NO_POLICY_RESOURCE",
    `${out.status} ${out.body?.code}`, out.status === 401 && out.body?.code === "SIWE_NO_POLICY_RESOURCE");
}

// 9. public receipt stays public
{
  const r = await fetch(`${B}/consumer/receipt/${REAL_INTENT}`);
  rec("public receipt remains public (no auth at all)", "200", String(r.status), r.status === 200);
}

// 10. private intent status requires ownership
{
  const r = await fetch(`${B}/consumer/intent/${REAL_INTENT}`);
  const b = await r.json().catch(() => null);
  rec("private intent status with NO credentials", "401 AUTH_REQUIRED",
    `${r.status} ${b?.code}`, r.status === 401 && b?.code === "AUTH_REQUIRED", b?.message ?? "");
}

// 11. policyId query parameter alone grants no access
{
  const r = await fetch(`${B}/consumer/intent/${REAL_INTENT}?policyId=9001`);
  const b = await r.json().catch(() => null);
  rec("?policyId= alone (the legacy bypass)", "401 AUTH_REQUIRED",
    `${r.status} ${b?.code}`, r.status === 401 && b?.code === "AUTH_REQUIRED");
}

// 12. an invalid bearer must not fall back to policyId
{
  const r = await fetch(`${B}/consumer/intent/${REAL_INTENT}?policyId=9001`, {
    headers: { authorization: "Bearer not-a-real-token" },
  });
  const b = await r.json().catch(() => null);
  rec("invalid bearer + valid ?policyId= (no fallback allowed)", "401 SESSION_INVALID",
    `${r.status} ${b?.code}`, r.status === 401 && b?.code === "SESSION_INVALID");
}

// 13. the SSE stream is scoped too
{
  const r = await fetch(`${B}/consumer/intent/${REAL_INTENT}/events?policyId=9001`);
  const b = await r.json().catch(() => null);
  rec("SSE event stream with ?policyId= only", "401 AUTH_REQUIRED",
    `${r.status} ${b?.code}`, r.status === 401 && b?.code === "AUTH_REQUIRED");
}

// 14. catalog stays public
{
  const r = await fetch(`${B}/consumer/catalog`);
  const b = await r.json().catch(() => null);
  rec("catalog remains public and reports required=true", "200 required=true",
    `${r.status} required=${b?.auth?.required}`, r.status === 200 && b?.auth?.required === true);
}

const width = Math.max(...results.map((r) => r.name.length));
let failed = 0;
console.log("");
for (const r of results) {
  if (!r.pass) failed += 1;
  console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  expected ${r.expected.padEnd(28)} got ${r.got}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
console.log(JSON.stringify({ results, failed }, null, 2), "\n--- END JSON ---");
process.exit(failed === 0 ? 0 : 1);
