# D0.1 confirmation — PASS (2026-07-09)

**One real, settled, paid A2MCP call was executed end-to-end on the real rail.** No mock, no
demo data, no substitute (no agentcash, no USDC-on-Base, no self-hosted facilitator): the buyer
signed an EIP-3009 authorization with its own key; OKX's **hosted** x402 facilitator
(`web3.okx.com/api/v6/pay/x402/*`, authenticated with the OKX HMAC triple) verified it and its
own relayer (`0x5ee567b8…`) broadcast the `transferWithAuthorization` on **X Layer mainnet
(eip155:196)**, moving **0.01 USDT0**. Independently confirmed on-chain via rpc.xlayer.tech:
receipt status 0x1, block 64,815,585, USDT0 Transfer of 10000.

The seller (`ping_untch`, priced $0.01) runs on Railway because OKX blocks the operator's
Nigeria/commercial-VPN egress at the network layer; only the seller needs OKX reachability, so
hosting it on a reachable box let the buyer pay from anywhere. Full transcript in
`paid-call-transcript.json` + `402-challenge.json`; on-chain proof in
`settlement-verification.txt`.

**Verdict: PASS. Settlement reference: 0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc**
