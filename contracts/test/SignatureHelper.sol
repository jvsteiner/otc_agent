// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import "forge-std/Test.sol";

/**
 * @title SignatureHelper
 * @notice Helper contract for generating operator signatures in tests
 */
contract SignatureHelper is Test {
    /**
     * @notice Generate operator signature for swapNative
     * @param operatorPrivateKey Private key of operator
     * @param brokerAddress Address of the broker contract
     * @param dealId Deal identifier
     * @param payback Payback address
     * @param recipient Recipient address
     * @param feeRecipient Fee recipient address
     * @param amount Swap amount
     * @param fees Fee amount
     * @param caller Address that will call the function (escrow EOA)
     * @return signature ECDSA signature bytes
     */
    function signSwapNative(
        uint256 operatorPrivateKey,
        address brokerAddress,
        bytes32 dealId,
        address payback,
        address recipient,
        address feeRecipient,
        uint256 amount,
        uint256 fees,
        address caller
    ) public pure returns (bytes memory) {
        // Convert to Ethereum signed message hash (adds "\x19Ethereum Signed Message:\n32" prefix)
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(
                    abi.encodePacked(
                        brokerAddress,
                        dealId,
                        payback,
                        recipient,
                        feeRecipient,
                        amount,
                        fees,
                        caller
                    )
                )
            )
        );

        // Sign the Ethereum signed message hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPrivateKey, ethSignedMessageHash);

        // Return signature bytes
        return abi.encodePacked(r, s, v);
    }

    /**
     * @notice Generate operator signature for revertNative
     * @param operatorPrivateKey Private key of operator
     * @param brokerAddress Address of the broker contract
     * @param dealId Deal identifier
     * @param payback Payback address
     * @param feeRecipient Fee recipient address
     * @param fees Fee amount
     * @param caller Address that will call the function (escrow EOA)
     * @return signature ECDSA signature bytes
     */
    function signRevertNative(
        uint256 operatorPrivateKey,
        address brokerAddress,
        bytes32 dealId,
        address payback,
        address feeRecipient,
        uint256 fees,
        address caller
    ) public pure returns (bytes memory) {
        // Convert to Ethereum signed message hash (adds "\x19Ethereum Signed Message:\n32" prefix)
        // For revert: recipient = address(0), amount = 0
        bytes32 ethSignedMessageHash = keccak256(
            abi.encodePacked(
                "\x19Ethereum Signed Message:\n32",
                keccak256(
                    abi.encodePacked(
                        brokerAddress,
                        dealId,
                        payback,
                        address(0),     // recipient is address(0) for revert
                        feeRecipient,
                        uint256(0),     // amount is 0 for revert
                        fees,
                        caller
                    )
                )
            )
        );

        // Sign the Ethereum signed message hash
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(operatorPrivateKey, ethSignedMessageHash);

        // Return signature bytes
        return abi.encodePacked(r, s, v);
    }
}
