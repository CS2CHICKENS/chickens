export type FeeLedger = {
  balance: bigint;
  projectCredit: bigint;
  projectRemainingMin: bigint;
  projectRemainingMax: bigint;
  otherCredit: bigint;
  claimed: bigint;
  direct: bigint;
};

export function openingFeeLedger(otherBalance: bigint): FeeLedger {
  if (otherBalance < 0n) throw Error("Invalid opening escrow balance");
  return {
    balance: otherBalance,
    projectCredit: 0n,
    projectRemainingMin: 0n,
    projectRemainingMax: 0n,
    otherCredit: otherBalance,
    claimed: 0n,
    direct: 0n,
  };
}

export function applyFeeEvent(
  previous: FeeLedger,
  kind: "project" | "other" | "claim" | "direct",
  amount: bigint,
): FeeLedger {
  if (amount < 0n) throw Error("Invalid fee amount");
  const next = { ...previous };
  if (kind === "direct") next.direct += amount;
  else if (kind === "claim") {
    if (amount > next.balance)
      throw Error("Escrow claim exceeds indexed credits");
    next.balance -= amount;
    next.claimed += amount;
    // Partial withdrawals from mixed funds do not identify which credit was paid.
    next.projectRemainingMin =
      next.projectRemainingMin > amount
        ? next.projectRemainingMin - amount
        : 0n;
    next.projectRemainingMax =
      next.projectRemainingMax < next.balance
        ? next.projectRemainingMax
        : next.balance;
  } else {
    next.balance += amount;
    if (kind === "project") {
      next.projectCredit += amount;
      next.projectRemainingMin += amount;
      next.projectRemainingMax += amount;
    } else next.otherCredit += amount;
  }
  return next;
}

export function collectedFeeBounds(ledger: FeeLedger) {
  return {
    lower: ledger.projectCredit - ledger.projectRemainingMax + ledger.direct,
    upper: ledger.projectCredit - ledger.projectRemainingMin + ledger.direct,
  };
}
