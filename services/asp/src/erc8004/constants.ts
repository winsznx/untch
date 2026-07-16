/**
 * ERC-8004 Identity registry — pinned to X Layer mainnet deployed bytecode.
 * Source: internal/ERC-8004-primary-source-report.md (live eth_getCode + name/symbol).
 * Do not import a third-party package that tracks the Draft EIP; pin to these addresses.
 */

export const ERC8004_IDENTITY_MAINNET =
  "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as const;
export const ERC8004_REPUTATION_MAINNET =
  "0x8004BAa17C55a88189AE136b182e5fdA19dE9b63" as const;

export const ERC8004_CHAIN_ID = 196 as const;
export const ERC8004_AGENT_REGISTRY =
  `eip155:${ERC8004_CHAIN_ID}:${ERC8004_IDENTITY_MAINNET}` as const;

/** Normative type discriminator — wrong string = card will not render. */
export const ERC8004_REGISTRATION_TYPE =
  "https://eips.ethereum.org/EIPS/eip-8004#registration-v1" as const;

export const EXPECTED_IDENTITY_NAME = "AgentIdentity" as const;
export const EXPECTED_IDENTITY_SYMBOL = "AGENT" as const;

/** Default public brand image (1:1 2048 PNG, already on production web). */
export const DEFAULT_AGENT_IMAGE_URL =
  "https://www.untch.xyz/brand/untch-icon-2048.png" as const;

export const DEFAULT_AGENT_URI =
  "https://asp.untch.xyz/agent-registration.json" as const;

export const DEFAULT_WELL_KNOWN_PATH = "/.well-known/agent-registration.json" as const;
export const AGENT_REGISTRATION_PATH = "/agent-registration.json" as const;

/** Narrowed ABI — only what we assert and what the register script calls. */
export const IDENTITY_REGISTRY_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "register",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    type: "function",
    name: "setAgentURI",
    stateMutability: "nonpayable",
    inputs: [
      { name: "agentId", type: "uint256" },
      { name: "newURI", type: "string" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getAgentWallet",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "event",
    name: "Registered",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;
