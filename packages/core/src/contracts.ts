import { parseAbi } from "viem";
export const splitAbi = parseAbi([
  "constructor(address dev_,address feed_)",
  "function dev() view returns (address)",
  "function feed() view returns (address)",
  "function released(uint256 round) view returns (bool)",
  "function grossFees(uint256 round) view returns (uint256)",
  "function releaseRound(uint256 round) payable",
  "event Released(uint256 devAmount,uint256 feedAmount)",
  "event RoundReleased(uint256 indexed round,uint256 grossAmount)",
]);
export const multisendAbi = parseAbi([
  "constructor(address feed_)",
  "function feed() view returns (address)",
  "function paid(uint256 round,uint256 batchIndex) view returns (bool)",
  "function manifests(uint256 round) view returns (bytes32)",
  "function sendEth(uint256 round,bytes32 manifestHash,uint256 batchIndex,address[] to,uint256[] amounts) payable",
  "event BatchSent(address indexed sender,bytes32 indexed batchHash,uint256 recipients,uint256 amount)",
  "event RoundBatchSent(uint256 indexed round,bytes32 indexed manifestHash,uint256 indexed batchIndex,bytes32 batchHash)",
]);
