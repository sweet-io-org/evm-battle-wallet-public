// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Create2} from "@openzeppelin/contracts/utils/Create2.sol";

import {BattleWallet} from "./BattleWallet.sol";
import {BattleWalletProxy} from "./BattleWalletProxy.sol";

/// @title BattleWalletFactory
/// @notice Deploys BattleWallet proxies using ERC-1967 upgradeable proxies and manages shared configuration.
contract BattleWalletFactory is ReentrancyGuard, EIP712 {

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────
    error ZeroAddress();
    error Unauthorized();
    error InvalidWallet();
    error InvalidSignature();
    error InvalidReservationTtl();

    // ─────────────────────────────────────────────────────────────────────────────
    // Events
    // ─────────────────────────────────────────────────────────────────────────────
    event BattleWalletDeployed(address indexed owner, address indexed proxy, address implementation);
    event WalletImplementationUpgraded(address indexed newImplementation);
    event BattleWalletUpgraded(address indexed proxy, address indexed newImplementation);
    event AdminUpdated(address indexed newAdmin);
    event ApproverUpdated(address indexed newApprover);
    event ReservationTtlUpdated(uint64 newTtl);

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────
    address public walletImplementation;
    address public admin;
    address public approver;
    address public immutable token;
    uint64 public reservationTtl;

    bytes32 private constant RESERVE_TYPEHASH = keccak256(
        "RESERVE(uint64 gameId,uint256 amount,address player1,address player2,bool isToken,uint64 noncePlayer1,uint64 noncePlayer2,address feeWallet,uint16 feeBasisPoints,address factory)"
    );
    bytes32 private constant SETTLE_TYPEHASH = keccak256(
        "SETTLE(uint64 gameId,address winner,address loser,address factory)"
    );
    bytes32 private constant CANCEL_TYPEHASH = keccak256("CANCEL(uint64 gameId,address factory)");
    bytes32 private constant RELEASE_EXPIRED_TYPEHASH = keccak256("RELEASE_EXPIRED(address wallet,address factory)");

    // ─────────────────────────────────────────────────────────────────────────────
    // Modifiers
    // ─────────────────────────────────────────────────────────────────────────────
    modifier onlyApprover() {
        if (msg.sender != approver) revert Unauthorized();
        _;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert Unauthorized();
        _;
    }

    constructor(
        address implementation_,
        address admin_,
        address approver_,
        address token_
    ) EIP712("BattleWalletFactory", "1") {
        // token_ can be zero address, in which case ERC-20 not supported
        if (implementation_ == address(0) || admin_ == address(0) || approver_ == address(0)) {
            revert ZeroAddress();
        }
        walletImplementation = implementation_;
        admin = admin_;
        approver = approver_;
        token = token_;
        reservationTtl = 3600;
        emit ReservationTtlUpdated(reservationTtl);
    }

    /// @notice Deploys a new BattleWallet proxy for the provided owner. Note that double
    /// deployments for the same owner will revert.
    /// @param walletOwner The externally owned account that will control the wallet instance.
    /// @return proxy The deployed BattleWallet proxy address.
    function deployBattleWallet(address walletOwner) external returns (address proxy) {
        if (walletOwner == address(0)) revert ZeroAddress();
        // no nonce, we want deployments with the same owner to revert
        bytes32 salt = _deriveSalt(walletOwner);
        proxy = address(new BattleWalletProxy{salt: salt}(walletImplementation, address(this), ""));
        BattleWallet battleWallet = BattleWallet(payable(proxy));
        battleWallet.initialize(walletOwner, token);
        emit BattleWalletDeployed(walletOwner, proxy, walletImplementation);
    }

    /// @notice Predicts the address where a BattleWallet proxy will be deployed for the provided owner.
    /// @param walletOwner The externally owned account that will control the wallet instance.
    /// @return predictedProxy The deterministic address for the proxy deployment.
    function predictBattleWalletAddress(address walletOwner) external view returns (address predictedProxy) {
        if (walletOwner == address(0)) revert ZeroAddress();

        bytes32 salt = _deriveSalt(walletOwner);
        bytes memory creation = abi.encodePacked(
            type(BattleWalletProxy).creationCode,
            abi.encode(walletImplementation, address(this), bytes(""))
        );
        predictedProxy = Create2.computeAddress(salt, keccak256(creation), address(this));
    }

    /// @notice Updates the implementation used for future BattleWallet deployments.
    /// @param newImplementation The address of the new BattleWallet implementation contract.
    function upgradeWalletImplementation(address newImplementation) external onlyAdmin {
        if (newImplementation == address(0)) revert ZeroAddress();
        walletImplementation = newImplementation;
        emit WalletImplementationUpgraded(newImplementation);
    }

    /// @notice Upgrades an existing BattleWallet proxy to a new implementation when authorized by the wallet owner.
    /// @param walletAddress Address of the BattleWallet proxy to upgrade.
    /// @param newImplementation Address of the new BattleWallet implementation contract.
    /// @param data Optional calldata executed on the new implementation after the upgrade.
    /// @param ownerSignature Signature from the BattleWallet owner authorizing the upgrade.
    function upgradeBattleWallet(
        address walletAddress,
        address newImplementation,
        bytes calldata data,
        bytes calldata ownerSignature
    ) external onlyAdmin {
        if (walletAddress == address(0) || newImplementation == address(0)) revert ZeroAddress();

        _validateWallet(walletAddress);
        BattleWalletProxy(payable(walletAddress)).upgradeWallet(newImplementation, data, ownerSignature);
        emit BattleWalletUpgraded(walletAddress, newImplementation);
    }

    /// @notice Updates the aprover address used for newly deployed wallets.
    function setApprover(address newApprover) external onlyAdmin {
        if (newApprover == address(0)) revert ZeroAddress();
        approver = newApprover;
        emit ApproverUpdated(newApprover);
    }

    /// @notice Updates admin account.
    function setAdmin(address newAdmin) external onlyAdmin {
        if (newAdmin == address(0)) revert ZeroAddress();
        admin = newAdmin;
        emit AdminUpdated(newAdmin);
    }

    /// @notice Updates the reservation TTL used for new reservations.
    function setReservationTtl(uint64 newTtl) external onlyAdmin {
        if (newTtl < 30 || newTtl > 864000) revert InvalidReservationTtl();
        reservationTtl = newTtl;
        emit ReservationTtlUpdated(newTtl);
    }

    /// @notice Relays a reserve call to both participating BattleWallet contracts.
    /// @dev Calls revert entirely if any of the underlying wallet calls fail.
    function relayReserve(
        BattleWallet.ReserveRequest calldata reserveRequest,
        bytes calldata reserveSignature,
        // player approval for every wager is optional
        // if player odes not require approval, then '0x' can be supplied
        // and signature will not be checked
        bytes calldata playerOneApproval,
        bytes calldata playerTwoApproval
    ) external {
        _verifyReserveSignature(reserveRequest, reserveSignature);
        if (reserveRequest.factory != address(this)) revert InvalidSignature();
        BattleWallet walletOne = _validateWallet(reserveRequest.player1);
        BattleWallet walletTwo = _validateWallet(reserveRequest.player2);

        // ttl is applied uniformly by the factory. it's more useful that this is
        // sequential, since allows efficient trimming of reservations. and no 
        // exploits are possible by manipulating the timestamp. for this reason we
        // prefer adding uniformly here, rather than having the caller supply an 
        // expiration timestamp and potentially use inconsistent TTLs. Reservation
        // cleanup is more consistent with a consistent TTL.
        uint64 ttl = reservationTtl;
        if (ttl == 0) revert InvalidReservationTtl();
        uint64 expiration = uint64(block.timestamp + ttl);

        walletOne.reserve(reserveRequest, expiration, playerOneApproval);
        walletTwo.reserve(reserveRequest, expiration, playerTwoApproval);
    }

    /// @notice Relays a settle call to both participating BattleWallet contracts.
    /// @dev Calls revert entirely if any of the underlying wallet calls fail.
    function relaySettle(
        BattleWallet.SettlementRequest calldata settlementRequest,
        bytes calldata settlementSignature
    ) external nonReentrant {
        _verifySettlementSignature(settlementRequest, settlementSignature);
        if (settlementRequest.factory != address(this)) revert InvalidSignature();
        BattleWallet winnerWallet = _validateWallet(settlementRequest.winner);
        BattleWallet loserWallet = _validateWallet(settlementRequest.loser);

        loserWallet.settleForLoser(settlementRequest);
        winnerWallet.settleForWinner(settlementRequest);
    }

    /// @notice Relays a cancel call to both participating BattleWallet contracts.
    /// @dev Cancels the reservation on each wallet after verifying the shared signature.
    function relayCancel(
        address walletOne,
        address walletTwo,
        uint64 gameId,
        bytes calldata cancelSignature
    ) external {
        _verifyCancelSignature(gameId, cancelSignature);
        BattleWallet firstWallet = _validateWallet(walletOne);
        BattleWallet secondWallet = _validateWallet(walletTwo);

        firstWallet.cancel(gameId);
        secondWallet.cancel(gameId);
    }

    /// @notice Relays a releaseExpired call to a BattleWallet contract.
    /// @dev Any caller may trigger cleanup as it only affects the wallet's internal accounting.
    function relayReleaseExpired(address walletAddress, bytes calldata releaseSignature) external {
        _verifyReleaseSignature(walletAddress, releaseSignature);
        BattleWallet battleWallet = _validateWallet(walletAddress);
        battleWallet.releaseExpired();
    }

    /// @dev Generates the deterministic salt used for deployments.
    function _deriveSalt(address walletOwner) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(walletOwner));
    }

    function _verifyReserveSignature(BattleWallet.ReserveRequest calldata request, bytes calldata signature) private view {
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
        address signer = ECDSA.recover(digest, signature);
        if (signer != approver) revert InvalidSignature();
    }

    function _verifySettlementSignature(
        BattleWallet.SettlementRequest calldata request,
        bytes calldata signature
    ) private view {
        bytes32 structHash = keccak256(
            abi.encode(
                SETTLE_TYPEHASH,
                request.gameId,
                request.winner,
                request.loser,
                request.factory
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != approver) revert InvalidSignature();
    }

    function _verifyCancelSignature(uint64 gameId, bytes calldata signature) private view {
        bytes32 structHash = keccak256(abi.encode(CANCEL_TYPEHASH, gameId, address(this)));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != approver) revert InvalidSignature();
    }

    function _verifyReleaseSignature(address walletAddress, bytes calldata signature) private view {
        bytes32 structHash = keccak256(abi.encode(RELEASE_EXPIRED_TYPEHASH, walletAddress, address(this)));
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        if (signer != approver) revert InvalidSignature();
    }

    function _validateWallet(address wallet) private view returns (BattleWallet battleWallet) {
        if (wallet == address(0)) revert ZeroAddress();

        battleWallet = BattleWallet(payable(wallet));
        (bool success, bytes memory data) = wallet.staticcall(abi.encodeWithSignature("factory()"));
        if (!success || data.length != 32) {
            revert InvalidWallet();
        }
        address walletFactory = abi.decode(data, (address));
        if (walletFactory != address(this)) {
            revert InvalidWallet();
        }
    }
}
