import test from "node:test";
import assert from "node:assert/strict";
import {
  replayRounds,
  gameRoundPolicy,
  WAD,
  type RoundPolicy,
  type Swap,
} from "../../packages/core/src/index";
import {
  buildManifest,
  derive,
  type Block,
} from "../../packages/core/src/engine";
import {
  assertVerifiedSettlementFees,
  compareManifest,
  financialManifest,
} from "../operator-plan";

const familyWallet = "0x1111111111111111111111111111111111111111" as const,
  chickWallet = "0x2222222222222222222222222222222222222222" as const,
  hash = ("0x" + "1".repeat(64)) as `0x${string}`;
const blocks: Block[] = [
  { number: 1, ts: 100, hash },
  { number: 2, ts: 200, hash },
  { number: 3, ts: 300, hash },
];
const swaps: Swap[] = [
  {
    token: "egg",
    block: 1,
    logIndex: 0,
    ts: 100,
    volume: 1000n * WAD,
    side: "buy",
    wallet: familyWallet,
    tx: hash,
    creatorFeeWei: 10n * WAD,
    feeVerified: true,
  },
  {
    token: "catalana",
    family: "catalana",
    block: 3,
    logIndex: 0,
    ts: 300,
    volume: 100n * WAD,
    side: "buy",
    wallet: familyWallet,
    tx: hash,
    creatorFeeWei: 6n * WAD,
    feeVerified: true,
  },
];
const policy: RoundPolicy = {
  ...gameRoundPolicy(),
  firstThreshold: 100n * WAD,
  minDuration: 0,
  timeout: 72 * 3600,
  earlyThreshold: "first-eligible-swap",
  tieBreak: "ascii",
};
const balances = {
  family: { [familyWallet]: WAD },
  chick: { [chickWallet]: WAD },
  streaks: {},
};

test("independent full-history settlement matches streamed reservation and binds its provenance", () => {
  const independent = derive(swaps, blocks, 1, 100n * WAD);
  const waiting = replayRounds(
    swaps.slice(0, 1),
    blocks.slice(0, 2),
    1,
    policy,
  );
  const indexed = replayRounds(swaps.slice(1), blocks.slice(2), 1, {
    ...policy,
    firstRoundId: waiting.active.id,
    seed: waiting.active,
  });
  const expected = buildManifest(
      independent.rounds[0],
      balances,
      [],
      1n,
      15,
      [],
    ),
    published = buildManifest(indexed.rounds[0], balances, [], 1n, 15, []);
  compareManifest(expected, published);
  assert.equal(expected.feeStartBlock, 1);
  assert.equal(expected.preStartCreatorFeesWei, (10n * WAD).toString());
  assert.equal(expected.creatorFeesWei, (16n * WAD).toString());
  assert.equal(expected.potWei, (8n * WAD).toString());
  assert.deepEqual(
    expected.payouts.map((row) => [row.category, BigInt(row.amountWei)]),
    [
      ["family", (48n * WAD) / 10n],
      ["chick", (8n * WAD) / 10n],
    ],
  );
  assert.equal(BigInt(expected.cook.egg), (24n * WAD) / 10n);
  assert.equal(financialManifest(expected).feeStartBlock, 1);
  for (const changed of [
    { feeStartBlock: 3 },
    { preStartCreatorFeesWei: "0" },
    { creatorFeesWei: (6n * WAD).toString() },
    { creatorFeesWei: (26n * WAD).toString() },
    { potWei: (3n * WAD).toString() },
  ])
    assert.throws(
      () => compareManifest(expected, { ...published, ...changed }),
      /differs from independent chain reconstruction/,
    );
});

test("local signing preparation rejects unverified reserved fees before the family clock opens", () => {
  const { rounds } = derive(swaps, blocks, 1, 100n * WAD);
  assert.equal(rounds[0].startBlock, 3);
  assert.doesNotThrow(() => assertVerifiedSettlementFees(swaps, rounds, 1));
  for (const feeVerified of [false, undefined])
    assert.throws(
      () =>
        assertVerifiedSettlementFees(
          [{ ...swaps[0], feeVerified }, swaps[1]],
          rounds,
          1,
        ),
      /Unverified fees prevent settlement/,
    );
  assert.doesNotThrow(() =>
    assertVerifiedSettlementFees(
      [
        { ...swaps[0], block: 0, feeVerified: false },
        ...swaps,
        { ...swaps[0], block: 4, feeVerified: false },
      ],
      rounds,
      1,
    ),
  );
  assert.throws(
    () => assertVerifiedSettlementFees(swaps, rounds, 2),
    /Round has not ended/,
  );
});
