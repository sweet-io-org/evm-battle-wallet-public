// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BattleWallet} from "../BattleWallet.sol";

/// @notice Test implementation used to validate BattleWallet proxy upgrades.
contract BattleWalletV2 is BattleWallet {
    function version() external pure returns (uint256) {
        return 2;
    }
}
