# Completion plan: every partial item, and how each finishes

This maps every status the README marks as PARTIAL, BETA, EXPERIMENTAL, sandbox or NOT_BUILT to a
concrete plan. None of it blocks the ASP #6086 relisting, which is the six self-contained x402 tools
that settle in-house. These are the broader Untch surfaces beyond that listing.

Most of the incomplete items share one root cause, so they are grouped by it rather than listed flat.

## Root cause A: Untch cannot settle to a merchant on Base or Solana yet

This one gap explains most of the sandbox and experimental providers.

**Symptoms in the README:**
- StableDomains (`domains.*`): `sandbox`, no Base treasury key exists, never settled.
- Purch (`shop.*`): `experimental`, Solana payload cannot be constructed, every call ends at
  `PROTOCOL_NOT_EXECUTABLE`.
- Limitation 5: Solana and Tempo/MPP are not executable, the payload serialisation was never confirmed.
- The cross-rail hot key we want to retire.

**Plan.** Two independent pieces.

1. **Solana payload construction.** Build and confirm the SPL/x402 Solana payment payload against a
   real Purch or StableDomains Solana challenge on devnet, then mainnet-beta with a tiny amount. This
   is a serialisation and signing task, not a protocol unknown. It unblocks every Solana provider.
2. **Cross-chain settlement via CCTP.** Follow `docs/cctp-settlement-plan.md`. Swap USDT0 to USDC on
   X Layer, `depositForBurn` to the provider's chain with the provider as `mintRecipient`. Untch then
   holds nothing and signs nothing on Base or Solana, and the one remaining X Layer signer can be an
   OKX Agentic Wallet so no raw key exists.

**What finishes when this lands:** StableDomains leaves sandbox, Purch becomes executable, the Consumer
Pack moves from three verified capabilities toward a full one, and the hot key is retired.

## Root cause B: the mainnet receipt writer is not yet authorised

**Symptoms:** on-chain anchoring is X Layer testnet, mainnet anchoring is pending, the writer key is
not an authorised writer on the mainnet `UntchReceipts`, and the contract gates writer-set changes
behind an immutable 3-day timelock.

**Plan.** This is a governance and operations step, not code. Submit the writer-set change on the
mainnet contract, wait out the 3-day (259200s) timelock, then activate. The whole receipt path is
already built and proven on testnet, so the moment the writer is authorised, anchoring moves from
testnet to mainnet with no code change. Sequence it deliberately because the timelock is immutable,
so a wrong writer address costs three days.

**What finishes:** the "on-chain anchored receipt" row goes from testnet to mainnet, and limitation 7
closes.

## Root cause C: UntchVault is deployed but not on the money path

**Symptoms:** UntchVault is on mainnet, deployed via VaultFactory, but the Consumer Pack settles from
the operational treasury rather than the vault.

**Plan.** Depends on B (the writer) and on an operational decision about how much value to custody in
the vault. After the writer is live, route one low-value provider settlement through the vault behind a
flag, prove the oracle-signed spend path end to end on mainnet, then widen. The contract review
discipline for the vault (more adversarial lenses because it holds funds) is already the standing rule.

**What finishes:** UntchVault joins the production money path, limitation 6 closes.

## Individual items

### Explorer ingestion (PARTIAL)

`activity_cases` is empty because the case-ingestion projection is not built end to end. The read side
(the case-first Explorer view) exists.

**Plan.** Build the ingestion job that projects each decision, approval, budget reservation and
settlement into a single `activity_case` row keyed by intent. It is a projection over tables that
already carry the data, run on the same job runner as the other scheduled work. No new sources.

### Delivery verification is not universal (limitation 4)

RDAP verifies domain delivery. Other categories fall back to a weaker check.

**Plan.** Add one verifier per category as each provider comes online. Email delivery is verifiable
through an inbox Untch owns (already the design for `mail.send`). For goods and travel, use the
provider's own receipt or order-status endpoint as the evidence, hashed into the verify record. Each
verifier is independent, so this fills in provider by provider rather than as one large change.

### StableMerch SIWX identity (experimental)

Four of five StableMerch steps need a wallet identity, and the EIP-4361 message this build produced was
never accepted by their verifier.

**Plan.** Produce the exact EIP-4361 rendering StableMerch's verifier accepts, or sign the SIWX
challenge with an OKX Agentic Wallet whose identity their verifier already trusts. This is the same
identity mechanism the buyer side and the account link already use, so it is a rendering and signing
fix, not new architecture.

### StableTravel (sandbox, search only)

`travel.search` and `compare` read live, but nothing settles.

**Plan.** Falls out of root cause A. Once cross-chain settlement works, travel booking settles on the
provider's rail like any other. Until then it stays a read-only price source, honestly labelled.

### Broker Guard, Mode D (NOT_BUILT)

**Plan.** Prior research (recorded in the session memory) confirmed the OKX APP Broker role is a
self-hostable protocol role, not an OKX-operated service, and that a self-hosted Broker can settle
through the same `ExactEvmScheme` facilitator Untch already uses. So Mode D is implementation work with
no OKX permission gate: build the Broker state machine (mint paymentId, hold challenge state, verify
buyer credentials, recompute nonce, submit for settlement, expose status polling) in front of the
existing facilitator. Scope it after root cause A, since a Broker that cannot settle cross-chain has
the same gap.

### Custodial between funding and completion (limitation 3)

Untch holds value between a user funding an intent and the provider being paid. Not trustless.

**Plan.** This narrows as root cause C (the vault) and root cause A (direct-to-provider CCTP mint)
land. When the provider is the CCTP `mintRecipient`, Untch never custodies the provider's leg at all,
it only routes the burn. The funding leg stays briefly custodial until the vault holds it under
oracle-signed spend. Full non-custodial is the end state of A plus C, not a separate task.

## Ordering

1. **A1 Solana payload** and **B writer timelock** can start in parallel. B is a governance clock, A1
   is code.
2. **A2 CCTP** after A1, on testnet first.
3. **C vault on money path** after B.
4. **Explorer ingestion**, **delivery verifiers** and **StableMerch SIWX** are independent and can
   slot in whenever, each small.
5. **Broker Guard** after A, since it needs cross-chain settlement to be worth building.

None of this is required for the current relisting. It is the map from "the ASP marketplace is live and
proven" to "every Untch surface is live".
