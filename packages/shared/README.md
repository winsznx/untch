# @untch/shared

The **single source of truth** for X Layer network constants: chain definitions, chain IDs, and the
per-network token registry. Every value in `src/chains.ts` is D0.3-verified — see
[`internal/day0/D0.3-sources.md`](../../internal/day0/D0.3-sources.md) for the source and method behind
each constant. **No service, library, or script may redefine an X Layer chain, chain ID, RPC URL, or
token address locally.** They all resolve through this package.

## Network selection — one env contract

Consumers never hard-wire a network. They resolve the active chain, RPC, and tokens through the
helpers below, driven by a single env contract:

| Var | Form | Example |
| --- | --- | --- |
| `CHAIN_ID` | numeric chainId | `196` · `1952` |
| `NETWORK` | CAIP-2 | `eip155:196` · `eip155:1952` |
| `RPC_URL` | RPC override (optional) | `https://rpc.xlayer.tech` |

`CHAIN_ID` wins when both it and `NETWORK` are set. When neither is set, each consumer applies its own
fallback — **the only per-consumer knob**; the selection mechanism is identical everywhere:

- library packages (`@untch/receipt-writer`, `@untch/policy-store`, `@untch/trust-bureau`,
  `@untch/reports`) fall back to **testnet** (`1952`);
- the ASP seller (`@untch/asp`) falls back to **mainnet** (`196`) — the OKX x402 rail only exists there.

Flipping `CHAIN_ID` from `1952` to `196` switches every consumer's chain ID, RPC, and token addresses
with **zero code changes**. That invariant is proven end-to-end by `pnpm prove:network-switch`
(`scripts/prove-network-switch.ts`).

## API

```ts
import {
  activeChain,      // (env?, fallback?) => Chain     — the selected viem Chain
  activeRpcUrl,     // (env?, fallback?) => string     — RPC_URL override, else the chain default
  chainById,        // (chainId) => Chain              — lookup a known chain, throws if unsupported
  resolveChainId,   // (env?, fallback?) => number     — parse CHAIN_ID/NETWORK
  settlementToken,  // (chainId) => ConfirmedToken     — the x402 settlement token (mainnet ⇒ USDT0)
  confirmedTokenAllowlist, // (chainId) => Address[]   — confirmed token addresses only
  xLayerMainnet, xLayerTestnet,
  X_LAYER_MAINNET_ID, X_LAYER_TESTNET_ID,
  TOKENS,
} from "@untch/shared";
```

## Honest network boundaries

- **X Layer testnet has no confirmed settleable stablecoin.** `settlementToken(1952)` throws rather
  than guessing, and `confirmedTokenAllowlist(1952)` is empty by construction.
- **Product contracts (PolicyRegistry / UntchReceipts) are deployed only to testnet today.** The config
  loaders default those addresses on testnet but **require an explicit address on mainnet**
  (`POLICY_REGISTRY` / `RECEIPTS_CONTRACT`) — a mainnet run fails loudly instead of silently anchoring
  to a testnet address.
- **Deploy scripts** (`scripts/deploy-*.ts`) resolve both networks via `chainById`, but a mainnet
  deploy stays gated on the §28 checklist: it refuses to run unless `ALLOW_MAINNET=1` is set.
