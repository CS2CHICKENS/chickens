import { run } from "./cli";
import { mkdir, writeFile } from "node:fs/promises";
import { derive, weights, buildManifest } from "../packages/core/src/engine";
import {
  config,
  WAD,
  json,
  payoutHash,
  type Token,
  type Swap,
  type BalanceEvent,
} from "../packages/core/src/index";
import { emptyState } from "../packages/core/src/state";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";

async function main() {
  const wallet = "0x1111111111111111111111111111111111111111" as Address;
  const blocks = Array.from({ length: 40 }, (_, i) => ({
    number: 100 + i,
    ts: 1000 + i,
    hash: ("0x" + (i + 1).toString(16).padStart(64, "0")) as Hex,
  }));
  const swaps: Swap[] = [
    {
      token: "catalana",
      family: "catalana",
      block: 106,
      ts: 1006,
      logIndex: 2,
      volume: 10n * WAD,
      creatorFeeWei: WAD / 10n,
      feeVerified: true,
      side: "buy",
      wallet,
      tx: ("0x" + "1".repeat(64)) as Hex,
    },
  ];
  const result = derive(swaps, blocks, 100, WAD, true),
    round = result.rounds[0];
  assert.equal(round.endBlock, 106);
  assert.equal(round.endLogIndex, 2);
  assert.equal(result.hatches[0].block, 116);
  const tokens: Token[] = [
    {
      id: "catalana",
      address: wallet,
      pool: "0x2222222222222222222222222222222222222222",
      role: "default",
      family: "catalana",
      isToken0: true,
      launchBlock: 1,
    },
  ];
  const events: BalanceEvent[] = [
    { wallet, token: "catalana", block: 1, ts: 1, delta: WAD, logIndex: 0 },
  ];
  const w = weights(round, events, tokens, { catalana: WAD }, new Set(), {});
  const manifest = buildManifest(round, w, [], 1000n, 15, tokens);
  const independentlyExpected = (round.pot * 60n) / 100n;
  assert.equal(BigInt(manifest.payouts[0].amountWei), independentlyExpected);
  assert.equal(
    manifest.hash,
    payoutHash(round.id, [
      { wallet, category: "family", amountWei: independentlyExpected },
    ]),
  );
  const state = structuredClone(emptyState);
  state.mode = "demo";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.stale = false;
  state.round = {
    id: 2,
    startBlock: 107,
    threshold: WAD.toString(),
    growthSteps: 0,
    progress: 0.63,
    volumeByFamily: {
      catalana: (WAD / 4n).toString(),
      polish: (WAD / 5n).toString(),
      silkie: ((WAD * 18n) / 100n).toString(),
    },
    volumeByToken: {},
    endsBy: Math.floor(Date.now() / 1000) + 3600,
    potWei: round.pot.toString(),
  };
  const h = result.hatches[0];
  state.incubator = {
    status: "hatched",
    family: h.family,
    hatchAt: h.hatchAt,
    remaining: h.remaining,
    result: {
      variant: h.variant!,
      block: h.block!,
      hash: h.hash!,
      tokenAddress: "",
    },
  };
  state.history.rounds = [
    {
      id: 1,
      winner: round.winner,
      potWei: round.pot.toString(),
      endReason: round.reason,
      endBlock: round.endBlock,
      payoutHash: manifest.hash,
      accountingVerified: true,
      settlementStatus: "published",
      payoutTransactions: [],
    },
  ];
  await mkdir("private/verification", { recursive: true });
  await writeFile(
    "private/verification/simulation.json",
    json({ result, manifest, state }),
  );
  await writeFile("private/verification/demo-state.json", json(state));
  console.log(
    "PASS: exact swap 106:2, hatch block 116, independent payout amount and published hash. Demo stored privately.",
  );
}
run(main);
