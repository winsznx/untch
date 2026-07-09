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

## Current dispositions (PolicyRegistry, first real contract)

| # | Finding | Tool | Impact | Disposition |
|---|---------|------|--------|-------------|
| 1 | `timestamp` — `registerPolicy` compares `expiry <= block.timestamp` | Slither | **Low** | Accepted — intentional. Expiry is inherently a wall-clock deadline (§10.1); validator timestamp skew is bounded to seconds while policy lifetimes are days/years, and no value or ordering depends on the exact expiry second. Non-blocking (Low). |
| 2 | `timestamp` — `updatePolicy` compares `newExpiry <= block.timestamp` | Slither | **Low** | Accepted — same rationale as #1. |
| 3 | `timestamp` — `isUsable` computes `block.timestamp <= expiry` | Slither | **Low** | Accepted — this is the derived-usability rule PRD §10.1 mandates verbatim (`status == ACTIVE && block.timestamp <= expiry`). Non-blocking (Low). |

Slither total: **0 High, 0 Medium, 3 Low** — CI passes under `--fail-medium`, nothing to triage.

## Cross-check vs Aderyn

Aderyn's per-release report is committed alongside this file. Its findings on `PolicyRegistry`
are dispositioned in that report; there is **no** High/Medium finding either tool raises that the
other misses. The `timestamp` (block-timestamp) class above is a Slither Low with no Aderyn
High/Medium counterpart — expected, and consistent with both tools' severity models.
