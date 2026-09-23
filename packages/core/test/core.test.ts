import test from "node:test";
import assert from "node:assert/strict";
import {
  WAD,
  hatch,
  priceWei,
  twab,
  streak,
  chickWeight,
  firePlan,
  settle,
  payoutHash,
  replayRounds,
  firstBlockAt,
  deterministicReel,
  type Swap,
} from "../src/index";
import type { Address, Hex } from "viem";
const wallet = "0x1111111111111111111111111111111111111111" as Address;
test("five fixed hatch vectors and deterministic reel agree", () => {
  for (const [n, expected] of [
    [0, "a"],
    [1, "b"],
    [2, "c"],
    [3, "a"],
    [255, "a"],
  ] as const) {
    const hash = ("0x" + n.toString(16).padStart(64, "0")) as Hex,
      p = hatch(hash, ["c", "a", "b"]);
    assert.equal(p.variant, expected);
    const reel = deterministicReel(hash, p.ids, p.variant);
    assert.equal(reel.reel[reel.stop], expected);
  }
  assert.throws(() => hatch("0x00", []));
  assert.throws(() => hatch(("0x" + "0".repeat(64)) as Hex, ["a", "a"]));
});
test("price orientation and creator fee use exact integer units", () => {
  assert.equal(priceWei(1n << 96n, true), WAD);
  assert.equal(priceWei(2n << 96n, true), 4n * WAD);
  assert.equal(priceWei(2n << 96n, false), WAD / 4n);
});
const events = [
  { ts: 0, delta: 100n, block: 1, logIndex: 0 },
  { ts: 50, delta: -100n, block: 2, logIndex: 0 },
  { ts: 50, delta: 100n, block: 2, logIndex: 1 },
];
test("TWAB includes opening balance; a zero balance resets streak even within the same timestamp", () => {
  assert.equal(twab(events, 0, 100), 100n);
  assert.equal(
    twab([{ ts: 99, delta: 100n, block: 2, logIndex: 0 }], 0, 100),
    1n,
  );
  assert.equal(streak(events, 0, 100, 4), 0);
  assert.equal(streak(events.slice(0, 1), 0, 100, 4), 5);
  assert.equal(chickWeight(100n, 10), 300n);
});
test("exact crossing log and complete end-block pot, EGG excluded from threshold", () => {
  const s = (
    token: string,
    family: string | undefined,
    block: number,
    logIndex: number,
    volume: bigint,
  ): Swap => ({
    token,
    family,
    block,
    logIndex,
    volume,
    creatorFeeWei: volume / 100n,
    feeVerified: true,
    ts: 100 + block,
    side: "buy",
    wallet,
    tx: ("0x" + "1".repeat(64)) as Hex,
  });
  const result = replayRounds(
    [
      s("egg", undefined, 1, 0, 1000n),
      s("catalana", "catalana", 2, 1, 50n),
      s("polish", "polish", 2, 2, 60n),
      s("egg", undefined, 2, 3, 100n),
    ],
    [
      { number: 1, ts: 101 },
      { number: 2, ts: 102 },
    ],
    1,
    {
      firstThreshold: 100n,
      minDuration: 1,
      timeout: 100,
      earlyThreshold: "first-eligible-swap",
      tieBreak: "ascii",
    },
  );
  assert.equal(result.rounds.length, 1);
  assert.equal(result.rounds[0].endLogIndex, 2);
  assert.equal(result.rounds[0].winner, "polish");
  assert.equal(result.rounds[0].pot, 5n);
  assert.equal(result.active.startBlock, 3);
});
test("timeout and minimum-duration boundaries", () => {
  const s: Swap = {
    token: "catalana",
    family: "catalana",
    block: 1,
    logIndex: 0,
    volume: 1000n,
    creatorFeeWei: 10n,
    feeVerified: true,
    ts: 100,
    side: "buy",
    wallet,
    tx: ("0x" + "1".repeat(64)) as Hex,
  };
  const p = {
    firstThreshold: 100n,
    minDuration: 50,
    timeout: 100,
    earlyThreshold: "first-eligible-swap" as const,
    tieBreak: "ascii" as const,
  };
  assert.equal(
    replayRounds(
      [s],
      [
        { number: 1, ts: 100 },
        { number: 2, ts: 149 },
      ],
      1,
      p,
    ).rounds.length,
    0,
  );
  const r = replayRounds(
    [s],
    [
      { number: 1, ts: 100 },
      { number: 2, ts: 200 },
    ],
    1,
    p,
  ).rounds[0];
  assert.equal(r.reason, "timeout");
  assert.equal(r.winner, null);
});
test("fire plan conserves wei and redirects sub-one-percent volume", () => {
  const plan = firePlan(10001n, { catalana: 8000n, chick: 1999n, rare: 1n }, [
    "catalana",
    "rare",
  ]);
  assert.equal(plan.rare, undefined);
  assert.equal(
    Object.values(plan).reduce((a, b) => a + b, 0n),
    10001n,
  );
  assert.ok(plan.egg >= 3000n);
});
test("payout gas cap, deterministic hash, expired carry, no lost wei", () => {
  const second = "0x2222222222222222222222222222222222222222" as Address;
  const rows = [
    { wallet, category: "family" as const, amountWei: 100n },
    { wallet: second, category: "chick" as const, amountWei: 1n },
  ];
  const result = settle(
    4,
    rows,
    [{ wallet: second, category: "family", amountWei: 2n, round: 1 }],
    1000n,
    30n,
  );
  assert.equal(result.paid.length, 1);
  assert.equal(result.cooked, 2n);
  assert.equal(result.carry[0].amountWei, 1n);
  assert.ok(result.estimatedGas <= result.gasBudget);
  assert.equal(payoutHash(4, rows), payoutHash(4, [...rows].reverse()));
});
test("hatch search chooses first block at timestamp including repeated timestamps", async () => {
  const times = [100n, 101n, 101n, 103n];
  assert.equal(
    await firstBlockAt(
      async (n) => ({ timestamp: times[Number(n)] }),
      0n,
      3n,
      101n,
    ),
    1n,
  );
  await assert.rejects(
    firstBlockAt(async (n) => ({ timestamp: times[Number(n)] }), 0n, 3n, 104n),
  );
});
