/**
 * The public, account-derived preflight — the route a stranger's agent can actually complete.
 *
 * WHAT CHANGED, AND WHY IT IS THE WHOLE POINT
 *
 * The registered contract has said for two passes that a caller sends six fields and the protocol
 * object is derived server-side. It was true of the SCHEMA and false of the ROUTE: `mapping.ts` was
 * written, tested, and wired to nothing, so the live endpoint still demanded a policy hash, an owner,
 * a token address, four content hashes, a nonce and two agent ids. A published contract nothing
 * enforces is worse than a bad contract, because it is the one a caller will build against.
 *
 * This module is the enforcement. It takes the public request, resolves who is asking from a
 * wallet-backed session, resolves what governs them from their account's policy, resolves who is paid
 * from the registered service definition, maps the result onto the protocol struct, and hands it to
 * the same engine the internal route uses. Every value it produces is reported back with what produced
 * it, so a caller can check the derivation rather than trusting it.
 *
 * WHAT IT REFUSES TO DO
 *
 * Substitute. There is no branch here that reaches for the host's payTo, a zero agent id, or a policy
 * nobody chose. Each of those has a named refusal with the route that resolves it, and a refusal that
 * costs one round trip is cheaper than a receipt that is wrong in a way nobody can see.
 */



import type { Address } from "viem";
import type { HandlerResult, PreflightDeps } from "../handlers";
import { evaluatePreflight } from "../handlers";
import { openAccountSession } from "../consumer/account-auth";
import { mapPreflightRequest, type NetworkFacts } from "./mapping";
import {
  OUTCOME_STATUS,
  publicOutcomeFor,
  resolveAuthority,
  type AuthorityDeps,
  type AccountFactsReader,
  type CallerIdentity,
  type OwnedServiceDefinition,
  type StoredPolicyReader,
} from "./authority";
import type { PublicPreflightRequest } from "./types";

/** What the public preflight needs from the account store: the resolver's reads, plus one write. */
export interface AccountUse extends AccountFactsReader {
  recordPolicyUse(args: { readonly accountId: string; readonly policyId: string; readonly by: string }): Promise<void>;
}

export interface PublicPreflightDeps {
  readonly accounts: AccountUse;
  readonly policies: StoredPolicyReader;
  readonly ownedService: (provider: string, capability: string) => OwnedServiceDefinition | null;
  readonly network: NetworkFacts;
  /** The HMAC secret account sessions are sealed with. */
  readonly sessionSecret: string;
  /**
   * Whether a provider could actually run right now.
   *
   * It changes no decision. It changes what an APPROVED decision is CALLED, and that is the field a
   * demo would otherwise turn into a claim that money moved.
   */
  readonly executionEnabled: boolean;
  readonly now?: () => number;
}

/**
 * Does this body speak the public contract?
 *
 * Detected by the four fields that have no counterpart in the protocol struct. A protocol intent has
 * `owner` and `taskHash`; a public request has `provider`, `capability`, `task` and `maxSpend`. The
 * two shapes cannot be confused, which is what lets one route serve both without a version flag —
 * and the internal shape stays available for `create_spend_intent` callers who already hold one.
 */
export function looksPublic(body: unknown): boolean {
  const b = (body ?? {}) as Record<string, unknown>;
  return (
    typeof b.provider === "string" &&
    typeof b.capability === "string" &&
    typeof b.task === "string" &&
    typeof b.maxSpend === "string"
  );
}

const REQUIRED_FIELDS = ["provider", "capability", "task", "maxSpend", "currency", "deadline"] as const;

