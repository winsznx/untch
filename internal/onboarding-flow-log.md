# Onboarding flow — running decision log (Step-31)

A live, reviewable record of every real decision made building the first-time onboarding sequence.
Written as the work happens, not reconstructed. Reviewed after, not approved before.

## 0. What was read first (before proposing anything)

- **PRD §13/§14** (`internal/untch-prd.md`): the four enforcement modes. Mode A Advisory MCP (add MCP
  server + system-prompt clause, agent creates an intent and calls preflight, zero setup, honest weakness
  = a misbehaving agent can skip, caught by reconciliation). Mode B Untch Guard (`@untch/x402-guard`
  wraps the agent's paid calls, runs the Challenge Binding Check + preflight before the agent signs).
  Mode C Untch Vault (funds live on-chain, only oracle-signed approvals within caps move them, "preflight
  becomes physics", owner withdraw unconditional). Mode D Broker Guard (broker-side, infrastructure-native
  — NOT a user-onboarding path, so excluded from the first-run picker). Adoption ladder is explicit:
  "A (minutes) → B (one import) → C (one deploy + deposit) → D (infrastructure-native)."
- **x402-guard README** (`packages/x402-guard/README.md`): real quickstart — `guardedPay({ url, method,
  body, expectedBinding }, { preflight, signAndPay })`, the two guarantees (never holds a key; ESCALATE
  never blocks), fail-closed. This is the in-product content Mode B's next step must surface.
- **Dashboard, current state**: `app/dashboard/page.tsx` (Overview + its empty state), `policies/page.tsx`
  + `components/dashboard/policy-actions.tsx` (real on-chain `registerPolicy`), `settings/page.tsx` +
  `components/dashboard/channel-bindings.tsx` (real code-roundtrip channel binding via `/api/bindings`),
  `vault/page.tsx` + `components/dashboard/vault-actions.tsx` (real deploy/deposit/withdraw/pause),
  `components/wallet/*` (RainbowKit connect + SIWE via `useWallet()`/`useAuthStatus()`, `TxButton`),
  `components/dashboard/ui.tsx` (token-only primitives), `components/landing/modes.tsx` (the existing
  mode copy on the landing, reused as the tone anchor).

## 1. First-time detection — the decision

The dashboard's seeded "live" data is scoped to the demo operator only (`lib/dashboard/scope.ts`), so a
brand-new wallet genuinely has no off-chain history. The honest signal for "does this wallet already have
a policy" is therefore **on-chain**: `PolicyRegistry.ownerNonce(wallet)`. The contract test
`PolicyRegistry.t.sol::test_RegisterPolicy_IncrementsOwnerNonce` proves it starts at `0` and increments
by one per registered policy, independently per owner. So:

> **First-time = an authenticated wallet whose `ownerNonce(wallet) === 0n`.**

Decision: `app/dashboard/page.tsx` (Overview) reads `ownerNonce` server-side for the signed-in wallet and
**redirects first-timers to `/dashboard/start`** — the onboarding path shown *instead of* the normal
empty-state dashboard (requirement #1, literal). Unauthenticated visitors still get the existing connect
prompt. Returning wallets (`ownerNonce > 0`) see the normal dashboard untouched. `/dashboard/start` is
reachable directly too (added to the nav), and shows an "already set up" state to returning wallets so no
one gets stuck.

## 2. Reuse, not rebuild — the boundary

Hard rule: sequence and frame the existing real pieces, do not reimplement them. So:

- **Policy creation** reuses `<PolicyActions>` verbatim, with ONE additive, optional prop
  `onCreated?({ policyId, txHash })` fired from its existing Create `onConfirmed`. No behavior change when
  the prop is absent (every current call site).
- **Channel binding** reuses `<ChannelBindings>` verbatim, with ONE additive, optional prop
  `onVerifiedChange?(verifiedCount)` fired from its existing `refresh()`. This lets the stepper *require*
  a verified channel before completion (requirement #4) without touching the binding logic.
- **Vault (Mode C)** reuses `<VaultActions>` verbatim inside the mode-specific step.
- **Connect + SIWE** reuses the existing RainbowKit flow via `useWallet()`; the stepper reads status,
  it does not re-implement connect.

Rationale for the two optional callbacks: they are pure *sequencing signals* (the onboarding needs to know
"a policy now exists on-chain" and "a channel is now verified" to advance and to gate completion). They add
no new capability and change no existing screen. This stays on the "frame/sequence" side of the line.

## 3. Copy + tone decisions

Plain, no em-dashes, no filler. The decisions that were not obvious:

- **The positioning line (said once, well)**, on the mode-select step: "Untch does not lock you into one
  channel or one integration path. That is on purpose. Start with advice, and tighten to physics as the
  stakes rise. The same policy governs every mode, so the control never changes, only how hard it is
  enforced." This is the real product philosophy (why offer A/B/C/D at all), grounded in PRD §14's
  adoption ladder and the landing `modes.tsx` tone. Stated in one place, not repeated per card.
- **Mode A is recommended** with the badge "Recommended · zero setup"; B is "One import", C is "One
  deploy". Wording taken from PRD §14's own strength column, trimmed.
- **The channel step says WHY it is required, in plain terms**: "Without a bound channel, every approval
  request times out and is denied, and no one can release it." This is the honest consequence (I2
  fail-closed default DENY), not a nag. It is the reason the step gates completion.
- **Mode-specific next steps are real in-product content**, not links: Mode A shows the exact
  system-prompt clause; Mode B shows the real `npm install` + a trimmed `guardedPay(...)` snippet from the
  x402-guard README plus its fail-closed guarantee; Mode C embeds the real `<VaultActions>` deploy/deposit.
- **Completion** shows the real on-chain policy tx link, the verified-channel count, the chosen mode, a
  one-line "do this next" per mode, a link to the public receipts explorer, and a button to the dashboard.

## 4. Build decisions, in order

1. **`lib/dashboard/onboarding.ts`** — `readOwnerNonce` / `hasAnyPolicy`, server-safe (reuses the existing
   `makePublicClient`). RPC failure resolves to "not first time" so an operator is never trapped in a loop.
2. **`app/dashboard/page.tsx`** — first-time redirect: authenticated + not the demo operator + no policy
   → `redirect("/dashboard/start")`. Everything else falls through to the existing dashboard untouched.
3. **`PolicyActions` + `ChannelBindings`** — two additive, optional callbacks only (`onCreated`,
   `onVerifiedChange`). Verified no existing call site passes them, so behavior is unchanged everywhere
   else. This is the "sequence, don't rebuild" boundary held in code.
4. **`components/onboarding/onboarding-flow.tsx`** — the client stepper. Connect gate (reactive on
   `useWallet`) → mode → policy (reuses `PolicyActions`) → channel, REQUIRED (reuses `ChannelBindings`,
   Finish disabled until `verifiedChannels >= 1`) → mode-specific next step → completion. Token-only, all
   primitives local and matching `components/dashboard/ui.tsx`.
5. **`app/dashboard/start/page.tsx`** — the route. Renders the flow for first-timers; a short "already set
   up" state for wallets that already own a policy (so no one is stuck if they navigate here directly).
6. **Nav + breadcrumb** — a "Get started" entry (new `start` nav icon) and the breadcrumb label.

## 5. Verification done (and the one boundary honestly not crossed here)

- **Typecheck**: `apps/web` `tsc --noEmit` shows 15 errors, ALL pre-existing (`ChainEnv` /
  `exactOptionalPropertyTypes` friction in untouched packages — confirmed by stashing ALL uncommitted work
  and re-running: still 15, none in onboarding files). My changes add **zero** new type errors.
- **Runtime**: dev server compiles clean; `GET /dashboard/start` returns **HTTP 200** and renders the
  onboarding copy server-side (the mode-select step is correctly client-gated behind sign-in); the nav
  shows "Get started"; no compile errors in the dev log.
- **Reuse verified**: the flow imports and renders the real `PolicyActions` (real `registerPolicy`),
  `ChannelBindings` (real `/api/bindings` code roundtrip), and `VaultActions` (real deploy/deposit) — no
  capability was reimplemented.

**The one thing this session could not produce: the screenshot-verified fresh-wallet on-chain walkthrough.**
That proof needs a browser with a wallet extension, a genuinely new funded wallet (testnet OKB for gas),
and human signing of SIWE + `registerPolicy` + the binding roundtrip. This environment has no
browser-automation tool (no Playwright/Puppeteer in the repo, no browser MCP connected) and no funded
fresh wallet, so the walkthrough was NOT run here and NO screenshots were fabricated. The flow is built,
compiles, renders, and reuses already-proven capabilities; the visual end-to-end is the owner's step.

### Runbook to complete the real proof
1. `pnpm --filter @untch/web dev` (or the deployed `app.untch.xyz`).
2. In a clean browser profile, connect a **brand-new wallet** funded with a little X Layer testnet OKB
   (faucet: `https://www.okx.com/xlayer/faucet`). Sign in (SIWE).
3. Land on `/dashboard` → you are redirected to `/dashboard/start` (first-time detection: `ownerNonce == 0`).
4. Pick a mode → **Create policy** (sign the real `registerPolicy` tx; the tx link appears) → **bind a
   channel** (the Finish button stays disabled until one channel verifies) → the mode-specific next step →
   the completion state with the real policy tx, the bound channel, and the explorer link.
5. Screenshot each step. The completion card's policy tx is independently checkable on OKLink.
