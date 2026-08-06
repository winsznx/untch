import { SERVICES } from "./services";
import type { JsonSchema, ServiceDefinition } from "./types";

/**
 * The OKX three-part description, generated from the contract instead of typed into a chat window.
 *
 * WHAT THE RULE IS
 *
 * OKX's own listing guidance for a non-subscription service requires three parts: what the service
 * does and who it is for; exactly what the caller provides; exactly what the caller receives. Both
 * rejected Untch services shipped two. Part three was absent entirely, and there is an official
 * pre-submission gate that checks for it which the submission never ran, because the submission was a
 * hand-written markdown table pasted into an agent chat.
 *
 * WHY GENERATION IS THE FIX AND NOT A BETTER TABLE
 *
 * A table can be correct on the day it is written. The audit found the same contract described in six
 * places, and the one that was enforced — the validators — disagreed with all five of the others. Part
 * two here is derived from the input schema's required fields, so a description cannot claim three
 * requirements while the validator demands seventeen: adding a required field changes the sentence.
 *
 * WHAT MAY NOT APPEAR
 *
 * No private section numbers. The registered descriptions cited "§7.1" and "§13/§7.3" — references
 * into an internal PRD that no reader outside this repository can resolve. To a marketplace agent
 * they are noise; to a human they are a promise of documentation that does not exist publicly.
 * `assertNoPrivateReferences` fails the build on them.
 */

export interface ThreePartDescription {
  readonly toolId: string;
  /** What it does and who it is for. */
  readonly what: string;
  /** Exactly what the caller provides. */
  readonly provide: string;
  /** Exactly what the caller receives. */
  readonly receive: string;
  /** The three parts joined, as the listing field wants them. */
  readonly text: string;
}

/** `§7.1`, `PRD §13`, `section 12.4` — anything that points into a document the reader cannot open. */
const PRIVATE_REFERENCE = /§\s*\d|(?:\bPRD\b)|(?:\bsection\s+\d+\.\d)/i;

export function assertNoPrivateReferences(text: string, where: string): void {
  const hit = PRIVATE_REFERENCE.exec(text);
  if (hit) {
    throw new Error(
      `${where} cites ${JSON.stringify(hit[0])}, which points into a document a marketplace reader cannot open. ` +
        "Say the thing itself instead of naming the section that says it.",
    );
  }
}

function describeField(name: string, schema: JsonSchema): string {
  const bits: string[] = [name];
  if (schema.type) bits.push(`(${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type})`);
  return bits.join(" ");
}

/**
 * Part two, built from the schema's own required list.
 *
 * Nested objects are expanded one level, because "an intent" is not a description of a requirement —
 * the whole failure being corrected is that a caller could read the published contract, send what it
 * asked for, and be refused by a validator wanting sixteen fields more.
 */
export function describeInputs(service: ServiceDefinition): string {
  const input = service.input;
  const required = input.required ?? [];
  if (required.length === 0 && !input.properties) return "Nothing. This service takes no parameters.";
  if (required.length === 0) {
    const optional = Object.keys(input.properties ?? {});
    if (optional.length === 0) return "Nothing. This service takes no parameters.";
    return `Any one of: ${optional.join(", ")}.`;
  }

  const parts: string[] = required.map((name) => describeRequirement(name, input));
  parts.push(...describeChoices(input, input));
  return `${parts.join("; ")}.`;
}

/** One required field, expanded one level when it is an object with requirements of its own. */
function describeRequirement(name: string, container: JsonSchema): string {
  const field = container.properties?.[name];
  if (!field) return name;
  const nestedRequired = field.required ?? [];
  if (field.type === "object" && nestedRequired.length > 0) {
    return `${name}, containing all ${nestedRequired.length} of: ${nestedRequired.join(", ")}`;
  }
  return describeField(name, field);
}

/**
 * The `anyOf` alternatives, spelled out as "either X or Y".
 *
 * Without this the generated sentence for policy preflight read "You provide: policyId" — one
 * requirement, for a service whose validator wants seventeen. That is the rejected listing, generated
 * instead of typed, which would have been no improvement at all.
 */
function describeChoices(schema: JsonSchema, root: JsonSchema): string[] {
  const out: string[] = [];
  for (const group of [schema.anyOf, ...(schema.allOf ?? []).map((b) => b.anyOf)]) {
    if (!group || group.length === 0) continue;
    const alternatives = group.map((alt) =>
      (alt.required ?? []).map((n) => describeRequirement(n, root)).join(" and "),
    );
    out.push(`either ${alternatives.join(", or ")}`);
  }
  return out;
}

