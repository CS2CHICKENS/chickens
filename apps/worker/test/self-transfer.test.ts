import test from "node:test";
import assert from "node:assert/strict";
import { type Address } from "viem";
import { WAD, streak, twab, config } from "../../../packages/core/src/index";
import { initialTokens, readChunk, type Rpc } from "../src/indexer";
import { mockRpc, hash } from "./fixture";

test("self-transfers preserve CHICK seniority while genuine same-block out-and-back transfers reset it", async () => {
  const { rpc: original } = mockRpc();
  const tokens = await initialTokens(original);
  const self = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
  const genuine = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as Address;
  const other = "0xcccccccccccccccccccccccccccccccccccccccc" as Address;
  const zero = "0x0000000000000000000000000000000000000000" as Address;
  const opening = config.tokenLaunchBlocks.chick;
  const events = [
    { from: zero, to: self, block: opening, log: 0 },
    { from: zero, to: genuine, block: opening, log: 1 },
    {
      from: self.toUpperCase().replace("0X", "0x") as Address,
      to: self,
      block: opening + 10,
      log: 0,
    },
    { from: genuine, to: other, block: opening + 20, log: 0 },
    { from: other, to: genuine, block: opening + 20, log: 1 },
  ];
  const rpc = new Proxy(original, {
    get(target, key) {
      if (key === "getBlock")
        return async ({ blockNumber }: { blockNumber: bigint }) => ({
          ...(await target.getBlock({ blockNumber })),
          timestamp: blockNumber,
        });
      if (key === "getContractEvents")
        return async (options: {
          address: string;
          eventName?: string;
          fromBlock: bigint;
          toBlock: bigint;
        }) => {
          if (
            options.eventName === "Transfer" &&
            options.address.toLowerCase() ===
              config.tokens
                .find((token) => token.id === "chick")!
                .address.toLowerCase()
          )
            return events
              .filter(
                (event) =>
                  BigInt(event.block) >= options.fromBlock &&
                  BigInt(event.block) <= options.toBlock,
              )
              .map((event) => ({
                args: { from: event.from, to: event.to, value: 100n * WAD },
                blockNumber: BigInt(event.block),
                logIndex: event.log,
                transactionHash: hash(event.block),
              }));
          return (
            target.getContractEvents as (options: unknown) => Promise<unknown>
          )(options);
        };
      return Reflect.get(target, key);
    },
  }) as Rpc;
  const from = BigInt(Math.min(...tokens.map((token) => token.launchBlock)));
  const to = BigInt(
    Math.max(opening + 30, config.tokenLaunchBlocks.catalana + 2),
  );
  const chunk = await readChunk(rpc, tokens, from, to);
  const selfEvents = chunk.balances.filter(
    (event) => event.token === "chick" && event.wallet === self,
  );
  const genuineEvents = chunk.balances.filter(
    (event) => event.token === "chick" && event.wallet === genuine,
  );
  assert.equal(selfEvents.length, 1);
  assert.equal(genuineEvents.length, 3);
  assert.equal(twab(selfEvents, opening + 1, opening + 30), 100n * WAD);
  assert.equal(twab(genuineEvents, opening + 1, opening + 30), 100n * WAD);
  assert.equal(
    streak(selfEvents, opening + 1, opening + 30, 2, opening + 1),
    3,
  );
  assert.equal(
    streak(genuineEvents, opening + 1, opening + 30, 2, opening + 1),
    0,
  );
  assert.equal(
    chunk.swaps
      .filter((swap) => swap.token === "catalana")
      .reduce((sum, swap) => sum + swap.volume, 0n),
    WAD,
  );
});
