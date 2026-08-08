# Plan: CCTP-native provider settlement, retiring the hot key

Status: **design only, not scheduled for implementation.** Written down so the path is decided before
we build it. Nothing in the running system changes because of this document.

## The thing we want to remove, stated precisely

Today the cross-rail leg works like this:

- The user pays **USDT0 on X Layer** (chainId 196). That is the settlement token the ASP is built on.
- Untch pays the **provider in USDC on Base (eip155:8453) or Solana**. See
  `packages/consumer-core/src/money.ts` and `assets.ts`, which model exactly this cross-chain,
  cross-token intent.
- To pay a provider on Base or Solana, Untch signs a USDC transfer from a treasury it holds **on those
  chains**, with a **hot key**. That is the key we want to eventually retire.

The hot key is fine for now. It is also the largest standing risk on the settlement side: a key that
holds spendable USDC on two chains and signs outbound payments, sitting in server-reachable memory.

## Why CCTP changes the shape of this

Circle's Cross-Chain Transfer Protocol (CCTP V2) moves **native USDC** between chains by burning it on
the source and minting it on the destination against a Circle-signed attestation. The mint lands at an
**arbitrary `mintRecipient`**. It does not have to be the sender, so USDC can be minted **directly to
the provider** on their chain.

Confirmed against Circle's current docs (2026-08-08):

| chain | CCTP V2 domain | as source | notes |
|---|---|---|---|
| X Layer | **37** | Standard ✅, Fast ✅ | Forwarding Service ❌ (as source) |
| Base | 6 | (dest) | destination for our providers |
| Solana | 5 | (dest) | destination, mint recipient is an SPL token account |

X Layer is a supported CCTP V2 chain, and Circle has launched **native USDC on X Layer**, which is what
makes the whole plan possible: we can hold and burn USDC on the same chain the user already pays on.

### CCTP V2 mechanics we rely on (factual)

- `depositForBurn(amount, destinationDomain, mintRecipient, burnToken, …)` on X Layer burns USDC via
  TokenMinterV2 and emits a message through MessageTransmitterV2.
- Circle's Iris attestation service signs the message once the source burn reaches the required
  finality.
- `receiveMessage(message, attestation)` on the destination mints USDC to `mintRecipient`. It is **not
  fully permissionless**: the message carries a `destinationCaller` field. Set it to `bytes32(0)` and
  **anyone** may submit the mint. Set it to a specific address to restrict who can.
- **Standard Transfer** waits for *finalized* source finality (minutes). **Fast Transfer** attests at
  *confirmed* finality (seconds) for a Circle fee, so the minted amount is `burn − fastFee`.
- **Hooks** are metadata attached to the burn for custom destination logic. CCTP does not execute them
  itself, the integrator does.

## The target flow

```
user pays USDT0 on X Layer                         (unchanged)
      │
      ▼
Untch swaps USDT0 → native USDC on X Layer          (1 signed tx, X Layer only)
      │
      ▼
Untch depositForBurn on X Layer:                    (1 signed tx, X Layer only)
   destinationDomain = 6 (Base) | 5 (Solana)
   mintRecipient     = the PROVIDER's address
   destinationCaller = 0  (anyone may mint)
      │
      ▼
Circle Iris attests the burn
      │
      ▼
receiveMessage on Base/Solana → USDC minted straight to the provider
   (submitted by a relayer, the provider, or us, permissionless)
```

**What this removes:** Untch no longer holds USDC on Base or Solana and never signs a payment on those
chains. The destination mint is permissionless, so no Untch key touches Base or Solana at all.

**What it does not remove by itself:** we still sign two transactions **on X Layer**, the swap and the
burn. So it is one chain, minimal surface, with funds never idle on the destination.

### The part that actually retires the raw key

The X Layer signing can be done by an **OKX Onchain OS Agentic Wallet (TEE-managed)**, the exact
mechanism the buyer side already uses, where the signing key never leaves OKX's TEE and we hold no raw
private key. If the settlement treasury on X Layer is an Agentic Wallet, then:

- the swap and the burn are signed inside the TEE,
- no raw private key exists in server memory on any chain,
- and the destination chains see only permissionless mints.

The real prize is narrow. CCTP leaves one signer, a TEE wallet on one chain, and destinations that
hold nothing.

## Risks and open questions to resolve before building

1. **USDT0 → USDC swap leg.** CCTP moves USDC only. We must swap the user's USDT0 to USDC on X Layer
   first, which adds DEX liquidity and slippage risk and a swap fee. Needs a chosen X Layer DEX with
   deep USDT0/USDC liquidity, and a max-slippage policy. This is new value-at-risk during the swap.
2. **Exact-amount settlement.** An x402 provider payment expects an *exact* amount. Fast Transfer
   deducts a Circle fee, so the mint is less than the burn. Either use **Standard Transfer** (no fee,
   slower) for provider settlement, or over-burn by the fee and confirm the provider tolerates it.
3. **Who submits `receiveMessage` and pays destination gas.** X Layer shows Forwarding Service ❌ as a
   source, so Circle will not relay the mint for us from X Layer. We need a relayer (self-run, or a
   third party) that submits the mint on Base/Solana and pays that gas. Permissionless mint (caller = 0)
   makes this possible for anyone, but someone still pays.
4. **Solana specifics.** The `mintRecipient` on Solana is an SPL associated token account (ATA), which
   must exist before the mint. Providers paid on Solana already have one, but the flow must verify or
   create it.
5. **Latency vs the intent's deadline.** Standard finality on X Layer plus attestation is minutes. The
   preflight/verify decision windows and any provider deadline must tolerate that, or use Fast Transfer
   and eat the fee.
6. **Reconciliation.** The cross-rail ledger (`consumer-core` clearing) must record the burn tx on
   X Layer and the mint tx on the destination as the two legs of one intent, so "balanced" stays
   checkable, the same property `money.ts` already enforces per-asset.

## Sequencing (when we do build it)

1. Stand up a USDC balance on X Layer (swap or bridge a float in) and prove `depositForBurn` → attest →
   `receiveMessage` on a **testnet** pair first.
2. Wire the USDT0→USDC swap on X Layer behind a slippage policy, decoupled from settlement so it can be
   tested alone.
3. Move provider settlement to Standard-Transfer CCTP with `mintRecipient` = provider, `destinationCaller`
   = 0, behind a flag, on a single low-value provider.
4. Make the X Layer settlement treasury an OKX Agentic Wallet so the burn is TEE-signed, and delete the
   Base/Solana hot keys once no code path signs on those chains.
5. Only then remove the old direct-USDC hot-key path.

## Sources

- Circle CCTP supported chains and domains: https://developers.circle.com/cctp/concepts/supported-chains-and-domains
- Circle CCTP V2 technical guide: https://developers.circle.com/cctp/technical-guide
- Circle CCTP V2 announcement: https://www.circle.com/blog/cctp-v2-the-future-of-cross-chain
