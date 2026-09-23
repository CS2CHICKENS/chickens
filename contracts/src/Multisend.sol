// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Multisend {
    address public immutable feed;
    mapping(uint256 => bytes32) public manifests;
    mapping(uint256 => mapping(uint256 => bool)) public paid;
    bool private entered;
    event BatchSent(address indexed sender, bytes32 indexed batchHash, uint256 recipients, uint256 amount);
    event RoundBatchSent(uint256 indexed round, bytes32 indexed manifestHash, uint256 indexed batchIndex, bytes32 batchHash);
    constructor(address feed_) { require(feed_ != address(0), "feed"); feed = feed_; }
    function sendEth(uint256 round, bytes32 manifestHash, uint256 batchIndex, address payable[] calldata to, uint256[] calldata amounts) external payable {
        require(msg.sender == feed, "feed only");
        require(round > 0 && manifestHash != bytes32(0) && !paid[round][batchIndex], "allocation");
        require(manifests[round] == bytes32(0) || manifests[round] == manifestHash, "manifest changed");
        require(!entered, "locked"); entered = true;
        require(to.length > 0 && to.length == amounts.length && to.length <= 200, "length");
        manifests[round] = manifestHash; paid[round][batchIndex] = true;
        uint256 sum;
        for(uint256 i; i < to.length; ++i) { require(to[i] != address(0) && amounts[i] > 0, "recipient"); require(i == 0 || to[i] > to[i - 1], "recipient order"); sum += amounts[i]; }
        require(sum == msg.value, "value");
        for(uint256 i; i < to.length; ++i) { (bool ok,) = to[i].call{value: amounts[i]}(""); require(ok, "transfer"); }
        entered = false; emit BatchSent(msg.sender, keccak256(abi.encode(to, amounts)), to.length, sum);
        emit RoundBatchSent(round, manifestHash, batchIndex, keccak256(abi.encode(to, amounts)));
    }
}
