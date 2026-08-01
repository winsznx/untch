import { hashCanonicalJson } from "@untch/canon";
import type { SpendIntentInput } from "@untch/policy-engine";
import { keccak256, toHex, type Address, type Hex } from "viem";
import type { DerivationRecord, MissingAuthority, PublicPreflightRequest } from "./types";

/**
 * Turn a caller's request into the protocol object, or refuse and say exactly what is missing.
 *
 * THE RULE THIS MODULE ENFORCES
 *
 * Derive what production state actually determines. Refuse everything else BY NAME. The failure this
 * prevents is the quiet one: substituting a zero for an agent id, or the payTo address for a
 * recipient nobody constrained, produces a request that validates, gets judged, gets receipted, and
 * is a decision about something the caller never asked for. A refusal that names the field and what
 * would supply it costs one round trip. A fabricated field costs a wrong receipt that looks right.
 *
 * WHAT IS A DERIVATION AND WHAT IS AN INVENTION
 *
 * A derivation is a function of state the server is the custodian of, or of the caller's own words.
 * `policyHash` comes from the stored policy — the server IS the record of what that policy hashes to.
 * `taskHash` is a hash of the sentence the caller wrote. `deadline` is their timestamp in another
 * unit. None of these adds information.
 *
 * An invention adds information the caller did not give and the server does not hold. Who receives
 * the money is the clearest case: absent a constraint from the caller and a resolved quote from the
 * provider, there is no honest value, and the address this host happens to be paid at is not one.
 */

/** The stored policy, reduced to what the mapping needs. */
export interface PolicyFacts {
  readonly policyId: string;
  readonly policyHash: Hex;
  readonly owner: Address;
}

/** What the network determines, not the caller. */
export interface NetworkFacts {
  readonly token: Address;
  readonly symbol: string;
  readonly decimals: number;
}

/** What the provider registry knows about the named provider. */
export interface ProviderFacts {
  readonly providerId: string;
  readonly capability: string;
  /** The absolute URL a payment to this provider is for. */
  readonly endpoint: string;
  /**
   * The address the provider is paid at, when a quote has resolved one.
   *
   * Null is the honest value before a quote. The registry seed records base URLs and capabilities; a
   * provider's payTo appears in its live payment challenge, which this pass does not fetch.
   */
  readonly resolvedRecipient: Address | null;
}

export interface MappingContext {
  readonly policy: PolicyFacts;
  readonly network: NetworkFacts;
  readonly provider: ProviderFacts;
  /** Unix ms. Injected so deadline arithmetic is testable. */
  readonly now: number;
}

export type MappingResult =
  | { readonly ok: true; readonly intent: SpendIntentInput; readonly derived: readonly DerivationRecord[] }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly missing: readonly MissingAuthority[];
    };

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_AMOUNT = /^\d+(\.\d+)?$/;
const UINT = /^[0-9]+$/;

/**
 * Display units to base units, by moving the point — never by multiplying a float.
 *
 * `20.10 * 1e6` is 20099999.999999997 in IEEE-754. A ceiling that is one base unit under what the
 * caller wrote is a ceiling that refuses the payment they authorised, and the failure would be
 * intermittent across amounts, which is the worst kind.
 */
export function toBaseUnits(display: string, decimals: number): string | null {
  if (!DECIMAL_AMOUNT.test(display.trim())) return null;
  const [whole = "0", frac = ""] = display.trim().split(".");
  if (frac.length > decimals) return null; // More precision than the token has is a caller error, not a rounding decision.
  const padded = frac.padEnd(decimals, "0");
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, "");
  return combined === "" ? "0" : combined;
}

/**
 * A nonce that is a function of the request, not of a counter.
 *
 * Two identical requests carrying the same idempotency key produce the same intent hash, so a retry
 * after a timeout resolves to the work already done rather than to a second decision. Without a key
 * the nonce is derived from the whole request plus the clock, because two genuinely separate
 * purchases of the same thing must not collide.
 */
export function deriveNonce(request: PublicPreflightRequest, now: number): string {
  const seed = request.idempotencyKey
    ? hashCanonicalJson({ key: request.idempotencyKey })
    : hashCanonicalJson({ request, now });
  return BigInt(`0x${seed.slice(2, 18)}`).toString();
}

function isoToUnixSeconds(iso: string): number | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Map a public preflight request onto the internal `SpendIntentInput`.
 *
 * The internal structure is unchanged. That is deliberate: it is what the policy engine evaluates,
 * what `@untch/canon` hashes, and what the on-chain registry commits to, and changing it to suit a
 * transport would be changing the protocol to make a form easier to fill in.
 */
