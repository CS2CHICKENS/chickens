import {
  encodeFunctionData,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
} from "viem";
import { config } from "../packages/core/src/index";
import {
  buyAbi,
  burnAbi,
  quoterAbi,
  minimumOutput,
  v4CookData,
  cookChunk,
} from "../packages/core/src/cook";
import {
  launchInfo,
  readTokenTrades,
  tokenAbi,
} from "../packages/core/src/chain";
import { decodeEventLog } from "viem";
import type { OperatorTransactions } from "./operator-transactions";
export async function nextCook(service: OperatorTransactions) {
  const prepared = service.prepared!;
  const manifest = prepared.manifest,
    feed = config.wallets.feed as Address;
  for (const [tokenId, budget] of Object.entries(manifest.cook).sort(
    ([a], [b]) => a.localeCompare(b),
  )) {
    const token = prepared.tokens.find((t) => t.id === tokenId);
    if (!token) throw Error("Cook token is not registered");
    let firstTs = 0;
    for (let index = 0; index < config.cook.chunks; index++) {
      let remaining = cookChunk(BigInt(budget), index, config.cook.chunks);
      for (let attempt = 0; remaining > 0n; attempt++) {
        if (attempt > 32)
          throw Error(
            "Repeated partial fills exceeded the work budget; reconciliation required",
          );
        const value = remaining;
        const id =
          "round-" +
          manifest.round +
          "-cook-" +
          tokenId +
          "-" +
          index +
          "-" +
          attempt;
        const buyId = id + "-buy",
          burnId = id + "-burn";
        const buy = await service.read(buyId),
          burn = await service.read(burnId);
        for (const saved of [buy, burn])
          if (saved && saved.proposal.proof !== prepared.proof)
            throw Error("Cook journal belongs to another plan");
        if (!buy?.tx) {
          const now = Number((await service.rpc.getBlock()).timestamp);
          const waitUntil =
            firstTs +
            Math.round(
              (index * config.cook.spreadMinutes * 60) /
                Math.max(1, config.cook.chunks - 1),
            );
          if (firstTs && now < waitUntil)
            return { waitUntil, label: "Waiting for the next scheduled cook" };
          const info = await launchInfo(service.rpc, token.address);
          let to: Address, data: `0x${string}`;
          if (info.phase === 0) {
            to = info.curve;
            const quote = await service.rpc.simulateContract({
              address: to,
              abi: buyAbi,
              functionName: "buy",
              args: [value, 0n, feed],
              account: feed,
              value,
            });
            data = encodeFunctionData({
              abi: buyAbi,
              functionName: "buy",
              args: [
                value,
                minimumOutput(quote.result, config.cook.maxSlippageBps),
                feed,
              ],
            });
          } else if (info.phase === 2) {
            const quoter = config.protocol.v4Quoter as Address;
            to = config.protocol.universalRouter as Address;
            for (const [address, codeHash] of [
              [to, config.protocol.routerCodeHash],
              [quoter, config.protocol.quoterCodeHash],
            ] as const) {
              const code = await service.rpc.getCode({ address });
              if (!code || keccak256(code) !== codeHash)
                throw Error("Swap dependency bytecode changed");
            }
            const poolKey = {
              currency0: zeroAddress,
              currency1: token.address,
              fee: info.poolFee,
              tickSpacing: info.tickSpacing,
              hooks: config.protocol.hook as Address,
            };
            const quote = await service.rpc.simulateContract({
              address: quoter,
              abi: quoterAbi,
              functionName: "quoteExactInputSingle",
              args: [
                {
                  poolKey,
                  zeroForOne: true,
                  exactAmount: value,
                  hookData: "0x",
                },
              ],
            });
            data = v4CookData(
              poolKey,
              value,
              minimumOutput(quote.result[0], config.cook.maxSlippageBps),
              feed,
              BigInt(now + 180),
            );
          } else
            throw Error(
              "Pool graduation is incomplete; retry the cook once the protocol finishes seeding",
            );
          return service.proposal({
            id: buyId,
            label:
              "Buy " +
              tokenId.toUpperCase() +
              " for cook " +
              (index + 1) +
              "/" +
              config.cook.chunks,
            from: feed,
            to,
            data,
            value,
            proof: prepared.proof,
          });
        }
        await service.confirm(buyId, buy.tx);
        const receipt = await service.rpc.getTransactionReceipt({
          hash: buy.tx,
        });
        const timestamp = Number(
          (await service.rpc.getBlock({ blockNumber: receipt.blockNumber }))
            .timestamp,
        );
        firstTs ||= timestamp;
        const swaps = (
          await readTokenTrades(
            service.rpc,
            [token],
            receipt.blockNumber,
            receipt.blockNumber,
          )
        ).filter(
          (s) =>
            s.tx.toLowerCase() === buy.tx!.toLowerCase() &&
            s.side === "buy" &&
            s.kind !== "fee-credit" &&
            s.wallet.toLowerCase() === feed.toLowerCase() &&
            s.feeVerified,
        );
        const spent = swaps.reduce((sum, s) => sum + s.volume, 0n);
        let received = 0n;
        for (const log of receipt.logs)
          if (log.address.toLowerCase() === token.address.toLowerCase()) {
            try {
              const event = decodeEventLog({
                abi: tokenAbi,
                eventName: "Transfer",
                data: log.data,
                topics: log.topics,
              });
              if (event.args.to.toLowerCase() === feed.toLowerCase())
                received += event.args.value;
              if (event.args.from.toLowerCase() === feed.toLowerCase())
                received -= event.args.value;
            } catch {}
          }
        if (!swaps.length || spent <= 0n || spent > value || received <= 0n)
          throw Error("Purchase cannot be independently reconciled");
        if (!burn?.tx)
          return service.proposal({
            id: burnId,
            label:
              "Burn purchased " +
              tokenId.toUpperCase() +
              " from cook " +
              (index + 1),
            from: feed,
            to: token.address,
            data: encodeFunctionData({
              abi: burnAbi,
              functionName: "transfer",
              args: [config.wallets.burn as Address, received],
            }),
            value: 0n,
            proof: prepared.proof,
          });
        await service.confirm(burnId, burn.tx);
        await service.reportCook(
          burnId,
          manifest.round,
          tokenId,
          buy.tx,
          burn.tx,
        );
        remaining -= spent;
      }
    }
  }
  return null;
}
export const sweepAbi = parseAbi([
  "function quoteFeeBalance() view returns (uint256)",
  "function creatorTaxBalance() view returns (uint256)",
  "function sweepFees(uint256 minimum)",
  "function pendingFees(bytes32,address) view returns (uint256)",
  "function pendingCreatorTax(bytes32,address) view returns (uint256)",
  "function sweepPoolFees(bytes32,uint256,uint256)",
]);
