// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title BattleWallet (EVM)
 * @notice Solidity port of the TON Battle Wallet contract. All functionality mirrors the
 *         original implementation with message based interactions replaced by direct
 *         function calls.
 */
contract BattleWallet is ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────
    error InvalidFeeBasisPoints();
    error AmountGreaterThanReserved();
    error InvalidAmount();
    error ExpiredInPast();
    error GameExists();
    error BadSignature();
    error InsufficientFunds();
    error SenderNotAllowed();
    error GameNotFound();
    error UnexpectedStatus();
    error InsufficientReserved();
    error ReservationExpired();
    error AddressMismatch();
    error NoTokenWallet();
    error ApprovalRequired();
    error InvalidToken();
    error AlreadyInitialized();
    error ZeroAddress();
    error InvalidFactory();
    error InvalidNonce();
    error InvalidGameId();

    // ─────────────────────────────────────────────────────────────────────────────
    // Types
    // ─────────────────────────────────────────────────────────────────────────────

    struct Reservation {
        uint256 amount;
        address opponent;
        bool isToken;
        address feeWallet;
        uint16 feeBasisPoints;
        // flag for whether the record exists
        bool exists;
        // whether the reservation is still active (funds reserved)
        bool active;
        uint64 expiration;
        uint64 nextGameId;
    }

    struct ReserveRequest {
        uint64 gameId;
        uint256 amount;
        address player1;
        address player2;
        bool isToken;
        uint64 noncePlayer1;
        uint64 noncePlayer2;
        address feeWallet;
        uint16 feeBasisPoints;
        address factory;
    }

    struct SettlementRequest {
        uint64 gameId;
        address winner;
        address loser;
        address factory;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────
    address public owner;
    address public factory;

    IERC20 public token;
    bool public tokenSet;

    bool public requireApproval;
    bool public initialized;

    uint64 public nextNonce;

    uint256 public totalReservedEth;
    uint256 public totalReservedToken;

    // reservations is a linked list, in the order they come in --
    // which is also in order of TTL, so long as TTL is not changed
    mapping(uint64 => Reservation) private reservations;
    uint64 private firstGameId;
    uint64 private lastGameId;

    // Type hashes for signatures (hashed with address(this) for domain separation)
    bytes32 private constant RESERVE_TYPEHASH = keccak256(
        "RESERVE(uint64 gameId,uint256 amount,address player1,address player2,bool isToken,uint64 noncePlayer1,uint64 noncePlayer2,address feeWallet,uint16 feeBasisPoints,address factory)"
    );

    constructor() EIP712("BattleWallet", "1") {}

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────
    event Reserved(uint64 indexed gameId, address indexed opponent, uint256 amount, bool isToken);
    event ReservationCancelled(uint64 indexed gameId);
    event ReservationSettled(
        uint64 indexed gameId,
        address indexed winner,
        address indexed loser,
        uint256 amount,
        bool isToken
    );
    event ApprovalRequirementUpdated(bool requireApproval);
    event TokensWithdrawn(address indexed recipient, uint256 amount);
    event EthWithdrawn(address indexed recipient, uint256 amount);

    modifier onlyOwner() {
        if (msg.sender != owner) revert SenderNotAllowed();
        _;
    }

    modifier onlyFactory() {
        if (msg.sender != factory) revert SenderNotAllowed();
        _;
    }

    function initialize(address owner_, address tokenAddress_) external {
        if (initialized) revert AlreadyInitialized();
        if (owner_ == address(0)) {
            revert ZeroAddress();
        }
        // can be null address, in which case ERC-20 not supported
        if (tokenAddress_ == address(0)) {
            tokenSet = false;
        } else {
            tokenSet = true;
        }
        token = IERC20(tokenAddress_);
        owner = owner_;
        factory = msg.sender;
        initialized = true;
        totalReservedEth = 0;
        totalReservedToken = 0;
        nextNonce = 0;
        firstGameId = 0;
        lastGameId = 0;
    }

    receive() external payable {}

    // ─────────────────────────────────────────────────────────────────────────────
    // Reservation lifecycle
    // ─────────────────────────────────────────────────────────────────────────────

    function reserve(
        ReserveRequest calldata request,
        uint64 expiration,
        bytes calldata walletApproval
    ) external onlyFactory {
        if (requireApproval) {
            // only check walletApproval if it is required
            _verifyReserveApprovalSignature(request, walletApproval);
        }
        _reserve(request, expiration);
    }

    function settleForWinner(SettlementRequest calldata request) external onlyFactory {
        if (request.factory != factory) revert InvalidFactory();
        Reservation storage res = reservations[request.gameId];
        if (!res.exists || !res.active) revert GameNotFound();
        if (res.isToken) {
            if (res.amount > totalReservedToken) revert InsufficientReserved();
            totalReservedToken -= res.amount;
        } else {
            if (res.amount > totalReservedEth) revert InsufficientReserved();
            totalReservedEth -= res.amount;
        }
        emit ReservationSettled(request.gameId, request.winner, request.loser, res.amount, res.isToken);
        res.active = false;
    }

    function settleForLoser(SettlementRequest calldata request) external onlyFactory {
        if (request.factory != factory) revert InvalidFactory();
        Reservation storage res = reservations[request.gameId];
        if (!res.exists || !res.active) revert GameNotFound();
        if (!(block.timestamp < res.expiration)) revert ReservationExpired();

        emit ReservationSettled(request.gameId, request.winner, request.loser, res.amount, res.isToken);
        res.active = false;
        if (res.opponent != request.winner) revert AddressMismatch();
        if (res.isToken) {
            uint256 tokenBalance = token.balanceOf(address(this));
            if (res.amount > totalReservedToken) revert InsufficientReserved();
            if (res.amount > tokenBalance) revert InsufficientFunds();
            totalReservedToken -= res.amount;
            _distributeTokenWinnings(request.winner, res.feeWallet, res.amount, res.feeBasisPoints);
        } else {
            if (res.amount > totalReservedEth) revert InsufficientReserved();
            totalReservedEth -= res.amount;
            _distributeEthWinnings(request.winner, res.feeWallet, res.amount, res.feeBasisPoints);
        }
    }

    function releaseExpired() external {
        if (msg.sender != factory && msg.sender != owner) revert SenderNotAllowed();
        _releaseExpiredInternal();
    }

    function releaseExpiredFullTraverse() external {
        if (msg.sender != factory && msg.sender != owner) revert SenderNotAllowed();
        _releaseExpiredInternalFullTraverse();
    }

    function cancel(uint64 gameId) external onlyFactory {
        Reservation storage res = reservations[gameId];
        if (!res.exists || !res.active) revert GameNotFound();
        if (res.isToken) {
            if (res.amount > totalReservedToken) revert InsufficientReserved();
            totalReservedToken -= res.amount;
        } else {
            if (res.amount > totalReservedEth) revert InsufficientReserved();
            totalReservedEth -= res.amount;
        }
        res.active = false;
        emit ReservationCancelled(gameId);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Funds management
    // ─────────────────────────────────────────────────────────────────────────────

    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        // always clear out expired items before determining if user can 
        // withdraw the amount
        _releaseExpiredInternal();
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < totalReservedEth) revert InsufficientFunds();
        uint256 available = address(this).balance - totalReservedEth;
        if (amount > available) revert InsufficientFunds();
        emit EthWithdrawn(owner, amount);
        Address.sendValue(payable(owner), amount);
    }

    function withdrawToken(uint256 amount) external onlyOwner nonReentrant {
        if (!tokenSet) revert NoTokenWallet();
        _releaseExpiredInternal();
        if (amount == 0) revert InvalidAmount();
        uint256 tokenBalance = token.balanceOf(address(this));
        if (tokenBalance < totalReservedToken) revert InsufficientFunds();
        uint256 available = tokenBalance - totalReservedToken;
        if (amount > available) revert InsufficientFunds();
        emit TokensWithdrawn(owner, amount);
        token.safeTransfer(owner, amount);
    }

    function setApprovalRequired(bool value) external onlyOwner {
        requireApproval = value;
        emit ApprovalRequirementUpdated(value);
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // View helpers (mirrors get-methods on TON contract)
    // ─────────────────────────────────────────────────────────────────────────────

    function getTotalReserved() external view returns (uint256 ethReserved, uint256 tokenReserved) {
        // will include reservations that are expired but not yet removed / cleaned up
        return (totalReservedEth, totalReservedToken);
    }

    function calculateTotalReserved() external view returns (uint256 ethReserved, uint256 tokenReserved) {
        if (firstGameId == 0) {
            return (0, 0);
        }
        ethReserved = totalReservedEth;
        tokenReserved = totalReservedToken;
        uint256 currentTime = block.timestamp;
        uint64 currGameId = firstGameId;
        while (currGameId != 0) {
            Reservation storage res = reservations[currGameId];
            if (currentTime < res.expiration) {
                // in order of expiration, and not expired, so break now,
                // no need to inspect the rest
                break;
            }
            if (res.active) {
                if (res.isToken) {
                    if (res.amount > tokenReserved) revert AmountGreaterThanReserved();
                    tokenReserved -= res.amount;
                } else {
                    if (res.amount > ethReserved) revert AmountGreaterThanReserved();
                    ethReserved -= res.amount;
                }
            }
            currGameId = res.nextGameId;
        }
        return (ethReserved, tokenReserved);
    }

    function getOwnerAndFactory() external view returns (address ownerAddress, address factoryAddress) {
        return (owner, factory);
    }

    function getReservationDetails(uint64 gameId)
        external
        view
        returns (uint256 amount, address opponent, uint64 expire, bool isToken, bool found)
    {
        Reservation storage res = reservations[gameId];
        // if settled or canceled, return zero/false
        if (!res.exists || !res.active) {
            return (0, address(0), 0, false, false);
        }
        // if expired, return zero/false
        if (res.expiration <= block.timestamp) {
            return (0, address(0), 0, false, false);
        }
        return (res.amount, res.opponent, res.expiration, res.isToken, true);
    }

    function getAllGames() external view returns (uint64[] memory activeGameIds) {
        // First count the number of elements, so we can create an array
        uint64 i = 0;
        uint64 currGameId = firstGameId;
        while (currGameId != 0) {
            unchecked {
                ++i;
            }
            Reservation storage res = reservations[currGameId];
            currGameId = res.nextGameId;  // will be zero at tend
        }

        // Allocate the array
        activeGameIds = new uint64[](i);

        // Populate the array
        currGameId = firstGameId;
        i = 0;
        while (currGameId != 0) {
            activeGameIds[i] = currGameId;
            unchecked {
                ++i;
            }
            Reservation storage res = reservations[currGameId];
            currGameId = res.nextGameId;  // will be zero at tend
        }
    }

    function getApprovalRequired() external view returns (bool) {
        return requireApproval;
    }

    function getCurrentNonce() external view returns (uint64) {
        return nextNonce;
    }

    // ─────────────────────────────────────────────────────────────────────────────
    // Internal helpers
    // ─────────────────────────────────────────────────────────────────────────────

    function _identifyOpponent(address player1, address player2) private view returns (address opponent, bool isPlayerOne) {
        if (player1 == address(this)) {
            return (player2, true);
        }
        if (player2 == address(this)) {
            return (player1, false);
        }
        revert AddressMismatch();
    }

    function _reserve(ReserveRequest calldata request, uint64 expiration) internal {
        if (request.amount == 0) revert InvalidAmount();
        if (request.factory != factory) revert InvalidFactory();
        if (request.feeBasisPoints > 2500) revert InvalidFeeBasisPoints();
        if (request.feeBasisPoints > 0 && request.feeWallet == address(0)) revert ZeroAddress();
        if (request.gameId <= 0) revert InvalidGameId();

        (address opponent, bool isPlayerOne) = _identifyOpponent(request.player1, request.player2);
        uint64 providedNonce = isPlayerOne ? request.noncePlayer1 : request.noncePlayer2;
        if (providedNonce != nextNonce) revert InvalidNonce();

        // not a critical function, since the nonce protects against replay,
        // but prevents non-settleable reservations from being inserted
        if (!(expiration > block.timestamp)) revert ExpiredInPast();

        _releaseExpiredInternal();
        if (reservations[request.gameId].exists) revert GameExists();

        if (request.isToken) {
            if (!tokenSet) revert NoTokenWallet();
            uint256 tokenBalance = token.balanceOf(address(this));
            if (tokenBalance < totalReservedToken) revert InsufficientFunds();
            uint256 available = tokenBalance - totalReservedToken;
            if (request.amount > available) revert InsufficientFunds();
            totalReservedToken += request.amount;
        } else {
            uint256 availableEth = address(this).balance - totalReservedEth;
            if (request.amount > availableEth) revert InsufficientFunds();
            totalReservedEth += request.amount;
        }

        reservations[request.gameId] = Reservation({
            amount: request.amount,
            opponent: opponent,
            isToken: request.isToken,
            feeWallet: request.feeWallet,
            feeBasisPoints: request.feeBasisPoints,
            exists: true,
            active: true,
            expiration: expiration,
            // will be last one in the chain
            nextGameId: 0
        });
        unchecked {
            ++nextNonce;
        }
        if (firstGameId == 0) {
            // no active games
            firstGameId = request.gameId;
            lastGameId = request.gameId;
        } else {
            // append to the end and update last game pointer
            Reservation storage lastRes = reservations[lastGameId];
            lastRes.nextGameId = request.gameId;
            lastGameId = request.gameId;
        }
        emit Reserved(request.gameId, opponent, request.amount, request.isToken);
    }

    function _releaseExpiredInternal() private {
        uint64 currGameId = firstGameId;
        if (currGameId == 0) {
            return;
        }

        uint256 currentTime = block.timestamp;
        uint256 totalEth = totalReservedEth;
        uint256 totalToken = totalReservedToken;

        uint64 nextGameId;
        while (currGameId != 0) {
            Reservation storage res = reservations[currGameId];
            if (currentTime < res.expiration) {
                break;
            }

            if (res.active) {
                if (res.isToken) {
                    if (res.amount > totalToken) revert AmountGreaterThanReserved();
                    totalToken -= res.amount;
                } else {
                    if (res.amount > totalEth) revert AmountGreaterThanReserved();
                    totalEth -= res.amount;
                }
            }

            nextGameId = res.nextGameId;
            if (nextGameId == 0) {
                lastGameId = 0;
            }

            delete reservations[currGameId];
            currGameId = nextGameId;
        }

        // handle state updates in one pass rather than 
        // performing within the loop (efficiency)
        if (firstGameId != currGameId) {
            firstGameId = currGameId;
        }
        if (totalReservedEth != totalEth) {
            totalReservedEth = totalEth;
        }
        if (totalReservedToken != totalToken) {
            totalReservedToken = totalToken;
        }
    }

    function _releaseExpiredInternalFullTraverse() private {
        uint64 currGameId = firstGameId;
        if (currGameId == 0) {
            return;
        }

        uint256 currentTime = block.timestamp;
        uint256 totalEth = totalReservedEth;
        uint256 totalToken = totalReservedToken;

        uint64 prevGameId = 0;

        while (currGameId != 0) {
            Reservation storage res = reservations[currGameId];
            uint64 nextGameId = res.nextGameId;

            if (currentTime >= res.expiration) {
                if (res.active) {
                    if (res.isToken) {
                        if (res.amount > totalToken) revert AmountGreaterThanReserved();
                        totalToken -= res.amount;
                    } else {
                        if (res.amount > totalEth) revert AmountGreaterThanReserved();
                        totalEth -= res.amount;
                    }
                }

                if (prevGameId == 0) {
                    firstGameId = nextGameId;
                } else {
                    reservations[prevGameId].nextGameId = nextGameId;
                }

                if (nextGameId == 0) {
                    lastGameId = prevGameId;
                }

                delete reservations[currGameId];
            } else {
                prevGameId = currGameId;
                if (nextGameId == 0) {
                    lastGameId = currGameId;
                }
            }

            currGameId = nextGameId;
        }

        if (firstGameId == 0) {
            lastGameId = 0;
        }
        if (totalReservedEth != totalEth) {
            totalReservedEth = totalEth;
        }
        if (totalReservedToken != totalToken) {
            totalReservedToken = totalToken;
        }
    }

    function _verifyReserveApprovalSignature(ReserveRequest calldata request, bytes calldata signature) private view {
        bytes32 structHash = keccak256(
            abi.encode(
                RESERVE_TYPEHASH,
                request.gameId,
                request.amount,
                request.player1,
                request.player2,
                request.isToken,
                request.noncePlayer1,
                request.noncePlayer2,
                request.feeWallet,
                request.feeBasisPoints,
                request.factory
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        if (ECDSA.recover(digest, signature) != owner) {
            revert BadSignature();
        }
    }

    function _distributeEthWinnings(
        address winner,
        address feeWallet,
        uint256 amount,
        uint16 feeBasisPoints
    ) private {
        uint256 fee = (amount * feeBasisPoints) / 10_000;
        uint256 payout;
        payout = amount - fee;
        Address.sendValue(payable(winner), payout);
        if (fee > 0) {
            Address.sendValue(payable(feeWallet), fee);
        }
    }

    function _distributeTokenWinnings(
        address winner,
        address feeWallet,
        uint256 amount,
        uint16 feeBasisPoints
    ) private {
        uint256 fee = (amount * feeBasisPoints) / 10_000;
        uint256 payout;
        payout = amount - fee;

        token.safeTransfer(winner, payout);
        if (fee > 0) {
            token.safeTransfer(feeWallet, fee);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal IERC20 + SafeERC20 implementations (MIT licensed)
// ─────────────────────────────────────────────────────────────────────────────

interface IERC20 {
    function transfer(address to, uint256 value) external returns (bool);

    function transferFrom(address from, address to, uint256 value) external returns (bool);

    function balanceOf(address account) external view returns (uint256);
}

library SafeERC20 {
    function safeTransfer(IERC20 token, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transfer.selector, to, value));
    }

    function safeTransferFrom(IERC20 token, address from, address to, uint256 value) internal {
        _callOptionalReturn(token, abi.encodeWithSelector(token.transferFrom.selector, from, to, value));
    }

    function _callOptionalReturn(IERC20 token, bytes memory data) private {
        (bool success, bytes memory returndata) = address(token).call(data);
        require(success, "SafeERC20: call failed");
        if (returndata.length > 0) {
            require(abi.decode(returndata, (bool)), "SafeERC20: operation did not succeed");
        }
    }
}
