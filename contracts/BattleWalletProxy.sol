// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";
import {StorageSlot} from "@openzeppelin/contracts/utils/StorageSlot.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

interface IBattleWalletMinimal {
    function owner() external view returns (address);

    function factory() external view returns (address);
}

/// @title BattleWalletProxy
/// @notice Upgradeable proxy for BattleWallet implementations gated by wallet owner signatures.
contract BattleWalletProxy is ERC1967Proxy, EIP712 {

    // ─────────────────────────────────────────────────────────────────────────────
    // Errors
    // ─────────────────────────────────────────────────────────────────────────────
    error UnauthorizedCaller();
    error InvalidSignature();
    error ZeroAddress();

    // ─────────────────────────────────────────────────────────────────────────────
    // Storage
    // ─────────────────────────────────────────────────────────────────────────────
    // keccak256("battlewallet.proxy.upgradeNonce") - 1
    bytes32 private constant _UPGRADE_NONCE_SLOT =
        0x36883c8fd5870d3a207ecd3373ee4ec258247ce590143f17a3bf6f85d6d0bb9c;

    // ─────────────────────────────────────────────────────────────────────────────
    // Constants
    // ─────────────────────────────────────────────────────────────────────────────
    bytes32 private constant UPGRADE_TYPEHASH =
        keccak256("UPGRADE(address wallet,address newImplementation,bytes32 dataHash,uint256 nonce)");

    constructor(address implementation, address factory_, bytes memory data)
        payable
        ERC1967Proxy(implementation, data)
        EIP712("BattleWalletProxy", "1")
    {
        if (factory_ == address(0)) revert ZeroAddress();
        ERC1967Utils.changeAdmin(factory_);
    }

    /// @notice Returns the current upgrade nonce for signature replay protection.
    function upgradeNonce() external view returns (uint256) {
        return StorageSlot.getUint256Slot(_UPGRADE_NONCE_SLOT).value;
    }

    /// @notice Performs an implementation upgrade when authorized by the factory and wallet owner signature.
    /// @param newImplementation Address of the new BattleWallet implementation.
    /// @param data Optional calldata executed on the new implementation via delegatecall after the upgrade.
    /// @param ownerSignature Signature produced by the BattleWallet owner authorizing the upgrade.
    function upgradeWallet(address newImplementation, bytes calldata data, bytes calldata ownerSignature) external {
        if (msg.sender != _factory()) revert UnauthorizedCaller();
        _authorizeUpgrade(newImplementation, data, ownerSignature);
    }

    receive() external payable {}

    /// @dev Retrieves the factory address from the underlying implementation storage.
    function _factory() private view returns (address) {
        return IBattleWalletMinimal(address(this)).factory();
    }

    /// @dev Validates the owner signature and performs the upgrade.
    function _authorizeUpgrade(address newImplementation, bytes calldata data, bytes calldata ownerSignature) private {
        if (newImplementation == address(0)) revert ZeroAddress();
        if (ownerSignature.length == 0) revert InvalidSignature();

        uint256 currentNonce = StorageSlot.getUint256Slot(_UPGRADE_NONCE_SLOT).value;
        address walletOwner = IBattleWalletMinimal(address(this)).owner();
        if (walletOwner == address(0)) revert InvalidSignature();

        bytes32 structHash = keccak256(
            abi.encode(
                UPGRADE_TYPEHASH,
                address(this),
                newImplementation,
                keccak256(data),
                currentNonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);

        address recovered = ECDSA.recover(digest, ownerSignature);
        if (recovered != walletOwner) revert InvalidSignature();

        StorageSlot.getUint256Slot(_UPGRADE_NONCE_SLOT).value = currentNonce + 1;
        ERC1967Utils.upgradeToAndCall(newImplementation, data);
    }
}
