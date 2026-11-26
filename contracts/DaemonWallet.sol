// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

interface IDaemonWalletFactory {
    function burnToken() external view returns (address);
}

/// @title DaemonWallet
/// @notice Wallet for one DAEMON agent. The operator (the agent runner) can pay out
///         native ETH up to `dailyCap` per UTC day and can burn the factory's burn token.
///         It cannot raise its own cap, move other tokens, or act while frozen.
///         The owner (the human) can change the cap, freeze, swap the operator and withdraw anything.
contract DaemonWallet {
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    address public immutable factory;
    address public owner;
    address public operator;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint256 public day;
    bool public frozen;

    event Paid(address indexed to, uint256 value, string memo);
    event Burned(address indexed token, uint256 amount);
    event CapSet(uint256 cap);
    event FrozenSet(bool frozen);
    event OperatorSet(address operator);
    event OwnerSet(address owner);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        require(!frozen, "frozen");
        _;
    }

    constructor(address owner_, address operator_, uint256 cap_) {
        require(owner_ != address(0) && operator_ != address(0), "zero address");
        factory = msg.sender;
        owner = owner_;
        operator = operator_;
        dailyCap = cap_;
        day = block.timestamp / 1 days;
        emit OwnerSet(owner_);
        emit OperatorSet(operator_);
        emit CapSet(cap_);
    }

    receive() external payable {}

    function remainingToday() public view returns (uint256) {
        if (block.timestamp / 1 days != day) return dailyCap;
        return spentToday >= dailyCap ? 0 : dailyCap - spentToday;
    }

    function pay(address payable to, uint256 value, string calldata memo) external onlyOperator {
        uint256 today = block.timestamp / 1 days;
        if (today != day) {
            day = today;
            spentToday = 0;
        }
        require(spentToday + value <= dailyCap, "over daily cap");
        spentToday += value;
        (bool ok, ) = to.call{value: value}("");
        require(ok, "send failed");
        emit Paid(to, value, memo);
    }

    function burn() external onlyOperator returns (uint256 amount) {
        address token = IDaemonWalletFactory(factory).burnToken();
        require(token != address(0), "no burn token yet");
        amount = IERC20(token).balanceOf(address(this));
        require(amount > 0, "nothing to burn");
        require(IERC20(token).transfer(BURN, amount), "transfer failed");
        emit Burned(token, amount);
    }

    function setCap(uint256 cap_) external onlyOwner {
        dailyCap = cap_;
        emit CapSet(cap_);
    }

    function setFrozen(bool frozen_) external onlyOwner {
        frozen = frozen_;
        emit FrozenSet(frozen_);
    }

    function setOperator(address operator_) external onlyOwner {
        require(operator_ != address(0), "zero address");
        operator = operator_;
        emit OperatorSet(operator_);
    }

    function setOwner(address owner_) external onlyOwner {
        require(owner_ != address(0), "zero address");
        owner = owner_;
        emit OwnerSet(owner_);
    }

    function withdraw(address payable to, uint256 value) external onlyOwner {
        (bool ok, ) = to.call{value: value}("");
        require(ok, "send failed");
        emit Withdrawn(address(0), to, value);
    }

    function withdrawToken(address token, address to, uint256 amount) external onlyOwner {
        require(IERC20(token).transfer(to, amount), "transfer failed");
        emit Withdrawn(token, to, amount);
    }
}

/// @title DaemonWalletFactory
/// @notice Deploys one DaemonWallet per agent at a predictable address.
///         The burn token can be set once, after the token exists.
contract DaemonWalletFactory is IDaemonWalletFactory {
    address public immutable admin;
    address public immutable operator;
    address public burnToken;

    event WalletCreated(address indexed wallet, address indexed owner, bytes32 indexed agentId, uint256 dailyCap);
    event BurnTokenSet(address token);

    constructor(address operator_) {
        require(operator_ != address(0), "zero address");
        admin = msg.sender;
        operator = operator_;
    }

    function setBurnToken(address token) external {
        require(msg.sender == admin, "not admin");
        require(burnToken == address(0), "already set");
        require(token != address(0), "zero address");
        burnToken = token;
        emit BurnTokenSet(token);
    }

    function create(address owner_, bytes32 agentId, uint256 dailyCap) external returns (address wallet) {
        wallet = address(new DaemonWallet{salt: agentId}(owner_, operator, dailyCap));
        emit WalletCreated(wallet, owner_, agentId, dailyCap);
    }

    function predict(address owner_, bytes32 agentId, uint256 dailyCap) external view returns (address) {
        bytes32 h = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                agentId,
                keccak256(abi.encodePacked(type(DaemonWallet).creationCode, abi.encode(owner_, operator, dailyCap)))
            )
        );
        return address(uint160(uint256(h)));
    }
}
