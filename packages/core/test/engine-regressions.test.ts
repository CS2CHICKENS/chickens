import test from "node:test";
import assert from "node:assert/strict";
import {
  config,
  WAD,
  excludedAddresses,
  type Swap,
  type Token,
} from "../src/index";
import {
  derive,
  deriveHatches,
  buildManifest,
  weights,
  matchLaunch,
} from "../src/engine";
import { walletRound } from "../src/wallet";
import type { Address, Hex } from "viem";
const wallet = "0x1111111111111111111111111111111111111111" as Address;
const blocks = Array.from({ length: 30 }, (_, i) => ({
  number: 100 + i,
  ts: 1000 + i,
  hash: ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex,
}));
const swaps: Swap[] = [6, 12].map((i) => ({
  token: "catalana",
  family: "catalana",
  block: 100 + i,
  ts: 1000 + i,
  logIndex: 0,
  volume: 10n * WAD,
  creatorFeeWei: WAD / 10n,
  side: "buy",
  wallet,
  tx: blocks[i].hash,
}));
const token: Token = {
  id: "catalana",
  family: "catalana",
  role: "default",
  address: wallet,
  pool: "0x2222222222222222222222222222222222222222",
  isToken0: true,
  launchBlock: 1,
};
const weight = {
  family: { [wallet]: WAD },
  chick: { [wallet]: WAD },
  streaks: { [wallet]: 1 },
};

test("a pending final egg reserves its slot and later rounds remain fire rounds", () => {
  const original = config.families[0].variants;
  try {
    config.families[0].variants = [original[0]];
    const before = derive(swaps, blocks.slice(0, 15), 100, WAD, true);
    const after = derive(swaps, blocks, 100, WAD, true);
    assert.equal(before.hatches.length, 1);
    assert.equal(after.hatches.length, 1);
    const first = buildManifest(
      before.rounds[1],
      weight,
      [],
      1000n,
      before.hatches.find((h) => h.round === 2)?.remaining.length ?? 0,
      [token],
    );
    const second = buildManifest(
      after.rounds[1],
      weight,
      [],
      1000n,
      after.hatches.find((h) => h.round === 2)?.remaining.length ?? 0,
      [token],
    );
    assert.deepEqual(first, second);
    assert.deepEqual(first.payouts, []);
  } finally {
    config.families[0].variants = original;
  }
});

test("parallel reserved eggs resolve distinct variants and preserve proofs with sparse history", () => {
  const original = config.families[0].variants;
  try {
    config.families[0].variants = original.slice(0, 2);
    const early = derive(swaps, blocks.slice(0, 18), 100, WAD, true);
    assert.equal(early.hatches.length, 2);
    assert.equal(early.hatches[1].remaining.length, 1);
    early.hatches[0].tokenAddress = wallet;
    const late = deriveHatches(
      early.rounds,
      blocks.slice(18),
      true,
      early.hatches,
    );
    assert.equal(new Set(late.map((h) => h.variant)).size, 2);
    assert.deepEqual(late[0], early.hatches[0]);
    assert.equal(late[1].block, 122);
    assert.equal(late[1].remaining.length, 1);
  } finally {
    config.families[0].variants = original;
  }
});

test("operator gas never reduces the advertised community allocations", () => {
  const round = derive(swaps, blocks, 100, WAD, true).rounds[0];
  const manifest = buildManifest(round, weight, [], 1000n, 15, [token]);
  assert.equal(manifest.gasFunding, "operator-funded");
  assert.equal(manifest.version, 2);
  assert.equal(BigInt(manifest.cook.egg), (round.pot * 30n) / 100n);
  assert.equal(
    manifest.payouts.reduce((sum, p) => sum + BigInt(p.amountWei), 0n),
    (round.pot * 70n) / 100n,
  );
  assert.equal(BigInt(manifest.estimatedGasWei), 1000n);
});

test("fee collection wallet is excluded from community weights", () => {
  const round = derive(swaps, blocks, 100, WAD, true).rounds[0];
  const collection = config.fees.collectionWallet as Address;
  const result = weights(
    round,
    [
      {
        wallet: collection,
        token: "catalana",
        block: 1,
        ts: 1,
        logIndex: 0,
        delta: WAD,
      },
    ],
    [token],
    { catalana: WAD },
    excludedAddresses([token]),
    {},
  );
  assert.equal(result.family[collection.toLowerCase()], undefined);
});

test("a registered variant cannot match a second launch after a fresh replay", () => {
  const state = derive(swaps, blocks, 100, WAD, true);
  const h = state.hatches[0];
  const name =
    config.variantMeta[h.variant as keyof typeof config.variantMeta]
      .displayName;
  assert.equal(matchLaunch(name, h.variant!, state.hatches), h);
  assert.equal(
    matchLaunch(name, h.variant!, state.hatches, [{ id: h.variant! }]),
    null,
  );
});

test("live CHICK weight projects continuity while completed streak remains unchanged", () => {
  const chick = { ...token, id: "chick", role: "chick", family: undefined };
  const opening = {
    wallet,
    token: "chick",
    block: 99,
    ts: 999,
    logIndex: 0,
    delta: WAD,
  };
  const live = walletRound(
    wallet,
    [opening],
    [chick],
    {},
    1000,
    1010,
    [],
    1,
    100,
  );
  assert.equal(live.chickStreak, 1);
  assert.equal(live.chickWeightWei, (2n * WAD).toString());
  const firstBlockBuyer = walletRound(
    wallet,
    [{ ...opening, block: 100, ts: 1000 }],
    [chick],
    {},
    1000,
    1010,
    [],
    0,
    100,
  );
  assert.equal(firstBlockBuyer.chickStreak, 0);
  assert.equal(firstBlockBuyer.chickWeightWei, WAD.toString());
  const reset = walletRound(
    wallet,
    [
      opening,
      { ...opening, block: 105, ts: 1005, delta: -WAD },
      { ...opening, block: 106, ts: 1006 },
    ],
    [chick],
    {},
    1000,
    1010,
    [],
    1,
    100,
  );
  assert.equal(reset.chickWeightWei, ((WAD * 9n) / 10n).toString());
});
