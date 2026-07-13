/**
 * The guard — operator-authorized payment middleware for x402 / APP flows (PRD §14 Mode B).
 *
 * `guardedPay` wraps ONE outbound paid HTTP call:
 *   1. probe the endpoint unpaid and intercept the 402 challenge;
 *   2. parse it and run the Challenge Binding Check against the caller's AUTHORIZED binding;
 *   3. call the injected `preflight_payment` for a policy decision;
 *   4. dispatch three ways —
 *        APPROVE   → invoke the caller's OWN signer (DI) and return the settled response;
 *        BLOCK     → structured refusal, signer never invoked;
 *        ESCALATE  → return a non-blocking poll handle immediately, signer never invoked.
 *
 * Two non-negotiable properties:
 *   • This module never holds, sees, or requests a private key. Signing is the injected `signAndPay`
 *     callback; the guard decides only WHETHER to call it.
 *   • ESCALATE never blocks. It returns `{ status: "ESCALATED", pollHandle }` at once; it never sleeps
 *     waiting on a human.
 *
 * Fail-closed (I2): any dependency failure — an un-parseable challenge, a preflight that throws, a
 * non-402 response — resolves to BLOCKED, never a silent APPROVE.
 */

import { checkChallengeBinding } from "./binding";
import {
  ChallengeParseError,
  bindingFromChallenge,
  decodePaymentRequiredHeader,
  parseChallenge,
} from "./challenge";
import { createPollHandle } from "./poll";
import type {
  ChallengeBinding,
  GuardDeps,
  GuardOutcome,
  ParsedChallenge,
  PreflightDecision,
} from "./types";

const PAYMENT_REQUIRED_HEADER = "payment-required";

/** APPROVE / BLOCK / ESCALATE from a preflight decision code, by prefix. Unknown ⇒ BLOCK (fail-closed). */
export function classifyDecision(code: string): "APPROVE" | "ESCALATE" | "BLOCK" {
  if (code === "APPROVED") return "APPROVE";
  if (code.startsWith("ESCALATED")) return "ESCALATE";
  return "BLOCK";
}

function blocked(
  code: string,
  detail: string,
  extra: Partial<GuardOutcome> = {},
): GuardOutcome {
  return { status: "BLOCKED", code, detail, ...extra } as GuardOutcome;
}

async function readChallenge(
  res: Response,
): Promise<{ header: string } | { error: string }> {
  const header = res.headers.get(PAYMENT_REQUIRED_HEADER);
  if (header) return { header };
  // Some stacks put the challenge in the JSON body instead of the header.
  try {
    const body = await res.clone().text();
    if (body) return { header: Buffer.from(body, "utf8").toString("base64") };
  } catch {
    /* fall through */
  }
  return { error: "402 response carried no PAYMENT-REQUIRED header or body" };
}

export async function guardedPay(
  request: {
    readonly url: string;
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: unknown;
    readonly expectedBinding: ChallengeBinding;
  },
  deps: GuardDeps,
): Promise<GuardOutcome> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const clock = deps.clock ?? Date.now;
  const method = (request.method ?? "GET").toUpperCase();
  const headers = request.headers ?? {};

  // 1) Probe unpaid — intercept the 402.
  const issuedAtMs = clock();
  type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;
  const init: FetchInit = { method, headers };
  if (request.body !== undefined) init.body = request.body as NonNullable<FetchInit["body"]>;

  let probe: Response;
  try {
    probe = await fetchImpl(request.url, init);
  } catch (err) {
    return blocked("PROBE_FAILED", `could not reach ${request.url}: ${(err as Error).message}`);
  }

  if (probe.status !== 402) {
    // No challenge ⇒ nothing to bind or preflight. Fail closed rather than let an unverified call pass.
    return blocked(
      "NO_402_CHALLENGE",
      `expected HTTP 402 from ${request.url}, got ${probe.status}; the guard has no challenge to verify`,
    );
  }

  const raw = await readChallenge(probe);
  if ("error" in raw) return blocked("CHALLENGE_MISSING", raw.error);

  // 2) Parse + run the Challenge Binding Check BEFORE any preflight spend.
  let parsed: ParsedChallenge;
  try {
    parsed = parseChallenge(decodePaymentRequiredHeader(raw.header));
  } catch (err) {
    const detail = err instanceof ChallengeParseError ? err.message : (err as Error).message;
    return blocked("CHALLENGE_UNPARSEABLE", detail);
  }

  const presented = bindingFromChallenge(parsed, { endpoint: request.url, method, issuedAtMs });
  const binding = checkChallengeBinding(request.expectedBinding, presented);
  if (!binding.ok) {
    // Terminal: recipient/amount/resource/etc. or nonce/expiry diverged from what was authorized.
    return blocked(binding.code, binding.detail, { binding });
  }

  // 3) Preflight — the real policy decision. Fail closed if it throws (I2).
  let decision: PreflightDecision;
  try {
    decision = await deps.preflight({ binding: presented, challenge: parsed });
  } catch (err) {
    return blocked("PREFLIGHT_UNAVAILABLE", `preflight_payment failed: ${(err as Error).message}`);
  }

  // 4) Three-way dispatch.
  switch (classifyDecision(decision.decision)) {
    case "ESCALATE":
      return {
        status: "ESCALATED",
        pollHandle: createPollHandle(decision, clock(), deps.escalationResolver),
        decision,
      };
    case "BLOCK":
      return blocked(decision.decision, `preflight withheld the spend: ${decision.decision}`, {
        decision,
      });
    case "APPROVE": {
      // Only here does the caller's OWN signer run — exactly once, paying the challenge we validated.
      let response: unknown;
      try {
        response = await deps.signAndPay({
          url: request.url,
          method,
          headers,
          body: request.body,
          challenge: parsed,
          binding: presented,
        });
      } catch (err) {
        return blocked("SIGN_AND_PAY_FAILED", `caller signer failed after APPROVE: ${(err as Error).message}`, {
          decision,
        });
      }
      return { status: "APPROVED", response, decision, binding: presented };
    }
  }
}
