// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
contract Split {
    address payable public immutable dev;
    address payable public immutable feed;
    bool private entered;
    mapping(uint256 => bool) public released;
    mapping(uint256 => uint256) public grossFees;
    event Released(uint256 devAmount, uint256 feedAmount);
    event RoundReleased(uint256 indexed round, uint256 grossAmount);
    constructor(address payable dev_, address payable feed_) {
        require(dev_ != address(0) && feed_ != address(0) && dev_ != feed_, "recipients");
        dev = dev_; feed = feed_;
    }
    function releaseRound(uint256 round) external payable {
        require(msg.sender == feed, "feed only");
        require(!entered && round > 0 && !released[round] && msg.value > 0, "allocation");
        entered = true;
        released[round] = true;
        grossFees[round] = msg.value;
        // Only this allocation is split; forced deposits cannot change the pot.
        uint256 total = msg.value;
        uint256 devAmount = total - total / 2;
        (bool a,) = dev.call{value: devAmount}(""); require(a, "dev transfer");
        (bool b,) = feed.call{value: total - devAmount}(""); require(b, "feed transfer");
        entered = false; emit Released(devAmount, total - devAmount);
        emit RoundReleased(round, total);
    }
}
