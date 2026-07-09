// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { IntentHash } from "../src/lib/IntentHash.sol";

/// @title IntentHashTest
/// @notice D0.5 / PRD §28-item-5 canonicalization differential. Reads the shared fixture
/// corpus (fixtures/intents.json) and the TS-generated hashes (fixtures/intents.hashes.json),
/// recomputes each hash on-struct with Solidity `IntentHash.hashIntent`, and asserts equality
/// per case. A failure here means the two hashing surfaces have diverged — precisely the #1
/// bug class PRD §9 exists to prevent. The single-field cases pin field ORDER: if Solidity and
/// TS disagreed on field order, `only-deadline` and `only-nonce` (etc.) would cross-fail.
contract IntentHashTest is Test {
    string internal corpus;
    string internal hashes;

    function setUp() public {
        corpus = vm.readFile("../fixtures/intents.json");
        hashes = vm.readFile("../fixtures/intents.hashes.json");
    }

    function test_Differential_SolidityMatchesTsForEveryCase() public view {
        uint256 count = vm.parseJsonUint(corpus, ".count");
        assertEq(count, vm.parseJsonUint(hashes, ".count"), "count mismatch corpus vs hashes");
        assertGe(count, 8, "D0.5 requires >=8 differential cases");

        for (uint256 i = 0; i < count; i++) {
            string memory c = string.concat(".cases[", vm.toString(i), "]");
            string memory h = string.concat(".hashes[", vm.toString(i), "]");

            string memory name = vm.parseJsonString(corpus, string.concat(c, ".name"));
            assertEq(
                name,
                vm.parseJsonString(hashes, string.concat(h, ".name")),
                "case/hash name misalignment"
            );

            IntentHash.SpendIntent memory intent = IntentHash.SpendIntent({
                owner: vm.parseJsonAddress(corpus, string.concat(c, ".owner")),
                buyerAgentId: vm.parseJsonUint(corpus, string.concat(c, ".buyerAgentId")),
                workerAgentId: vm.parseJsonUint(corpus, string.concat(c, ".workerAgentId")),
                token: vm.parseJsonAddress(corpus, string.concat(c, ".token")),
                maxAmount: vm.parseJsonUint(corpus, string.concat(c, ".maxAmount")),
                taskHash: vm.parseJsonBytes32(corpus, string.concat(c, ".taskHash")),
                acceptanceHash: vm.parseJsonBytes32(corpus, string.concat(c, ".acceptanceHash")),
                schemaHash: vm.parseJsonBytes32(corpus, string.concat(c, ".schemaHash")),
                policyHash: vm.parseJsonBytes32(corpus, string.concat(c, ".policyHash")),
                deadline: vm.parseJsonUint(corpus, string.concat(c, ".deadline")),
                nonce: vm.parseJsonUint(corpus, string.concat(c, ".nonce"))
            });

            bytes32 onchain = IntentHash.hashIntent(intent);
            bytes32 offchain = vm.parseJsonBytes32(hashes, string.concat(h, ".hash"));

            assertEq(onchain, offchain, string.concat("intentHash mismatch for case: ", name));
        }
    }
}
