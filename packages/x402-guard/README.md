# @untch/x402-guard

**Operator-authorized payment middleware for x402 / APP flows.** It wraps an outbound paid HTTP
call, intercepts the `402` challenge, runs a **Challenge Binding Check** and a **preflight policy
decision**, and then either lets *your own* signer proceed, refuses with a structured reason, or hands
back a non-blocking poll handle.

```
outbound paid call ─▶ 402 ─▶ Challenge Binding Check ─▶ preflight ─▶ ┌ APPROVE  → your signer runs
                                    │                                 ├ BLOCK    → structured refusal
                                    └ (any mismatch = terminal)       └ ESCALATE → poll handle (no wait)
```

MIT-licensed, zero runtime dependencies, drops into any JS runtime (Node, Bun, Deno, edge).

## Two guarantees

1. **It never holds, sees, or requests a private key.** Signing is a callback *you* inject
   (`signAndPay`). The guard decides only **whether** that callback may run — it never performs or has
   access to the signing itself. If you find yourself handing this package a raw key, you're holding it
   wrong.
2. **ESCALATE never blocks.** On an escalated decision it returns `{ status: "ESCALATED", pollHandle }`
   immediately. It never sleeps waiting on a human; *you* decide how to poll/retry. Sending the
   escalation notification is a separate concern this package does not own.

It is also **fail-closed**: an unparseable challenge, a non-402 response, or a preflight that throws
all resolve to `BLOCKED` — never a silent approve.

## Install

```sh
npm install @untch/x402-guard
```

## Quick start

```ts
import { guardedPay, type ChallengeBinding } from "@untch/x402-guard";

// What YOU authorize this payment to be. The 402 challenge is checked EXACTLY against this.
const expectedBinding: ChallengeBinding = {
  recipient: "0xVendorPayoutAddress",
  token: "0xUSDCAddress",
  amount: "50000",                       // atomic base units, exact string (never a float)
  resourceUrl: "https://api.vendor.example/v1/report",
  endpoint: "https://api.vendor.example/v1/report",
  method: "POST",
  nonce: "",                             // "" when the seller binds no per-challenge nonce
  expiry: "",                            // "" when the seller binds no explicit expiry
  // optional, bound only when present on either side:
  // taskHash, intentHash, policyId, metadataHash
};

const outcome = await guardedPay(
  { url: "https://api.vendor.example/v1/report", method: "POST", body, expectedBinding },
  {
    // (1) reach your preflight/policy service and return its decision. How it authenticates/pays
    //     for itself is YOUR concern — that is the whole point of the injection boundary.
    preflight: async ({ binding, challenge }) => {
      const res = await fetch("https://your-asp.example/preflight_payment", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ binding }),
      });
      return res.json(); // { decision: "APPROVED" | "BLOCKED_*" | "ESCALATED_*", ... }
    },
    // (2) YOUR signer. Runs ONLY after APPROVE. The guard never sees your key.
    signAndPay: async (ctx) => mySignerPaysAndReturnsResponse(ctx.url, ctx.method, ctx.body),
  },
);

switch (outcome.status) {
  case "APPROVED":
    return outcome.response;                // whatever your signer returned (the settled response)
  case "BLOCKED":
    throw new Error(`payment refused: ${outcome.code} — ${outcome.detail}`);
  case "ESCALATED": {
    const state = await outcome.pollHandle.poll(); // non-blocking; poll on YOUR schedule
    // persist outcome.pollHandle.id, resolve later
    return state;
  }
}
```

## The Challenge Binding Check

Before signing, the guard validates — **exactly**, after case-only normalization — every field the
payment is bound to, against the original 402 challenge:

| Field | Bound to | Mismatch ⇒ |
|---|---|---|
| `recipient` | challenge `payTo` | `REJECTED_BINDING` |
| `token` | challenge `asset` | `REJECTED_BINDING` |
| `amount` | challenge `amount` (atomic) | `REJECTED_BINDING` |
| `resourceUrl` | challenge `resource.url` | `REJECTED_BINDING` |
| `endpoint` / `method` | the request you invoked | `REJECTED_BINDING` |
| `nonce` | seller-bound nonce (if any) | `BLOCKED_REPLAY` |
| `expiry` | seller-bound expiry (if any) | `BLOCKED_REPLAY` |
| `taskHash` / `intentHash` / `policyId` / `metadataHash` | if present on either side | `REJECTED_BINDING` |

Any single divergence — a redirected recipient, an altered amount, a swapped resource, a reused nonce,
an extended expiry, an injected or dropped bound hash — is terminal. Your signer is never invoked.
`nonce`/`expiry` are replay-critical but only present when the seller binds them: absent on both sides
they are vacuously bound; present-but-different, or present on one side only, is `BLOCKED_REPLAY`.

You can call the primitive directly:

```ts
import { checkChallengeBinding } from "@untch/x402-guard";
const r = checkChallengeBinding(expected, presented);
if (!r.ok) console.error(r.code, r.field, r.detail);
```

## Decision mapping

`APPROVED` → APPROVE. Any code starting `ESCALATED` → ESCALATE. Everything else (including unknown
codes) → BLOCK. This is prefix-based so new `BLOCKED_*` / `REJECTED_*` codes fail closed automatically.

## API surface

- `guardedPay(request, deps)` → `Promise<GuardOutcome>` — the wrapper.
- `checkChallengeBinding(expected, presented)` → `BindingResult` — the pure primitive.
- `parseChallenge(decoded, { preferNetwork? })` / `bindingFromChallenge(parsed, ctx)` /
  `decodePaymentRequiredHeader(header)` — x402 challenge helpers.
- `createPollHandle(decision, heldAt, resolver?)` — the escalation handle factory.
- `classifyDecision(code)` — the APPROVE/ESCALATE/BLOCK mapper.
- `normAddress` / `normHash` / `normMethod` / `normUrl` / `normRaw` — the normalizers used by the check.

All types are exported (`ChallengeBinding`, `GuardOutcome`, `GuardDeps`, `PreflightDecision`,
`PollHandle`, …).

## Building an expected binding from a challenge

If you want the guard to compute the presented binding for you (e.g. to pre-inspect a challenge):

```ts
import { decodePaymentRequiredHeader, parseChallenge, bindingFromChallenge } from "@untch/x402-guard";

const res = await fetch(url);                       // 402
const parsed = parseChallenge(decodePaymentRequiredHeader(res.headers.get("payment-required")!));
const presented = bindingFromChallenge(parsed, { endpoint: url, method: "POST" });
```

## Design notes

- **Zero dependencies.** Addresses/hashes are plain `0x` strings, normalized internally, so the
  package pulls no chain SDK.
- **Deterministic, side-effect-free core.** `checkChallengeBinding` is pure — no I/O, no clock, no key
  — which is why it can be fuzzed exhaustively (every field tampered independently).
- **You bring the transport and the signer.** The guard orchestrates; it does not choose your chain,
  wallet, or preflight service.

## License

MIT © Untch
