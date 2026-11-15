// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Test stand-in for HyperEVM's mark price precompile. Like the real one, it is
/// called with a bare abi.encode(uint32 perpIndex) and no function selector.
contract MockPrices {
    mapping(uint32 => uint64) public prices;

    function set(uint32 perp, uint64 px) external {
        prices[perp] = px;
    }

    function setMany(uint32[] calldata perps, uint64[] calldata pxs) external {
        for (uint256 i = 0; i < perps.length; i++) {
            prices[perps[i]] = pxs[i];
        }
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        uint32 perp = abi.decode(data, (uint32));
        return abi.encode(prices[perp]);
    }
}
