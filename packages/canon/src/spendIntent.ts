import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

/**
 * Surface B — SpendIntent struct hash (PRD §8.1).
 *
 * The intentHash threads through decision, oracle signature, vault spend, delivery, and
 * receipt, so its bytes MUST match the on-chain `IntentHash.hashIntent` exactly. Both sides
 * compute `keccak256(abi.encode(...))` over the same 11 fields in the same order — this is
 * `abi.encode`, NOT `abi.encodePacked` (packed drops padding and is ambiguous across field
 * boundaries). viem's `encodeAbiParameters` over an all-static parameter list is byte-for-byte
 * identical to Solidity `abi.encode`; the differential fixtures prove it per-case.
 */
export interface SpendIntent {
  /** operator wallet */
  owner: Address;
  buyerAgentId: bigint;
  /** 0 if A2MCP endpoint call */
  workerAgentId: bigint;
  token: Address;
  /** base units */
  maxAmount: bigint;
  taskHash: Hex;
  /** committed acceptance criteria (0x0 ⇒ hygiene event) */
  acceptanceHash: Hex;
  /** expected output schema */
  schemaHash: Hex;
  policyHash: Hex;
  /** unix */
  deadline: bigint;
  nonce: bigint;
}

/**
 * The exact ABI parameter list, field order and types verbatim from §8.1. Exported so the
 * ordering is inspectable and reusable (e.g. for EIP-712 struct definitions) and so any drift
 * from §8.1 is a one-line, reviewable diff.
 */
export const SPEND_INTENT_ABI_PARAMS = [
  { name: "owner", type: "address" },
  { name: "buyerAgentId", type: "uint256" },
  { name: "workerAgentId", type: "uint256" },
  { name: "token", type: "address" },
  { name: "maxAmount", type: "uint256" },
  { name: "taskHash", type: "bytes32" },
  { name: "acceptanceHash", type: "bytes32" },
  { name: "schemaHash", type: "bytes32" },
  { name: "policyHash", type: "bytes32" },
  { name: "deadline", type: "uint256" },
  { name: "nonce", type: "uint256" },
] as const;

/** `hashSpendIntent(intent) = keccak256(abi.encode(<§8.1 fields, in order>))`. */
export function hashSpendIntent(intent: SpendIntent): Hex {
  return keccak256(
    encodeAbiParameters(SPEND_INTENT_ABI_PARAMS, [
      intent.owner,
      intent.buyerAgentId,
      intent.workerAgentId,
      intent.token,
      intent.maxAmount,
      intent.taskHash,
      intent.acceptanceHash,
      intent.schemaHash,
      intent.policyHash,
      intent.deadline,
      intent.nonce,
    ]),
  );
}
