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
 * WHAT IT WILL NOT DO WITHOUT A SCHEMA
 *
 * Only a string that parses to an OBJECT or ARRAY is replaced. A bare `"123"` is left alone, because
 * turning it into `123` would be inventing a type the caller never asked for.
 *
 * WITH the tool's own schema it is not a guess, and then it must go further. `--param` can only
 * produce strings, so a contract declaring `useDefaultPolicy: boolean` receives `"true"`, the handler
 * checks `typeof === "boolean"`, drops it, and refuses the call for a missing parameter the caller
 * plainly supplied. That is not hypothetical: `preflight_payment` with `--param useDefaultPolicy=true`
 * answered POLICY_ID_REQUIRED after a live purchase. Every boolean or numeric parameter on every tool
 * is unreachable from the standard CLI until the declared type is honoured.
 *
 * Only the top level is walked. A nested string is the nested contract's business, and recursing would
 * make this a general-purpose coercion pass with no boundary — the kind of helpful guess that quietly
 * changes a payload nobody asked it to touch.
 */

/** The subset of JSON Schema this needs: a type per top-level property. */
export interface ParamSchema {
  readonly properties?: Record<string, { readonly type?: string } | undefined>;
}

export function coerceObjectParams(body: unknown, schema?: ParamSchema): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;

  const declared = (key: string): string | undefined => schema?.properties?.[key]?.type;

  let changed = false;
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    out[key] = value;
    if (typeof value !== "string") continue;

    /**
     * Declared types first. Only what the contract itself names, so nothing is coerced on a hunch,
     * and an unparseable value is left alone for the handler to refuse with its own message.
     */
    const want = declared(key);
    if (want === "boolean") {
      if (value === "true") { out[key] = true; changed = true; }
      else if (value === "false") { out[key] = false; changed = true; }
      continue;
    }
    if (want === "number" || want === "integer") {
      const n = Number(value);
      // `Number("")` is 0 and `Number(" ")` is 0; neither is a number the caller typed.
      if (value.trim() !== "" && Number.isFinite(n)) { out[key] = n; changed = true; }
      continue;
    }

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
