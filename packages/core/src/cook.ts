import {
  encodeAbiParameters,
  encodeFunctionData,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
  type Address,
} from "viem";
export const buyAbi = parseAbi([
  "function buy(uint256 quoteIn,uint256 minTokensOut,address recipient) payable returns (uint256 tokensOut)",
]);
export const burnAbi = parseAbi([
  "function transfer(address to,uint256 value) returns (bool)",
]);
export const quoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut,uint256 gasEstimate)",
]);
const routerAbi = parseAbi([
  "function execute(bytes commands,bytes[] inputs,uint256 deadline) payable",
]);
export function minimumOutput(quoted: bigint, slippageBps: number) {
  if (
    quoted <= 0n ||
    !Number.isSafeInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > 200
  )
    throw Error("Invalid quote or slippage bound");
  const minimum = (quoted * BigInt(10000 - slippageBps)) / 10000n;
  if (minimum <= 0n) throw Error("Quote is too small");
  return minimum;
}
export function v4CookData(
  key: {
    currency0: Address;
    currency1: Address;
    fee: number;
    tickSpacing: number;
    hooks: Address;
  },
  amount: bigint,
  minimum: bigint,
  recipient: Address,
  deadline: bigint,
) {
  if (
    key.currency0 !== zeroAddress ||
    amount <= 0n ||
    amount >= 1n << 128n ||
    minimum <= 0n ||
    minimum >= 1n << 128n
  )
    throw Error("Unsupported native swap");
  const swap = encodeAbiParameters(
    parseAbiParameters(
      "((address,address,uint24,int24,address),bool,uint128,uint128,uint256,bytes)",
    ),
    [
      [
        [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
        true,
        amount,
        minimum,
        0n,
        "0x",
      ],
    ],
  );
  const settle = encodeAbiParameters(parseAbiParameters("address,uint256"), [
    zeroAddress,
    amount,
  ]);
  const take = encodeAbiParameters(parseAbiParameters("address,uint256"), [
    key.currency1,
    minimum,
  ]);
  const actions = encodeAbiParameters(parseAbiParameters("bytes,bytes[]"), [
    "0x060c0f",
    [swap, settle, take],
  ]);
  const refund = encodeAbiParameters(
    parseAbiParameters("address,address,uint256"),
    [zeroAddress, recipient, 0n],
  );
  return encodeFunctionData({
    abi: routerAbi,
    functionName: "execute",
    args: ["0x1004", [actions, refund], deadline],
  });
}
export function cookChunk(total: bigint, index: number, count: number) {
  if (
    total < 0n ||
    !Number.isSafeInteger(index) ||
    index < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    index >= count
  )
    throw Error("Invalid cook chunk");
  return (
    total / BigInt(count) + (index === count - 1 ? total % BigInt(count) : 0n)
  );
}
