// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "../UnicitySwapEscrow.sol";

/**
 * @title ReentrancyAttacker
 * @notice Malicious contract attempting reentrancy attack
 * @dev Used for security testing to verify reentrancy protection
 */
contract ReentrancyAttacker {
    UnicitySwapEscrow public escrow;
    uint256 public attackCount;
    uint256 public maxAttacks;
    bool public attacking;

    constructor(address _escrow, uint256 _maxAttacks) {
        escrow = UnicitySwapEscrow(payable(_escrow));
        maxAttacks = _maxAttacks;
    }

    /**
     * @notice Update escrow address (for testing circular dependencies)
     */
    function setEscrow(address _escrow) external {
        escrow = UnicitySwapEscrow(payable(_escrow));
    }

    /**
     * @notice Attempt to reenter swap() during callback
     */
    function attack() external {
        attacking = true;
        attackCount = 0;
        escrow.swap();
    }

    /**
     * @notice Attempt to reenter refund() during callback
     */
    function attackRefund() external {
        attacking = true;
        attackCount = 0;
        escrow.refund();
    }

    /**
     * @notice Receive callback - attempt reentrancy
     */
    receive() external payable {
        if (attacking && attackCount < maxAttacks) {
            attackCount++;
            try escrow.swap() {
                // Should fail due to reentrancy guard
            } catch {
                // Expected to fail
            }
        }
    }

    /**
     * @notice Fallback for reentrancy attempts
     */
    fallback() external payable {
        if (attacking && attackCount < maxAttacks) {
            attackCount++;
            try escrow.refund() {
                // Should fail due to reentrancy guard
            } catch {
                // Expected to fail
            }
        }
    }
}
