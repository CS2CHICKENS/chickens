import test from "node:test";
import assert from "node:assert/strict";
import { config, WAD, type BalanceEvent, type Token } from "../src/index";
import { walletRound } from "../src/wallet";
import {
  appendWalletEvents,
  streamedWalletRound,
  type WalletMoments,
} from "../src/wallet-stream";

const wallet = ("0x" + "1".repeat(40)) as `0x${string}`;
const tokens: Token[] = config.tokens.map((token) => ({
  ...token,
  pool: token.address,
  isToken0: true,
  launchBlock: 1,
})) as Token[];
const prices = Object.fromEntries(tokens.map((token) => [token.id, 3n * WAD]));

test("streamed wallet moments match the independent event replay beyond twenty thousand transfers", () => {
  const events: BalanceEvent[] = [];
  const moments: WalletMoments = {};
  const opening = tokens.map((token) => ({
    token: token.id,
    wallet,
    block: 9,
    logIndex: -1,
    ts: 99,
    delta: 100n * WAD,
  }));
  for (let n = 0; n < 25001; n++)
    events.push({
      token: n % 2 ? "catalana" : "chick",
      wallet,
      block: 10 + n,
      logIndex: n % 3,
      ts: 100 + n,
      delta: (n % 7 ? 2n : -1n) * WAD,
    });
  const held = tokens.map((token) => ({
    token: token.id,
    balanceWei: (
      100n * WAD +
      events
        .filter((event) => event.token === token.id)
        .reduce((sum, event) => sum + event.delta, 0n)
    ).toString(),
  }));
  for (let offset = 0; offset < events.length; offset += 137)
    appendWalletEvents(moments, events.slice(offset, offset + 137), 100, 25101);
  assert.deepEqual(
    streamedWalletRound(held, tokens, prices, 100, 25101, moments, 2),
    walletRound(
      wallet,
      [...opening, ...events],
      tokens,
      prices,
      100,
      25101,
      [],
      2,
      10,
    ),
  );
  assert.equal(Object.keys(moments).length, 2);
});

test("streamed seniority observes opening-block zero balances and equal timestamps", () => {
  for (const changes of [
    [-100n, 100n],
    [10n, -110n, 120n],
    [-40n, 10n, 20n],
    [0n, 0n],
  ]) {
    const moments: WalletMoments = {};
    const opening: BalanceEvent = {
      token: "chick",
      wallet,
      block: 9,
      logIndex: -1,
      ts: 99,
      delta: 100n,
    };
    const events = changes.map((delta, logIndex) => ({
      token: "chick",
      wallet,
      block: 10,
      logIndex,
      ts: 100,
      delta,
    }));
    appendWalletEvents(moments, events, 100, 200);
    const held = [
      {
        token: "chick",
        balanceWei: (
          100n + changes.reduce((sum, delta) => sum + delta, 0n)
        ).toString(),
      },
    ];
    assert.deepEqual(
      streamedWalletRound(held, tokens, prices, 100, 200, moments, 4),
      walletRound(
        wallet,
        [opening, ...events],
        tokens,
        prices,
        100,
        200,
        [],
        4,
        10,
      ),
    );
  }
});

test("streamed wallet weights reject negative balance histories", () => {
  const moments: WalletMoments = {};
  appendWalletEvents(
    moments,
    [
      { token: "chick", ts: 101, delta: -10n },
      { token: "chick", ts: 102, delta: 10n },
    ],
    100,
    200,
  );
  assert.throws(
    () =>
      streamedWalletRound(
        [{ token: "chick", balanceWei: "1" }],
        tokens,
        prices,
        100,
        200,
        moments,
      ),
    /Incomplete balance history/,
  );
});
