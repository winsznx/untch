import { canonicalize, hashCanonicalJson } from "@untch/canon";
import Ajv, { type ErrorObject } from "ajv";
import { stringToBytes, type Hex } from "viem";
import type {
  AcceptanceCriteria,
  Delivery,
  Diff,
  FieldConstraint,
  TierResult,
} from "./types";

/**
 * T0 — Schema Proof (PRD §13 / §7.3): deterministic conformance verification of a delivery against
 * the acceptance criteria the buyer COMMITTED at intent time. No LLM anywhere (invariant I1) — every
 * check is pure, deterministic code, so the same delivery + criteria always yields the same verdict.
 *
 * The check ladder, in order (short-circuit only on the criteria-binding failure — every other check
 * runs so the caller gets ALL diffs at once, matching §7.3's `VERIFY_FAILED{diffs[]}`):
 *   0. criteria binding  — hashCanonicalJson(criteria) MUST equal the committed acceptanceHash (§9).
 *                          A mismatch means the presented spec is not the one committed → FAIL. This
 *                          is what stops a buyer swapping criteria after seeing the delivery.
 *   1. ajv schema        — the payload validates against criteria.schema (§7.3 "ajv schema").
 *   2. required fields   — every criteria.requiredFields dot-path is present.
 *   3. size bounds       — the payload's canonical JSON byte length is within [minBytes, maxBytes].
 *   4. field constraints — per-field regex / enum / length (§7.3 "regex/enum").
 *   5. exact hash        — for a deterministic deliverable, the payload's canonical keccak256 matches
 *                          criteria.exactHash.value (§7.3 "exact-hash where deterministic").
 *
 * The committed-uncommitted branch (acceptanceHash == 0x0) is handled by the caller (`evaluate.ts`),
 * per §7.3's first branch — it never reaches here.
 */

/** ajv is instantiated once; `strict:false` tolerates draft variance + unknown formats without
 *  throwing, `allErrors:true` collects every violation (deterministic order) for the diff list. */
const ajv = new Ajv({ allErrors: true, strict: false });

/** Byte length of the payload's §9 canonical JSON — the same RFC 8785 string `hashCanonicalJson`
 *  hashes, so the size the receipt commits to and the size checked here never drift. */
function canonJsonBytes(value: unknown): number {
  return stringToBytes(canonicalize(value)).length;
}

