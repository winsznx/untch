// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test, Vm } from "forge-std/Test.sol";
import { UntchReceipts } from "../src/UntchReceipts.sol";
import { AuthorizedWriters } from "../src/AuthorizedWriters.sol";

/// @title UntchReceiptsTest
/// @notice Unit + per-function fuzz tests for UntchReceipts (PRD §10.3, §28 test tiers 1–2). Covers
/// every function and every revert path: batch receipt logging (per-receipt + batch events, schema
/// stamping, empty-batch guard, non-writer), the two anchors (zero-primary-hash guards, non-writer),
/// and the admin timelock (propose/execute/cancel, execute-before-delay, non-admin on every op). The
/// three §10.3 judgment calls are asserted explicitly: `agentId` is a numeric id (not an address),
/// `receiptId` is caller-supplied and recorded verbatim, and admin writer-set changes cannot take
/// effect before the timelock delay — the last reinforced by the adversarial invariant suite in
/// UntchReceipts.invariant.t.sol.
contract UntchReceiptsTest is Test {
    UntchReceipts internal rec;

    address internal writer = makeAddr("writer");
    address internal stranger = makeAddr("stranger");
    address internal newWriter = makeAddr("newWriter");
    address internal newAdmin = makeAddr("newAdmin");
    address internal tokenAddr = makeAddr("token");

    uint64 internal constant DELAY = 3 days;

    // Local redeclarations so tests can `vm.expectEmit` against them (topics/data matched by signature).
    event ReceiptLogged(
        uint16 schemaVersion,
        bytes32 receiptId,
        uint256 indexed policyId,
        bytes32 policyHash,
        bytes32 indexed agentId,
        bytes32 indexed vendorId,
        uint256 amount,
        address token,
        bytes32 category,
        uint8 payType,
        bytes32 intentHash,
        bytes32 taskHash,
        uint8 decision,
        uint8 verifyResult,
        uint8 proofTier,
        bytes32 metadataHash
    );
    event BatchLogged(
        uint256 indexed batchId, uint256 indexed receiptCount, address indexed writer
    );
    event ScoreAnchored(bytes32 merkleRoot, uint64 epoch, uint8 subjectKind);
    event AuditAnchored(bytes32 reportHash, bytes32 agentId, uint64 period);
    event OpProposed(
        bytes32 indexed opId, UntchReceipts.OpKind indexed kind, address indexed target, uint64 eta
    );
    event OpExecuted(
        bytes32 indexed opId, UntchReceipts.OpKind indexed kind, address indexed target
    );
    event OpCancelled(
        bytes32 indexed opId, UntchReceipts.OpKind indexed kind, address indexed target
    );
    event WriterAdded(address indexed writer, address indexed admin);
    event WriterRemoved(address indexed writer, address indexed admin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);

    // The 32-byte signature topic of ReceiptLogged — used to filter recorded logs in fuzz tests.
    bytes32 internal constant RECEIPT_LOGGED_SIG = keccak256(
        "ReceiptLogged(uint16,bytes32,uint256,bytes32,bytes32,bytes32,uint256,address,bytes32,uint8,bytes32,bytes32,uint8,uint8,uint8,bytes32)"
    );

    function setUp() public {
        vm.warp(1_700_000_000);
        rec = new UntchReceipts(DELAY); // admin = this test contract
        _addWriterViaTimelock(writer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // helpers
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev A structurally-real §10.3 receipt whose fields are all distinct functions of `seed`, so a
    /// per-entry field-mapping check can detect any cross-contamination or off-by-one.
    function _receipt(uint256 seed) internal view returns (UntchReceipts.Receipt memory) {
        return UntchReceipts.Receipt({
            receiptId: keccak256(abi.encode("receiptId", seed)),
            policyId: uint256(keccak256(abi.encode("policyId", seed))),
            policyHash: keccak256(abi.encode("policyHash", seed)),
            // agentId is bytes32(uint256 numeric id) — judgment call 1, NOT an address.
            agentId: bytes32(uint256(1000 + seed)),
            vendorId: keccak256(abi.encode("vendorId", seed)),
            amount: 1_000_000 + seed,
            token: tokenAddr,
            category: keccak256(abi.encode("category", seed)),
            payType: uint8(bound(seed, 0, 1)),
            intentHash: keccak256(abi.encode("intentHash", seed)),
            taskHash: keccak256(abi.encode("taskHash", seed)),
            decision: uint8(bound(seed, 0, 2)),
            verifyResult: uint8(bound(seed, 0, 3)),
            proofTier: uint8(bound(seed, 0, 4)),
            metadataHash: keccak256(abi.encode("metadataHash", seed))
        });
    }

    function _batch(uint256 n, uint256 baseSeed)
        internal
        view
        returns (UntchReceipts.Receipt[] memory batch)
    {
        batch = new UntchReceipts.Receipt[](n);
        for (uint256 i = 0; i < n; i++) {
            batch[i] = _receipt(baseSeed + i);
        }
    }

    /// @dev The ONLY way to authorize a writer in UntchReceipts is through the timelock (there is no
    /// immediate mutator). This helper proposes, warps past the delay, and executes.
    function _addWriterViaTimelock(address w) internal {
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, w);
        vm.warp(block.timestamp + DELAY);
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, w);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // constructor
    // ─────────────────────────────────────────────────────────────────────────

    function test_Constructor_SetsAdminDelayNotWriter() public view {
        assertEq(rec.admin(), address(this), "deployer is admin");
        assertEq(rec.timelockDelay(), DELAY, "delay stored");
        assertFalse(rec.isWriter(address(this)), "admin is not a writer by default");
        assertEq(rec.batchCount(), 0, "no batches yet");
        assertEq(rec.SCHEMA_VERSION(), 1, "schemaVersion starts at 1");
    }

    function test_RevertWhen_ConstructorZeroDelay() public {
        vm.expectRevert(UntchReceipts.ZeroDelay.selector);
        new UntchReceipts(0);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // logReceipts
    // ─────────────────────────────────────────────────────────────────────────

    function test_LogReceipts_EmitsPerReceiptAndBatchStampsSchema() public {
        UntchReceipts.Receipt memory r = _receipt(1);

        vm.expectEmit(true, true, true, true, address(rec));
        emit ReceiptLogged(
            1, // SCHEMA_VERSION stamped by contract
            r.receiptId,
            r.policyId,
            r.policyHash,
            r.agentId,
            r.vendorId,
            r.amount,
            r.token,
            r.category,
            r.payType,
            r.intentHash,
            r.taskHash,
            r.decision,
            r.verifyResult,
            r.proofTier,
            r.metadataHash
        );
        vm.expectEmit(true, true, true, true, address(rec));
        emit BatchLogged(1, 1, writer);

        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](1);
        batch[0] = r;
        vm.prank(writer);
        uint256 batchId = rec.logReceipts(batch);

        assertEq(batchId, 1, "first batch id is 1");
        assertEq(rec.batchCount(), 1, "batchCount incremented");
    }

    function test_LogReceipts_BatchOfThree() public {
        UntchReceipts.Receipt[] memory batch = _batch(3, 100);

        vm.recordLogs();
        vm.prank(writer);
        uint256 batchId = rec.logReceipts(batch);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(batchId, 1);
        assertEq(_countReceiptLogged(logs), 3, "exactly three ReceiptLogged emitted");
    }

    function test_LogReceipts_IncrementsBatchCounterAcrossCalls() public {
        vm.prank(writer);
        uint256 b1 = rec.logReceipts(_batch(2, 1));
        vm.prank(writer);
        uint256 b2 = rec.logReceipts(_batch(2, 50));
        assertEq(b1, 1);
        assertEq(b2, 2);
        assertEq(rec.batchCount(), 2);
    }

    /// @notice A receipt with all-zero content is still logged verbatim — the log validates nothing
    /// about a receipt's contents (judgment call 2: append-only, caller-supplied receiptId).
    function test_LogReceipts_RecordsZeroContentVerbatim() public {
        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](1);
        // batch[0] left zero-initialized (zero receiptId, zero everything)

        vm.recordLogs();
        vm.prank(writer);
        rec.logReceipts(batch);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(_countReceiptLogged(logs), 1, "zero-content receipt is still logged");
    }

    function test_RevertWhen_LogReceiptsEmptyBatch() public {
        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](0);
        vm.prank(writer);
        vm.expectRevert(UntchReceipts.EmptyBatch.selector);
        rec.logReceipts(batch);
    }

    function test_RevertWhen_LogReceiptsByNonWriter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, stranger));
        rec.logReceipts(_batch(1, 1));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // anchorScore
    // ─────────────────────────────────────────────────────────────────────────

    function test_AnchorScore_Emits() public {
        bytes32 root = keccak256("score-root");
        vm.expectEmit(true, true, true, true, address(rec));
        emit ScoreAnchored(root, 7, 1);
        vm.prank(writer);
        rec.anchorScore(root, 7, 1);
    }

    function test_RevertWhen_AnchorScoreZeroRoot() public {
        vm.prank(writer);
        vm.expectRevert(UntchReceipts.ZeroMerkleRoot.selector);
        rec.anchorScore(bytes32(0), 7, 1);
    }

    function test_RevertWhen_AnchorScoreByNonWriter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, stranger));
        rec.anchorScore(keccak256("root"), 7, 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // anchorAudit
    // ─────────────────────────────────────────────────────────────────────────

    function test_AnchorAudit_Emits() public {
        bytes32 reportHash = keccak256("report");
        bytes32 agentId = bytes32(uint256(4242)); // numeric id (judgment call 1), NOT an address
        vm.expectEmit(true, true, true, true, address(rec));
        emit AuditAnchored(reportHash, agentId, 202_607);
        vm.prank(writer);
        rec.anchorAudit(reportHash, agentId, 202_607);
    }

    /// @notice agentId is passed through as a numeric identity id — a large value that would OVERFLOW
    /// an address is preserved intact (proves it is NOT treated as / truncated to an address).
    function test_AnchorAudit_AgentIdIsNumericNotAddress() public {
        // A value with bits set above the 160-bit address range: address(uint160(x)) would lose them.
        bytes32 agentId = bytes32(uint256(type(uint200).max));
        assertTrue(
            uint256(agentId) > uint256(uint160(type(uint160).max)), "value exceeds address range"
        );
        vm.expectEmit(true, true, true, true, address(rec));
        emit AuditAnchored(keccak256("r"), agentId, 1);
        vm.prank(writer);
        rec.anchorAudit(keccak256("r"), agentId, 1);
    }

    function test_RevertWhen_AnchorAuditZeroReportHash() public {
        vm.prank(writer);
        vm.expectRevert(UntchReceipts.ZeroReportHash.selector);
        rec.anchorAudit(bytes32(0), bytes32(uint256(1)), 1);
    }

    function test_RevertWhen_AnchorAuditByNonWriter() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, stranger));
        rec.anchorAudit(keccak256("r"), bytes32(uint256(1)), 1);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // timelock — propose
    // ─────────────────────────────────────────────────────────────────────────

    function test_Propose_QueuesOpAndEmits() public {
        bytes32 id = rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        uint64 eta = uint64(block.timestamp) + DELAY;

        vm.expectEmit(true, true, true, true, address(rec));
        emit OpProposed(id, UntchReceipts.OpKind.ADD_WRITER, newWriter, eta);
        bytes32 returned = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        assertEq(returned, id, "returns opId");
        assertEq(rec.opEta(id), eta, "eta = now + delay");
    }

    function test_RevertWhen_ProposeByNonAdmin() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotAdmin.selector, stranger));
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_RevertWhen_ProposeNoneKind() public {
        vm.expectRevert(UntchReceipts.InvalidOpKind.selector);
        rec.propose(UntchReceipts.OpKind.NONE, newWriter);
    }

    function test_RevertWhen_ProposeZeroTarget() public {
        vm.expectRevert(AuthorizedWriters.ZeroAddress.selector);
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, address(0));
    }

    function test_RevertWhen_ProposeAlreadyPending() public {
        bytes32 id = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.expectRevert(abi.encodeWithSelector(UntchReceipts.OpAlreadyPending.selector, id));
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // timelock — execute (the core §10.3 property: no effect before T + delay)
    // ─────────────────────────────────────────────────────────────────────────

    function test_Execute_AddWriterAfterDelay() public {
        bytes32 id = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(true, true, false, false, address(rec));
        emit WriterAdded(newWriter, address(this));
        vm.expectEmit(true, true, true, true, address(rec));
        emit OpExecuted(id, UntchReceipts.OpKind.ADD_WRITER, newWriter);
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        assertTrue(rec.isWriter(newWriter), "writer authorized after delay");
        assertEq(rec.opEta(id), 0, "pending entry cleared");
    }

    /// @notice THE property (judgment call 3): a change proposed at T cannot execute before T + delay.
    function test_RevertWhen_ExecuteBeforeDelay() public {
        bytes32 id = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        uint64 eta = uint64(block.timestamp) + DELAY;
        uint64 oneBefore = eta - 1;
        vm.warp(oneBefore); // one second before eta → contract's nowTs is exactly `oneBefore`

        vm.expectRevert(
            abi.encodeWithSelector(UntchReceipts.TimelockNotElapsed.selector, id, eta, oneBefore)
        );
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertFalse(rec.isWriter(newWriter), "not authorized before delay elapses");
    }

    /// @notice Boundary: execution at EXACTLY eta is allowed (the guard is `now < eta`, inclusive at eta).
    function test_Execute_AtExactEtaSucceeds() public {
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        uint64 eta = uint64(block.timestamp) + DELAY;
        vm.warp(eta);
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertTrue(rec.isWriter(newWriter), "executes at exactly eta");
    }

    function test_RevertWhen_ExecuteNotFound() public {
        bytes32 id = rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.expectRevert(abi.encodeWithSelector(UntchReceipts.OpNotFound.selector, id));
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_RevertWhen_ExecuteByNonAdmin() public {
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.warp(block.timestamp + DELAY);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotAdmin.selector, stranger));
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_Execute_RemoveWriter() public {
        // `writer` was added in setUp; remove it via the timelock.
        bytes32 id = rec.propose(UntchReceipts.OpKind.REMOVE_WRITER, writer);
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(true, true, false, false, address(rec));
        emit WriterRemoved(writer, address(this));
        vm.expectEmit(true, true, true, true, address(rec));
        emit OpExecuted(id, UntchReceipts.OpKind.REMOVE_WRITER, writer);
        rec.execute(UntchReceipts.OpKind.REMOVE_WRITER, writer);

        assertFalse(rec.isWriter(writer), "writer removed");
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, writer));
        rec.logReceipts(_batch(1, 1));
    }

    function test_Execute_TransferAdmin() public {
        bytes32 id = rec.propose(UntchReceipts.OpKind.TRANSFER_ADMIN, newAdmin);
        vm.warp(block.timestamp + DELAY);

        vm.expectEmit(true, true, false, false, address(rec));
        emit AdminTransferred(address(this), newAdmin);
        vm.expectEmit(true, true, true, true, address(rec));
        emit OpExecuted(id, UntchReceipts.OpKind.TRANSFER_ADMIN, newAdmin);
        rec.execute(UntchReceipts.OpKind.TRANSFER_ADMIN, newAdmin);

        assertEq(rec.admin(), newAdmin, "admin moved");

        // Old admin can no longer drive the timelock.
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotAdmin.selector, address(this)));
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        // New admin can.
        vm.prank(newAdmin);
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    /// @notice A doomed op (execute would revert in the base guard) can still be executed-attempted;
    /// it reverts through the base and leaves the op pending, recoverable by cancel.
    function test_RevertWhen_ExecuteAddAlreadyWriter() public {
        // `writer` is already authorized; queue ADD_WRITER(writer) — passes propose (shape-only), then
        // reverts at execute in _addWriter.
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, writer);
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.AlreadyWriter.selector, writer));
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, writer);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // timelock — cancel
    // ─────────────────────────────────────────────────────────────────────────

    function test_Cancel_RemovesPendingOp() public {
        bytes32 id = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        vm.expectEmit(true, true, true, true, address(rec));
        emit OpCancelled(id, UntchReceipts.OpKind.ADD_WRITER, newWriter);
        rec.cancel(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        assertEq(rec.opEta(id), 0, "cancelled op cleared");

        // Even after the delay, a cancelled op cannot execute.
        vm.warp(block.timestamp + DELAY);
        vm.expectRevert(abi.encodeWithSelector(UntchReceipts.OpNotFound.selector, id));
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_RevertWhen_CancelNotFound() public {
        bytes32 id = rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.expectRevert(abi.encodeWithSelector(UntchReceipts.OpNotFound.selector, id));
        rec.cancel(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_RevertWhen_CancelByNonAdmin() public {
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotAdmin.selector, stranger));
        rec.cancel(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    function test_ReproposeAfterCancel() public {
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        rec.cancel(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        // Re-proposable after cancel.
        bytes32 id = rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertEq(rec.opEta(id), uint64(block.timestamp) + DELAY);
    }

    function test_ReproposeAfterExecute() public {
        // add then remove `newWriter` via timelock, then the ADD op is re-proposable (opEta cleared).
        _addWriterViaTimelock(newWriter);
        bytes32 id = rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertEq(rec.opEta(id), 0, "executed op cleared");
        // remove so ADD becomes meaningful again
        rec.propose(UntchReceipts.OpKind.REMOVE_WRITER, newWriter);
        vm.warp(block.timestamp + DELAY);
        rec.execute(UntchReceipts.OpKind.REMOVE_WRITER, newWriter);
        // re-propose ADD
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertEq(rec.opEta(id), uint64(block.timestamp) + DELAY, "re-proposable after execute");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // opId
    // ─────────────────────────────────────────────────────────────────────────

    function test_OpId_MatchesFormulaAndDistinguishesKindTarget() public view {
        assertEq(
            rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter),
            keccak256(abi.encode(UntchReceipts.OpKind.ADD_WRITER, newWriter)),
            "opId == keccak256(abi.encode(kind,target))"
        );
        assertTrue(
            rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter)
                != rec.opId(UntchReceipts.OpKind.REMOVE_WRITER, newWriter),
            "kind distinguishes opId"
        );
        assertTrue(
            rec.opId(UntchReceipts.OpKind.ADD_WRITER, newWriter)
                != rec.opId(UntchReceipts.OpKind.ADD_WRITER, newAdmin),
            "target distinguishes opId"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fuzz — batch event count / field mapping / access control totality
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice For any batch size, exactly `n` ReceiptLogged and one BatchLogged are emitted, the
    /// returned/stored batch id advances by one, and each entry's fields map 1:1 to the emitted event
    /// with no off-by-one or cross-contamination.
    function testFuzz_LogReceipts_EventCountAndFieldMapping(uint8 nSeed, uint256 baseSeed) public {
        uint256 n = bound(nSeed, 1, 30);
        // Keep seeds well below overflow range — `_receipt` does `1_000_000 + seed` etc.
        baseSeed = bound(baseSeed, 0, 1e15);
        UntchReceipts.Receipt[] memory batch = _batch(n, baseSeed);

        vm.recordLogs();
        vm.prank(writer);
        uint256 batchId = rec.logReceipts(batch);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        assertEq(batchId, 1, "single call -> batch id 1");
        assertEq(rec.batchCount(), 1);

        uint256 seen;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter != address(rec) || logs[i].topics[0] != RECEIPT_LOGGED_SIG) {
                continue;
            }
            _assertReceiptLogMatches(logs[i], batch[seen]);
            seen++;
        }
        assertEq(seen, n, "one ReceiptLogged per entry, in order, no off-by-one");
    }

    /// @notice schemaVersion stamped into every receipt is always 1, whatever the input.
    function testFuzz_LogReceipts_SchemaVersionAlwaysOne(uint256 seed) public {
        seed = bound(seed, 0, 1e15);
        UntchReceipts.Receipt[] memory batch = _batch(1, seed);
        vm.recordLogs();
        vm.prank(writer);
        rec.logReceipts(batch);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics[0] != RECEIPT_LOGGED_SIG) continue;
            (uint16 schemaVersion,,,,,,,,,,,,) = _decodeReceiptData(logs[i].data);
            assertEq(schemaVersion, 1);
        }
    }

    function testFuzz_BatchCounterMonotonic(uint8 numBatchesSeed) public {
        uint256 numBatches = bound(numBatchesSeed, 1, 20);
        for (uint256 i = 0; i < numBatches; i++) {
            vm.prank(writer);
            uint256 id = rec.logReceipts(_batch(1, i * 7 + 1));
            assertEq(id, i + 1, "batch ids are 1,2,3,...");
            assertEq(rec.batchCount(), i + 1, "counter tracks batches exactly");
        }
    }

    function testFuzz_NonWriterCannotLog(address caller) public {
        vm.assume(caller != writer);
        vm.prank(caller);
        vm.expectRevert(abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, caller));
        rec.logReceipts(_batch(1, 1));
    }

    function testFuzz_NonWriterCannotAnchor(address caller) public {
        vm.assume(caller != writer);
        bytes memory notWriter =
            abi.encodeWithSelector(AuthorizedWriters.NotWriter.selector, caller);

        vm.prank(caller);
        vm.expectRevert(notWriter);
        rec.anchorScore(keccak256("root"), 1, 0);

        vm.prank(caller);
        vm.expectRevert(notWriter);
        rec.anchorAudit(keccak256("r"), bytes32(uint256(1)), 1);
    }

    function testFuzz_NonAdminCannotDriveTimelock(address caller) public {
        vm.assume(caller != address(this));
        bytes memory notAdmin = abi.encodeWithSelector(AuthorizedWriters.NotAdmin.selector, caller);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        rec.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        rec.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);

        vm.prank(caller);
        vm.expectRevert(notAdmin);
        rec.cancel(UntchReceipts.OpKind.ADD_WRITER, newWriter);
    }

    /// @notice For any delay and any wait strictly shorter than it, execute reverts — an example-based
    /// companion to the adversarial timelock invariant.
    function testFuzz_ExecuteBeforeDelayReverts(uint64 delaySeed, uint64 waitSeed) public {
        uint64 delay = uint64(bound(delaySeed, 1, 3650 days));
        UntchReceipts r = new UntchReceipts(delay); // admin = this
        uint64 wait = uint64(bound(waitSeed, 0, uint256(delay) - 1)); // strictly < delay

        r.propose(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        vm.warp(block.timestamp + wait);
        vm.expectRevert();
        r.execute(UntchReceipts.OpKind.ADD_WRITER, newWriter);
        assertFalse(r.isWriter(newWriter));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // log-decoding helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _countReceiptLogged(Vm.Log[] memory logs) internal view returns (uint256 c) {
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].emitter == address(rec) && logs[i].topics[0] == RECEIPT_LOGGED_SIG) c++;
        }
    }

    /// @dev Decode the 13 non-indexed data fields of a ReceiptLogged log, in declared order.
    function _decodeReceiptData(bytes memory data)
        internal
        pure
        returns (
            uint16 schemaVersion,
            bytes32 receiptId,
            bytes32 policyHash,
            uint256 amount,
            address token,
            bytes32 category,
            uint8 payType,
            bytes32 intentHash,
            bytes32 taskHash,
            uint8 decision,
            uint8 verifyResult,
            uint8 proofTier,
            bytes32 metadataHash
        )
    {
        return abi.decode(
            data,
            (
                uint16,
                bytes32,
                bytes32,
                uint256,
                address,
                bytes32,
                uint8,
                bytes32,
                bytes32,
                uint8,
                uint8,
                uint8,
                bytes32
            )
        );
    }

    /// @dev Assert a ReceiptLogged log matches `r` field-for-field (indexed topics + decoded data).
    function _assertReceiptLogMatches(Vm.Log memory log, UntchReceipts.Receipt memory r)
        internal
        pure
    {
        // Indexed topics: [sig, policyId, agentId, vendorId].
        assertEq(uint256(log.topics[1]), r.policyId, "policyId topic");
        assertEq(log.topics[2], r.agentId, "agentId topic");
        assertEq(log.topics[3], r.vendorId, "vendorId topic");

        (
            uint16 schemaVersion,
            bytes32 receiptId,
            bytes32 policyHash,
            uint256 amount,
            address token,
            bytes32 category,
            uint8 payType,
            bytes32 intentHash,
            bytes32 taskHash,
            uint8 decision,
            uint8 verifyResult,
            uint8 proofTier,
            bytes32 metadataHash
        ) = _decodeReceiptData(log.data);

        assertEq(schemaVersion, 1, "schemaVersion");
        assertEq(receiptId, r.receiptId, "receiptId");
        assertEq(policyHash, r.policyHash, "policyHash");
        assertEq(amount, r.amount, "amount");
        assertEq(token, r.token, "token");
        assertEq(category, r.category, "category");
        assertEq(payType, r.payType, "payType");
        assertEq(intentHash, r.intentHash, "intentHash");
        assertEq(taskHash, r.taskHash, "taskHash");
        assertEq(decision, r.decision, "decision");
        assertEq(verifyResult, r.verifyResult, "verifyResult");
        assertEq(proofTier, r.proofTier, "proofTier");
        assertEq(metadataHash, r.metadataHash, "metadataHash");
    }
}
