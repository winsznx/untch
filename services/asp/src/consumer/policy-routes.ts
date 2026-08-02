/**
 * The public policy journey: draft → the user's own wallet registers → sync → default.
 *
 * THE CONSTRAINT EVERYTHING HERE OBEYS
 *
 * `PolicyRegistry.registerPolicy` makes `msg.sender` the owner. There is no relayer and no delegate.
 * Three consequences follow directly, and each is a thing this file refuses to do:
 *
 *   • Untch must not relay the call. If the server broadcast it, the SERVER would own every user's
 *     spending rules, and "your policy" would be a label on something you cannot change without asking
 *     us.
 *   • the operator key must not register on a user's behalf, for the same reason and with the added
 *     property that the operator key is shared across users.
 *   • a hosted, server-owned policy must not be the default, because a default is what a caller gets
 *     when they did not choose — and nobody should silently inherit rules whose owner is not them.
 *
 * So the server does the parts that need no key: canonicalise the rules, hash them exactly as the
 * registry will, build the unsigned transaction, and afterwards read the confirmed event back to learn
 * who ACTUALLY registered it. The wallet does the one part that establishes ownership.
 *
 * WHAT SYNC PROVES, AND WHY IT IS NOT A FORMALITY
 *
 * `syncRegistration` does not take the caller's word for anything. It reads the receipt, decodes the
 * `PolicyRegistered` event, and takes `owner` from the chain. It then re-hashes the rules it was given
 * and refuses if they do not match the anchored `policyHash`. On top of that this route checks the
 * event's owner against the ACCOUNT'S OWN verified wallet — the chain says who registered it, the
 * account says which wallets are its, and only when those agree is the policy linked. Without that
 * last check, anyone could sync a stranger's registration into their own account and inherit a policy
 * they cannot sign for but can now name as their default.
 */

import type { Express, Request, Response, NextFunction } from "express";
import type { Address, Hex } from "viem";
import {
  newDraftId,
  type AccountStore,
  type BindingScope,
  type UntchAccount,
  type WalletBinding,
} from "@untch/consumer-core";
import { PolicyValidationError, type PolicyProvider, type PolicyRegistrationService, type StoredPolicy } from "@untch/policy-store";
import { hashCanonicalJson } from "@untch/canon";
import type { HandlerResult } from "../handlers";
import { openAccountSession } from "./account-auth";
import { derivePolicyRules, summarisePolicyRules, PolicyShapeError, type PolicyIntentInput } from "./policy-shape";

export const POLICY_DRAFT_ROUTE = "/consumer/policies/draft" as const;
export const POLICY_SYNC_ROUTE = "/consumer/policies/sync" as const;
export const POLICY_LIST_ROUTE = "/consumer/policies" as const;
export const POLICY_GET_ROUTE = "/consumer/policies/:policyId" as const;
export const DEFAULT_POLICY_ROUTE = "/consumer/account/default-policy" as const;

export interface PolicyRoutesDeps {
  readonly accounts: AccountStore;
  readonly registration: PolicyRegistrationService;
  readonly policies: PolicyProvider;
  readonly secret: string;
  /** The agent address a policy governs, when the caller does not name one. */
  readonly defaultAgent: Address | null;
  readonly now?: () => number;
}

const refuse = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): HandlerResult => ({
  status,
  body: { code, message, retryable: false, docsUrl: null, ...extra },
});

/** The wallets of this account that may act as a policy owner. Scope is read, never assumed from role. */
function policyAuthorities(wallets: readonly WalletBinding[]): readonly string[] {
  return wallets
    .filter(
      (w) =>
        w.status === "ACTIVE" &&
        w.chainKind === "evm" &&
        w.proofKind === "siwe" &&
        (w.scopes as readonly BindingScope[]).includes("policy-authority"),
    )
    .map((w) => w.address.toLowerCase());
}

function publicPolicy(
  stored: StoredPolicy,
  args: { readonly accountId: string | null; readonly isDefault: boolean; readonly nowMs: number },
): Record<string, unknown> {
  const expired = stored.expiry * 1000 <= args.nowMs;
  return {
    policyId: stored.id,
    policyHash: stored.policyHash,
    owner: stored.owner,
    agentId: stored.agentId,
    version: stored.version,
    // The stored status and the DERIVED one are both reported. A policy whose row says ACTIVE and
    // whose expiry has passed authorises nothing, and a view that showed only the row would be
    // telling the user something the engine disagrees with.
    status: stored.status,
    usable: stored.status === "ACTIVE" && !expired,
    expired,
    expiry: new Date(stored.expiry * 1000).toISOString(),
    onchain: {
      chainId: stored.onchainRef.chainId,
      registry: stored.onchainRef.registry,
      registerTx: stored.onchainRef.registerTx,
      registerBlock: stored.onchainRef.registerBlock,
    },
    linkedAccountId: args.accountId,
    isDefault: args.isDefault,
    rules: summarisePolicyRules(stored.rules as unknown as Record<string, unknown>),
  };
}