function readRequest(body: unknown): PublicPreflightRequest | { readonly missing: readonly string[] } {
  const b = (body ?? {}) as Record<string, unknown>;
  const missing = REQUIRED_FIELDS.filter((f) => typeof b[f] !== "string" || (b[f] as string).trim() === "");
  if (missing.length > 0) return { missing };

  const optionalString = (k: string): string | undefined =>
    typeof b[k] === "string" && (b[k] as string).trim() !== "" ? (b[k] as string) : undefined;
  const optionalObject = (k: string): Record<string, unknown> | undefined =>
    typeof b[k] === "object" && b[k] !== null && !Array.isArray(b[k]) ? (b[k] as Record<string, unknown>) : undefined;

  // Built by explicit assignment rather than a spread of `b`, so an unknown key in the request can
  // never reach the canonicaliser and change a hash the caller did not intend to commit to.
  return {
    provider: (b.provider as string).trim(),
    capability: (b.capability as string).trim(),
    task: (b.task as string).trim(),
    maxSpend: (b.maxSpend as string).trim(),
    currency: (b.currency as string).trim(),
    deadline: (b.deadline as string).trim(),
    ...(optionalString("policyId") !== undefined ? { policyId: optionalString("policyId") as string } : {}),
    ...(typeof b.useDefaultPolicy === "boolean" ? { useDefaultPolicy: b.useDefaultPolicy } : {}),
    ...(optionalString("recipient") !== undefined ? { recipient: optionalString("recipient") as string } : {}),
    ...(optionalObject("parameters") !== undefined ? { parameters: optionalObject("parameters") as Record<string, unknown> } : {}),
    ...(optionalObject("acceptance") !== undefined ? { acceptance: optionalObject("acceptance") as Record<string, unknown> } : {}),
    ...(optionalString("idempotencyKey") !== undefined ? { idempotencyKey: optionalString("idempotencyKey") as string } : {}),
    ...(optionalString("buyerAgentId") !== undefined ? { buyerAgentId: optionalString("buyerAgentId") as string } : {}),
    ...(optionalString("workerAgentId") !== undefined ? { workerAgentId: optionalString("workerAgentId") as string } : {}),
  };
}

const refusal = (
  code: keyof typeof OUTCOME_STATUS,
  message: string,
  extra: Record<string, unknown> = {},
): HandlerResult => ({
  status: OUTCOME_STATUS[code],
  body: { outcome: code, code, message, retryable: false, docsUrl: null, ...extra },
});

/**
 * Run a public preflight.
 *
 * `bearer` is the raw Authorization header. It is opened here rather than in the route so that the
 * one place that decides what an unauthenticated request means is the same place that knows what an
 * account would have supplied — otherwise `ACCOUNT_LINK_REQUIRED` gets raised by a middleware that
 * cannot say which of the derived fields it was needed for.
 */
