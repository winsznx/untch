// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title IntentHash
/// @author Untch
/// @notice Canonical on-chain hash of a SpendIntent (PRD §8.1). The intentHash threads
/// through decision, oracle signature, vault spend, delivery, and receipt, so it MUST be
/// byte-for-byte reproducible off-chain. `hashIntent` is the Solidity half of the D0.5 /
/// §28-item-5 canonicalization differential: it hashes the SAME 11 fields in the SAME order
/// as the canon package's `hashSpendIntent` (viem `encodeAbiParameters` + keccak256), proving
/// the two implementations agree on every fixture.
/// @dev Hashing is `keccak256(abi.encode(...))` — NOT `abi.encodePacked`. All 11 fields are
/// static (address / uint256 / bytes32), so `abi.encode` lays them out as eleven 32-byte
/// words with no dynamic offsets; `abi.encodePacked` would strip the padding and make the
/// field boundaries ambiguous.
library IntentHash {
    /// @notice SpendIntent — the bounded object, field order and types verbatim from PRD §8.1.
    struct SpendIntent {
        address owner; // operator wallet
        uint256 buyerAgentId;
        uint256 workerAgentId; // 0 if A2MCP endpoint call
        address token;
        uint256 maxAmount; // base units
        bytes32 taskHash;
        bytes32 acceptanceHash; // committed acceptance criteria (0x0 ⇒ hygiene event)
        bytes32 schemaHash; // expected output schema
        bytes32 policyHash;
        uint256 deadline; // unix
        uint256 nonce;
    }

    /// @notice keccak256 over the ABI encoding of the §8.1 fields, in declared order.
    /// @param intent The bounded spend intent.
    /// @return The canonical intentHash.
    function hashIntent(SpendIntent memory intent) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
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
                intent.nonce
            )
        );
    }
}
