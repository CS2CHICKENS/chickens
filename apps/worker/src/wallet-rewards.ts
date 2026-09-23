import type { WalletLedger } from "../../../packages/core/src/state";
import type { Env } from "./index";

export async function walletRewards(env: Env, wallet: string) {
  const changes = (
    await env.DB.prepare(
      "SELECT sequence,amountWei,countDelta FROM wallet_reward_changes WHERE wallet=? ORDER BY sequence LIMIT 1001",
    )
      .bind(wallet)
      .all<{ sequence: number; amountWei: string; countDelta: number }>()
  ).results;
  const saved = await env.DB.prepare(
    "SELECT amountWei,entries FROM wallet_reward_totals WHERE wallet=?",
  )
    .bind(wallet)
    .first<{ amountWei: string; entries: number }>();
  let total = BigInt(saved?.amountWei ?? "0"),
    count = saved?.entries ?? 0;
  const used = changes.slice(0, 1000);
  for (const change of used) {
    total += BigInt(change.amountWei);
    count += change.countDelta;
  }
  const writes: D1PreparedStatement[] = [];
  if (used.length) {
    writes.push(
      env.DB.prepare(
        "INSERT INTO wallet_reward_totals(wallet,amountWei,entries) VALUES(?,?,?) ON CONFLICT(wallet) DO UPDATE SET amountWei=excluded.amountWei,entries=excluded.entries",
      ).bind(wallet, total.toString(), count),
    );
    writes.push(
      env.DB.prepare(
        "DELETE FROM wallet_reward_changes WHERE wallet=? AND sequence<=?",
      ).bind(wallet, used.at(-1)!.sequence),
    );
  }
  const more = changes.length > 1000;
  if (!more && (total < 0n || count < 0))
    throw Error("Invalid pending wallet reward aggregate");
  const latest = (
    await env.DB.prepare(
      "SELECT round,category,amountWei FROM payouts WHERE wallet=? AND status='PUBLISHED' ORDER BY round DESC,category LIMIT 101",
    )
      .bind(wallet)
      .all<{ round: number; category: "family" | "chick"; amountWei: string }>()
  ).results;
  const pending: NonNullable<WalletLedger["pendingRewards"]> = {
    ready: !more,
    totalWei: more ? null : total.toString(),
    count: more ? null : count,
    latest: latest.slice(0, 100),
    hasMore: latest.length > 100,
  };
  return { pending, writes, more };
}
