import test from "node:test";
import assert from "node:assert/strict";
import {
  replayRounds,
  WAD,
  type Swap,
  type RoundPolicy,
} from "../../../packages/core/src/index";
import { derive, type Block } from "../../../packages/core/src/engine";
import { ensureTemporalHeaders, type Rpc } from "../src/indexer";
import type { Address, Hex } from "viem";
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const hash = (number: number) =>
  ("0x" + number.toString(16).padStart(64, "0")) as Hex;
const policy: RoundPolicy = {
  firstThreshold: WAD,
  minDuration: 5,
  timeout: 60,
  earlyThreshold: "first-eligible-swap",
  tieBreak: "ascii",
};
function trade(
  block: number,
  volume = 10n * WAD,
  kind: "trade" | "fee-credit" = "trade",
): Swap {
  return {
    token: "catalana",
    family: "catalana",
    block,
    ts: 1000 + block - 100,
    logIndex: 0,
    volume,
    side: "buy",
    wallet,
    tx: hash(block),
    creatorFeeWei: WAD / 10n,
    feeVerified: true,
    kind,
  };
}

test("streaming replay preserves volumes, exact crossing, fee credits and thresholds", () => {
  const blocks = Array.from({ length: 141 }, (_, i) => ({
    number: 100 + i,
    ts: 1000 + i,
  }));
  const trades = [
    trade(102),
    trade(105, 0n, "fee-credit"),
    trade(106, WAD / 10n),
    trade(112),
    trade(119),
    trade(230),
  ];
  const dense = replayRounds(trades, blocks, 100, policy);
  let active: ReturnType<typeof replayRounds>["active"] | undefined;
  const rounds: typeof dense.rounds = [];
  let offset = 0;
  for (const end of [3, 7, 13, 48, 82, 141]) {
    const chunk = blocks.slice(offset, end);
    const found = replayRounds(
      trades.filter(
        (t) => t.block >= chunk[0].number && t.block <= chunk.at(-1)!.number,
      ),
      chunk,
      active?.startBlock ?? 100,
      {
        ...policy,
        firstRoundId: active?.id ?? 1,
        seed: active
          ? {
              startTs: active.startTs,
              tokens: active.tokens,
              families: active.families,
              creatorFeeWei: active.creatorFeeWei,
            }
          : undefined,
      },
    );
    rounds.push(...found.rounds);
    active = found.active;
    offset = end;
  }
  assert.deepEqual({ rounds, active }, dense);
  assert.equal(dense.rounds[0].endBlock, 106);
  assert.equal(dense.rounds[0].pot, (3n * WAD) / 20n);
});

test("a crossing at the chunk end obtains next round time only from the next block", () => {
  const blocks = Array.from({ length: 9 }, (_, i) => ({
    number: 100 + i,
    ts: 1000 + i,
  }));
  const trades = [trade(106)];
  const first = replayRounds(trades, blocks.slice(0, 7), 100, policy);
  assert.equal(first.active.startBlock, 107);
  assert.equal(first.active.startTs, 0);
  const second = replayRounds([], blocks.slice(7), first.active.startBlock, {
    ...policy,
    firstRoundId: first.active.id,
    seed: first.active,
  });
  assert.equal(second.active.startTs, 1007);
  assert.deepEqual(
    second.active,
    replayRounds(trades, blocks, 100, policy).active,
  );
});

test("sparse header enrichment reproduces exact timeout and earliest repeated-timestamp hatch block", async () => {
  const dense: Block[] = Array.from({ length: 201 }, (_, i) => ({
    number: 100 + i,
    ts: 1000 + Math.floor(i / 2),
    hash: hash(100 + i),
  }));
  const trades = [{ ...trade(112), ts: 1006 }];
  const rpc = {
    getBlock: async ({ blockNumber }: { blockNumber: bigint }) => {
      const b = dense[Number(blockNumber) - 100];
      assert(b, "fixture block exists");
      return { timestamp: BigInt(b.ts), hash: b.hash };
    },
  } as unknown as Rpc;
  const sparse = dense.filter((b) => [100, 112, 113, 300].includes(b.number));
  const enriched = await ensureTemporalHeaders(
    rpc,
    sparse,
    trades,
    100,
    WAD,
    true,
  );
  const actual = derive(trades, enriched, 100, WAD, true);
  const expected = derive(trades, dense, 100, WAD, true);
  assert.deepEqual(actual, expected);
  assert.equal(actual.hatches[0].block, 132);
  assert.equal(actual.rounds[1].endBlock, 232);
  assert(enriched.length < dense.length / 2);
});
