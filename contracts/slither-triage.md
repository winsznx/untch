# Slither triage & cross-tool disposition — PRD §28

This file is the human-readable companion to [`slither.triage.json`](slither.triage.json).

## The rule (PRD §28)

CI runs `slither . --triage-database slither.triage.json --fail-medium`, so **CI fails on any
Slither finding of Medium or High impact** unless that exact finding is accepted in
`slither.triage.json` with a written justification here. Optimization / Informational / **Low**
findings do **not** block CI (§28: "fail CI on High/Medium").

To accept a Medium/High finding, run `slither . --triage-database slither.triage.json
--triage-mode`; Slither appends an entry keyed by its stable finding hash. Add the justification,
reviewer, and date in this file. Never accept a finding without a written justification.

Cross-tool rule (§28): any finding one of Slither/Aderyn raises and the other does not gets a
written disposition here — no silent disagreement.

## Why `slither.triage.json` is now `[]` (a repair, not a widening)

D0.4 shipped this file carrying JSON *documentation objects* (prose with no `id`/`description`
keys), on the belief that Slither's loader ignores array elements lacking an `id`. That is **not
true** for Slither `0.11.5`: `SlitherCore.valid_result` reads `pr["description"]` for **every**
element loaded from the triage database. With the D0.4 Scaffold there were zero findings, so
`valid_result` was never reached and the malformed entries were harmless. The moment a real
contract (`PolicyRegistry`) produced its first finding, Slither crashed with
`KeyError: 'description'`.

The fix is the correct shape for a triage database: machine-format only, and **empty** because
there is nothing Medium/High to accept. All human documentation lives in this `.md` instead.

## Current dispositions (PolicyRegistry + SpendIntentRegistry)

| # | Finding | Tool | Impact | Disposition |
|---|---------|------|--------|-------------|
| 1 | `timestamp` — `PolicyRegistry.registerPolicy` compares `expiry <= block.timestamp` | Slither | **Low** | Accepted — intentional. Expiry is inherently a wall-clock deadline (§10.1); validator timestamp skew is bounded to seconds while policy lifetimes are days/years, and no value or ordering depends on the exact expiry second. Non-blocking (Low). |
| 2 | `timestamp` — `PolicyRegistry.updatePolicy` compares `newExpiry <= block.timestamp` | Slither | **Low** | Accepted — same rationale as #1. |
| 3 | `timestamp` — `PolicyRegistry.isUsable` computes `block.timestamp <= expiry` | Slither | **Low** | Accepted — this is the derived-usability rule PRD §10.1 mandates verbatim (`status == ACTIVE && block.timestamp <= expiry`). Non-blocking (Low). |
| 4 | `timestamp` — `SpendIntentRegistry.registerIntent` compares `deadline <= block.timestamp` | Slither | **Low** | Accepted — same rationale as #1. The intent `deadline` is a wall-clock bound (§8.1 / §10.2); registration only rejects a deadline already at or behind the current second, and second-scale validator skew is immaterial to a real deadline. Non-blocking (Low). |
| 5 | `timestamp` — `SpendIntentRegistry.isExpired` computes `block.timestamp > deadline` | Slither | **Low** | Accepted — this IS the derived-expiry rule PRD §10.2 requires: expiry is computed at read time, never a stored/transitioned `EXPIRED` state. Non-blocking (Low). |
| 6 | `timestamp` — `SpendIntentRegistry.isUsable` computes `block.timestamp <= deadline` (with `status == APPROVED`) | Slither | **Low** | Accepted — the derived usability rule the vault (§7.5) turns on, the intent analogue of PolicyRegistry's `isUsable`. Non-blocking (Low). |

Slither total: **0 High, 0 Medium, 6 Low** — CI passes under `--fail-medium`, nothing to triage.

All six are the same `timestamp` (block-timestamp) detector class: a deliberate, dispositioned
wall-clock comparison, read into a `uint64 nowTs` local first so it is uniform across every
time-using function and satisfies the Foundry v1.7.1 block-timestamp build lint at the same time.

## Cross-check vs Aderyn

Aderyn (v0.6.8, via the pinned `Cyfrin/aderyn-ci@v0` npm binary) reports **0 High, 0 Low** across
all three source files (`PolicyRegistry`, `SpendIntentRegistry`, `IntentHash`). There is **no**
High/Medium finding either tool raises that the other misses. The `timestamp` (block-timestamp)
class above is a Slither Low with no Aderyn High/Medium counterpart — expected, and consistent with
both tools' severity models.
