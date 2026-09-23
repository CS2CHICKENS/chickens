import test from "node:test";
import assert from "node:assert/strict";
import { replayRounds, WAD, type RoundPolicy, type Swap } from "../src/index";
import { derive, weights, buildManifest } from "../src/engine";
const policy: RoundPolicy = {
  firstThreshold: 100n * WAD,
  minDuration: 0,
  timeout: 72 * 3600,
  firstRoundTimeout: false,
  waitForFirstTrade: true,
  preStartFeePolicy: "reserve-for-first-round",
  launchBlocks: [],
  earlyThreshold: "first-eligible-swap",
  tieBreak: "ascii",
};
const trade = (
  block: number,
  ts: number,
  volume: bigint,
  extra: Partial<Swap> = {},
): Swap => ({
  block,
  ts,
  volume,
  token: "catalana",
  family: "catalana",
  logIndex: 0,
  side: "buy",
  wallet: "0x1111111111111111111111111111111111111111",
  tx: ("0x" + "1".repeat(64)) as `0x${string}`,
  creatorFeeWei: 2n,
  feeVerified: true,
  ...extra,
});
test("round one waits for verified family volume, has no timeout, then round two times out", () => {
  const blocks = [
    { number: 1, ts: 100 },
    { number: 2, ts: 200 },
    { number: 3, ts: 300 },
    { number: 4, ts: 400 },
    { number: 5, ts: 400000 },
    { number: 6, ts: 400001 },
    { number: 7, ts: 400001 + 72 * 3600 },
  ];
  const swaps = [
    trade(1, 100, WAD, { family: undefined, token: "egg" }),
    trade(2, 200, WAD, { feeVerified: false }),
    trade(3, 300, 0n, { kind: "fee-credit" }),
    trade(4, 400, WAD),
    trade(5, 400000, 99n * WAD),
  ];
  const waiting = replayRounds(
    swaps.slice(0, 3),
    blocks.slice(0, 3),
    1,
    policy,
  );
  assert.equal(waiting.active.startTs, 0);
  assert.equal(waiting.active.creatorFeeWei, 4n);
  assert.equal(waiting.active.preStartCreatorFeeWei, 4n);
  assert.equal(waiting.active.feeStartBlock, 1);
  assert.deepEqual(waiting.active.tokens, {});
  assert.deepEqual(waiting.active.families, {});
  const result = replayRounds(swaps, blocks, 1, policy);
  assert.deepEqual(
    result.rounds.map((r) => [
      r.id,
      r.startBlock,
      r.endBlock,
      r.reason,
      r.threshold,
    ]),
    [
      [1, 4, 5, "threshold", 100n * WAD],
      [2, 6, 7, "timeout", 100n * WAD],
    ],
  );
  assert.equal(result.active.threshold, 100n * WAD);
  assert.equal(result.rounds[0].creatorFeeWei, 8n);
  assert.equal(result.rounds[0].preStartCreatorFeeWei, 4n);
  assert.equal(result.rounds[0].pot, 4n);
  assert.equal(result.rounds[1].preStartCreatorFeeWei, 0n);
});
test("all verified pre-opening fees fund round one once across every streamed boundary", () => {
  const blocks = [100, 200, 300, 400, 500, 500 + 72 * 3600].map((ts, i) => ({
    number: i + 1,
    ts,
  }));
  const swaps = [
    trade(1, 100, 1000n * WAD, {
      token: "egg",
      family: undefined,
      creatorFeeWei: 8n * WAD,
    }),
    trade(2, 200, 200n * WAD, {
      token: "chick",
      family: undefined,
      creatorFeeWei: 6n * WAD,
    }),
    trade(3, 300, 80n * WAD, { creatorFeeWei: 2n * WAD }),
    trade(4, 400, 1000n * WAD, {
      token: "chick",
      family: undefined,
      creatorFeeWei: 4n * WAD,
    }),
    trade(4, 400, 20n * WAD, {
      logIndex: 1,
      creatorFeeWei: 2n * WAD,
    }),
    trade(4, 400, 0n, {
      token: "egg",
      family: undefined,
      logIndex: 2,
      kind: "fee-credit",
      creatorFeeWei: 10n * WAD,
    }),
    trade(5, 500, 100n * WAD, {
      token: "egg",
      family: undefined,
      creatorFeeWei: 6n * WAD,
    }),
  ];
  const expected = replayRounds(swaps, blocks, 1, policy);
  assert.deepEqual(
    expected.rounds.map((round) => ({
      id: round.id,
      start: round.startBlock,
      feesStart: round.feeStartBlock,
      reason: round.reason,
      gross: round.creatorFeeWei,
      reserved: round.preStartCreatorFeeWei,
      pot: round.pot,
    })),
    [
      {
        id: 1,
        start: 3,
        feesStart: 1,
        reason: "threshold",
        gross: 32n * WAD,
        reserved: 14n * WAD,
        pot: 16n * WAD,
      },
      {
        id: 2,
        start: 5,
        feesStart: 5,
        reason: "timeout",
        gross: 6n * WAD,
        reserved: 0n,
        pot: 3n * WAD,
      },
    ],
  );
  assert.deepEqual(expected.rounds[0].familyVolumes, {
    catalana: 100n * WAD,
  });
  assert.equal(expected.rounds[0].volumes.chick, 1000n * WAD);
  assert.equal(expected.rounds[0].volumes.egg, 0n);
  assert.equal(expected.rounds[0].endLogIndex, 1);
  for (let cut = 1; cut < blocks.length; cut++) {
    const first = replayRounds(
      swaps.filter((swap) => swap.block <= cut),
      blocks.slice(0, cut),
      1,
      policy,
    );
    const rest = replayRounds(
      swaps.filter((swap) => swap.block > cut),
      blocks.slice(cut),
      first.active.startBlock,
      { ...policy, firstRoundId: first.active.id, seed: first.active },
    );
    assert.deepEqual([...first.rounds, ...rest.rounds], expected.rounds);
    assert.deepEqual(rest.active, expected.active);
  }
});
test("the first family trade can close its block using the reserved pot without moving holdings time", () => {
  const result = replayRounds(
    [
      trade(1, 100, 500n * WAD, {
        token: "egg",
        family: undefined,
        creatorFeeWei: 10n * WAD,
      }),
      trade(2, 200, 100n * WAD, { creatorFeeWei: 2n * WAD }),
      trade(2, 200, 0n, {
        token: "chick",
        family: undefined,
        kind: "fee-credit",
        logIndex: 1,
        creatorFeeWei: 4n * WAD,
      }),
    ],
    [
      { number: 1, ts: 100 },
      { number: 2, ts: 200 },
    ],
    1,
    policy,
  );
  const round = result.rounds[0];
  assert.equal(round.startBlock, 2);
  assert.equal(round.feeStartBlock, 1);
  assert.equal(round.startTs, 200);
  assert.equal(round.endTs, 200);
  assert.equal(round.preStartCreatorFeeWei, 10n * WAD);
  assert.equal(round.creatorFeeWei, 16n * WAD);
  assert.equal(round.pot, 8n * WAD);
});
test("two-hour wins and thirty ETH of ongoing volume overlap independent ten-hour eggs", () => {
  const hour = 3600;
  const blocks = [6, 7, 7, 8, 9, 9, 10, 17, 19].map((h, i) => ({
    number: i + 1,
    ts: h * hour + (i === 2 || i === 5 ? 1 : 0),
    hash: ("0x" + String(i + 1).padStart(64, "0")) as `0x${string}`,
  }));
  const swaps = [
    trade(1, 6 * hour, WAD),
    trade(2, 7 * hour, 99n * WAD),
    trade(4, 8 * hour, 30n * WAD),
    trade(5, 9 * hour, 70n * WAD),
    trade(7, 10 * hour, 30n * WAD),
  ];
  const pending = derive(swaps, blocks.slice(0, 7), 1, 100n * WAD);
  assert.deepEqual(
    pending.rounds.map((r) => [r.id, r.startBlock, r.endBlock, r.threshold]),
    [
      [1, 1, 2, 100n * WAD],
      [2, 3, 5, 100n * WAD],
    ],
  );
  assert.deepEqual(
    pending.hatches.map((h) => [h.hatchAt, h.block]),
    [
      [17 * hour, null],
      [19 * hour, null],
    ],
  );
  assert.equal(pending.active.families.catalana, 30n * WAD);
  const hatched = derive(swaps, blocks, 1, 100n * WAD);
  assert.deepEqual(
    hatched.hatches.map((h) => h.block),
    [8, 9],
  );
  assert.notEqual(hatched.hatches[0].variant, hatched.hatches[1].variant);
  assert.equal(hatched.active.families.catalana, 30n * WAD);
  assert.equal(hatched.active.threshold, 100n * WAD);
});
test("an opening-block win uses pre-opening holdings and conserves the pot", () => {
  const result = derive(
    [trade(2, 200, 100n * WAD, { creatorFeeWei: 2n * WAD })],
    [{ number: 2, ts: 200, hash: ("0x" + "1".repeat(64)) as `0x${string}` }],
    1,
    100n * WAD,
  );
  const r = result.rounds[0],
    existing = "0x1111111111111111111111111111111111111111" as const,
    buyer = "0x2222222222222222222222222222222222222222" as const;
  assert.equal(r.startBlock, r.endBlock);
  const tokens = [
    {
      id: "catalana",
      address: existing,
      role: "default",
      family: "catalana",
      pool: buyer,
      isToken0: false,
      launchBlock: 1,
    },
  ];
  const w = weights(
    r,
    [
      {
        wallet: existing,
        token: "catalana",
        block: 1,
        ts: 100,
        logIndex: 0,
        delta: WAD,
      },
      {
        wallet: buyer,
        token: "catalana",
        block: 2,
        ts: 200,
        logIndex: 0,
        delta: 100n * WAD,
      },
    ],
    tokens,
    { catalana: WAD },
    new Set(),
    {},
  );
  assert.equal(w.family[existing], WAD);
  assert.equal(w.family[buyer], 0n);
  const m = buildManifest(r, w, [], 1n, 15, tokens);
  assert.equal(
    m.payouts.reduce((s, p) => s + BigInt(p.amountWei), 0n) +
      m.carry.reduce((s, p) => s + BigInt(p.amountWei), 0n) +
      Object.values(m.cook).reduce((s, p) => s + BigInt(p), 0n),
    r.pot,
  );
});
test("only launches before the opening block increase a fixed round threshold", () => {
  const blocks = Array.from({ length: 8 }, (_, i) => ({
    number: i + 1,
    ts: 100 + i * 10,
  }));
  const swaps = [
    trade(1, 100, WAD),
    trade(2, 110, 99n * WAD),
    trade(3, 120, 50n * WAD),
    trade(4, 130, 50n * WAD),
    trade(5, 140, 110n * WAD),
    trade(6, 150, 121n * WAD),
  ];
  const p = { ...policy, minDuration: 0, launchBlocks: [3, 5] };
  const result = replayRounds(swaps, blocks, 1, p);
  assert.deepEqual(
    result.rounds.map((r) => r.threshold),
    [100n * WAD, 100n * WAD, 110n * WAD, 121n * WAD],
  );
  assert.equal(result.active.growthSteps, 2);
  const first = replayRounds(
    swaps.filter((s) => s.block <= 3),
    blocks.slice(0, 3),
    1,
    p,
  );
  const rest = replayRounds(
    swaps.filter((s) => s.block > 3),
    blocks.slice(3),
    first.active.startBlock,
    { ...p, firstRoundId: first.active.id, seed: first.active },
  );
  assert.deepEqual([...first.rounds, ...rest.rounds], result.rounds);
  assert.deepEqual(rest.active, result.active);
});
