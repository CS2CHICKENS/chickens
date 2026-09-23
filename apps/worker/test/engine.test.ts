import test from "node:test";
import assert from "node:assert/strict";
import { derive, matchLaunch, buildManifest, weights } from "../src/engine";
import {
  config,
  WAD,
  type Swap,
  type Token,
  type BalanceEvent,
} from "../../../packages/core/src/index";
import type { Address, Hex } from "viem";
const wallet = "0x1111111111111111111111111111111111111111" as Address;
export const blocks = Array.from({ length: 50 }, (_, i) => ({
  number: 100 + i,
  ts: 1000 + i,
  hash: ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex,
}));
export const swaps: Swap[] = [
  {
    token: "catalana",
    family: "catalana",
    block: 106,
    ts: 1006,
    logIndex: 2,
    volume: 10n * WAD,
    creatorFeeWei: WAD / 10n,
    side: "buy",
    wallet,
    tx: ("0x" + "1".repeat(64)) as Hex,
  },
];
test("full tiny-threshold round and incubation are reproducible", () => {
  const a = derive(swaps, blocks, 100, WAD, true),
    b = derive([...swaps], blocks, 100, WAD, true);
  assert.deepEqual(a, b);
  assert.equal(a.rounds[0].endBlock, 106);
  assert.equal(a.rounds[0].endLogIndex, 2);
  assert.equal(a.hatches[0].block, 116);
  assert.ok(a.hatches[0].variant);
  const h = a.hatches[0],
    name =
      config.variantMeta[h.variant as keyof typeof config.variantMeta]
        .displayName;
  assert.equal(
    matchLaunch(
      name,
      config.variantMeta[h.variant as keyof typeof config.variantMeta].symbol,
      a.hatches,
    ),
    h,
  );
  assert.equal(matchLaunch(name, "FAKE", a.hatches), null);
});
test("settlement conserves pot plus carry and excludes nonrecipients", () => {
  const round = derive(swaps, blocks, 100, WAD, true).rounds[0];
  const token = {
    id: "catalana",
    address: wallet,
    pool: "0x2222222222222222222222222222222222222222" as Address,
    role: "default",
    family: "catalana",
    isToken0: true,
    launchBlock: 1,
  } satisfies Token;
  const events: BalanceEvent[] = [
    { wallet, token: "catalana", block: 1, ts: 1, delta: WAD, logIndex: 0 },
  ];
  const w = weights(round, events, [token], { catalana: WAD }, new Set(), {});
  const manifest = buildManifest(round, w, [], 1000n, 15, [token]);
  const paid = manifest.payouts.reduce((s, p) => s + BigInt(p.amountWei), 0n),
    cook = Object.values(manifest.cook).reduce((s, v) => s + BigInt(v), 0n),
    carry = manifest.carry.reduce((s, p) => s + BigInt(p.amountWei), 0n);
  assert.equal(paid + cook + carry, round.pot);
  assert.equal(
    weights(round, events, [token], { catalana: WAD }, new Set([wallet]), {})
      .family[wallet],
    undefined,
  );
});

test("production incubation uses the first block at ten hours, never an earlier block", () => {
  const end = 1000 + 6 * 3600;
  const deadline = end + 10 * 3600;
  const headers = [
    { number: 100, ts: 1000, hash: blocks[0].hash },
    { number: 101, ts: end, hash: blocks[1].hash },
    { number: 102, ts: end + 1, hash: blocks[2].hash },
    { number: 300, ts: deadline - 1, hash: blocks[3].hash },
    { number: 301, ts: deadline, hash: blocks[4].hash },
    { number: 302, ts: deadline, hash: blocks[5].hash },
  ];
  const trades = [
    { ...swaps[0], block: 100, ts: 1000, volume: 1n, feeVerified: true },
    { ...swaps[0], block: 101, ts: end, feeVerified: true },
  ];
  const pending = derive(trades, headers.slice(0, 4), 100, WAD);
  assert.equal(pending.hatches[0].hatchAt, deadline);
  assert.equal(pending.hatches[0].block, null);
  const ready = derive(trades, headers, 100, WAD);
  assert.equal(ready.hatches[0].block, 301);
  assert.equal(ready.hatches[0].hash, headers[4].hash);
  assert.ok(ready.hatches[0].variant);
  assert.equal(ready.active.startBlock, 102);
});
