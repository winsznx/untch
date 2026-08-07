/**
 * Policy registration on Workers: the head of the chain everything else hangs off.
 *
 * WHY THIS WAS THE REAL BLOCKER
 *
 * `create_spend_intent` was ported first, which made it a live door into a room with no floor. It
 * requires a `policyId` and matching `policyHash` that reference a REGISTERED policy, and the only way
 * to obtain one is `policy_draft` → sign → `policy_sync`. With both of those still refusing, a fresh
 * buyer could call `create_spend_intent` and never satisfy it, so `preflight_payment` and
 * `verify_delivery` stayed uncompletable end to end. Migrating the middle of a chain before its head
 * moves the blocker rather than closing it.
 *
 * WHAT THIS DEPLOYMENT CAN AND CANNOT DO HERE
 *
 * `PolicyRegistrationService` is key-free by construction: it holds a `RegistryReader`, not a wallet,
 * and cannot sign. `buildCreate` returns UNSIGNED calldata for the caller's own wallet to send, and
 * `syncRegistration` reads the confirmed event back over RPC. That is the whole point of the split —
 * the backend never signs a user's policy registration, so a Worker holding no operator key loses
 * nothing by comparison with the Node deployment.
 *
 * viem's `http` transport is `fetch`, so the RPC read works here unchanged.
 */

import { PgAccountStore, type Pool } from "@untch/consumer-core";
import {
  PgPolicyRepo,
  PolicyProvider,
  PolicyRegistrationService,
  resolvePolicyRegistry,
  ViemRegistryReader,
} from "@untch/policy-store";
import { activeChain, activeRpcUrl } from "@untch/shared";
import { openAccountSession } from "../consumer/account-auth";
import { DEFAULT_POLICY_ROUTE, POLICY_DRAFT_ROUTE, POLICY_SYNC_ROUTE } from "../consumer/policy-routes";
import {
  derivePolicyRules,
  PolicyShapeError,
  type PolicyIntentInput,
} from "../consumer/policy-shape";
import type { Route, RouteRequest } from "./router";
import { assertOwnsWrites, type WriterGate } from "./writer-gate";

/**
 * `JSON.stringify` throws outright on a BigInt, and this response carries one: `unsignedTx.args` is
 * `[agent, policyHash, expiry]` where the uint64 expiry is a bigint. Serialising it as a decimal
 * string is what a caller needs anyway — they re-encode it to send the transaction — and it is the
 * only lossless JSON form. The third place in this port where an unhandled BigInt became a 500.
 */
const bigintSafe = (_k: string, v: unknown): unknown => (typeof v === "bigint" ? v.toString() : v);

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body, bigintSafe, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" },
  });

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): Response =>
  json({ code, message, retryable: false, docsUrl: null, ...extra }, status);

export interface PolicyRouteDeps {
  readonly pool: Pool;
  readonly secret: string;
  readonly gate: WriterGate;
}

/** `pdft_` plus 26 base32 characters, matching the id shape the rest of the schema uses. */
const DRAFT_BASE32 = "abcdefghijklmnopqrstuvwxyz234567";
function newDraftId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let out = "";
  for (const b of bytes) out += DRAFT_BASE32[b % 32];
  return `pdft_${out}`;
}

const SESSION_REQUIRED =
  "policy registration is account-scoped: POST /consumer/account/link/start, sign the message with " +
  "your wallet, then POST /consumer/account/link/complete to obtain a session";

