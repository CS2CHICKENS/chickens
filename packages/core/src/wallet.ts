import {
  twab,
  streak,
  chickWeight,
  familyWeight,
  type BalanceEvent,
  type Token,
  type Round,
} from "./index";
export function walletRound(
  wallet: string,
  events: BalanceEvent[],
  tokens: Token[],
  prices: Record<string, bigint>,
  start: number,
  end: number,
  rounds: Round[],
  previousStreak?: number,
  activeStartBlock?: number,
) {
  const history = events.filter(
    (e) => e.wallet.toLowerCase() === wallet.toLowerCase(),
  );
  let seniority = previousStreak ?? 0;
  for (const round of previousStreak === undefined ? rounds : [])
    seniority = streak(
      history.filter((e) => e.token === "chick" && e.block <= round.endBlock),
      round.startTs,
      round.endTs,
      seniority,
      round.startBlock,
    );
  const holdings = tokens.map((t) => ({
    token: t.id,
    balanceWei: history
      .filter((e) => e.token === t.id)
      .reduce((s, e) => s + e.delta, 0n)
      .toString(),
  }));
  if (!start || end <= start)
    return {
      holdings,
      chickStreak: seniority,
      chickWeightWei: "0",
      roundWeight: {},
    };
  const families: Record<string, Record<string, bigint>> = {};
  for (const token of tokens.filter((t) => t.family)) {
    const f = token.family!;
    families[f] ??= {};
    families[f][token.id] = twab(
      history.filter((e) => e.token === token.id),
      start,
      end,
    );
  }
  return {
    holdings,
    chickStreak: seniority,
    chickWeightWei: chickWeight(
      twab(
        history.filter((e) => e.token === "chick"),
        start,
        end,
      ),
      streak(
        history.filter((e) => e.token === "chick"),
        start,
        end,
        seniority,
        activeStartBlock,
      ),
    ).toString(),
    roundWeight: Object.fromEntries(
      Object.entries(families).map(([family, balances]) => [
        family,
        familyWeight(balances, prices).toString(),
      ]),
    ),
  };
}
