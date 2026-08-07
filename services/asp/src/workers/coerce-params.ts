/**
 * Accept an object-valued parameter that arrived as a JSON string.
 *
 * WHY
 *
 * The OnChainOS CLI serialises `payment pay --param` values as strings. A tool whose contract takes an
 * object — `redact_payment_metadata` takes `metadata` — therefore receives `"{\"email\":\"a@b.c\"}"`
 * where it expects `{email: "a@b.c"}`, and validation refuses it. An independent buyer hit exactly
 * this: the call only settled after they hand-built the JSON body and replayed the x402 signature
 * themselves. Any buyer using the standard CLI on an object-param tool trips on it.
 *
 * The seller can fix this for every buyer by accepting both, or every buyer can work around it
 * individually. Accepting both is obviously right.
 *
 * WHAT IT WILL NOT DO
 *
 * Only a string that parses to an OBJECT or ARRAY is replaced. A string that happens to parse as a
 * number, a boolean or null is left exactly as it was — `"123"` is a string the caller sent, and
 * turning it into `123` would be inventing a type they did not ask for and could not have meant.
 *
 * Only the top level is walked. A nested string is the nested contract's business, and recursing would
 * make this a general-purpose coercion pass with no boundary — the kind of helpful guess that quietly
 * changes a payload nobody asked it to touch.
 */

export function coerceObjectParams(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = value;
    if (typeof value !== "string") continue;

    const trimmed = value.trim();
    // Cheap shape check first: only `{…}` and `[…]` can be the object the contract wanted, and this
    // avoids attempting a parse on every ordinary string field.
    if (!(trimmed.startsWith("{") && trimmed.endsWith("}")) && !(trimmed.startsWith("[") && trimmed.endsWith("]"))) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        out[key] = parsed;
        changed = true;
      }
    } catch {
      // Not JSON. A string that merely starts with a brace is still just a string.
    }
  }

  return changed ? out : body;
}
