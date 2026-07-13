// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { Test } from "forge-std/Test.sol";
import { UntchReceipts } from "../src/UntchReceipts.sol";

/// @title UntchReceiptsHandler
/// @notice Stateful-fuzz handler (PRD §28 tier 3). Drives a bounded set of actors through random
/// sequences of timelock proposals, executions, cancellations, TIME WARPS, batch logging, and — most
/// importantly — adversarial attempts to execute admin ops early and to mutate as a non-writer /
/// non-admin. It mirrors the on-chain timelock and writer set in ghost state so the invariants can
/// assert: (a) no op EVER takes effect before its eta, under any ordering (judgment call 3's
/// property); (b) the pending-op eta on chain always equals the ghost eta; (c) writers change ONLY
/// through executed timelock ops; (d) no unauthorized caller ever mutates; (e) the batch counter
/// equals the number of successful `logReceipts` calls.
contract UntchReceiptsHandler is Test {
    UntchReceipts internal immutable REC;
    uint64 public immutable DELAY;

    address[] internal actors;

    // Ghost mirror of the timelock: eta of each op the handler believes pending (0 = not pending).
    mapping(bytes32 opId => uint64 eta) public ghostEta;
    bytes32[] internal opIds;
    mapping(bytes32 opId => bool known) internal knownOp;

    // Ghost mirror of the writer set (updated ONLY on a successful execute — the only path that
    // changes writers).
    mapping(address actor => bool isWriter) public ghostWriter;

    /// @notice Set true if ANY op ever executed successfully while `block.timestamp < eta`. MUST stay
    /// false forever — this is judgment call 3's adversarial property.
    bool public everExecutedEarly;

    /// @notice Count of unauthorized mutations that unexpectedly succeeded. Invariant: stays 0.
    uint256 public unauthorizedSuccesses;

    // Liveness counters. The invariant contract's afterInvariant() asserts each is > 0 after every
    // run, so the safety invariants CANNOT pass vacuously: if the write path were broken (e.g. every
    // execute reverted), no execute/batch would succeed, these would stay 0, and afterInvariant would
    // fail. The deterministic `happyPath` action guarantees each is reached on any run that picks it
    // (overwhelmingly likely per run), so the gate is robust rather than probabilistic.
    uint256 public successfulExecs;
    uint256 public successfulBatches;
    uint256 public earlyExecAttempts;

    constructor(address[] memory _actors, uint64 delay) {
        REC = new UntchReceipts(delay); // handler is admin
        DELAY = delay;
        actors = _actors;
    }

    function receipts() external view returns (UntchReceipts) {
        return REC;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function opCount() external view returns (uint256) {
        return opIds.length;
    }

    function opIdAt(uint256 i) external view returns (bytes32) {
        return opIds[i];
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    /// @dev Map a seed to a real op kind and its target. TRANSFER_ADMIN always targets the handler
    /// itself so the handler stays admin (keeping the fuzz able to keep driving the timelock) while
    /// still exercising the TRANSFER_ADMIN execute path through the delay.
    function _op(uint256 kindSeed, uint256 actorSeed)
        internal
        view
        returns (UntchReceipts.OpKind kind, address target)
    {
        uint256 k = bound(kindSeed, 1, 3); // 1=ADD, 2=REMOVE, 3=TRANSFER
        kind = UntchReceipts.OpKind(k);
        target = kind == UntchReceipts.OpKind.TRANSFER_ADMIN ? address(this) : _actor(actorSeed);
    }

    function _recordProposed(bytes32 id) internal {
        ghostEta[id] = REC.opEta(id);
        if (!knownOp[id]) {
            knownOp[id] = true;
            opIds.push(id);
        }
    }

    // ── timelock actions ──────────────────────────────────────────────────────

    function proposeOp(uint256 kindSeed, uint256 actorSeed) external {
        (UntchReceipts.OpKind kind, address target) = _op(kindSeed, actorSeed);
        try REC.propose(kind, target) returns (bytes32 id) {
            _recordProposed(id);
        } catch { }
    }

    function executeOp(uint256 kindSeed, uint256 actorSeed) external {
        (UntchReceipts.OpKind kind, address target) = _op(kindSeed, actorSeed);
        bytes32 id = REC.opId(kind, target);
        uint64 etaBefore = REC.opEta(id);
        // block.timestamp is constant across the execute() call (no warp inside), so this one read is
        // valid both before and after. Read into a local (forge block-timestamp lint) then compare.
        uint256 nowTs = block.timestamp;
        if (etaBefore != 0 && nowTs < etaBefore) earlyExecAttempts++;

        try REC.execute(kind, target) {
            // Success ⇒ the contract guaranteed now >= eta. If it executed with now < eta, the
            // judgment-call-3 property is broken and the invariant must catch it.
            if (nowTs < etaBefore) everExecutedEarly = true;
            ghostEta[id] = 0;
            if (kind == UntchReceipts.OpKind.ADD_WRITER) ghostWriter[target] = true;
            else if (kind == UntchReceipts.OpKind.REMOVE_WRITER) ghostWriter[target] = false;
            successfulExecs++;
        } catch { }
    }

    function cancelOp(uint256 kindSeed, uint256 actorSeed) external {
        (UntchReceipts.OpKind kind, address target) = _op(kindSeed, actorSeed);
        bytes32 id = REC.opId(kind, target);
        try REC.cancel(kind, target) {
            ghostEta[id] = 0;
        } catch { }
    }

    function warpTime(uint256 seed) external {
        uint256 jump = bound(seed, 1, uint256(DELAY));
        // solhint-disable-next-line not-rely-on-time
        vm.warp(block.timestamp + jump);
    }

    // ── receipt logging ───────────────────────────────────────────────────────

    function logBatch(uint256 actorSeed, uint256 sizeSeed) external {
        address actor = _actor(actorSeed);
        if (!ghostWriter[actor]) return; // happy path: only writers log
        uint256 n = bound(sizeSeed, 1, 6);
        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](n);
        for (uint256 i = 0; i < n; i++) {
            batch[i].receiptId = keccak256(abi.encode(actor, sizeSeed, i));
        }
        vm.prank(actor);
        REC.logReceipts(batch);
        successfulBatches++;
    }

    /// @notice Deterministic happy path — GUARANTEES the write path is exercised on any run that
    /// picks it: authorize a writer through the FULL timelock (propose → warp to eta → execute), then
    /// log a batch as that writer. On a working contract this always succeeds (so successfulExecs and
    /// successfulBatches both grow); on a broken one it reverts/rolls back and the counters stay 0,
    /// which the invariant contract's afterInvariant() liveness gate then catches. Warps forward only
    /// (never rewinds), so it does not disturb other pending ops' etas.
    function happyPath(uint256 actorSeed) external {
        address w = _actor(actorSeed);
        if (!ghostWriter[w]) {
            bytes32 id = REC.opId(UntchReceipts.OpKind.ADD_WRITER, w);
            if (REC.opEta(id) == 0) {
                REC.propose(UntchReceipts.OpKind.ADD_WRITER, w);
                _recordProposed(id);
            }
            uint64 eta = REC.opEta(id);
            uint256 nowTs = block.timestamp;
            if (nowTs < eta) {
                vm.warp(eta); // forward only — never rewinds
                nowTs = eta;
            }
            REC.execute(UntchReceipts.OpKind.ADD_WRITER, w);
            if (nowTs < eta) everExecutedEarly = true; // warped to eta ⇒ never true; a broken guard trips it
            ghostEta[id] = 0;
            ghostWriter[w] = true;
            successfulExecs++;
        }
        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](1);
        // solhint-disable-next-line not-rely-on-time
        batch[0].receiptId = keccak256(abi.encode("happy", w, block.timestamp));
        vm.prank(w);
        REC.logReceipts(batch);
        successfulBatches++;
    }

    // ── adversarial actions (every one MUST revert) ───────────────────────────

    function attackNonWriterLog(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (ghostWriter[actor]) return; // only probe non-writers
        UntchReceipts.Receipt[] memory batch = new UntchReceipts.Receipt[](1);
        vm.prank(actor);
        try REC.logReceipts(batch) {
            unauthorizedSuccesses++;
        } catch { }
    }

    /// @notice Adversary: propose an op then try to execute it IN THE SAME CALL (no warp). Since the
    /// delay is > 0, `now < eta` always holds, so this is a guaranteed early-execute attempt — it MUST
    /// revert every time. If it ever succeeds, `everExecutedEarly` trips and the invariant fails. This
    /// hammers the judgment-call-3 boundary deterministically on every call, on top of the incidental
    /// early attempts `executeOp` makes.
    function attackExecuteImmediately(uint256 kindSeed, uint256 actorSeed) external {
        (UntchReceipts.OpKind kind, address target) = _op(kindSeed, actorSeed);
        bytes32 id = REC.opId(kind, target);
        if (REC.opEta(id) != 0) return; // an op is already pending for this (kind,target)
        REC.propose(kind, target);
        _recordProposed(id);

        uint256 nowTs = block.timestamp;
        uint64 eta = REC.opEta(id);
        earlyExecAttempts++;
        try REC.execute(kind, target) {
            // Delay > 0 ⇒ now < eta ⇒ this branch means the timelock was bypassed.
            if (nowTs < eta) {
                everExecutedEarly = true;
            } else {
                ghostEta[id] = 0;
                successfulExecs++;
            }
        } catch { }
    }

    function attackNonAdminTimelock(uint256 kindSeed, uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        if (actor == address(this)) return; // only probe non-admins
        (UntchReceipts.OpKind kind, address target) = _op(kindSeed, actorSeed);
        vm.prank(actor);
        try REC.propose(kind, target) {
            unauthorizedSuccesses++;
        } catch { }
        vm.prank(actor);
        try REC.execute(kind, target) {
            unauthorizedSuccesses++;
        } catch { }
    }
}

