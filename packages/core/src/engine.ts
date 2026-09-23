import {
  config,
  bps,
  hatch,
  replayRounds,
  gameRoundPolicy,
  json,
  allocate,
  twab,
  streak,
  chickWeight,
  familyWeight,
  settle,
  firePlan,
  WAD,
  type Round,
  type Swap,
  type BalanceEvent,
  type Token,
  type Carry,
  type Payout,
} from "./index";
import type { Address, Hex } from "viem";
export type Block = { number: number; ts: number; hash: Hex };
export type HatchRecord = {
  round: number;
  family: string;
  hatchAt: number;
  remaining: string[];
  block: number | null;
  hash: Hex | null;
  variant: string | null;
  tokenAddress: Address | null;
};
export function derive(
  swaps: Swap[],
  blocks: Block[],
  start: number,
  threshold: bigint,
  testMode = false,
  tokens: Token[] = [],
) {
  const result = replayRounds(swaps, blocks, start, {
    firstThreshold: threshold,
    minDuration: testMode ? 5 : config.round.minDurationSec,
    timeout: testMode ? 60 : config.round.timeoutSec,
    earlyThreshold: "first-eligible-swap",
    tieBreak: "ascii",
    ...gameRoundPolicy(tokens, testMode),
  });
  return { ...result, hatches: deriveHatches(result.rounds, blocks, testMode) };
}
export function deriveHatches(
  rounds: Round[],
  blocks: Block[],
  testMode = false,
  priorHatches: HatchRecord[] = [],
) {
  const hatches: HatchRecord[] = [],
    used = new Set<string>();
  const reserved = new Map<string, number>();
  const orderedBlocks = [...blocks].sort((a, b) => a.number - b.number);
  for (const round of [...rounds].sort((a, b) => a.id - b.id)) {
    if (!round.winner) continue;
    const family = config.families.find((f) => f.id === round.winner);
    if (!family) throw Error("Unknown winning family");
    const slots = reserved.get(family.id) ?? 0;
    if (slots >= family.variants.length) continue;
    reserved.set(family.id, slots + 1);
    const remaining = family.variants.filter((v) => !used.has(v));
    const hatchAt = round.endTs + (testMode ? 10 : config.round.incubationSec),
      previous = priorHatches.find((h) => h.round === round.id),
      block = orderedBlocks.find(
        (b) => b.ts >= hatchAt && b.number >= round.endBlock,
      );
    if (
      previous &&
      (previous.family !== family.id || previous.hatchAt !== hatchAt)
    )
      throw Error("Stored hatch does not match round");
    const hash = previous?.hash ?? block?.hash ?? null;
    const proof = hash ? hatch(hash, remaining) : null;
    if (
      previous?.variant &&
      (previous.variant !== proof?.variant ||
        JSON.stringify([...previous.remaining].sort()) !==
          JSON.stringify([...remaining].sort()))
    )
      throw Error("Stored hatch proof changed");
    if (proof) used.add(proof.variant);
    hatches.push({
      round: round.id,
      family: round.winner,
      hatchAt,
      remaining,
      block: previous?.block ?? block?.number ?? null,
      hash,
      variant: proof?.variant ?? null,
      tokenAddress: previous?.tokenAddress ?? null,
    });
  }
  return hatches;
}
export function matchLaunch(
  name: string,
  symbol: string,
  expected: HatchRecord[],
  registered: Pick<Token, "id">[] = [],
) {
  const matches = expected.filter(
    (h) =>
      h.variant &&
      !registered.some((token) => token.id === h.variant) &&
      !h.tokenAddress &&
      config.variantMeta[
        h.variant as keyof typeof config.variantMeta
      ]?.displayName.toLowerCase() === name.trim().toLowerCase() &&
      symbol.toLowerCase() === h.variant,
  );
  return matches.length === 1 ? matches[0] : null;
}
export function weights(
  round: Round,
  events: BalanceEvent[],
  tokens: Token[],
  prices: Record<string, bigint>,
  excluded: Set<string>,
  priorStreaks: Record<string, number>,
) {
  const average = (history: BalanceEvent[]) => {
    if (round.endTs !== round.startTs)
      return twab(history, round.startTs, round.endTs);
    // An instant round has no time integral; use holdings before its opening block.
    const balance = history
      .filter((event) => event.block < round.startBlock)
      .reduce((sum, event) => sum + event.delta, 0n);
    if (balance < 0n) throw Error("Incomplete balance history");
    return balance;
  };
  const wallets = [
    ...new Set(events.map((e) => e.wallet.toLowerCase())),
  ].filter((w) => !excluded.has(w));
  const family: Record<string, bigint> = {},
    chick: Record<string, bigint> = {},
    streaks: Record<string, number> = {};
  for (const wallet of wallets) {
    const balances: Record<string, bigint> = {};
    for (const token of tokens.filter((t) => t.family === round.winner)) {
      if (prices[token.id] === undefined)
        throw Error("Missing end-block price");
      balances[token.id] = average(
        events.filter(
          (e) => e.wallet.toLowerCase() === wallet && e.token === token.id,
        ),
      );
    }
    family[wallet] = familyWeight(balances, prices);
    const history = events.filter(
      (e) => e.wallet.toLowerCase() === wallet && e.token === "chick",
    );
    streaks[wallet] = streak(
      history,
      round.startTs,
      round.endTs,
      priorStreaks[wallet] ?? 0,
      round.startBlock,
    );
    chick[wallet] = chickWeight(average(history), streaks[wallet]);
  }
  return { family, chick, streaks };
}
export function buildManifest(
  round: Round,
  roundWeights: ReturnType<typeof weights>,
  carry: Carry[],
  gasPerRecipient: bigint,
  remaining: number,
  tokens: Token[],
) {
  const payouts: Payout[] = [];
  if (round.winner && remaining > 0)
    for (const [category, share] of [
      ["family", bps(config.split.hatch.family)],
      ["chick", bps(config.split.hatch.chick)],
    ] as const) {
      for (const row of allocate(
        (round.pot * share) / 10000n,
        roundWeights[category],
      ))
        payouts.push({
          wallet: row.id as Address,
          category,
          amountWei: row.amount,
        });
    }
  const hatchRound = !!round.winner && remaining > 0;
  const settlement = hatchRound
    ? settle(round.id, payouts, carry, round.pot, gasPerRecipient)
    : {
        ...settle(round.id, [], [], round.pot, gasPerRecipient),
        carry: carry.filter(
          (c) => round.id - c.round < config.payouts.carryoverRounds,
        ),
        cooked: carry
          .filter((c) => round.id - c.round >= config.payouts.carryoverRounds)
          .reduce((s, c) => s + c.amountWei, 0n),
      };
  const distributed = settlement.paid.reduce((s, r) => s + r.amountWei, 0n);
  const newCarry = settlement.carry.reduce((s, r) => s + r.amountWei, 0n);
  const oldCarry = carry.reduce((s, r) => s + r.amountWei, 0n);
  const cookBudget = round.pot + oldCarry - distributed - newCarry;
  if (cookBudget < 0n) throw Error("Settlement exceeds available pot");
  const plan =
    !round.winner || remaining > 0
      ? { egg: cookBudget }
      : firePlan(
          round.pot,
          round.volumes,
          tokens.filter((t) => t.family === round.winner).map((t) => t.id),
        );
  if (round.winner && remaining === 0)
    plan.egg = (plan.egg ?? 0n) + oldCarry - newCarry;
  return {
    version: 2,
    round: round.id,
    feeStartBlock: round.feeStartBlock ?? round.startBlock,
    endBlock: round.endBlock,
    potWei: round.pot.toString(),
    creatorFeesWei: round.creatorFeeWei?.toString() ?? null,
    preStartCreatorFeesWei: (round.preStartCreatorFeeWei ?? 0n).toString(),
    payouts: settlement.paid.map((p) => ({
      ...p,
      amountWei: p.amountWei.toString(),
    })),
    hash: settlement.hash,
    carry: settlement.carry
      .map((c) => ({
        ...c,
        amountWei: c.amountWei.toString(),
      }))
      .sort(
        (a, b) =>
          a.wallet.toLowerCase().localeCompare(b.wallet.toLowerCase()) ||
          a.round - b.round ||
          a.category.localeCompare(b.category),
      ),
    minimumWei: settlement.minimum.toString(),
    estimatedGasWei: settlement.estimatedGas.toString(),
    gasFunding: "operator-funded" as const,
    cook: JSON.parse(json(plan)) as Record<string, string>,
    weights: JSON.parse(json(roundWeights)),
    gasPerRecipientWei: gasPerRecipient.toString(),
  };
}
