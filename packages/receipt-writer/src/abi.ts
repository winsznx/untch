/**
 * UntchReceipts (§10.3) ABI — the subset this component uses: `logReceipts` (the worker's anchor
 * call), the timelock admin surface (`propose`/`execute`/`cancel`/`opEta`/`opId`), the read views the
 * provisioning script asserts on (`isWriter`/`admin`/`timelockDelay`/`batchCount`), and the two events
 * the worker + the raw-RPC verifier decode (`ReceiptLogged`, `BatchLogged`). Kept in sync with
 * contracts/src/UntchReceipts.sol.
 */
export const UNTCH_RECEIPTS_ABI = [
  {
    type: "function",
    name: "logReceipts",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "receipts",
        type: "tuple[]",
        components: [
          { name: "receiptId", type: "bytes32" },
          { name: "policyId", type: "uint256" },
          { name: "policyHash", type: "bytes32" },
          { name: "agentId", type: "bytes32" },
          { name: "vendorId", type: "bytes32" },
          { name: "amount", type: "uint256" },
          { name: "token", type: "address" },
          { name: "category", type: "bytes32" },
          { name: "payType", type: "uint8" },
          { name: "intentHash", type: "bytes32" },
          { name: "taskHash", type: "bytes32" },
          { name: "decision", type: "uint8" },
          { name: "verifyResult", type: "uint8" },
          { name: "proofTier", type: "uint8" },
          { name: "metadataHash", type: "bytes32" },
        ],
      },
    ],
    outputs: [{ name: "batchId", type: "uint256" }],
  },
  {
    type: "function",
    name: "propose",
    stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "target", type: "address" },
    ],
    outputs: [{ name: "id", type: "bytes32" }],
  },
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "target", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "cancel",
    stateMutability: "nonpayable",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "target", type: "address" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "opId",
    stateMutability: "pure",
    inputs: [
      { name: "kind", type: "uint8" },
      { name: "target", type: "address" },
    ],
    outputs: [{ name: "", type: "bytes32" }],
  },
  {
    type: "function",
    name: "opEta",
    stateMutability: "view",
    inputs: [{ name: "opId", type: "bytes32" }],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "isWriter",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "admin",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "timelockDelay",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint64" }],
  },
  {
    type: "function",
    name: "batchCount",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "event",
    name: "ReceiptLogged",
    inputs: [
      { name: "schemaVersion", type: "uint16", indexed: false },
      { name: "receiptId", type: "bytes32", indexed: false },
      { name: "policyId", type: "uint256", indexed: true },
      { name: "policyHash", type: "bytes32", indexed: false },
      { name: "agentId", type: "bytes32", indexed: true },
      { name: "vendorId", type: "bytes32", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "token", type: "address", indexed: false },
      { name: "category", type: "bytes32", indexed: false },
      { name: "payType", type: "uint8", indexed: false },
      { name: "intentHash", type: "bytes32", indexed: false },
      { name: "taskHash", type: "bytes32", indexed: false },
      { name: "decision", type: "uint8", indexed: false },
      { name: "verifyResult", type: "uint8", indexed: false },
      { name: "proofTier", type: "uint8", indexed: false },
      { name: "metadataHash", type: "bytes32", indexed: false },
    ],
  },
  {
    type: "event",
    name: "BatchLogged",
    inputs: [
      { name: "batchId", type: "uint256", indexed: true },
      { name: "receiptCount", type: "uint256", indexed: true },
      { name: "writer", type: "address", indexed: true },
    ],
  },
] as const;

/** UntchReceipts.OpKind — NONE=0, ADD_WRITER=1, REMOVE_WRITER=2, TRANSFER_ADMIN=3. */
export const OP_KIND = {
  NONE: 0,
  ADD_WRITER: 1,
  REMOVE_WRITER: 2,
  TRANSFER_ADMIN: 3,
} as const;
