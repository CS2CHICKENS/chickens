// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import "../src/Split.sol";
import "../src/Multisend.sol";
interface Vm { function deal(address,uint256) external; function expectRevert() external; }
contract Reject { receive() external payable { revert(); } }
contract ContractsTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    bytes32 constant manifest = keccak256("manifest");
    receive() external payable {}
    function testSplitConservesOddWeiAndNeverRepeats() public {
        address payable dev = payable(address(0x1111));
        Split s = new Split(dev, payable(address(this))); vm.deal(address(this), 1000);
        vm.deal(address(s), 7);
        s.releaseRound{value:101}(1);
        require(dev.balance == 51 && address(this).balance == 949 && address(s).balance == 7, "split");
        require(s.released(1), "record");
        vm.expectRevert(); s.releaseRound{value:101}(1);
        s.releaseRound{value:100}(2); require(dev.balance == 101, "next round");
    }
    function testSplitRevertsAtomically() public {
        Split s = new Split(payable(address(new Reject())), payable(address(this))); vm.deal(address(this), 100);
        vm.expectRevert(); s.releaseRound{value:100}(1);
        require(!s.released(1) && address(this).balance == 100, "atomic");
    }
    function testOnlyFeedCanAllocate() public {
        Split s = new Split(payable(address(1)), payable(address(2)));
        Multisend m = new Multisend(address(2)); vm.deal(address(this),100);
        vm.expectRevert(); s.releaseRound{value:100}(1);
        (address payable[] memory to, uint256[] memory amounts) = recipients();
        vm.expectRevert(); m.sendEth{value:50}(1,manifest,0,to,amounts);
    }
    function recipients() private pure returns (address payable[] memory to, uint256[] memory amounts) {
        to = new address payable[](2); to[0] = payable(address(0x4444)); to[1] = payable(address(0x5555));
        amounts = new uint256[](2); amounts[0] = 20; amounts[1] = 30;
    }
    function testMultisendMismatchDuplicateAndChangedManifest() public {
        Multisend m = new Multisend(address(this)); vm.deal(address(this),1000);
        (address payable[] memory to, uint256[] memory amounts) = recipients();
        vm.expectRevert(); m.sendEth{value:51}(1,manifest,0,to,amounts);
        require(!m.paid(1,0), "reverted record");
        m.sendEth{value:50}(1,manifest,0,to,amounts);
        require(to[0].balance == 20 && to[1].balance == 30, "batch");
        vm.expectRevert(); m.sendEth{value:50}(1,manifest,0,to,amounts);
        vm.expectRevert(); m.sendEth{value:50}(1,keccak256("changed"),1,to,amounts);
        m.sendEth{value:50}(2,manifest,0,to,amounts);
        require(to[0].balance == 40 && to[1].balance == 60, "next round");
    }
    function testMultisendRevertsAllRecipients() public {
        Multisend m = new Multisend(address(this)); vm.deal(address(this),100);
        address payable[] memory to = new address payable[](2); to[0] = payable(address(1)); to[1] = payable(address(new Reject()));
        uint256[] memory amounts = new uint256[](2); amounts[0] = 10; amounts[1] = 10;
        vm.expectRevert(); m.sendEth{value:20}(1,manifest,0,to,amounts);
        require(to[0].balance == 0 && !m.paid(1,0), "atomic");
    }
    function testMultisendRejectsRepeatedRecipient() public {
        Multisend m = new Multisend(address(this)); vm.deal(address(this),100);
        (address payable[] memory to, uint256[] memory amounts) = recipients(); to[1] = to[0];
        vm.expectRevert(); m.sendEth{value:50}(1,manifest,0,to,amounts);
    }
    function testFuzzSplitConservation(uint96 amount) public {
        if (amount == 0) return;
        address payable dev = payable(address(0x1234)); Split s = new Split(dev, payable(address(this)));
        vm.deal(address(this), amount); s.releaseRound{value:amount}(1);
        require(dev.balance + address(this).balance == amount && address(this).balance == amount / 2, "conservation");
    }
}
