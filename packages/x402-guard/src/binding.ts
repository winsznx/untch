/**
 * The Challenge Binding Check (PRD §14) — a named, first-class primitive.
 *
 * Given the binding the caller AUTHORIZED and the binding PRESENTED by the actual 402 challenge,
 * confirm every field matches EXACTLY (after `normalize.ts`'s case-only normalization). The first
 * field that diverges yields a terminal result — and the caller's signer is never invoked.
 *
 * Field → failure-code mapping (PRD §14 / §7.1):
 *   nonce, expiry                         → BLOCKED_REPLAY  (reused / altered / extended authorization)
 *   everything else (recipient, token,    → REJECTED_BINDING (context swap: redirected funds, altered
 *   amount, resourceUrl, endpoint,                            amount, different resource/endpoint,
 *   method, taskHash, intentHash,                             swapped task/intent/policy/metadata)
 *   policyId, metadataHash)
 *
 * This is a pure function: no I/O, no clock, no key. It is the unit the adversarial fuzz suite hammers
 * one field at a time.
 */

import { normAddress, normHash, normMethod, normRaw, normUrl } from "./normalize";
import type {
  BindingField,
  BindingFailureCode,
  BindingResult,
  ChallengeBinding,
} from "./types";

type Norm = (v: string) => string;

interface FieldSpec {
  readonly field: BindingField;
  readonly code: BindingFailureCode;
  readonly norm: Norm;
  readonly optional: boolean;
  readonly get: (b: ChallengeBinding) => string | undefined;
}

/** Fixed evaluation order ⇒ deterministic first-mismatch reporting. */
const FIELDS: readonly FieldSpec[] = [
  { field: "recipient", code: "REJECTED_BINDING", norm: normAddress, optional: false, get: (b) => b.recipient },
  { field: "token", code: "REJECTED_BINDING", norm: normAddress, optional: false, get: (b) => b.token },
  { field: "amount", code: "REJECTED_BINDING", norm: normRaw, optional: false, get: (b) => b.amount },
  { field: "resourceUrl", code: "REJECTED_BINDING", norm: normUrl, optional: false, get: (b) => b.resourceUrl },
  { field: "endpoint", code: "REJECTED_BINDING", norm: normUrl, optional: false, get: (b) => b.endpoint },
  { field: "method", code: "REJECTED_BINDING", norm: normMethod, optional: false, get: (b) => b.method },
  // nonce/expiry are replay-critical but only present when the seller binds them into the challenge.
  // Absent on both sides ⇒ nothing to replay-check (vacuously bound); present on one side only, or
  // present-but-different ⇒ BLOCKED_REPLAY (a stripped, injected, reused or extended authorization).
  { field: "nonce", code: "BLOCKED_REPLAY", norm: normRaw, optional: true, get: (b) => b.nonce },
  { field: "expiry", code: "BLOCKED_REPLAY", norm: normRaw, optional: true, get: (b) => b.expiry },
  { field: "taskHash", code: "REJECTED_BINDING", norm: normHash, optional: true, get: (b) => b.taskHash },
  { field: "intentHash", code: "REJECTED_BINDING", norm: normHash, optional: true, get: (b) => b.intentHash },
  { field: "policyId", code: "REJECTED_BINDING", norm: normRaw, optional: true, get: (b) => b.policyId },
  { field: "metadataHash", code: "REJECTED_BINDING", norm: normHash, optional: true, get: (b) => b.metadataHash },
];

function present(v: string | undefined): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function fail(
  code: BindingFailureCode,
  field: BindingField,
  expected: string | null,
  presented: string | null,
  detail: string,
): BindingResult {
  return { ok: false, code, field, expected, presented, detail };
}

/**
 * Run the Challenge Binding Check. Returns `{ ok: true }` only if EVERY field binds; otherwise the
 * first diverging field with its terminal code.
 */
export function checkChallengeBinding(
  expected: ChallengeBinding,
  presented: ChallengeBinding,
): BindingResult {
  for (const spec of FIELDS) {
    const rawE = spec.get(expected);
    const rawP = spec.get(presented);

    if (spec.optional) {
      const hasE = present(rawE);
      const hasP = present(rawP);
      // Present on exactly one side ⇒ injected or dropped context ⇒ mismatch.
      if (hasE !== hasP) {
        return fail(
          spec.code,
          spec.field,
          hasE ? spec.norm(rawE) : null,
          hasP ? spec.norm(rawP) : null,
          hasE
            ? `authorized ${spec.field} is absent from the challenge`
            : `challenge carries a ${spec.field} that was not authorized`,
        );
      }
      if (!hasE) continue; // absent on both — nothing to bind
    } else if (!present(rawE) || !present(rawP)) {
      // A required field missing on either side is itself a binding failure (fail-closed).
      return fail(
        spec.code,
        spec.field,
        present(rawE) ? spec.norm(rawE as string) : null,
        present(rawP) ? spec.norm(rawP as string) : null,
        `required binding field ${spec.field} is missing`,
      );
    }

    const e = spec.norm(rawE as string);
    const p = spec.norm(rawP as string);
    if (e !== p) {
      return fail(
        spec.code,
        spec.field,
        e,
        p,
        `${spec.field} mismatch: authorized ${JSON.stringify(e)} ≠ presented ${JSON.stringify(p)}`,
      );
    }
  }
  return { ok: true };
}
