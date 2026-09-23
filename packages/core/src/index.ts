import { keccak256, stringToHex, type Address, type Hex } from "viem";
import configFile from "../../../config/config.json" with { type: "json" };

export const config = configFile as Omit<
  typeof configFile,
  "wallets" | "round" | "socials" | "rules"
> & {
  wallets: Record<string, string | null>;
  round: Omit<typeof configFile.round, "startBlock" | "firstThresholdEth"> & {
    startBlock: number | null;
    firstThresholdEth: string | number | null;
  };
  socials: { x: string | null };
  rules: Record<string, string | null>;
};
export const WAD = 10n ** 18n;
export const BPS = 10000n;
export const bps = (value: number) => BigInt(Math.round(value * 10000));
export type Family = "catalana" | "polish" | "silkie";
export type Token = {
  id: string;
  address: Address;
  role: string;
  family?: string;
  pool: Address;
  isToken0: boolean;
  launchBlock: number;
  curve?: Address;
  phase?: number;
  poolId?: Hex;
};
export type Swap = {
  token: string;
  family?: string;
  block: number;
  logIndex: number;
  ts: number;
  volume: bigint;
  side: "buy" | "sell";
  wallet: Address;
  tx: Hex;
  creatorFeeWei?: bigint;
  feeVerified?: boolean;
  kind?: "trade" | "fee-credit";
  tokenAmountWei?: bigint;
  payer?: Address;
  recipient?: Address;
};
export type BalanceEvent = {
  token: string;
  wallet: Address;
  block: number;
  logIndex: number;
  ts: number;
  delta: bigint;
};
export type Round = {
  id: number;
  startBlock: number;
  feeStartBlock?: number;
  startTs: number;
  endBlock: number;
  endTs: number;
  endLogIndex: number | null;
  threshold: bigint;
  volumes: Record<string, bigint>;
  familyVolumes: Record<string, bigint>;
  winner: string | null;
  reason: "threshold" | "timeout";
  pot: bigint;
  creatorFeeWei?: bigint;
  preStartCreatorFeeWei?: bigint;
};
export type Payout = {
  wallet: Address;
  category: "family" | "chick";
  amountWei: bigint;
};
export type Carry = Payout & { round: number };
export const abs = (v: bigint) => (v < 0n ? -v : v);
export function priceWei(sqrt: bigint, isToken0: boolean): bigint {
  if (sqrt <= 0n) throw Error("Invalid pool price");
  return isToken0
    ? (sqrt * sqrt * WAD) / (1n << 192n)
    : ((1n << 192n) * WAD) / (sqrt * sqrt);
}
export function swapVolume(
  amount0: bigint,
  amount1: bigint,
  isToken0: boolean,
) {
  const amount = isToken0 ? amount1 : amount0;
  return {
    volume: abs(amount),
    side: amount > 0n ? ("buy" as const) : ("sell" as const),
  };
}
export function creatorFees(swaps: Swap[]) {
  return swaps.reduce((sum, s) => {
    if (s.creatorFeeWei === undefined || s.creatorFeeWei < 0n)
      throw Error("Verified creator fee amount required");
    return sum + s.creatorFeeWei;
  }, 0n);
}
export function potFromSwaps(swaps: Swap[]) {
  return (creatorFees(swaps) * bps(config.fees.feedShareOfCreatorFee)) / BPS;
}
export function excludedAddresses(tokens: Token[]) {
  return new Set(
    [
      ...Object.values(config.wallets),
      config.fees.collectionWallet,
      ...tokens.flatMap((t) => [t.pool, t.curve]),
      ...Object.values(config.protocol).filter(
        (v) => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v),
      ),
      "0x0000000000000000000000000000000000000000",
    ]
      .filter((a): a is string => !!a)
      .map((a) => a.toLowerCase()),
  );
}
export function thresholdFor(first: bigint, round: number) {
  if (first <= 0n || round < 1 || !Number.isSafeInteger(round))
    throw Error("Invalid round");
  return (
    (first * (BPS + bps(config.round.thresholdGrowth)) ** BigInt(round - 1)) /
    BPS ** BigInt(round - 1)
  );
}
export function hatch(hash: Hex, remaining: readonly string[]) {
  if (
    !/^0x[0-9a-fA-F]{64}$/.test(hash) ||
    !remaining.length ||
    new Set(remaining).size !== remaining.length
  )
    throw Error("Invalid hatch inputs");
  const ids = [...remaining].sort();
  const index = Number(BigInt(hash) % BigInt(ids.length));
  return { ids, index, variant: ids[index] };
}
export function roundVolume(swaps: Swap[]) {
  const tokens: Record<string, bigint> = {},
    families: Record<string, bigint> = {};
  for (const s of swaps) {
    tokens[s.token] = (tokens[s.token] ?? 0n) + s.volume;
    if (s.family) families[s.family] = (families[s.family] ?? 0n) + s.volume;
  }
  return { tokens, families };
}
export type RoundPolicy = {
  waitForFirstTrade?: boolean;
  preStartFeePolicy?: "reserve-for-first-round";
  firstRoundTimeout?: boolean;
  launchBlocks?: number[];
  firstRoundId?: number;
  seed?: {
    startTs: number;
    feeStartBlock?: number;
    tokens: Record<string, bigint>;
    families: Record<string, bigint>;
    creatorFeeWei: bigint;
    preStartCreatorFeeWei?: bigint;
  };
  minDuration: number;
  timeout: number;
  firstThreshold: bigint;
  earlyThreshold: "first-eligible-swap";
  tieBreak: "ascii";
};
export function replayRounds(
  swaps: Swap[],
  blocks: { number: number; ts: number }[],
  startBlock: number,
  policy: RoundPolicy,
) {
  const ordered = [...swaps].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex,
  );
  const rounds: Round[] = [];
  let tokens = { ...policy.seed?.tokens },
    families = { ...policy.seed?.families };
  let fees = policy.seed?.creatorFeeWei ?? 0n,
    preStartFees = policy.seed?.preStartCreatorFeeWei ?? 0n,
    feeStartBlock = policy.seed?.feeStartBlock ?? startBlock,
    startTs = policy.seed?.startTs ?? 0,
    first = startBlock,
    offset = 0;
  let familyVolume = Object.values(families).reduce(
    (sum, value) => sum + value,
    0n,
  );
  const growthSteps = () =>
    policy.launchBlocks === undefined
      ? rounds.length + (policy.firstRoundId ?? 1) - 1
      : policy.launchBlocks.filter((block) => block < first).length;
  for (const b of [...blocks]
    .filter((b) => b.number >= startBlock)
    .sort((a, b) => a.number - b.number)) {
    const roundId = rounds.length + (policy.firstRoundId ?? 1);
    while (offset < ordered.length && ordered[offset].block < b.number)
      offset++;
    if (!startTs && roundId === 1 && policy.waitForFirstTrade) {
      if (
        !ordered.some(
          (swap) =>
            swap.block === b.number &&
            swap.family &&
            swap.volume > 0n &&
            swap.kind !== "fee-credit" &&
            swap.feeVerified === true,
        )
      ) {
        while (offset < ordered.length && ordered[offset].block === b.number) {
          const swap = ordered[offset++];
          if (
            policy.preStartFeePolicy === "reserve-for-first-round" &&
            swap.feeVerified === true
          ) {
            const fee = creatorFees([swap]);
            fees += fee;
            preStartFees += fee;
          }
        }
        continue;
      }
      first = b.number;
    }
    if (!startTs) startTs = b.ts;
    const limit = thresholdFor(policy.firstThreshold, growthSteps() + 1);
    let reason: Round["reason"] | null =
      (roundId !== 1 || policy.firstRoundTimeout !== false) &&
      b.ts >= startTs + policy.timeout
        ? "timeout"
        : null;
    let endLogIndex: number | null = null;
    while (offset < ordered.length && ordered[offset].block === b.number) {
      const swap = ordered[offset++];
      tokens[swap.token] = (tokens[swap.token] ?? 0n) + swap.volume;
      fees += creatorFees([swap]);
      if (swap.family) {
        families[swap.family] = (families[swap.family] ?? 0n) + swap.volume;
        familyVolume += swap.volume;
        if (
          !reason &&
          swap.kind !== "fee-credit" &&
          b.ts >= startTs + policy.minDuration &&
          familyVolume >= limit
        ) {
          reason = "threshold";
          endLogIndex = swap.logIndex;
        }
      }
    }
    if (reason) {
      const winner =
        reason === "timeout"
          ? null
          : (Object.keys(families).sort((a, b) =>
              families[a] === families[b]
                ? a < b
                  ? -1
                  : 1
                : families[a] > families[b]
                  ? -1
                  : 1,
            )[0] ?? null);
      rounds.push({
        id: rounds.length + (policy.firstRoundId ?? 1),
        startBlock: first,
        feeStartBlock,
        startTs,
        endBlock: b.number,
        endTs: b.ts,
        endLogIndex,
        threshold: limit,
        volumes: tokens,
        familyVolumes: families,
        winner,
        reason,
        pot: (fees * bps(config.fees.feedShareOfCreatorFee)) / BPS,
        creatorFeeWei: fees,
        preStartCreatorFeeWei: preStartFees,
      });
      tokens = {};
      families = {};
      familyVolume = 0n;
      fees = 0n;
      preStartFees = 0n;
      first = b.number + 1;
      feeStartBlock = first;
      startTs = 0;
    }
  }
  return {
    rounds,
    active: {
      id: rounds.length + (policy.firstRoundId ?? 1),
      startBlock: first,
      feeStartBlock,
      startTs,
      threshold: thresholdFor(policy.firstThreshold, growthSteps() + 1),
      growthSteps: growthSteps(),
      tokens,
      families,
      creatorFeeWei: fees,
      preStartCreatorFeeWei: preStartFees,
    },
  };
}
export function twab(
  events: Pick<BalanceEvent, "ts" | "delta" | "block" | "logIndex">[],
  start: number,
  end: number,
) {
  if (end <= start) throw Error("Invalid balance interval");
  let balance = 0n,
    integral = 0n,
    last = start;
  for (const e of [...events].sort(
    (a, b) => a.ts - b.ts || a.block - b.block || a.logIndex - b.logIndex,
  )) {
    if (e.ts > end) break;
    if (e.ts <= start) {
      balance += e.delta;
      if (balance < 0n) throw Error("Incomplete balance history");
      continue;
    }
    integral += balance * BigInt(e.ts - last);
    balance += e.delta;
    last = e.ts;
    if (balance < 0n) throw Error("Incomplete balance history");
  }
  return (integral + balance * BigInt(end - last)) / BigInt(end - start);
}
export function streak(
  events: Pick<BalanceEvent, "ts" | "delta" | "block" | "logIndex">[],
  start: number,
  end: number,
  previous: number,
  startBlock?: number,
) {
  let balance = 0n,
    continuous = true;
  const sorted = [...events].sort(
    (a, b) => a.ts - b.ts || a.block - b.block || a.logIndex - b.logIndex,
  );
  const before = (e: (typeof sorted)[number]) =>
    startBlock === undefined ? e.ts <= start : e.block < startBlock;
  for (const e of sorted) if (before(e)) balance += e.delta;
  if (balance <= 0n) continuous = false;
  for (const e of sorted)
    if (!before(e) && e.ts <= end) {
      balance += e.delta;
      if (balance <= 0n) continuous = false;
    }
  return continuous ? previous + 1 : 0;
}
export function chickWeight(balance: bigint, roundStreak: number) {
  return (
    (balance *
      bps(
        Math.min(
          1 + config.payouts.chickStreakStep * roundStreak,
          config.payouts.chickStreakCap,
        ),
      )) /
    BPS
  );
}
export function familyWeight(
  balances: Record<string, bigint>,
  prices: Record<string, bigint>,
) {
  return Object.entries(balances).reduce(
    (sum, [id, bal]) => sum + (bal * (prices[id] ?? 0n)) / WAD,
    0n,
  );
}
export function allocate(amount: bigint, weights: Record<string, bigint>) {
  const rows = Object.entries(weights)
      .filter(([, w]) => w > 0n)
      .sort(([a], [b]) => (a < b ? -1 : 1)),
    total = rows.reduce((s, [, w]) => s + w, 0n);
  if (amount < 0n) throw Error("Negative allocation");
  return rows.map(([id, w]) => ({
    id,
    amount: total ? (amount * w) / total : 0n,
  }));
}
export function firePlan(
  amount: bigint,
  volumes: Record<string, bigint>,
  familyTokenIds: string[],
) {
  const total = Object.values(volumes).reduce((s, v) => s + v, 0n);
  const result: Record<string, bigint> = {
    egg: (amount * bps(config.split.fire.eggCook)) / BPS,
  };
  const family = Object.fromEntries(
    Object.entries(volumes).filter(([id]) => familyTokenIds.includes(id)),
  );
  for (const [share, weights] of [
    [bps(config.split.fire.familyBurn), family],
    [bps(config.split.fire.volumeBurn), volumes],
  ] as const) {
    const allocated = allocate((amount * share) / BPS, weights);
    for (const row of allocated) {
      const id =
        (volumes[row.id] ?? 0n) * BPS <
        total * bps(config.split.fire.minVolumeShare)
          ? "egg"
          : row.id;
      result[id] = (result[id] ?? 0n) + row.amount;
    }
  }
  const sum = Object.values(result).reduce((a, b) => a + b, 0n);
  result.egg += amount - sum;
  return result;
}
export function payoutHash(round: number, rows: Payout[]) {
  const canonical = rows
    .filter((r) => r.amountWei > 0n)
    .map((r) => ({
      wallet: r.wallet.toLowerCase(),
      category: r.category,
      amountWei: r.amountWei.toString(),
    }))
    .sort(
      (a, b) =>
        a.wallet.localeCompare(b.wallet) ||
        a.category.localeCompare(b.category),
    );
  if (
    new Set(canonical.map((r) => r.wallet + ":" + r.category)).size !==
    canonical.length
  )
    throw Error("Duplicate payout");
  return keccak256(stringToHex(JSON.stringify({ round, payouts: canonical })));
}
export function settle(
  round: number,
  payouts: Payout[],
  previous: Carry[],
  potWei: bigint,
  gasPerRecipient: bigint,
) {
  if (gasPerRecipient <= 0n) throw Error("Gas estimate required");
  const gasBudget = (potWei * bps(config.payouts.gasBudgetShare)) / BPS,
    capacity = Number(gasBudget / gasPerRecipient);
  const entries: Carry[] = [
    ...previous,
    ...payouts.map((p) => ({ ...p, round })),
  ];
  const byWallet = new Map<string, Carry[]>();
  for (const p of entries) {
    const key = p.wallet.toLowerCase();
    byWallet.set(key, [...(byWallet.get(key) ?? []), p]);
  }
  const ranked = [...byWallet]
    .map(([wallet, rows]) => ({
      wallet,
      rows,
      total: rows.reduce((s, r) => s + r.amountWei, 0n),
    }))
    .filter((r) => r.total > 0n)
    .sort((a, b) =>
      a.total === b.total
        ? a.wallet.localeCompare(b.wallet)
        : a.total > b.total
          ? -1
          : 1,
    );
  const minimum =
    capacity >= ranked.length ? 0n : (ranked[capacity]?.total ?? 0n) + 1n;
  const paid: Payout[] = [],
    carry: Carry[] = [];
  let cooked = 0n;
  for (const w of ranked) {
    if (capacity > 0 && w.total >= minimum)
      for (const category of ["family", "chick"] as const) {
        const amountWei = w.rows
          .filter((r) => r.category === category)
          .reduce((s, r) => s + r.amountWei, 0n);
        if (amountWei)
          paid.push({ wallet: w.wallet as Address, category, amountWei });
      }
    else
      for (const r of w.rows) {
        if (round - r.round >= config.payouts.carryoverRounds)
          cooked += r.amountWei;
        else carry.push(r);
      }
  }
  const recipients = new Set(paid.map((r) => r.wallet)).size;
  return {
    paid,
    carry,
    cooked,
    minimum,
    gasBudget,
    estimatedGas: BigInt(recipients) * gasPerRecipient,
    hash: payoutHash(round, paid),
  };
}
export function deterministicReel(hash: Hex, ids: string[], result: string) {
  const sorted = [...ids].sort();
  if (!sorted.includes(result)) throw Error("Unknown reel result");
  const seed = BigInt(hash),
    reel = Array.from(
      { length: 43 },
      (_, i) =>
        sorted[Number((seed + BigInt(i) * 17n) % BigInt(sorted.length))],
    );
  reel[36] = result;
  return { reel, stop: 36 };
}
export async function firstBlockAt(
  getBlock: (n: bigint) => Promise<{ timestamp: bigint }>,
  low: bigint,
  high: bigint,
  target: bigint,
) {
  if ((await getBlock(high)).timestamp < target)
    throw Error("Hatch block not mined");
  while (low < high) {
    const mid = (low + high) / 2n;
    if ((await getBlock(mid)).timestamp >= target) high = mid;
    else low = mid + 1n;
  }
  return low;
}
export function json(value: unknown) {
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
}
export function roundsReady() {
  return (
    (config.round.startBlock === null
      ? config.round.startMode === "first-family-trade"
      : Number.isSafeInteger(config.round.startBlock) &&
        Number(config.round.startBlock) >= config.factoryStartBlock) &&
    Number(config.round.firstThresholdEth) > 0 &&
    config.rules.earlyThreshold === "first-eligible-swap" &&
    config.rules.tieBreak === "ascii" &&
    config.rules.concurrentIncubation === "parallel"
  );
}
export function roundStartBlock() {
  return config.round.startBlock ?? config.factoryStartBlock;
}
export function gameRoundPolicy(
  tokens: Pick<Token, "role" | "launchBlock">[] = [],
  testMode = false,
): Pick<
  RoundPolicy,
  | "waitForFirstTrade"
  | "preStartFeePolicy"
  | "firstRoundTimeout"
  | "launchBlocks"
> {
  return {
    waitForFirstTrade:
      !testMode &&
      config.round.startBlock === null &&
      config.round.startMode === "first-family-trade",
    preStartFeePolicy:
      config.round.preStartFeePolicy === "reserve-for-first-round"
        ? "reserve-for-first-round"
        : undefined,
    firstRoundTimeout: testMode || config.round.firstRoundTimeout,
    launchBlocks:
      config.round.thresholdProgression === "launched-variants"
        ? tokens
            .filter((token) => token.role === "variant")
            .map((token) => token.launchBlock)
        : undefined,
  };
}
export function productionReady() {
  return (
    roundsReady() &&
    config.rules.gasFunding === "operator-funded" &&
    Object.values(config.wallets).every(
      (v) => !!v && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/.test(v),
    )
  );
}
