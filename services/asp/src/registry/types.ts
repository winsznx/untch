/**
 * One typed description per public service, and everything else derived from it.
 *
 * WHY THIS EXISTS
 *
 * The cold relisting audit traced the same service contract to six places, none generated from
 * another: a hand-written markdown table that was typed into the OKX submission chat, a second
 * submission doc, the `services[]` array in `/agent-registration.json`, the `role` strings in
 * `/catalog`, the `description` inside each 402 challenge, and — the only one that was actually
 * enforced — the validators. Nothing reconciled the first five against the sixth. The listing said a
 * service needed three things; the validator demanded seventeen.
 *
 * The 402 body made that unrecoverable. It was `{}`. A marketplace agent hitting a paid route got a
 * bill and no contract, so the only way to learn what a tool wanted was to pay for a rejection.
 *
 * This module is the sixth place becoming the only place. Every field below is either enforced at
 * runtime or published, and the generated artefacts — OpenAPI, the x402 discovery document, the
 * registration card's service list, the OKX three-part descriptions, the conformance fixtures — are
 * projections of it that CI refuses to let drift.
 *
 * WHAT A DEFINITION IS FOR
 *
 * Not documentation. A definition has to answer the questions a stranger's agent asks before it
 * spends money: what do I send, what do I get, what must already exist before this can succeed, what
 * will it change, what will it charge me, and what will it refuse. `predecessors` and `sideEffects`
 * are there because the audit's central finding was not that the descriptions were short — it was
 * that both rejected services were UNREACHABLE, needing a policy no public route could create. A
 * contract that documents its inputs perfectly and stays silent about that is still a trap.
 */

/** The transport a marketplace caller reaches this service through. */
export type ServiceProtocol = "A2MCP" | "A2A";

/**
 * What kind of thing a route IS, which is a different question from whether it works.
 *
 * WHY A CLASS AND NOT A BOOLEAN
 *
 * The listing generator already refused to publish a service whose predecessors could not be
 * obtained. That check is necessary and it is not sufficient, because it only catches the routes
 * that are BROKEN for a stranger. It says nothing about the routes that work perfectly and are still
 * not products: `POST /consumer/account/link/start` is reachable, documented, free and correct, and
 * listing it on a marketplace would be advertising this project's own account setup as a service
 * somebody could buy.
 *
 * Twenty-four entries were published on that basis. Among them were wallet linking, policy drafting,
 * a default-policy setter and an approval-decision route, none of which a stranger's agent has any
 * reason to call, plus a health ping and a coffee simulation. The count looked like breadth; it was
 * a classification that had never been made.
 *
 * Exactly one class per route, and `reason` is required, so the answer to "why is this listed" is
 * always a sentence somebody wrote rather than an inference from what the code happens to do.
 */
export type ServiceClass =
  /**
   * A stranger's agent can call it with the documented input and receive the exact promised result.
   * A paid entry must produce a real standalone deliverable after settlement; a free entry must
   * return the real result directly, with no payment involved.
   */
  | "MARKETPLACE_LISTABLE"
  /**
   * Discovery, health or documentation. Free and public, and not a product — nobody buys a catalog.
   */
  | "PUBLIC_SUPPORT"
  /**
   * Configures or operates an existing Untch account. A real product API, and not a marketplace
   * product: it expects authentication, an account binding, or prior state that belongs to a
   * specific person. Being free is not what disqualifies it. Being somebody's account is.
   */
  | "ACCOUNT_CONTROL"
  /**
   * Answers from private host history, operator access, a known buyer or a known vendor. A stranger
   * cannot supply what it needs, so a stranger cannot buy the result — at any price.
   */
  | "INTERNAL_OR_WITHHELD"
  /**
   * Incomplete, unsafe, or unable to deliver what it would charge for. Mounted or not, it is not on
   * offer.
   */
  | "PRODUCTION_DISABLED";

/** Only one class is ever published to the marketplace. The rest are stated so they are not guessed. */
export const MARKETPLACE_CLASS: ServiceClass = "MARKETPLACE_LISTABLE";

export interface ServiceClassification {
  readonly serviceClass: ServiceClass;
  /**
   * Why this route is in this class, in a sentence a reviewer can check against the code.
   *
   * Required for every class including the listable one. "Why is this NOT listed" and "why is this
   * SAFE to list" are the same question asked from two sides, and only recording one of them is how
   * a listing comes to contain routes nobody ever argued for.
   */
  readonly reason: string;
  /**
   * Whether an arbitrary external buyer — no account here, no prior state — can complete this call.
   *
   * This is the single fact the whole classification turns on, so it is recorded separately rather
   * than left implicit in the class. A MARKETPLACE_LISTABLE service with this false is a
   * contradiction, and a test says so.
   */
  readonly strangerCallable: boolean;
  /** Whether the route appears in the free, public `/catalog`. Independent of being listable. */
  readonly catalogVisible: boolean;
}

/**
 * How honest the service is about its own readiness.
 *
 * `blocked` is the load-bearing value. It means the contract is correct and the service still cannot
 * be completed by a fresh caller, because something it requires has no public way to be created. A
 * registry without it would let a service that is merely well-described pass for one that works.
 */
export type ServiceMaturity = "live" | "demo" | "blocked";

export interface ServicePricing {
  /** `free` costs nothing and settles nothing. `paid` is gated by x402 before the handler runs. */
  readonly kind: "free" | "paid";
  /** Display price, e.g. `$0.05`. Null when free. */
  readonly price: string | null;
  /** Base units at the settlement token's decimals, as a decimal string. Null when free. */
  readonly amountBaseUnits: string | null;
}

