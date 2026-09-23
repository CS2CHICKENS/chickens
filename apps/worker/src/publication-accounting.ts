import { json } from "../../../packages/core/src/index";
import type { PublicState } from "../../../packages/core/src/state";
import type { Env } from "./index";
import { metadata } from "./storage";

type Change = {
  sequence: number;
  round: number;
  owedWei: string;
  unpaidDelta: number;
  distributedDelta: number;
  cookedWei: string;
  devWei: string;
};
type Totals = { owedWei: string; devWei: string };
type RoundTotals = {
  round: number;
  owedWei: string;
  unpaidCount: number;
  distributedCount: number;
  cookedWei: string;
};
export const HISTORY_PAGE_SIZE = 100;

export async function maintainAccounting(env: Env, batches = 2) {
  for (let batch = 0; batch < batches; batch++) {
    await env.checkpoint?.();
    const changes = (
      await env.DB.prepare(
        "SELECT * FROM publication_changes ORDER BY sequence LIMIT 1000",
      ).all<Change>()
    ).results;
    if (!changes.length) break;
    const deltas = new Map<
      number,
      { owed: bigint; unpaid: number; distributed: number; cooked: bigint }
    >();
    let used = 0,
      owed = 0n,
      dev = 0n;
    for (const row of changes) {
      if (row.round && !deltas.has(row.round) && deltas.size === 80) break;
      used++;
      owed += BigInt(row.owedWei);
      dev += BigInt(row.devWei);
      if (!row.round) continue;
      const delta = deltas.get(row.round) ?? {
        owed: 0n,
        unpaid: 0,
        distributed: 0,
        cooked: 0n,
      };
      delta.owed += BigInt(row.owedWei);
      delta.unpaid += row.unpaidDelta;
      delta.distributed += row.distributedDelta;
      delta.cooked += BigInt(row.cookedWei);
      deltas.set(row.round, delta);
    }
    const total = (await env.DB.prepare(
      "SELECT owedWei,devWei FROM publication_totals WHERE id=1",
    ).first<Totals>())!;
    const prior = deltas.size
      ? (
          await env.DB.prepare(
            "SELECT * FROM publication_round_totals WHERE round IN (" +
              [...deltas.keys()].map(() => "?").join(",") +
              ")",
          )
            .bind(...deltas.keys())
            .all<RoundTotals>()
        ).results
      : [];
    const writes: D1PreparedStatement[] = [];
    for (const [round, delta] of deltas) {
      const old = prior.find((row) => row.round === round);
      writes.push(
        env.DB.prepare(
          "INSERT INTO publication_round_totals(round,owedWei,unpaidCount,distributedCount,cookedWei) VALUES(?,?,?,?,?) ON CONFLICT(round) DO UPDATE SET owedWei=excluded.owedWei,unpaidCount=excluded.unpaidCount,distributedCount=excluded.distributedCount,cookedWei=excluded.cookedWei",
        ).bind(
          round,
          (BigInt(old?.owedWei ?? "0") + delta.owed).toString(),
          (old?.unpaidCount ?? 0) + delta.unpaid,
          (old?.distributedCount ?? 0) + delta.distributed,
          (BigInt(old?.cookedWei ?? "0") + delta.cooked).toString(),
        ),
      );
    }
    writes.push(
      env.DB.prepare(
        "UPDATE publication_totals SET owedWei=?,devWei=? WHERE id=1",
      ).bind(
        (BigInt(total.owedWei) + owed).toString(),
        (BigInt(total.devWei) + dev).toString(),
      ),
    );
    writes.push(
      env.DB.prepare("DELETE FROM publication_changes WHERE sequence<=?").bind(
        changes[used - 1].sequence,
      ),
    );
    await env.checkpoint?.();
    // Applying the sums and consuming their journal entries must commit together.
    await env.DB.batch(writes);
  }
  const more = !!(await env.DB.prepare(
    "SELECT sequence FROM publication_changes LIMIT 1",
  ).first());
  const totals = (await env.DB.prepare(
    "SELECT owedWei,devWei FROM publication_totals WHERE id=1",
  ).first<Totals>())!;
  return { more, ...totals };
}

