/**
 * Real Untch on-chain artifacts and explorer helpers.
 *
 * Every value here is a genuinely on-chain address or transaction from this build's actual
 * history (sources: contracts/deploy/*.json, internal/day0/D0.1-evidence/*, package READMEs).
 * Nothing is fabricated. The explorer bases mirror `@untch/shared` chains.ts (inlined to keep
 * the client bundle free of the workspace package). Product contracts live on X Layer testnet
 * (mainnet deploy is deferred until all five clear the §28 gate); only the D0.1 settlement and
 * the ERC-8004 registry are mainnet.
 */

export type Net = "mainnet" | "testnet";

export const EXPLORER: Record<Net, string> = {
  mainnet: "https://www.oklink.com/x-layer",
  testnet: "https://www.oklink.com/x-layer-testnet",
};

export function txUrl(net: Net, hash: string): string {
  return `${EXPLORER[net]}/tx/${hash}`;
}

export function addressUrl(net: Net, addr: string): string {
  return `${EXPLORER[net]}/address/${addr}`;
}

export function shortHex(value: string, head = 8, tail = 6): string {
  return value.length > head + tail + 2 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

export type ProofTx = {
  label: string;
  hash: string;
  net: Net;
  note: string;
};

/** Real, anchored/settled transactions — each verifiable on OKLink. */
export const PROOF_TXS: ProofTx[] = [
  {
    label: "First paid call, settled on mainnet",
    hash: "0x9db78b52ca60f376b84b37510ce77836051b3177973ef22f05285e9296cd1efc",
    net: "mainnet",
    note: "A real paid A2MCP call, settled end-to-end via OKX's hosted x402 facilitator and verified on rpc.xlayer.tech.",
  },
  {
    label: "Delivery verified and anchored",
    hash: "0x48d41b364ec1d78f1c118a64b44b7b456cb34a62b07a3d1617a21a959472e209",
    net: "testnet",
    note: "A T0 schema proof passed, then written on-chain as a VERIFY receipt (block 35295900).",
  },
  {
    label: "A blocked payment, receipted",
    hash: "0x84f1eded3f2b9e7ac5c003b60c87f505b146d2aaf9366b8b9c1d84b848c05700",
    net: "testnet",
    note: "A cooldown block, anchored as a DECISION receipt. Blocks are auditable value, not silence.",
  },
  {
    label: "Vendor score root, anchored",
    hash: "0x6b56d12d4a1c43f64d7bbc31565eb418b1f3d37a62636df4b589a702eba4687d",
    net: "testnet",
    note: "A Trust Bureau score epoch, merkle-rooted and anchored on-chain (ScoreAnchored).",
  },
  {
    label: "A reconciliation report, anchored",
    hash: "0x23b356d5621f94adcb74b66a7beef45ce37e4b7628b83a5fea9dab73bae86494",
    net: "testnet",
    note: "A period reconciliation, hashed and anchored on-chain (AuditAnchored).",
  },
  {
    label: "A dispute packet, anchored",
    hash: "0xcb577c8e55f7f7a4777d2d0eb04d84b2422dcd2016f7e0291c12872caefcb699",
    net: "testnet",
    note: "An evidence bundle for a held payment, hashed and anchored on-chain (AuditAnchored).",
  },
];

export type ContractRef = {
  name: string;
  address: string;
  net: Net;
  note: string;
};

/** Real deployed contracts. */
export const CONTRACTS: ContractRef[] = [
  {
    name: "PolicyRegistry",
    address: "0xe1d74c90801db0fa806c72eb818b7671b8233532",
    net: "testnet",
    note: "Anchors which committed ruleset governs an agent.",
  },
  {
    name: "SpendIntentRegistry",
    address: "0xf87e50f83172c2dace7d274e4c701212caeb1372",
    net: "testnet",
    note: "On-chain lifecycle for bounded spend intents above the policy threshold.",
  },
  {
    name: "UntchReceipts",
    address: "0x0c64997277b7d94d2999dea22a123cac56334863",
    net: "testnet",
    note: "Versioned, batched receipt event log. Hashes only, never payloads.",
  },
  {
    name: "UntchVaultFactory",
    address: "0x1562c6eb1813016c8562cf6771cbf715007bb7e9",
    net: "testnet",
    note: "Deploys per-agent vaults (Mode C enforcement).",
  },
  {
    name: "UntchVault (demo)",
    address: "0x42e699ffd8215d48397a049b4f7a176db06f4848",
    net: "testnet",
    note: "A deployed vault instance with real spend and withdraw transactions.",
  },
];

/** Product invariants — guarantees, not testimonials. */
export const INVARIANTS: { id: string; claim: string; detail: string }[] = [
  {
    id: "I1",
    claim: "The model never touches the money.",
    detail: "Every approve, block, or escalate comes from deterministic policy evaluation. No LLM output sits in a money decision.",
  },
  {
    id: "I2",
    claim: "Fail closed.",
    detail: "Any dependency failure during a preflight blocks or escalates the payment. It never silently approves.",
  },
  {
    id: "I4",
    claim: "The owner keeps custody.",
    detail: "Untch's oracle key cannot withdraw or transfer funds. The owner can pause or withdraw without us.",
  },
];
