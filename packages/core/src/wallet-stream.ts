import {
  chickWeight,
  familyWeight,
  type BalanceEvent,
  type Token,
} from "./index";

export type WalletMoments = Record<
  string,
  { delta: bigint; weighted: bigint; minimum: bigint }
>;

export function appendWalletEvents(
  moments: WalletMoments,
  events: Pick<BalanceEvent, "token" | "ts" | "delta">[],
  start: number,
  end: number,
) {
  for (const event of events) {
    if (event.ts > end) continue;
    const value = (moments[event.token] ??= {
      delta: 0n,
      weighted: 0n,
      minimum: 0n,
    });
    value.delta += event.delta;
    value.weighted += event.delta * BigInt(Math.max(start, event.ts) - start);
    if (value.delta < value.minimum) value.minimum = value.delta;
  }
}

export function streamedWalletRound(
  held: { token: string; balanceWei: string }[],
  tokens: Token[],
  prices: Record<string, bigint>,
  start: number,
  end: number,
  moments: WalletMoments,
  previousStreak = 0,
) {
  const balances = new Map(
    held.map((row) => [row.token, BigInt(row.balanceWei)]),
  );
  const holdings = tokens.map((token) => ({
    token: token.id,
    balanceWei: (balances.get(token.id) ?? 0n).toString(),
  }));
  if (!start || end <= start)
    return {
      holdings,
      chickStreak: previousStreak,
      chickWeightWei: "0",
      roundWeight: {} as Record<string, string>,
    };
  const average: Record<string, bigint> = {};
  let continuous = false;
  for (const token of tokens) {
    const closing = balances.get(token.id) ?? 0n;
    const value = moments[token.id] ?? { delta: 0n, weighted: 0n, minimum: 0n };
    const opening = closing - value.delta;
    if (opening + value.minimum < 0n) throw Error("Incomplete balance history");
    // Integrating backward from the closing balance needs only these event moments.
    average[token.id] =
      (closing * BigInt(end - start) - value.weighted) / BigInt(end - start);
    if (token.id === "chick") continuous = opening + value.minimum > 0n;
  }
  const families: Record<string, Record<string, bigint>> = {};
  for (const token of tokens.filter((token) => token.family))
    (families[token.family!] ??= {})[token.id] = average[token.id];
  return {
    holdings,
    chickStreak: previousStreak,
    chickWeightWei: chickWeight(
      average.chick ?? 0n,
      continuous ? previousStreak + 1 : 0,
    ).toString(),
    roundWeight: Object.fromEntries(
      Object.entries(families).map(([family, balances]) => [
        family,
        familyWeight(balances, prices).toString(),
      ]),
    ),
  };
}