export async function roundHistory(
  env: Env,
  from: number,
  to: number,
): Promise<PublicState["history"]["rounds"]> {
  const rows = (
    await env.DB.prepare(
      "SELECT r.id,r.winner,r.pot AS potWei,r.endReason,r.endBlock,m.hash AS payoutHash,m.data AS manifest,a.unpaidCount,a.distributedCount,a.cookedWei FROM rounds r LEFT JOIN manifests m ON m.round=r.id LEFT JOIN publication_round_totals a ON a.round=r.id WHERE r.id>=? AND r.id<=? ORDER BY r.id LIMIT 100",
    )
      .bind(from, to)
      .all<{
        id: number;
        winner: string | null;
        potWei: string;
        endReason: string;
        endBlock: number;
        payoutHash: string | null;
        manifest: string | null;
        unpaidCount: number | null;
        distributedCount: number | null;
        cookedWei: string | null;
      }>()
  ).results;
  const result: PublicState["history"]["rounds"] = [];
  for (const row of rows) {
    const receipts = (
      await env.DB.prepare(
        "SELECT tx FROM payout_receipts WHERE round=? ORDER BY block,tx LIMIT 101",
      )
        .bind(row.id)
        .all<{ tx: string }>()
    ).results;
    let settlementStatus: "pending" | "published" | "partial" | "distributed" =
      row.manifest ? "published" : "pending";
    if (row.manifest) {
      const cook = Object.values(
        JSON.parse(row.manifest).cook as Record<string, string>,
      ).reduce((sum, value) => sum + BigInt(value), 0n);
      const cooked = BigInt(row.cookedWei ?? "0");
      if (!(row.unpaidCount ?? 0) && cooked >= cook)
        settlementStatus = "distributed";
      else if ((row.distributedCount ?? 0) || cooked > 0n)
        settlementStatus = "partial";
    }
    result.push({
      id: row.id,
      winner: row.winner,
      potWei: row.potWei,
      endReason: row.endReason,
      endBlock: row.endBlock,
      payoutHash: row.payoutHash ?? undefined,
      accountingVerified: !!row.manifest,
      settlementStatus,
      payoutTransactions: receipts.slice(0, 100).map((receipt) => receipt.tx),
      payoutTransactionsHasMore: receipts.length > 100,
    });
  }
  return result;
}

export async function publishRoundHistory(env: Env, pages = 2) {
  if (
    await env.DB.prepare(
      "SELECT sequence FROM publication_changes LIMIT 1",
    ).first()
  )
    return { more: true };
  const dirty = (
    await env.DB.prepare("SELECT page FROM history_dirty ORDER BY page LIMIT ?")
      .bind(pages)
      .all<{ page: number }>()
  ).results;
  for (const { page } of dirty) {
    const rounds = await roundHistory(
      env,
      page * HISTORY_PAGE_SIZE + 1,
      (page + 1) * HISTORY_PAGE_SIZE,
    );
    await env.checkpoint?.();
    await env.DATA.put(
      `history/rounds/${page}.json`,
      json({
        page,
        pageSize: HISTORY_PAGE_SIZE,
        updatedAt: Math.floor(Date.now() / 1000),
        rounds,
      }),
      metadata,
    );
    await env.DB.prepare("DELETE FROM history_dirty WHERE page=?")
      .bind(page)
      .run();
  }
  return {
    more: !!(await env.DB.prepare(
      "SELECT page FROM history_dirty LIMIT 1",
    ).first()),
  };
}

export async function publishWalletHistory(env: Env, pages = 25) {
  const dirty = (
    await env.DB.prepare(
      "SELECT wallet,page FROM wallet_history_dirty ORDER BY wallet,page LIMIT ?",
    )
      .bind(pages)
      .all<{ wallet: string; page: number }>()
  ).results;
  for (const { wallet, page } of dirty) {
    const received = (
      await env.DB.prepare(
        "SELECT round,category,amountWei,tx FROM payouts WHERE wallet=? AND status='DISTRIBUTED' AND round>=? AND round<=? ORDER BY round DESC,category LIMIT 201",
      )
        .bind(
          wallet,
          page * HISTORY_PAGE_SIZE + 1,
          (page + 1) * HISTORY_PAGE_SIZE,
        )
        .all()
    ).results;
    if (received.length > 200)
      throw Error("Wallet receipt page exceeds two categories per round");
    await env.checkpoint?.();
    await env.DATA.put(
      `wallets/${wallet.toLowerCase()}/received/${page}.json`,
      json({
        address: wallet,
        page,
        pageSize: HISTORY_PAGE_SIZE,
        updatedAt: Math.floor(Date.now() / 1000),
        received,
      }),
      metadata,
    );
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM wallet_history_dirty WHERE wallet=? AND page=?",
      ).bind(wallet, page),
      env.DB.prepare(
        "INSERT OR IGNORE INTO wallet_dirty(wallet) VALUES(?)",
      ).bind(wallet),
    ]);
  }
  return {
    more: !!(await env.DB.prepare(
      "SELECT wallet FROM wallet_history_dirty LIMIT 1",
    ).first()),
  };
}
