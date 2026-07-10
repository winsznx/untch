// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import { UntchVault } from "../../src/UntchVault.sol";

/// @title MockERC20
/// @notice Minimal, fully standard-compliant ERC20 (returns a bool from transfer/transferFrom) for the
/// UntchVault suite. Public `mint` so tests can fund arbitrary accounts.
contract MockERC20 {
    string public name = "Mock USD";
    string public symbol = "mUSD";
    uint8 public decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        balanceOf[from] = b - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @title MockERC20NoReturn
/// @notice A non-standard ERC20 in the mainnet-USDT mould: `transfer`/`transferFrom` return NOTHING
/// (no bool). Naive Solidity that assumes a bool return breaks on this; SafeERC20 (judgment call 3)
/// handles it. Used to prove UntchVault moves such a token correctly.
contract MockERC20NoReturn {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        uint256 b = balanceOf[msg.sender];
        require(b >= amount, "balance");
        balanceOf[msg.sender] = b - amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        balanceOf[from] = b - amount;
        balanceOf[to] += amount;
    }
}

/// @title ReentrantToken
/// @notice A malicious ERC20 whose `transfer` reenters `UntchVault.spend` (or `spendFallback`) mid-call.
/// The vault's CEI ordering + reentrancy guard must make the reentrant attempt revert, so the outer
/// call reverts and NO double-spend occurs. `armed`/`payload` are set by the test before the trigger.
contract ReentrantToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    UntchVault public vault;
    bool public armed;
    bytes public payload;
    bool public reentered;
    /// @notice Sticky: set true if ANY reentrant call into the vault ever succeeded. MUST stay false —
    /// a successful reentry means CEI/guard failed and a double-spend got through.
    bool public everReentered;
    /// @notice Count of times the armed reentry actually fired (a liveness counter for the invariant).
    uint256 public fireCount;

    function setVault(UntchVault v) external {
        vault = v;
    }

    function arm(bytes calldata p) external {
        armed = true;
        payload = p;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        if (armed) {
            armed = false; // fire once per arm
            fireCount++;
            (bool ok,) = address(vault).call(payload);
            reentered = ok; // if the vault let it through, ok == true → test fails
            if (ok) everReentered = true; // sticky — never cleared
        }
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        balanceOf[from] = b - amount;
        balanceOf[to] += amount;
    }
}

/// @title CEIProbeToken
/// @notice Proves checks-effects-INTERACTIONS ordering INDEPENDENTLY of the reentrancy guard. During
/// its `transfer` (the vault's INTERACTION step), it reads the vault's `epochSpent()` and
/// `nonceUsed(watchNonce)` — plain view getters that the `nonReentrant` guard does NOT block — and
/// records what it observes. If the vault commits its effects BEFORE the transfer (correct CEI), the
/// probe sees `epochSpent == amount` and `nonceUsed == true` mid-transfer. If effects were (wrongly)
/// moved AFTER the transfer, the probe would see the pre-spend values (0 / false) — so a CEI regression
/// is caught here even though the guard would still block an actual reentrant call.
contract CEIProbeToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    UntchVault public vault;
    uint256 public watchNonce;
    uint256 public observedEpochSpent;
    bool public observedNonceUsed;
    bool public observed;

    function setVault(UntchVault v) external {
        vault = v;
    }

    function watch(uint256 nonce) external {
        watchNonce = nonce;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        // The vault is mid-`spend`, executing its INTERACTION step. Read its committed effects.
        observedEpochSpent = vault.epochSpent();
        observedNonceUsed = vault.nonceUsed(watchNonce);
        observed = true;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        uint256 b = balanceOf[from];
        require(b >= amount, "balance");
        balanceOf[from] = b - amount;
        balanceOf[to] += amount;
    }
}

/// @title MockIntentRegistry
/// @notice Configurable stand-in for SpendIntentRegistry's `isUsable`. `setUsable(hash, bool)` marks a
/// specific intent usable; unset hashes read false. Used for the happy path and the not-approved path.
contract MockIntentRegistry {
    mapping(bytes32 => bool) public usable;

    function setUsable(bytes32 intentHash, bool v) external {
        usable[intentHash] = v;
    }

    function isUsable(bytes32 intentHash) external view returns (bool) {
        return usable[intentHash];
    }
}

/// @title RevertingRegistry
/// @notice `isUsable` always reverts — the cross-contract-failure mode (a). The vault must NOT swallow
/// it (no try/catch, judgment call 5): the whole spend reverts.
contract RevertingRegistry {
    error Boom();

    function isUsable(bytes32) external pure returns (bool) {
        revert Boom();
    }
}

/// @title EmptyReturnRegistry
/// @notice `isUsable` returns ZERO bytes instead of a 32-byte bool — the cross-contract-failure mode
/// (b): unexpected/short return data. Solidity's return-data ABI decode for the typed call must revert,
/// reverting the whole spend.
contract EmptyReturnRegistry {
    // solhint-disable-next-line no-empty-blocks
    fallback() external {
        // returns 0 bytes for any selector, including isUsable(bytes32)
    }
}

/// @title GarbageReturnRegistry
/// @notice `isUsable` returns a "dirty" first word (value 2, not a clean ABI bool of 0/1) plus extra
/// tail bytes — cross-contract-failure mode (c): unexpected/garbage return data. Solidity's typed
/// return-data decode validates that a `bool` is 0 or 1 and reverts on anything else, so the whole spend
/// reverts (fails closed), never silently proceeds.
contract GarbageReturnRegistry {
    function isUsable(bytes32) external pure returns (bytes32, bytes32) {
        return (bytes32(uint256(2)), bytes32(uint256(0xdead)));
    }
}
