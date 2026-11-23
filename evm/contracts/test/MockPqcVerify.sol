// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.24;

/// Local-test stand-in for QoreChain's pqcVerify precompile (0x0A01), which Hardhat
/// doesn't have. The test suite verifies each real ML-DSA-87 signature off-chain with
/// the noble post-quantum library and registers only the ones that pass. The real check runs on
/// testnet (see evm/scripts/pqc-probe.mts and docs/TESTNET_LOG.md).
contract MockPqcVerify {
    mapping(bytes32 => bool) public valid;

    function allow(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external {
        valid[keccak256(abi.encode(pubkey, sig, message))] = true;
    }

    function pqcVerify(bytes calldata pubkey, bytes calldata sig, bytes calldata message) external view returns (bool) {
        return valid[keccak256(abi.encode(pubkey, sig, message))];
    }
}
