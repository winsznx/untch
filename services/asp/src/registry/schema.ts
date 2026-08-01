import { SUPPORTED_KEYWORDS, type JsonSchema, type JsonSchemaType } from "./types";

/**
 * Validate a value against the registry's JSON Schema subset, and refuse schemas it cannot enforce.
 *
 * The second half is the point. A validator that ignores a keyword it does not implement turns a
 * published rule into a decoration: the schema says `minLength: 3`, the caller trusts it, and nothing
 * checks it. `assertSupported` walks a schema and throws on any keyword outside the supported set, and
 * the registry test runs it over every definition — so an unimplemented rule fails the build instead
 * of shipping as a promise nobody keeps.
 *
 * Errors are phrased as instructions rather than as assertions. The reader is an agent that has just
 * had a request refused and has to decide what to send instead; "expected string, got number" is a
 * diagnosis, and "`amount` must be a number" is a fix.
 */

export interface SchemaViolation {
  /** JSON-pointer-ish path into the value, e.g. `intent.maxAmount`. Empty string for the root. */
  readonly path: string;
  readonly message: string;
}

class UnsupportedSchema extends Error {
  constructor(keyword: string, at: string) {
    super(
      `schema keyword ${JSON.stringify(keyword)} at ${at || "<root>"} is not implemented by the registry validator. ` +
        "Implement it in registry/schema.ts or express the rule with a supported keyword — a rule that " +
        "is published but not enforced is worse than one that is absent.",
    );
    this.name = "UnsupportedSchema";
  }
}

/** Throw if `schema` uses anything the validator below would silently ignore. */
export function assertSupported(schema: JsonSchema, at = ""): void {
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.includes(key)) throw new UnsupportedSchema(key, at);
  }
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    assertSupported(sub, at ? `${at}.${name}` : name);
  }
  if (schema.items) assertSupported(schema.items, `${at}[]`);
  for (const [i, alt] of (schema.anyOf ?? []).entries()) assertSupported(alt, `${at}/anyOf[${i}]`);
  for (const [i, alt] of (schema.allOf ?? []).entries()) assertSupported(alt, `${at}/allOf[${i}]`);
}

function typeOf(value: unknown): JsonSchemaType {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "string") return "string";
  return "object";
}

function typeMatches(expected: JsonSchemaType, actual: JsonSchemaType): boolean {
  // An integer is a number; a number is not an integer. Nothing else widens.
  if (expected === "number") return actual === "number" || actual === "integer";
  return expected === actual;
}

function describeTypes(t: JsonSchemaType | readonly JsonSchemaType[]): string {
  return Array.isArray(t) ? t.join(" or ") : String(t);
}

export function validate(schema: JsonSchema, value: unknown, path = ""): SchemaViolation[] {
  const out: SchemaViolation[] = [];
  const here = path;

  for (const branch of schema.allOf ?? []) {
    out.push(...validate(branch, value, path));
  }

  if (schema.anyOf) {
    const allFailed = schema.anyOf.every((alt) => validate(alt, value, path).length > 0);
    if (allFailed) {
      // Named by what each alternative ASKS FOR, not by its type: the alternatives that matter here
      // are "send the thing" versus "send its hash", and both are objects.
      const shapes = schema.anyOf
        .map((a) => (a.required && a.required.length > 0 ? a.required.join(" and ") : a.type ? describeTypes(a.type) : "an alternative form"))
        .join(", or ");
      out.push({ path: here, message: `must carry one of: ${shapes}` });
      if (!schema.type) return out;
    }
  }

  if (schema.type !== undefined) {
    const actual = typeOf(value);
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!expected.some((e) => typeMatches(e, actual))) {
      out.push({ path: here, message: `must be ${describeTypes(schema.type)}` });
      return out; // Every check below assumes the type held.
    }
  }

  if (schema.const !== undefined && value !== schema.const) {
    out.push({ path: here, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    out.push({ path: here, message: `must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}` });
  }

  if (typeof value === "string") {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      out.push({ path: here, message: `must match ${schema.pattern}` });
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      out.push({ path: here, message: `must be at least ${schema.minLength} characters` });
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      out.push({ path: here, message: `must be at most ${schema.maxLength} characters` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      out.push({ path: here, message: `must be at least ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      out.push({ path: here, message: `must be at most ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      out.push({ path: here, message: `must have at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      out.push({ path: here, message: `must have at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      for (const [i, item] of value.entries()) out.push(...validate(schema.items, item, `${here}[${i}]`));
    }
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    for (const name of schema.required ?? []) {
      if (obj[name] === undefined) {
        out.push({ path: here ? `${here}.${name}` : name, message: "is required" });
      }
    }
    for (const [name, sub] of Object.entries(schema.properties ?? {})) {
      if (obj[name] === undefined) continue;
      out.push(...validate(sub, obj[name], here ? `${here}.${name}` : name));
    }
    if (schema.additionalProperties === false && schema.properties) {
      const known = new Set(Object.keys(schema.properties));
      for (const name of Object.keys(obj)) {
        if (!known.has(name)) {
          out.push({
            path: here ? `${here}.${name}` : name,
            // Named rather than dropped: a field the caller believed was doing something, and was not.
            message: "is not a field of this request; it would have been ignored",
          });
        }
      }
    }
  }

  return out;
}

/** One line a caller can act on, or null when the value conforms. */
export function describeViolations(violations: readonly SchemaViolation[]): string | null {
  if (violations.length === 0) return null;
  return violations.map((v) => `${v.path || "the request body"} ${v.message}`).join("; ");
}