export function threePartDescription(service: ServiceDefinition): ThreePartDescription {
  const what = `${service.summary} For ${service.intendedCaller}.`;
  const provide = `You provide: ${describeInputs(service)}`;
  const receive = `You receive: ${service.delivers}.`;
  const text = `${what}\n\n${provide}\n\n${receive}`;
  assertNoPrivateReferences(text, `the generated description for ${service.toolId}`);
  return { toolId: service.toolId, what, provide, receive, text };
}

/**
 * A service is listable only when every predecessor it needs can actually be obtained.
 *
 * This is the check that would have stopped the rejected submission. Both services were described as
 * needing two or three things and required a policy id no public route creates — so a caller could
 * follow the listing exactly and still be refused, or worse, pay and be refused. `obtainableBy: null`
 * on any predecessor means the listing generator will not emit an entry, and the reason travels with
 * the refusal so it is actionable rather than mysterious.
 */
export interface ListingVerdict {
  readonly toolId: string;
  readonly listable: boolean;
  readonly blockedBy: readonly string[];
}

/**
 * Two independent reasons to withhold, and both have to be asked.
 *
 * The predecessor check catches routes that are BROKEN for a stranger — a service needing a policy
 * no public route creates. It says nothing about routes that work perfectly and are still not
 * products. `POST /consumer/account/link/start` is reachable, documented, free and correct, and
 * listing it advertises this project's own sign-in as something to buy.
 *
 * Twenty-four entries were published on the predecessor check alone. Wallet linking, policy
 * drafting, a default-policy setter and an approval-decision route all passed it, because nothing
 * about them is broken. The class is what refuses them.
 */
export function listingVerdict(service: ServiceDefinition): ListingVerdict {
  const blockedBy = service.predecessors.filter((p) => p.obtainableBy === null).map((p) => p.what);
  if (service.classification.serviceClass !== "MARKETPLACE_LISTABLE") {
    return {
      toolId: service.toolId,
      listable: false,
      blockedBy: [
        `classified ${service.classification.serviceClass}: ${service.classification.reason}`,
        ...blockedBy,
      ],
    };
  }
  /**
   * A listable service that a stranger cannot call is a contradiction, refused here rather than
   * trusted to be caught by whoever wrote the class. The two fields are set by hand and by different
   * arguments, so disagreement between them is exactly the kind of thing that survives review.
   */
  if (!service.classification.strangerCallable) {
    return {
      toolId: service.toolId,
      listable: false,
      blockedBy: [
        "classified MARKETPLACE_LISTABLE but marked not stranger-callable — a marketplace entry no " +
          "stranger can complete is a contradiction, not a listing",
        ...blockedBy,
      ],
    };
  }
  return { toolId: service.toolId, listable: blockedBy.length === 0, blockedBy };
}

export interface ListingEntry {
  readonly toolId: string;
  readonly name: string;
  readonly endpoint: string;
  readonly method: string;
  readonly protocol: string;
  readonly pricing: string;
  readonly description: string;
  readonly schemaUrl: string;
  readonly schemaVersion: string;
  /** Always `MARKETPLACE_LISTABLE` — published so a reader can see the claim rather than infer it. */
  readonly serviceClass: string;
  /** Why this one is safe to list, carried into the payload so the argument travels with the entry. */
  readonly classReason: string;
}

export interface ListingPayload {
  readonly role: "asp";
  readonly name: string;
  readonly baseUrl: string;
  readonly network: string;
  readonly service: readonly ListingEntry[];
  /** Services deliberately withheld, with the reason. Withholding silently is how a gap gets forgotten. */
  readonly withheld: readonly ListingVerdict[];
}

export function buildListingPayload(args: {
  readonly baseUrl: string;
  readonly network: string;
  readonly name: string;
}): ListingPayload {
  const service: ListingEntry[] = [];
  const withheld: ListingVerdict[] = [];

  for (const s of SERVICES) {
    const verdict = listingVerdict(s);
    if (!verdict.listable) {
      withheld.push(verdict);
      continue;
    }
    service.push({
      toolId: s.toolId,
      name: s.publicName,
      endpoint: `${args.baseUrl}${s.path}`,
      method: s.method,
      protocol: s.protocol,
      pricing: s.pricing.kind === "free" ? "free" : `${s.pricing.price} per call`,
      description: threePartDescription(s).text,
      schemaUrl: `${args.baseUrl}/schema/${s.toolId}`,
      schemaVersion: s.schemaVersion,
      serviceClass: s.classification.serviceClass,
      classReason: s.classification.reason,
    });
  }

  return { role: "asp", name: args.name, baseUrl: args.baseUrl, network: args.network, service, withheld };
}