export function policyRoutes(deps: PolicyRouteDeps): readonly Route[] {
  const accounts = new PgAccountStore(deps.pool as never);
  const repo = new PgPolicyRepo(deps.pool as never);
  const policies = new PolicyProvider(repo);

  /**
   * The chain, RPC and registry — assembled from the three pieces, not from `loadRegistryConfig`.
   *
   * That helper spreads in `loadStorageConfig()`, which requires `DATABASE_URL`. A Worker reaches
   * Postgres through Hyperdrive and never sets it, so calling the helper failed with
   * "Missing required environment variable: DATABASE_URL" — a storage variable, refusing a route that
   * only needed to know which contract to read. The narrower functions ask for exactly what a reader
   * needs and nothing more.
   *
   * Built tolerantly: a deployment without this config should refuse these two routes by name rather
   * than take down every request in the table.
   */
  let registration: PolicyRegistrationService | null = null;
  let registryError: string | null = null;
  try {
    const chain = activeChain(process.env);
    const rpcUrl = activeRpcUrl(process.env);
    const registry = resolvePolicyRegistry(chain.id, process.env.POLICY_REGISTRY);
    registration = new PolicyRegistrationService(
      repo,
      new ViemRegistryReader({ chain, rpcUrl, registry }),
    );
  } catch (err) {
    registryError = (err as Error).message;
  }

  const session = (req: RouteRequest) => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.request.headers.get("authorization") ?? "")?.[1];
    return openAccountSession(deps.secret, bearer, Date.now());
  };

  const authed =
    (handler: (accountId: string, req: RouteRequest) => Promise<Response>) =>
    async (req: RouteRequest): Promise<Response> => {
      if (!registration) {
        return refuse(503, "POLICY_REGISTRY_UNCONFIGURED", `this deployment cannot reach the policy registry: ${registryError}`);
      }
      const s = session(req);
      if (!s) return refuse(401, "ACCOUNT_SESSION_REQUIRED", SESSION_REQUIRED);
      return handler(s.accountId, req);
    };

  return [
    {
      /**
       * Sets which policy answers when a caller does not name one.
       *
       * It matters more than a preference toggle: `preflight_payment` accepts `useDefaultPolicy`, and
       * with nothing set that path refuses — so the account could hold a perfectly good registered
       * policy and still be unable to buy the service it was registered for.
       *
       * PUT, because setting a default is an idempotent replace. The registry advertised POST for as
       * long as it existed and a caller following our own catalog got a 405.
       */
      method: "PUT",
      pattern: DEFAULT_POLICY_ROUTE,
      bodyMode: "json",
      handler: authed(async (accountId, req) => {
        const policyId = (req.body as { policyId?: unknown } | undefined)?.policyId;
        if (typeof policyId !== "string" || policyId.length === 0) {
          return refuse(400, "POLICY_ID_REQUIRED", "policyId is required");
        }

        const owned = await accounts.policiesFor(accountId);
        if (!owned.includes(policyId)) {
          return refuse(404, "POLICY_NOT_FOUND", `no policy ${policyId} on this account`);
        }

        const stored = await policies.loadStored(policyId);
        if (!stored) return refuse(404, "POLICY_NOT_FOUND", `no stored policy ${policyId}`);

        /**
         * A default is what a caller gets when they did not choose. Letting a paused or expired policy
         * be one means every unchosen call fails at decision time with a reason the caller cannot act
         * on, which is worse than refusing the setting here where they can.
         */
        if (stored.status !== "ACTIVE") {
          return refuse(409, "POLICY_NOT_ACTIVE", `policy ${policyId} is ${stored.status} and cannot be a default`);
        }
        if (stored.expiry * 1000 <= Date.now()) {
          return refuse(
            409,
            "POLICY_EXPIRED",
            `policy ${policyId} expired at ${new Date(stored.expiry * 1000).toISOString()} and cannot be a default`,
          );
        }

        /**
         * The owner must be a wallet this account can actually sign with. A default naming a policy
         * owned by someone else would send every unchosen call at rules this account cannot change.
         */
        const wallets = await accounts.walletsFor(accountId);
        const authorities = wallets
          .filter(
            (w) =>
              w.status === "ACTIVE" &&
              w.chainKind === "evm" &&
              w.proofKind === "siwe" &&
              (w.scopes as readonly string[]).includes("policy-authority"),
          )
          .map((w) => w.address.toLowerCase());
        if (!authorities.includes(stored.owner.toLowerCase())) {
          return refuse(
            403,
            "NOT_POLICY_OWNER",
            `policy ${policyId} is owned by ${stored.owner}, which is not a policy-authority wallet of ` +
              "this account; a default must be a policy this account can actually sign for",
          );
        }

        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        await accounts.setDefaultPolicy({ accountId, policyId, by: `account:${accountId}` });
        return json({ accountId, defaultPolicyId: policyId });
      }),
    },

    {
      /**
       * Returns UNSIGNED `registerPolicy` calldata. The caller's own wallet is the only signer — this
       * host never signs a user's policy, which is why a policy registered here is owned by the user
       * forever and not by Untch.
       */
      method: "POST",
      pattern: POLICY_DRAFT_ROUTE,
      bodyMode: "json",
      handler: authed(async (accountId, req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;

        const wallets = await accounts.walletsFor(accountId);
        const authorities = wallets
          .filter((w) => w.status === "ACTIVE" && (w.scopes as readonly string[]).includes("policy-authority"))
          .map((w) => w.address);
        if (authorities.length === 0) {
          return refuse(
            409,
            "POLICY_AUTHORITY_REQUIRED",
            "this account has no wallet permitted to own a policy. Link one with the `policy-authority` " +
              "scope: a wallet that only proved identity has not consented to hold spending rules.",
          );
        }

        const agent = (typeof b.agentId === "string" ? b.agentId : authorities[0]) as `0x${string}`;

        /**
         * The friendly shape is DERIVED before it becomes rules.
         *
         * `/schema/policy_draft` publishes a human-facing body — name, currency, perActionLimit,
         * dailyLimit — and `derivePolicyRules` turns that into the canonical rule structure the
         * registry hashes. Passing the friendly body straight to `buildCreate` refused our own
         * published example with "rules.budgets must be an object": the caller was blamed for the
         * shape this transport forgot to convert.
         */
        let derived: ReturnType<typeof derivePolicyRules>;
        try {
          derived = derivePolicyRules(b as unknown as PolicyIntentInput);
        } catch (err) {
          if (err instanceof PolicyShapeError) return refuse(400, err.code, err.message);
          throw err;
        }

        let built;
        try {
          built = registration!.buildCreate({ agent, rules: derived.rules });
        } catch (err) {
          const e = err as { code?: string; message: string };
          return refuse(400, e.code ?? "POLICY_INVALID", e.message);
        }

        /**
         * Recording the draft is a write, so it asks the gate. A deployment that does not own writes
         * must not hand back calldata whose confirmation it could never record — the caller would send
         * a real transaction and then find nothing here to sync it against.
         */
        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        /**
         * `PolicyDraft` omits `policyId` on create by design: the id only exists once the chain has
         * confirmed the registration, and inventing one here would let a draft claim an identity no
         * contract had issued. `markDraftConfirmed` fills it during sync.
         */
        const draft = await accounts.createDraft({
          draftId: newDraftId(),
          accountId,
          rules: derived.rules as unknown as Record<string, unknown>,
          policyHash: built.policyHash,
          agentId: built.agentId,
          chainId: built.chainId,
          by: "policy-draft",
        } as never);

        return json({
          policyDraftId: draft.draftId,
          policyHash: built.policyHash,
          agentId: built.agentId,
          expiry: built.expiry,
          registry: built.registry,
          chainId: built.chainId,
          unsignedTx: built.unsignedTx,
          nextStep:
            "send unsignedTx from the policy-authority wallet, then POST /consumer/policies/sync with " +
            "{ policyDraftId, txHash }",
        });
      }),
    },

    {
      /**
       * Reads the confirmed registration back from chain and stores it.
       *
       * The owner comes from the on-chain event, never from the request body — a caller cannot claim a
       * different owner, and the stored rules must hash to the `policyHash` that was anchored.
       */
      method: "POST",
      pattern: POLICY_SYNC_ROUTE,
      bodyMode: "json",
      handler: authed(async (accountId, req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        const draftId = typeof b.policyDraftId === "string" ? b.policyDraftId : null;
        const txHash = typeof b.txHash === "string" ? b.txHash : null;
        if (!draftId || !txHash) {
          return refuse(400, "SYNC_BAD_REQUEST", "policyDraftId and txHash are both required");
        }

        const draft = await accounts.getDraft(draftId);
        if (!draft || (draft as { accountId?: string }).accountId !== accountId) {
          return refuse(404, "DRAFT_NOT_FOUND", `no policy draft ${draftId} on this account`);
        }

        /**
         * A draft that has already been confirmed carries the policy id the chain issued. A fresh one
         * does not — `policyId` is absent until `markDraftConfirmed` fills it — so this must read the
         * draft's own field rather than assume one is there. The first version passed `undefined` to
         * `loadStored` on every genuine sync.
         */
        const confirmedId = (draft as { policyId?: string | null }).policyId ?? null;
        if (confirmedId) {
          const already = await policies.loadStored(confirmedId);
          if (already) return json({ policy: already, policyId: confirmedId, alreadySynced: true });
        }

        assertOwnsWrites(deps.gate, "approval-expiry-mutation");
        const synced = await registration!.syncRegistration({
          txHash: txHash as `0x${string}`,
          rules: (draft as { rules?: unknown }).rules,
        });

        /**
         * The transaction must be the one this draft described.
         *
         * Without this a caller could sync ANY registration transaction against their own draft and
         * have the resulting policy linked to their account — including one whose rules they never
         * drafted and whose hash nobody here ever agreed to.
         */
        const draftHash = (draft as { policyHash?: string }).policyHash;
        if (draftHash && draftHash !== synced.policyHash) {
          return refuse(
            409,
            "POLICY_HASH_MISMATCH",
            `the draft hashes to ${draftHash} but the transaction anchored ${synced.policyHash}`,
          );
        }

        /**
         * WITHOUT THE THREE WRITES BELOW, A REGISTERED POLICY IS INVISIBLE TO ITS OWN ACCOUNT.
         *
         * This route used to stop at `syncRegistration`, which stores the policy in the policy repo and
         * nothing more. The account never learned it owned one: `GET /consumer/policies` returned an
         * empty list, `defaultPolicyId` stayed null, and setting it as the default answered
         * POLICY_NOT_FOUND — for a policy that was registered on chain, in a confirmed transaction,
         * owned by the caller's own wallet. Sync reported success the whole time.
         */
        await accounts.markDraftConfirmed({ draftId, policyId: synced.policyId, by: `account:${accountId}` });
        await accounts.linkPolicy({
          accountId,
          policyId: synced.policyId,
          linkedBy: "registered",
          by: `account:${accountId}`,
        });

        /**
         * The FIRST policy an account registers becomes its default, because an account with exactly
         * one policy and no default is an account whose next preflight fails for no reason a user can
         * act on. A second policy does not silently displace it — that is a choice, not a fact.
         */
        const fresh = await accounts.getAccount(accountId);
        let becameDefault = false;
        if (!fresh?.defaultPolicyId) {
          await accounts.setDefaultPolicy({ accountId, policyId: synced.policyId, by: "first-policy" });
          becameDefault = true;
        }

        const stored = await policies.loadStored(synced.policyId);
        return json({
          policyId: synced.policyId,
          owner: synced.owner,
          policyHash: synced.policyHash,
          version: synced.version,
          registerTx: synced.txHash,
          registerBlock: synced.blockNumber,
          alreadySynced: synced.alreadyStored,
          becameDefault,
          policy: stored,
        });
      }),
    },
  ];
}

/** The paths this module serves, so the route classifier reads truth rather than a guess. */
export const POLICY_PATHS = [POLICY_DRAFT_ROUTE, POLICY_SYNC_ROUTE, DEFAULT_POLICY_ROUTE] as const;