export function mapPreflightRequest(
  request: PublicPreflightRequest,
  context: MappingContext,
): MappingResult {
  const derived: DerivationRecord[] = [];
  const missing: MissingAuthority[] = [];
  // Generic so a derived Hex or Address keeps its type through the record; a `string` return here
  // would force a cast at every use, and a cast is where a wrong-shaped value gets in.
  const record = <T extends string>(field: string, value: T, derivedFrom: string): T => {
    derived.push({ field, value, derivedFrom });
    return value;
  };

  // ── the network's facts ───────────────────────────────────────────────────
  if (request.currency.trim().toUpperCase() !== context.network.symbol.trim().toUpperCase()) {
    return {
      ok: false,
      code: "CURRENCY_NOT_SETTLEABLE",
      message: `this network settles in ${context.network.symbol}; ${JSON.stringify(request.currency)} has no confirmed contract here, and guessing one would send funds to an address nobody verified`,
      missing: [
        {
          field: "token",
          why: `no confirmed ${request.currency} contract is recorded for this network`,
          resolvedFrom: "the chain registry's confirmed token list",
        },
      ],
    };
  }
  const token = record("token", context.network.token, `the settlement token for this network (${context.network.symbol})`);

  const maxAmount = toBaseUnits(request.maxSpend, context.network.decimals);
  if (maxAmount === null) {
    return {
      ok: false,
      code: "MAX_SPEND_INVALID",
      message: `maxSpend must be a decimal amount in display units with at most ${context.network.decimals} decimal places, e.g. "20.00"`,
      missing: [],
    };
  }
  record("maxAmount", maxAmount, `maxSpend ${request.maxSpend} at ${context.network.decimals} decimals`);

  // ── the policy's facts ────────────────────────────────────────────────────
  const owner = record("owner", context.policy.owner, `the on-chain owner of policy ${context.policy.policyId}`);
  const policyHash = record("policyHash", context.policy.policyHash, `the stored hash of policy ${context.policy.policyId}`);

  // ── the caller's own words, hashed ────────────────────────────────────────
  const taskHash = record("taskHash", hashCanonicalJson({ task: request.task }), "a hash of the task text you sent");
  const acceptanceHash = record(
    "acceptanceHash",
    hashCanonicalJson(request.acceptance ?? { task: request.task }),
    request.acceptance
      ? "a hash of the acceptance criteria you sent"
      : "a hash of the task text, used as the acceptance criteria because none were given",
  );
  const paramsHash = record(
    "paramsHash",
    hashCanonicalJson(request.parameters ?? {}),
    request.parameters ? "a hash of the parameters you sent" : "a hash of the empty parameter set",
  );
  /**
   * The result schema, committed by naming the capability.
   *
   * A capability id is a promise about the SHAPE of what comes back, which is what a schema hash is
   * for. Stating that is a derivation. Substituting a zero hash — the shape the old contract would
   * have accepted — would be committing to "no schema" while the capability plainly implies one.
   */
  const schemaHash = record(
    "schemaHash",
    hashCanonicalJson({ provider: context.provider.providerId, capability: context.provider.capability }),
    `a hash of the capability ${context.provider.providerId}/${context.provider.capability}, which is what fixes the result's shape`,
  );

  const deadlineSeconds = isoToUnixSeconds(request.deadline);
  if (deadlineSeconds === null) {
    return { ok: false, code: "DEADLINE_INVALID", message: "deadline must be an ISO 8601 timestamp", missing: [] };
  }
  if (deadlineSeconds * 1000 <= context.now) {
    return {
      ok: false,
      code: "DEADLINE_IN_THE_PAST",
      message: "deadline has already passed; rebuild the request rather than replaying it",
      missing: [],
    };
  }
  record("deadline", String(deadlineSeconds), `your deadline ${request.deadline} in unix seconds`);

  const nonce = record(
    "nonce",
    deriveNonce(request, context.now),
    request.idempotencyKey ? "your idempotencyKey" : "this request and the clock, because no idempotencyKey was given",
  );

  const endpoint = record(
    "endpoint",
    context.provider.endpoint,
    `the registered base URL of provider ${context.provider.providerId}`,
  );

  // ── what cannot be derived ────────────────────────────────────────────────
  let recipientAddress: Address | null = null;
  if (request.recipient !== undefined) {
    if (!ADDRESS.test(request.recipient)) {
      return {
        ok: false,
        code: "RECIPIENT_INVALID",
        message: "recipient must be a 20-byte hex address",
        missing: [],
      };
    }
    recipientAddress = request.recipient.toLowerCase() as Address;
    record("recipientAddress", recipientAddress, "the recipient constraint you sent");
  } else if (context.provider.resolvedRecipient) {
    recipientAddress = context.provider.resolvedRecipient;
    record("recipientAddress", recipientAddress, `the payment address resolved from provider ${context.provider.providerId}`);
  } else {
    missing.push({
      field: "recipientAddress",
      why: "you did not constrain who may be paid, and no quote has resolved the provider's payment address. The address this host is itself paid at is not the provider's, and using it would judge a payment to the wrong party.",
      resolvedFrom: "either send `recipient`, or a resolved quote for this provider and capability",
    });
  }

  const buyerAgentId = request.buyerAgentId?.trim();
  if (buyerAgentId !== undefined && buyerAgentId !== "" && UINT.test(buyerAgentId)) {
    record("buyerAgentId", buyerAgentId, "the buyer agent id you sent");
  } else {
    missing.push({
      field: "buyerAgentId",
      why: "which agent is doing the spending is a property of an account, and this wallet is not yet bound to one. A zero here would receipt the decision against an agent that does not exist.",
      resolvedFrom: "either send `buyerAgentId`, or bind your wallet to an Untch account",
    });
  }

  const workerAgentId = request.workerAgentId?.trim();
  if (workerAgentId !== undefined && workerAgentId !== "" && UINT.test(workerAgentId)) {
    record("workerAgentId", workerAgentId, "the worker agent id you sent");
  } else {
    missing.push({
      field: "workerAgentId",
      why: "which agent is being paid is a property of the provider's registration, and no binding records it yet.",
      resolvedFrom: "either send `workerAgentId`, or bind this provider to its registered agent identity",
    });
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: "AUTHORITY_NOT_DERIVABLE",
      message: `${missing.length} value(s) could not be derived without inventing them: ${missing.map((m) => m.field).join(", ")}. Each entry in \`missing\` says what would supply it.`,
      missing,
    };
  }

  const intent: SpendIntentInput = {
    owner,
    buyerAgentId: BigInt(buyerAgentId as string),
    workerAgentId: BigInt(workerAgentId as string),
    token,
    maxAmount: BigInt(maxAmount),
    taskHash,
    acceptanceHash,
    schemaHash,
    policyHash,
    deadline: BigInt(deadlineSeconds),
    nonce: BigInt(nonce),
    endpoint,
    paramsHash,
    recipientAddress: recipientAddress as Address,
    category: context.provider.capability,
    amount: Number(request.maxSpend),
  };

  return { ok: true, intent, derived };
}