export async function handlePublicPreflight(
  body: unknown,
  bearer: string | undefined,
  publicDeps: PublicPreflightDeps,
  engineDeps: PreflightDeps,
): Promise<HandlerResult> {
  const now = publicDeps.now ?? Date.now;
  const parsed = readRequest(body);
  if ("missing" in parsed) {
    return {
      status: 400,
      body: {
        outcome: "REQUEST_SCHEMA_VIOLATION",
        code: "REQUEST_SCHEMA_VIOLATION",
        message: `these fields are required and were missing or blank: ${parsed.missing.join(", ")}`,
        missing: parsed.missing,
        retryable: false,
        docsUrl: null,
      },
    };
  }
  const request = parsed;

  const token = /^Bearer\s+(.+)$/i.exec(bearer ?? "")?.[1];
  const session = openAccountSession(publicDeps.sessionSecret, token, now());
  const identity: CallerIdentity | null = session
    ? {
        accountId: session.accountId,
        address: session.address,
        bindingId: session.bindingId,
        scopes: session.scopes,
      }
    : null;

  const authorityDeps: AuthorityDeps = {
    accounts: publicDeps.accounts,
    policies: publicDeps.policies,
    ownedService: publicDeps.ownedService,
    now,
  };

  const authority = await resolveAuthority(
    {
      provider: request.provider,
      capability: request.capability,
      ...(request.policyId !== undefined ? { policyId: request.policyId } : {}),
      ...(request.useDefaultPolicy !== undefined ? { useDefaultPolicy: request.useDefaultPolicy } : {}),
      ...(request.recipient !== undefined ? { recipient: request.recipient } : {}),
      ...(request.buyerAgentId !== undefined ? { buyerAgentId: request.buyerAgentId } : {}),
      ...(request.workerAgentId !== undefined ? { workerAgentId: request.workerAgentId } : {}),
    },
    identity,
    authorityDeps,
  );

  if (!authority.ok) {
    return refusal(authority.code, authority.message, {
      missing: authority.missing,
      resolveBy: authority.resolveBy,
    });
  }

  const a = authority.authority;

  /**
   * The mapping is given the recipient and the agent ids as FACTS.
   *
   * `mapPreflightRequest` still refuses when it cannot derive them, and that refusal is still
   * reachable — through the internal path, and through any future caller that reaches the mapping
   * without an account. Passing the resolved values in rather than teaching the mapping to read an
   * account keeps the mapping pure and testable with no store at all.
   */
  const mapped = mapPreflightRequest(
    {
      ...request,
      ...(a.recipient !== null ? { recipient: a.recipient } : {}),
      buyerAgentId: a.buyerAgentId,
      workerAgentId: a.workerAgentId,
    },
    {
      policy: { policyId: a.policy.id, policyHash: a.policy.policyHash, owner: a.policy.owner as Address },
      network: publicDeps.network,
      provider: {
        providerId: request.provider,
        capability: request.capability,
        endpoint: a.ownedService?.endpoint ?? `https://asp.untch.xyz/${request.provider}/${request.capability}`,
        resolvedRecipient: a.recipient,
      },
      now: now(),
    },
  );

  if (!mapped.ok) {
    const code = (mapped.code in OUTCOME_STATUS ? mapped.code : "AUTHORITY_NOT_DERIVABLE") as keyof typeof OUTCOME_STATUS;
    return {
      status: code in OUTCOME_STATUS ? OUTCOME_STATUS[code] : 400,
      body: {
        outcome: code,
        code: mapped.code,
        message: mapped.message,
        missing: mapped.missing,
        retryable: false,
        docsUrl: null,
      },
    };
  }

  const decision = await evaluatePreflight(mapped.intent, a.policy.id, a.policy, body, engineDeps);
  if (decision.status !== 200) return decision;

  const engineDecision = String(decision.body.decision ?? "");
  const outcome = publicOutcomeFor(engineDecision);

  /**
   * The account's use of the policy is recorded AFTER the decision, and a failure to record it does
   * not fail the request. It is provenance, not authority: losing it costs a "last used" timestamp,
   * and letting it fail a decision the engine already made would be trading a real answer for a
   * bookkeeping row.
   */
  try {
    await publicDeps.accounts.recordPolicyUse({
      accountId: a.account.accountId,
      policyId: a.policy.id,
      by: `account:${a.account.accountId}`,
    });
  } catch (err) {
    console.error("[asp] recordPolicyUse failed — the decision stands", err);
  }

  return {
    status: 200,
    body: {
      ...decision.body,
      outcome,
      // The engine's own word stays beside the public one. `ESCALATED_OVER_THRESHOLD` says which rule
      // fired; `ESCALATED` is what a caller branches on. Collapsing them would lose the reason.
      engineDecision,
      account: { accountId: a.account.accountId, wallet: a.wallet.address },
      policy: {
        policyId: a.policy.id,
        policyHash: a.policy.policyHash,
        version: a.policy.version,
        selectedBy: request.policyId ? "explicit" : "account-default",
        expiry: new Date(a.policy.expiry * 1000).toISOString(),
      },
      marketplace:
        a.marketplace === null
          ? null
          : {
              marketplace: a.marketplace.marketplace,
              agentId: a.marketplace.agentId,
              // Reported, never quietly upgraded. `unproven` is the schema saying an id arrived in a
              // header, and a reader deciding how much to trust this decision needs to see that word.
              provenBy: a.marketplace.provenBy,
            },
      recipient: { address: a.recipient, derivedFrom: a.recipientDerivedFrom },
      derived: [...a.derived, ...mapped.derived],
      executionPosture: {
        enabled: publicDeps.executionEnabled,
        note: publicDeps.executionEnabled
          ? "Provider execution is enabled on this deployment."
          : "Provider execution is DISABLED on this deployment. A decision was recorded and nothing was paid.",
      },
      paid: false,
    },
  };
}
