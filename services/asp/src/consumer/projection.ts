/**
 * Projecting a Consumer Intent onto a §8.1 SpendIntent.
 *
 * This is the join between the two halves of Untch, and it is the reason the Consumer Pack does not
 * ship a second policy engine. A consumer action — "register untchprobe.com for $20.00 USDC on Base"
 * — is projected into exactly the object `@untch/policy-engine` already evaluates, so all thirteen
 * §7.1 rules apply to a domain registration for the same reason they apply to an A2MCP call. Budget,
 * per-call cap, escalate-above, category allow/deny, recipient allow/deny, duplicates, cooldowns,
 * rate limit, expiry: none of them needed changing.
 *
 * Four mapping decisions are worth stating, because each could reasonably have gone another way:
 *
 *   1. `amount` (the DISPLAY figure every budget rule reads) is the TOTAL the user funds, not the
 *      provider's cost. A user's daily budget is spent on what leaves their wallet, and the fee and
 *      spread leave their wallet too. Charging the budget only the provider's share would let fees
 *      accumulate outside every limit a policy sets.
 *
 *   2. `maxAmount` (the base-units ceiling) is the AUTHORISED maximum, which may exceed `amount` when
 *      a policy permits tolerance. The engine's intent-bound rule compares the two, so the ceiling
 *      has to be the ceiling, not a copy of the amount.
 *
 *   3. `token` is the FUNDING token (X Layer USDT0), not the settlement token. `maxAmount` and
 *      `amount` are denominated in what the user pays, so the token field must agree with them or
 *      the intent describes two different currencies at once.
 *
 *   4. `recipientAddress` is the PROVIDER's settlement address, not the funding address. The
 *      recipient allow/deny rule exists to answer "may my agent send money to THIS party", and the
 *      party is the merchant. Untch's own funding wallet is never the interesting answer.
 *
 * `category` is `consumer.<action>` (e.g. `consumer.domains.register`), so a policy can allow
 * `consumer.domains.check` while denying `consumer.domains.register` — a distinction that matters a
 * great deal when one costs five cents and the other twenty dollars.
 */

import { canonUrl, hashSpendIntent, type SpendIntent } from "@untch/canon";
import type { SpendIntentInput } from "@untch/policy-engine";
import {
  formatMoney,
  policyCategoryFor,
  sha256Hex,
  stableStringify,
  type ConsumerIntent,
  type ConsumerQuote,
} from "@untch/consumer-core";
import type { StoredPolicy } from "@untch/policy-store";
import { getAddress, keccak256, toHex, type Address, type Hex } from "viem";

const ZERO_BYTES32 = `0x${"0".repeat(64)}` as Hex;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** keccak of a UTF-8 string, for the task / params / schema hashes. */
function hashText(text: string): Hex {
  return keccak256(toHex(text));
}

/**
 * A stable, non-EVM recipient still has to occupy an `address` field. A Solana mint or a base58
 * account is hashed down to 20 bytes rather than left as a zero address, so the recipient allow/deny
 * rule can still distinguish two Solana merchants from each other. The mapping is deterministic and
 * documented; it is an identifier, never something anyone should try to send funds to.
 */
export function recipientAsAddress(recipient: string): Address {
  if (/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    return getAddress(recipient).toLowerCase() as Address;
  }
  const digest = keccak256(toHex(`non-evm:${recipient}`));
  return `0x${digest.slice(-40)}` as Address;
}

export interface ProjectedIntent {
  readonly input: SpendIntentInput;
  readonly struct: SpendIntent;
  readonly intentHash: Hex;
}

export interface ProjectionArgs {
  readonly intent: ConsumerIntent;
  readonly quote: ConsumerQuote;
  readonly stored: StoredPolicy;
  /** Unix seconds the authorisation is good until — the quote's expiry. */
  readonly deadlineSec: bigint;
  /** A per-intent nonce. Derived from the intentId so a retry projects identically. */
  readonly nonce?: bigint;
}

/**
 * Build the §8.1 struct and the engine input for one quoted consumer action.
 *
 * Everything here is DERIVED. Nothing is caller-supplied, which is what makes the projection
 * tamper-evident: the same intent and quote always produce the same `intentHash`, and any change to
 * what was quoted changes it.
 */
export function projectConsumerIntent(args: ProjectionArgs): ProjectedIntent {
  const { intent, quote, stored } = args;

  const owner = getAddress(stored.owner).toLowerCase() as Address;
  const buyerAgentId = agentIdToUint(intent.requestingAgentId);
  const fundingToken = quote.totalUserAmount.asset.address;
  const token = fundingToken === null ? ZERO_ADDRESS : (getAddress(fundingToken).toLowerCase() as Address);

  // The endpoint the money buys. Normalised with canon's canonUrl so the cooldown rule's
  // service-identity and the duplicate rule's key match what the rest of Untch computes.
  const endpoint = canonUrl(`${providerBaseUrl(intent, quote)}#${intent.action}`);

  // taskHash commits to WHAT is being bought; paramsHash to the exact request that buys it. Two
  // registrations of the same domain share a taskHash, which is precisely what the duplicate rule
  // needs to see.
  const taskHash = hashText(`${intent.action}|${quote.providerId}|${quote.providerRef}`);
  const paramsHash = hashText(stableStringify(intent.request));

  // acceptanceHash commits to the delivery criteria. For a consumer action that is the quote's own
  // terms: what the merchant said it would do is what it must be judged against.
  const acceptanceHash = hashText(stableStringify(quote.terms));
  const schemaHash = hashText(`untch.consumer.v1:${intent.action}`);

  const struct: SpendIntent = {
    owner,
    buyerAgentId,
    workerAgentId: 0n, // an A2MCP-style call: no worker agent (§8.1)
    token,
    maxAmount: quote.maxAuthorisedAmount.amount,
    taskHash,
    acceptanceHash,
    schemaHash,
    policyHash: stored.policyHash.toLowerCase() as Hex,
    deadline: args.deadlineSec,
    nonce: args.nonce ?? nonceFor(intent.intentId),
  };

  const input: SpendIntentInput = {
    ...struct,
    endpoint,
    paramsHash,
    recipientAddress: recipientAsAddress(quote.settlementRecipient),
    category: policyCategoryFor(intent.action),
    // DISPLAY units of the funding token — the total the user actually parts with.
    amount: Number(formatMoney(quote.totalUserAmount)),
  };

  return { input, struct, intentHash: hashSpendIntent(struct) };
}

/**
 * The agent id as a uint. The §8 model uses numeric agent ids; a consumer caller may present a
 * non-numeric one, so a non-numeric id is hashed into the uint space deterministically rather than
 * collapsed to 0 — which would make every non-numeric agent share one budget.
 */
export function agentIdToUint(agentId: string): bigint {
  const t = agentId.trim();
  if (/^\d+$/.test(t)) return BigInt(t);
  return BigInt(`0x${sha256Hex(t).slice(0, 32)}`);
}

/** A deterministic per-intent nonce, so a retried projection is byte-identical. */
export function nonceFor(intentId: string): bigint {
  return BigInt(`0x${sha256Hex(`nonce:${intentId}`).slice(0, 32)}`);
}

function providerBaseUrl(intent: ConsumerIntent, quote: ConsumerQuote): string {
  const fromRequest = intent.request.__providerBaseUrl;
  if (typeof fromRequest === "string" && fromRequest.startsWith("https://")) return fromRequest;
  return `https://consumer.untch.xyz/${quote.providerId}`;
}

export { ZERO_BYTES32 };