/// @title UntchReceiptsInvariant
/// @notice PRD §28 tier-3 invariants for UntchReceipts (§10.3):
///   • TIMELOCK: no admin writer-set change ever takes effect before its eta — the judgment-call-3
///     property, stated as an adversarially-fuzzed invariant, not just example tests;
///   • the on-chain pending eta always equals the ghost eta (propose sets exactly now+delay; execute
///     and cancel clear it; it never drifts while pending);
///   • the writer set changes ONLY through executed timelock ops;
///   • no unauthorized (non-writer / non-admin) call ever mutates;
///   • the batch counter equals the number of successful `logReceipts` calls.
contract UntchReceiptsInvariant is Test {
    UntchReceipts internal rec;
    UntchReceiptsHandler internal handler;

    uint64 internal constant DELAY = 2 days;

    function setUp() public {
        vm.warp(1_700_000_000);

        address[] memory actors = new address[](4);
        actors[0] = makeAddr("alice");
        actors[1] = makeAddr("bob");
        actors[2] = makeAddr("carol");
        actors[3] = makeAddr("dave");

        handler = new UntchReceiptsHandler(actors, DELAY);
        rec = handler.receipts();

        bytes4[] memory selectors = new bytes4[](9);
        selectors[0] = handler.proposeOp.selector;
        selectors[1] = handler.executeOp.selector;
        selectors[2] = handler.cancelOp.selector;
        selectors[3] = handler.warpTime.selector;
        selectors[4] = handler.logBatch.selector;
        selectors[5] = handler.attackNonWriterLog.selector;
        selectors[6] = handler.attackNonAdminTimelock.selector;
        selectors[7] = handler.attackExecuteImmediately.selector;
        selectors[8] = handler.happyPath.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// @notice THE property (judgment call 3): a writer-set change proposed at T never takes effect
    /// before T + delay, under any caller, under any ordering of calls.
    function invariant_TimelockNeverExecutesEarly() public view {
        assertFalse(handler.everExecutedEarly(), "an op executed before its timelock eta");
    }

    /// @notice The on-chain pending eta always equals the ghost eta — proves propose records exactly
    /// now+delay, execute/cancel clear it, and it never mutates while pending.
    function invariant_PendingEtaMirrorsChain() public view {
        uint256 n = handler.opCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 id = handler.opIdAt(i);
            assertEq(rec.opEta(id), handler.ghostEta(id), "on-chain eta drifted from ghost");
        }
    }

    /// @notice The writer set changes ONLY via executed timelock ops (the ghost is updated only there).
    function invariant_WriterSetChangesOnlyViaTimelock() public view {
        for (uint256 i = 0; i < 4; i++) {
            address a = handler.actorAt(i);
            assertEq(
                rec.isWriter(a), handler.ghostWriter(a), "writer set drifted from timelock ghost"
            );
        }
    }

    /// @notice No unauthorized (non-writer / non-admin) call ever mutates.
    function invariant_NoUnauthorizedMutation() public view {
        assertEq(handler.unauthorizedSuccesses(), 0, "an unauthorized caller mutated the contract");
    }

    /// @notice The batch counter equals the number of successful `logReceipts` calls (monotone, exact).
    function invariant_BatchCountEqualsSuccessfulLogs() public view {
        assertEq(
            rec.batchCount(), handler.successfulBatches(), "batch counter diverged from log calls"
        );
    }

    /// @notice Liveness gate — runs after each campaign sequence and fails if the write path was NOT
    /// exercised. Without this, all five safety invariants could pass VACUOUSLY on a broken contract
    /// where no execute/batch ever succeeds (0==0, empty==empty, everExecutedEarly never trips). The
    /// deterministic `happyPath` action makes these reliably > 0 on a working contract, so a regression
    /// that breaks the write path is caught here rather than silently passing green.
    function afterInvariant() public view {
        assertGt(handler.successfulExecs(), 0, "vacuous: no timelock execute ever succeeded");
        assertGt(handler.successfulBatches(), 0, "vacuous: no receipt batch ever logged");
        assertGt(handler.earlyExecAttempts(), 0, "vacuous: no early-execute was ever attempted");
    }
}