export function registerPolicyRoutes(
  app: Express,
  send: (res: Response, r: HandlerResult) => void,
  deps: PolicyRoutesDeps | null,
): void {
  if (!deps) {
    const why =
      "the policy store is not wired on this instance (DATABASE_URL unset), so no policy can be " +
      "drafted, synced or read here";
    for (const p of [POLICY_DRAFT_ROUTE, POLICY_SYNC_ROUTE]) {
      app.post(p, (_req, res) => send(res, refuse(503, "POLICY_STORE_UNAVAILABLE", why)));
    }
    app.put(DEFAULT_POLICY_ROUTE, (_req, res) => send(res, refuse(503, "POLICY_STORE_UNAVAILABLE", why)));
    for (const p of [POLICY_LIST_ROUTE, POLICY_GET_ROUTE]) {
      app.get(p, (_req, res) => send(res, refuse(503, "POLICY_STORE_UNAVAILABLE", why)));
    }
    return;
  }

  const d = deps;
  const now = (): number => d.now?.() ?? Date.now();

  const withAccount = (
    req: Request,
    fn: (account: UntchAccount) => Promise<HandlerResult>,
  ): Promise<HandlerResult> => {
    const bearer = /^Bearer\s+(.+)$/i.exec(req.header("authorization") ?? "")?.[1];
    const session = openAccountSession(d.secret, bearer, now());
    if (!session) {
      return Promise.resolve(
        refuse(
          401,
          "ACCOUNT_SESSION_REQUIRED",
          "the policy journey is account-scoped: link a wallet at /consumer/account/link/start first",
        ),
      );
    }
    return d.accounts.getAccount(session.accountId).then((account) =>
      account
        ? fn(account)
        : refuse(404, "ACCOUNT_NOT_FOUND", `no account ${session.accountId}`),
    );
  };

  const route = (
    method: "post" | "get" | "put",
    path: string,
    handler: (req: Request) => Promise<HandlerResult>,
  ): void => {
    app[method](path, (req: Request, res: Response, next: NextFunction) => {
      handler(req)
        .then((r) => send(res, r))
        .catch(next);
    });
  };

  // ── draft ──────────────────────────────────────────────────────────────────

  route("post", POLICY_DRAFT_ROUTE, (req) =>
    withAccount(req, async (account) => {
      const b = (req.body ?? {}) as Record<string, unknown>;

      let derived: ReturnType<typeof derivePolicyRules>;
      try {
        derived = derivePolicyRules(b as unknown as PolicyIntentInput);
      } catch (err) {
        if (err instanceof PolicyShapeError) return refuse(400, err.code, err.message);
        throw err;
      }

      const wallets = await d.accounts.walletsFor(account.accountId);
      const authorities = policyAuthorities(wallets);
      if (authorities.length === 0) {
        return refuse(
          409,
          "POLICY_AUTHORITY_REQUIRED",
          "this account has no wallet permitted to own a policy. Link one with the `policy-authority` " +
            "scope: a wallet that only proved identity has not consented to hold spending rules.",
        );
      }

      const agent = typeof b.agentId === "string" ? (b.agentId as Address) : d.defaultAgent;
      if (!agent) {
        return refuse(
          400,
          "AGENT_REQUIRED",
          "agentId is required: a policy governs one agent address, and it is immutable on chain once " +
            "registered, so it cannot be chosen later",
        );
      }

      let built: ReturnType<PolicyRegistrationService["buildCreate"]>;
      try {
        built = d.registration.buildCreate({ agent, rules: derived.rules });
      } catch (err) {
        if (err instanceof PolicyValidationError) return refuse(400, err.code, err.message);
        throw err;
      }

      const draftId = newDraftId();
      await d.accounts.createDraft({
        draftId,
        accountId: account.accountId,
        rules: derived.rules as unknown as Record<string, unknown>,
        policyHash: built.policyHash,
        agentId: agent,
        chainId: built.chainId,
        by: `account:${account.accountId}`,
      });

      return {
        status: 200,
        body: {
          policyDraftId: draftId,
          policyHash: built.policyHash,
          // The whole ruleset, verbatim. Signing a hash of something you were not shown is not
          // consent, so the thing the hash covers is returned beside it.
          canonicalRules: derived.rules,
          derivedDefaults: derived.derived,
          readable: summarisePolicyRules(derived.rules as unknown as Record<string, unknown>),
          transaction: {
            chainId: built.chainId,
            to: built.registry,
            functionName: built.unsignedTx.functionName,
            args: built.unsignedTx.args,
            data: built.unsignedTx.calldata,
            value: "0x0",
          },
          mustBeSentBy: {
            // Named explicitly, because the property that makes the policy YOURS is which key sends
            // this transaction — and it is the one thing the server structurally cannot do for you.
            addresses: authorities,
            reason:
              "PolicyRegistry.registerPolicy makes msg.sender the owner. Untch does not relay it and " +
              "cannot: a relayed policy would be owned by Untch, not by you.",
          },
          expiry: new Date(built.expiry * 1000).toISOString(),
          nextStep:
            "Send this transaction from one of the addresses above, then POST " +
            "{policyDraftId, txHash} to /consumer/policies/sync.",
        },
      };
    }),
  );

  // ── sync ───────────────────────────────────────────────────────────────────

  route("post", POLICY_SYNC_ROUTE, (req) =>
    withAccount(req, async (account) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const draftId = typeof b.policyDraftId === "string" ? b.policyDraftId : null;
      const txHash = typeof b.txHash === "string" ? b.txHash : null;
      if (!draftId || !txHash) {
        return refuse(400, "SYNC_BAD_REQUEST", "policyDraftId and txHash are both required");
      }

      const draft = await d.accounts.getDraft(draftId);
      if (!draft) return refuse(404, "DRAFT_NOT_FOUND", `no policy draft ${draftId}`);
      if (draft.accountId !== account.accountId) {
        // The draft holds the rules the hash was computed over. Syncing someone else's draft would
        // let an account adopt rules it never wrote.
        return refuse(404, "DRAFT_NOT_FOUND", `no policy draft ${draftId} on this account`);
      }
      if (draft.status === "CONFIRMED" && draft.policyId) {
        const already = await d.policies.loadStored(draft.policyId);
        return {
          status: 200,
          body: {
            policyId: draft.policyId,
            alreadySynced: true,
            policy: already
              ? publicPolicy(already, { accountId: account.accountId, isDefault: account.defaultPolicyId === draft.policyId, nowMs: now() })
              : null,
          },
        };
      }

      if (draft.status === "DRAFT") {
        await d.accounts.markDraftSubmitted({ draftId, registerTx: txHash, by: `account:${account.accountId}` });
      }

      let synced: Awaited<ReturnType<PolicyRegistrationService["syncRegistration"]>>;
      try {
        synced = await d.registration.syncRegistration({ txHash: txHash as Hex, rules: draft.rules });
      } catch (err) {
        if (err instanceof PolicyValidationError) {
          return refuse(409, err.code, err.message);
        }
        return refuse(
          502,
          "REGISTRATION_UNREADABLE",
          `could not read a PolicyRegistered event from ${txHash}: ${(err as Error).message}`,
        );
      }

      // The chain says who registered it. The account says which wallets are its. Only when those
      // agree is the policy linked — otherwise anyone could sync a stranger's registration into
      // their own account and then name it as their default.
      const wallets = await d.accounts.walletsFor(account.accountId);
      const authorities = policyAuthorities(wallets);
      if (!authorities.includes(synced.owner.toLowerCase())) {
        return refuse(
          403,
          "NOT_POLICY_OWNER",
          `transaction ${txHash} registered policy ${synced.policyId} to ${synced.owner}, which is not ` +
            "a policy-authority wallet of this account. A policy is linked to the account that can sign " +
            "for it, never to the account that happened to report the transaction.",
          { registeredOwner: synced.owner, accountAuthorities: authorities },
        );
      }

      if (synced.policyHash.toLowerCase() !== draft.policyHash.toLowerCase()) {
        return refuse(
          409,
          "POLICY_HASH_MISMATCH",
          `the draft hashes to ${draft.policyHash} but the transaction anchored ${synced.policyHash}`,
        );
      }

      await d.accounts.markDraftConfirmed({ draftId, policyId: synced.policyId, by: `account:${account.accountId}` });
      await d.accounts.linkPolicy({
        accountId: account.accountId,
        policyId: synced.policyId,
        linkedBy: "registered",
        by: `account:${account.accountId}`,
      });

      // The FIRST policy an account registers becomes its default, because an account with exactly
      // one policy and no default is an account whose next preflight fails for no reason a user can
      // act on. A second policy does not silently displace it — that is a choice, not a fact.
      const fresh = await d.accounts.getAccount(account.accountId);
      let becameDefault = false;
      if (!fresh?.defaultPolicyId) {
        await d.accounts.setDefaultPolicy({
          accountId: account.accountId,
          policyId: synced.policyId,
          by: "first-policy",
        });
        becameDefault = true;
      }

      const stored = await d.policies.loadStored(synced.policyId);
      return {
        status: 200,
        body: {
          policyId: synced.policyId,
          owner: synced.owner,
          policyHash: synced.policyHash,
          version: synced.version,
          registerTx: synced.txHash,
          registerBlock: synced.blockNumber,
          alreadySynced: synced.alreadyStored,
          becameDefault,
          policy: stored
            ? publicPolicy(stored, { accountId: account.accountId, isDefault: becameDefault, nowMs: now() })
            : null,
        },
      };
    }),
  );

  // ── list and read ──────────────────────────────────────────────────────────

  route("get", POLICY_LIST_ROUTE, (req) =>
    withAccount(req, async (account) => {
      const ids = await d.accounts.policiesFor(account.accountId);
      const loaded = await Promise.all(ids.map((id) => d.policies.loadStored(id)));
      const policies = loaded
        .map((p, i) =>
          p
            ? publicPolicy(p, {
                accountId: account.accountId,
                isDefault: account.defaultPolicyId === p.id,
                nowMs: now(),
              })
            : // A linked id with no stored row is a real state — the join table is deliberately not a
              // foreign key onto `policies` — and it is reported rather than dropped, because a
              // silently shorter list is indistinguishable from a policy that was never linked.
              { policyId: ids[i], status: "UNREADABLE", note: "linked to this account but not present in the policy store" },
        )
        .filter(Boolean);

      return {
        status: 200,
        body: {
          accountId: account.accountId,
          defaultPolicyId: account.defaultPolicyId,
          count: policies.length,
          policies,
        },
      };
    }),
  );

  route("get", POLICY_GET_ROUTE, (req) =>
    withAccount(req, async (account) => {
      const policyId = req.params.policyId ?? "";
      const owned = await d.accounts.policiesFor(account.accountId);
      if (!owned.includes(policyId)) {
        // Deliberately the same answer as "no such policy". A policy id is public on-chain data, and
        // distinguishing "exists but not yours" from "does not exist" is free information.
        return refuse(404, "POLICY_NOT_FOUND", `no policy ${policyId} on this account`);
      }
      const stored = await d.policies.loadStored(policyId);
      if (!stored) return refuse(404, "POLICY_NOT_FOUND", `no stored policy ${policyId}`);
      return {
        status: 200,
        body: publicPolicy(stored, {
          accountId: account.accountId,
          isDefault: account.defaultPolicyId === policyId,
          nowMs: now(),
        }),
      };
    }),
  );

  // ── default ────────────────────────────────────────────────────────────────

  route("put", DEFAULT_POLICY_ROUTE, (req) =>
    withAccount(req, async (account) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const policyId = typeof b.policyId === "string" ? b.policyId : null;
      if (!policyId) return refuse(400, "POLICY_ID_REQUIRED", "policyId is required");

      const owned = await d.accounts.policiesFor(account.accountId);
      if (!owned.includes(policyId)) {
        return refuse(404, "POLICY_NOT_FOUND", `no policy ${policyId} on this account`);
      }

      const stored = await d.policies.loadStored(policyId);
      if (!stored) return refuse(404, "POLICY_NOT_FOUND", `no stored policy ${policyId}`);

      // A default is what a caller gets when they did not choose. Letting a paused or expired policy
      // be one means every unchosen call fails at decision time with a reason the caller cannot act
      // on, which is worse than refusing the setting here where they can.
      if (stored.status !== "ACTIVE") {
        return refuse(409, "POLICY_NOT_ACTIVE", `policy ${policyId} is ${stored.status} and cannot be a default`);
      }
      if (stored.expiry * 1000 <= now()) {
        return refuse(
          409,
          "POLICY_EXPIRED",
          `policy ${policyId} expired at ${new Date(stored.expiry * 1000).toISOString()} and cannot be a default`,
        );
      }

      const wallets = await d.accounts.walletsFor(account.accountId);
      if (!policyAuthorities(wallets).includes(stored.owner.toLowerCase())) {
        return refuse(
          403,
          "NOT_POLICY_OWNER",
          `policy ${policyId} is owned by ${stored.owner}, which is not a policy-authority wallet of ` +
            "this account; a default must be a policy this account can actually sign for",
        );
      }

      await d.accounts.setDefaultPolicy({ accountId: account.accountId, policyId, by: `account:${account.accountId}` });
      return {
        status: 200,
        body: {
          accountId: account.accountId,
          defaultPolicyId: policyId,
          policy: publicPolicy(stored, { accountId: account.accountId, isDefault: true, nowMs: now() }),
        },
      };
    }),
  );
}

/** Exposed so a test can assert the draft hash is the one the registry would compute. */
export { hashCanonicalJson };
