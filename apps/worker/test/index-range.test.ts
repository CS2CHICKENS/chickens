import test from "node:test";
import assert from "node:assert/strict";
import { config, WAD } from "../../../packages/core/src/index";
import { tick } from "../src/index";
import type { Rpc } from "../src/indexer";
import type { WorkMessage } from "../src/work-queue";
import { meta } from "../src/storage";
import { curve, fixture, hash, holder, mockRpc } from "./fixture";

function queuedFixture() {
  const result = fixture();
  result.env.ENVIRONMENT = "production";
  result.env.WORK = {
    send: async (_message: WorkMessage) => {},
  } as unknown as Queue<WorkMessage>;
  return result;
}

test("production chunks preserve exact replay and events at consecutive boundaries", async () => {
  const small = queuedFixture(),
    single = queuedFixture(),
    start = config.factoryStartBlock,
    end = start + 5999,
    original = mockRpc(end).rpc,
    token = config.tokens.find((entry) => entry.id === "catalana")!;
  const factoryRanges: [bigint, bigint][] = [];
  const trades = [
    { block: start + 3999, volume: 100n * WAD },
    { block: start + 4000, volume: 25n * WAD },
    { block: end, volume: 75n * WAD },
  ];
  const rpc = {
    ...original,
    getContractEvents: async (params: {
      address: string;
      eventName?: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      if (params.eventName === "TokenLaunched")
        factoryRanges.push([params.fromBlock, params.toBlock]);
      const existing = await original.getContractEvents(params as never);
      if (
        params.address.toLowerCase() !== curve(token.address).toLowerCase() ||
        params.eventName
      )
        return existing;
      return [
        ...existing,
        ...trades
          .filter(
            (entry) =>
              BigInt(entry.block) >= params.fromBlock &&
              BigInt(entry.block) <= params.toBlock,
          )
          .map((entry) => ({
            eventName: "CurveBuy",
            args: {
              buyer: holder,
              recipient: holder,
              quoteIn: entry.volume,
              tokensOut: WAD,
              fee: WAD / 100n,
              tax: WAD / 100n,
            },
            blockNumber: BigInt(entry.block),
            logIndex: 1,
            transactionHash: hash(entry.block),
          })),
      ];
    },
  } as unknown as Rpc;
  try {
    for (let step = 1; step <= 3; step++) {
      assert.equal(await tick(small.env, { rpc, queued: true }), step < 3);
      assert.equal(
        await meta(small.env.DB, "cursor"),
        String(start + step * 2000 - 1),
      );
      assert.equal(await meta(small.env.DB, "stagedRange"), undefined);
    }
    let next = BigInt(start);
    for (const [from, to] of factoryRanges) {
      assert.equal(from, next);
      assert.ok(to - from < 100n);
      next = to + 1n;
    }
    assert.equal(next, BigInt(end + 1));
    assert.equal(factoryRanges.length, 60);
    assert.equal(
      await tick(single.env, { rpc, maxBlocks: 6000, queued: true }),
      false,
    );
    for (const query of [
      "SELECT * FROM rounds ORDER BY id",
      "SELECT * FROM swaps ORDER BY block,logIndex",
      "SELECT * FROM balance_events ORDER BY block,logIndex,id",
      "SELECT * FROM current_balances ORDER BY token,wallet",
    ])
      assert.deepEqual(
        small.sql.prepare(query).all(),
        single.sql.prepare(query).all(),
      );
    for (const key of ["active", "creatorFeesWei", "feesVerified", "cursor"])
      assert.equal(
        await meta(small.env.DB, key),
        await meta(single.env.DB, key),
      );
    assert.deepEqual(
      small.sql
        .prepare("SELECT endBlock FROM rounds ORDER BY id")
        .all()
        .map((row) => row.endBlock),
      [start + 3999, end],
    );
    assert.equal(small.sql.prepare("SELECT COUNT(*) n FROM swaps").get()!.n, 4);
  } finally {
    small.sql.close();
    single.sql.close();
  }
});

test("splitter logs use contiguous small ranges and a failed read cannot advance the cursor", async () => {
  const f = queuedFixture(),
    split = config.wallets.split,
    start = config.factoryStartBlock,
    end = start + 274,
    original = mockRpc(end).rpc,
    ranges: [bigint, bigint][] = [],
    blocks = [start + 99, start + 100, end];
  let fail = true;
  const rpc = {
    ...original,
    getLogs: async ({
      fromBlock,
      toBlock,
    }: {
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      ranges.push([fromBlock, toBlock]);
      assert.ok(toBlock - fromBlock < 100n);
      if (fail && fromBlock === BigInt(start + 200))
        throw Error("RPC temporarily unavailable");
      return blocks
        .filter(
          (block) => BigInt(block) >= fromBlock && BigInt(block) <= toBlock,
        )
        .map((block) => ({
          args: { devAmount: 7n, feedAmount: 7n },
          blockNumber: BigInt(block),
          logIndex: 0,
          transactionHash: hash(block),
        }));
    },
  } as unknown as Rpc;
  try {
    config.wallets.split = holder;
    await assert.rejects(
      tick(f.env, { rpc, maxBlocks: 275, queued: true }),
      /RPC temporarily unavailable/,
    );
    assert.equal(await meta(f.env.DB, "cursor"), undefined);
    assert.equal(await meta(f.env.DB, "stagedRange"), undefined);
    assert.equal(await meta(f.env.DB, "lease"), undefined);
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM split_releases").get()!.n,
      0,
    );
    fail = false;
    ranges.length = 0;
    assert.equal(
      await tick(f.env, { rpc, maxBlocks: 275, queued: true }),
      false,
    );
    assert.deepEqual(ranges, [
      [BigInt(start), BigInt(start + 99)],
      [BigInt(start + 100), BigInt(start + 199)],
      [BigInt(start + 200), BigInt(end)],
    ]);
    assert.equal(await meta(f.env.DB, "cursor"), String(end));
    assert.deepEqual(
      f.sql
        .prepare(
          "SELECT block,devWei,feedWei FROM split_releases ORDER BY block",
        )
        .all()
        .map((row) => ({ ...row })),
      blocks.map((block) => ({ block, devWei: "7", feedWei: "7" })),
    );
    await tick(f.env, { rpc, maxBlocks: 275, queued: true });
    assert.equal(
      f.sql.prepare("SELECT COUNT(*) n FROM split_releases").get()!.n,
      3,
    );
  } finally {
    config.wallets.split = split;
    f.sql.close();
  }
});
