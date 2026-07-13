/**
 * @untch/x402-guard — operator-authorized payment middleware for x402 / APP flows (PRD §14 Mode B).
 *
 * Wraps an outbound paid HTTP call: intercepts the 402 challenge, runs the Challenge Binding Check +
 * a preflight policy decision, and either lets the caller's OWN signer proceed (APPROVE), returns a
 * structured refusal (BLOCK), or returns a non-blocking poll handle (ESCALATE).
 *
 * Design guarantees:
 *   • Never holds, sees, or requests a private key — signing is dependency-injected.
 *   • ESCALATE never blocks — it returns a pollable handle immediately.
 *   • Fail-closed — any dependency failure resolves to BLOCK, never a silent APPROVE.
 *
 * See README.md for third-party integration.
 */

export { guardedPay, classifyDecision } from "./guard";
export { checkChallengeBinding } from "./binding";
export {
  parseChallenge,
  bindingFromChallenge,
  decodePaymentRequiredHeader,
  ChallengeParseError,
  type RequestContext,
} from "./challenge";
export { createPollHandle } from "./poll";
export {
  normAddress,
  normHash,
  normMethod,
  normUrl,
  normRaw,
} from "./normalize";
export type {
  HexString,
  ChallengeBinding,
  BindingField,
  BindingFailureCode,
  BindingResult,
  ParsedChallenge,
  PreflightDecision,
  PollHandle,
  EscalationState,
  EscalationResolver,
  GuardOutcome,
  GuardDeps,
  GuardRequest,
  SignAndPay,
  SignAndPayContext,
  PreflightFn,
  PreflightInput,
} from "./types";