/**
 * Something that must already exist before a call can succeed.
 *
 * `obtainableBy` is the field that matters, and `null` is a legitimate and important value: it means
 * there is NO public route that produces this, which is precisely the state that made two listed
 * services uncallable. Recording it is what lets the listing generator refuse to publish them.
 */
export interface Predecessor {
  readonly what: string;
  readonly why: string;
  /** The public route or flow that produces it, or null when none exists. */
  readonly obtainableBy: string | null;
}

/** What the call changes. An empty list is a claim, not an omission. */
export interface SideEffect {
  readonly what: string;
  /** Whether it outlives the request. A durable effect is one a caller may need to reconcile later. */
  readonly durable: boolean;
}

/**
 * Whether repeating an identical request repeats its effect.
 *
 * `not-idempotent` on a PAID route is worth stating loudly: `verify_delivery` writes a durable receipt
 * and anchors it, so a retried call after a timeout costs $0.10 again and produces a second receipt.
 * The registered description never said so.
 */
export type Idempotency = "idempotent" | "not-idempotent" | "read-only";

export interface RefusalCode {
  readonly code: string;
  readonly status: number;
  readonly when: string;
}

/** A worked request, with the response or refusal it actually produces. */
export interface ServiceExample {
  readonly title: string;
  readonly request: unknown;
  /** For `invalid`, the refusal code the real validator returns. */
  readonly refusalCode?: string;
}

export interface ServiceDefinition {
  /** Stable across renames and reprices. Never reused for a different contract. */
  readonly toolId: string;
  /** What a human sees in a marketplace listing. */
  readonly publicName: string;
  readonly protocol: ServiceProtocol;
  /**
   * PUT is here because one route is a PUT and the type could not say so.
   *
   * `set_default_policy` is served as `PUT /consumer/account/default-policy` — the idempotent-replace
   * semantic is the right one for setting a default. With only GET and POST available, the entry was
   * written as POST, and every caller following our own catalog or MCP tool list got a 405 naming the
   * method they should have been given. A type that cannot express the truth gets a plausible lie
   * instead.
   */
  readonly method: "GET" | "POST" | "PUT";
  readonly path: string;
  readonly pricing: ServicePricing;
  readonly maturity: ServiceMaturity;
  /**
   * What this route is, and why. Required — a service with no stated class is one nobody decided
   * about, and the listing generator refuses to publish a decision that was never made.
   */
  readonly classification: ServiceClassification;
  /**
   * Still served, and nobody should build on it.
   *
   * Distinct from the class: ACCOUNT_CONTROL says "this is not a marketplace product", deprecated
   * says "this is on its way out". `approval_decide` is both, and a reader needs to be told both.
   */
  readonly deprecated?: boolean;
  /** One sentence. What it does — not how. */
  readonly summary: string;
  /** Who this is for, in their own terms. Part one of the OKX three-part description. */
  readonly intendedCaller: string;
  /** What the caller receives. Part three of the OKX three-part description. */
  readonly delivers: string;

  readonly input: JsonSchema;
  readonly output: JsonSchema;

  readonly validExample: ServiceExample;
  readonly invalidExample: ServiceExample;

  readonly predecessors: readonly Predecessor[];
  readonly sideEffects: readonly SideEffect[];
  readonly idempotency: Idempotency;
  readonly refusals: readonly RefusalCode[];

  /**
   * Bumped when the contract changes in a way an existing caller would notice. Adding an optional
   * field is not a change an existing caller notices; removing one, or tightening a rule, is.
   */
  readonly schemaVersion: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// The JSON Schema subset
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deliberately small subset of JSON Schema — the constructs these contracts actually use.
 *
 * WHY A SUBSET
 *
 * The alternative was a dependency. Ajv is the right answer for arbitrary schemas, and this registry
 * does not have arbitrary schemas: it has object shapes with typed fields, patterns, enums and a
 * handful of `anyOf` alternatives. Pulling in a validator and its meta-schema to check that would
 * be adding a supply-chain surface to the money path for constructs nobody writes.
 *
 * WHY UNSUPPORTED KEYWORDS ARE A HARD ERROR
 *
 * The failure mode of a partial validator is not that it rejects too much — it is that it SILENTLY
 * SKIPS what it does not understand, so a schema author believes a rule is enforced when nothing
 * reads it. `assertSupported` runs over every registered schema in a test, so an unsupported keyword
 * fails the build rather than becoming a rule that is published and never checked.
 */
export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface JsonSchema {
  readonly type?: JsonSchemaType | readonly JsonSchemaType[];
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly anyOf?: readonly JsonSchema[];
  /**
   * Every branch must hold. Present because two contracts require a choice on TWO independent axes —
   * verify_delivery needs an intent (inline or by hash) AND a delivery (inline or by hash) — and a
   * single `anyOf` would have to enumerate the cross product, which reads as four unrelated shapes
   * rather than as two independent choices.
   */
  readonly allOf?: readonly JsonSchema[];
  readonly examples?: readonly unknown[];
  /** Free-form note carried into the published schema. Never enforced. */
  readonly $comment?: string;
}

export const SUPPORTED_KEYWORDS: readonly string[] = [
  "type",
  "title",
  "description",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "minItems",
  "maxItems",
  "anyOf",
  "allOf",
  "examples",
  "$comment",
];