/**
 * The evidence a verification is built from, all of it held by this service.
 *
 * There is no mapping function for `PublicVerifyRequest` in the sense that preflight has one, and the
 * absence is the point: the request carries one identifier, and everything the verifier needs is
 * loaded against it. What this type records is WHICH stores must answer, so a partial load is a
 * named gap rather than a verification that quietly judged against less than it should have.
 */
export interface VerificationEvidence {
  readonly intentId: string;
  readonly policyFound: boolean;
  readonly intentFound: boolean;
  readonly quoteFound: boolean;
  readonly executionFound: boolean;
  readonly settlementFound: boolean;
  readonly resultFound: boolean;
  readonly receiptFound: boolean;
}

/** Which pieces of evidence are absent. Empty means the verification is judging on the full record. */
export function missingEvidence(evidence: VerificationEvidence): readonly string[] {
  const gaps: string[] = [];
  if (!evidence.policyFound) gaps.push("the policy this intent was judged against");
  if (!evidence.intentFound) gaps.push("the intent itself");
  if (!evidence.quoteFound) gaps.push("the quote that priced it");
  if (!evidence.executionFound) gaps.push("the provider execution");
  if (!evidence.settlementFound) gaps.push("the settlement");
  if (!evidence.resultFound) gaps.push("the delivered result");
  if (!evidence.receiptFound) gaps.push("the receipt");
  return gaps;
}

/** A caller-supplied result hash, checked for shape before it is compared to anything. */
export function parseExpectedResultHash(raw: string | undefined): Hex | null {
  if (raw === undefined) return null;
  return /^0x[0-9a-fA-F]{64}$/.test(raw) ? (raw.toLowerCase() as Hex) : null;
}

/** Stable id for a provider capability, used where a 32-byte value is needed for one. */
export function capabilityId(providerId: string, capability: string): Hex {
  return keccak256(toHex(`untch-capability:${providerId}/${capability}`));
}