/** Resolve a dot-path (e.g. `a.b.0.c`) into a value; returns `undefined` if any segment is absent. */
function getByPath(root: unknown, path: string): unknown {
  const segments = path.split(".");
  let cur: unknown = root;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/** A stable, human-readable rendering of an ajv error into a §7.3 diff. */
function ajvErrorToDiff(err: ErrorObject): Diff {
  const path = err.instancePath === "" ? "(root)" : err.instancePath.replace(/^\//, "").replace(/\//g, ".");
  return {
    check: "schema",
    path,
    message: `${path} ${err.message ?? "failed schema"}`.trim(),
  };
}

function checkSchema(payload: unknown, schema: Record<string, unknown>, diffs: Diff[]): void {
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch (err) {
    diffs.push({ check: "schema", message: `acceptance schema is not a valid JSON Schema: ${(err as Error).message}` });
    return;
  }
  if (!validate(payload)) {
    for (const e of validate.errors ?? []) diffs.push(ajvErrorToDiff(e));
  }
}

function checkRequiredFields(payload: unknown, fields: readonly string[], diffs: Diff[]): void {
  for (const field of fields) {
    if (getByPath(payload, field) === undefined) {
      diffs.push({
        check: "requiredField",
        path: field,
        message: `required field "${field}" is missing`,
      });
    }
  }
}

function checkSize(payload: unknown, bounds: NonNullable<AcceptanceCriteria["sizeBounds"]>, diffs: Diff[]): void {
  const bytes = canonJsonBytes(payload);
  if (bounds.maxBytes !== undefined && bytes > bounds.maxBytes) {
    diffs.push({
      check: "size",
      expected: `<= ${bounds.maxBytes}`,
      actual: bytes,
      message: `payload is ${bytes} bytes, exceeds maxBytes ${bounds.maxBytes}`,
    });
  }
  if (bounds.minBytes !== undefined && bytes < bounds.minBytes) {
    diffs.push({
      check: "size",
      expected: `>= ${bounds.minBytes}`,
      actual: bytes,
      message: `payload is ${bytes} bytes, below minBytes ${bounds.minBytes}`,
    });
  }
}

function lengthOf(value: unknown): number | null {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  return null;
}

function checkFieldConstraint(payload: unknown, c: FieldConstraint, diffs: Diff[]): void {
  const value = getByPath(payload, c.field);
  if (value === undefined) {
    diffs.push({ check: "fieldConstraint", path: c.field, message: `constrained field "${c.field}" is missing` });
    return;
  }

  if (c.enum !== undefined) {
    const ok = c.enum.some((e) => e === value);
    if (!ok) {
      diffs.push({
        check: "enum",
        path: c.field,
        expected: c.enum.map(String).join("|"),
        actual: String(value),
        message: `"${c.field}"=${JSON.stringify(value)} is not one of [${c.enum.map(String).join(", ")}]`,
      });
    }
  }

  if (c.regex !== undefined) {
    const anchored = c.regexAnchored !== false;
    const source = anchored ? `^(?:${c.regex})$` : c.regex;
    let re: RegExp;
    try {
      re = new RegExp(source);
    } catch (err) {
      diffs.push({ check: "regex", path: c.field, message: `constraint regex is invalid: ${(err as Error).message}` });
      return;
    }
    if (typeof value !== "string" || !re.test(value)) {
      diffs.push({
        check: "regex",
        path: c.field,
        expected: source,
        actual: typeof value === "string" ? value : typeof value,
        message: `"${c.field}"=${JSON.stringify(value)} does not match ${source}`,
      });
    }
  }

  const len = lengthOf(value);
  if (c.maxLen !== undefined) {
    if (len === null || len > c.maxLen) {
      diffs.push({
        check: "maxLen",
        path: c.field,
        expected: `<= ${c.maxLen}`,
        actual: len ?? typeof value,
        message: `"${c.field}" length ${len ?? "(not measurable)"} exceeds maxLen ${c.maxLen}`,
      });
    }
  }
  if (c.minLen !== undefined) {
    if (len === null || len < c.minLen) {
      diffs.push({
        check: "minLen",
        path: c.field,
        expected: `>= ${c.minLen}`,
        actual: len ?? typeof value,
        message: `"${c.field}" length ${len ?? "(not measurable)"} is below minLen ${c.minLen}`,
      });
    }
  }
}

function checkExactHash(
  payload: unknown,
  payloadHash: Hex | null,
  exact: NonNullable<AcceptanceCriteria["exactHash"]>,
  diffs: Diff[],
): void {
  const actual = payloadHash ?? (payload === undefined ? null : hashCanonicalJson(payload));
  if (actual === null) {
    diffs.push({
      check: "exactHash",
      message: "exact-hash check requires the payload (or a payloadHash); neither was supplied",
    });
    return;
  }
  if (actual.toLowerCase() !== exact.value.toLowerCase()) {
    diffs.push({
      check: "exactHash",
      expected: exact.value,
      actual,
      message: `deterministic deliverable hash ${actual} does not equal committed ${exact.value}`,
    });
  }
}

/**
 * Run T0 against a delivery. `acceptanceHash` is the committed §8.1 value (already known non-zero when
 * this is called). Returns the T0 tier line: PASS with no diffs, or FAIL with every diff found.
 */
export function runT0(
  acceptanceHash: Hex,
  criteria: AcceptanceCriteria,
  delivery: Delivery,
): { tier: TierResult; payloadHash: Hex } {
  const diffs: Diff[] = [];

  // Compute the delivery's canonical hash for the receipt (and exact-hash fallback). Prefer the actual
  // payload; fall back to a supplied opaque payloadHash; last resort a zero hash with a diff below.
  const payloadHash: Hex =
    delivery.payload !== undefined
      ? hashCanonicalJson(delivery.payload)
      : (delivery.payloadHash ?? (`0x${"0".repeat(64)}` as Hex));

  // 0. Criteria binding — the presented spec must be the one committed. A mismatch is terminal for T0.
  const criteriaHash = hashCanonicalJson(criteria);
  if (criteriaHash.toLowerCase() !== acceptanceHash.toLowerCase()) {
    diffs.push({
      check: "criteriaBinding",
      expected: acceptanceHash,
      actual: criteriaHash,
      message: `presented acceptance criteria hash ${criteriaHash} does not equal the committed acceptanceHash ${acceptanceHash} — the spec was not the one committed at intent time`,
    });
    return {
      tier: { tier: "T0", result: "FAIL", diffs, note: "acceptance-criteria binding failed (§9)" },
      payloadHash,
    };
  }

  const hasPayload = delivery.payload !== undefined;

  // 1. Schema (needs the payload).
  if (criteria.schema !== undefined) {
    if (!hasPayload) {
      diffs.push({ check: "schema", message: "schema check requires the delivery payload; only a payloadHash was supplied" });
    } else {
      checkSchema(delivery.payload, criteria.schema, diffs);
    }
  }

  // 2. Required fields.
  if (criteria.requiredFields && criteria.requiredFields.length > 0) {
    if (!hasPayload) {
      diffs.push({ check: "requiredField", message: "required-field check requires the delivery payload" });
    } else {
      checkRequiredFields(delivery.payload, criteria.requiredFields, diffs);
    }
  }

  // 3. Size bounds.
  if (criteria.sizeBounds) {
    if (!hasPayload) {
      diffs.push({ check: "size", message: "size check requires the delivery payload" });
    } else {
      checkSize(delivery.payload, criteria.sizeBounds, diffs);
    }
  }

  // 4. Field constraints.
  if (criteria.fieldConstraints && criteria.fieldConstraints.length > 0) {
    if (!hasPayload) {
      diffs.push({ check: "fieldConstraint", message: "field-constraint checks require the delivery payload" });
    } else {
      for (const c of criteria.fieldConstraints) checkFieldConstraint(delivery.payload, c, diffs);
    }
  }

  // 5. Exact hash (deterministic deliverable) — works from payload OR opaque payloadHash.
  if (criteria.exactHash) {
    checkExactHash(delivery.payload, delivery.payloadHash ?? null, criteria.exactHash, diffs);
  }

  return {
    tier: diffs.length === 0 ? { tier: "T0", result: "PASS" } : { tier: "T0", result: "FAIL", diffs },
    payloadHash,
  };
}
