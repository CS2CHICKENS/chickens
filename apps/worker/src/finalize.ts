import { type Address } from "viem";
import {
  json,
  excludedAddresses,
  type Token,
  type BalanceEvent,
  type Carry,
} from "../../../packages/core/src/index";
import { client, tokenSnapshot } from "../../../packages/core/src/chain";
import {
  weights,
  buildManifest,
  type HatchRecord,
} from "../../../packages/core/src/engine";
import { settlementGasReference } from "../../../packages/core/src/gas";
import { all, queuePublication, insertRows } from "./storage";
import {
  stageManifest,
  loadManifest,
  manifestReference,
  type ManifestSummary,
} from "./manifests";
import { reviveRound } from "./publication";
import type { Env } from "./index";
type Job = {
  round: number;
  walletCursor: string;
  prices: string;
  gasWei: string;
  data: string | null;
  writeOffset: number;
};
export async function finalizePending(
  env: Env,
  rpc: ReturnType<typeof client>,
  tokens: Token[],
  hatches: HatchRecord[],
  walletLimit = 100,
) {
  if (
    !Number.isSafeInteger(walletLimit) ||
    walletLimit < 1 ||
    walletLimit > 1000
  )
    throw Error("Invalid settlement wallet budget");
  await env.checkpoint?.();
  const pending = await env.DB.prepare(
    "SELECT data FROM rounds WHERE status='PENDING' ORDER BY id LIMIT 1",
  ).first<{ data: string }>();
  if (!pending) return { pending: false, processed: 0 };
  const round = reviveRound(pending.data),
    roundTokens = tokens.filter((token) => token.launchBlock <= round.endBlock);
  const unverified = await env.DB.prepare(
    "SELECT id FROM swaps WHERE block>=? AND block<=? AND feeVerified=0 LIMIT 1",
  )
    .bind(round.startBlock, round.endBlock)
    .first();
  if (unverified)
    throw Error("Round fees have not been independently verified");
  let job = await env.DB.prepare("SELECT * FROM settlement_jobs WHERE round=?")
    .bind(round.id)
    .first<Job>();
  if (!job) {
    const prices: Record<string, bigint> = {};
    for (const token of roundTokens.filter(
      (token) => token.family === round.winner,
    ))
      prices[token.id] = (
        await tokenSnapshot(rpc, token.address, BigInt(round.endBlock))
      ).priceWei;
    const block = await rpc.getBlock({ blockNumber: BigInt(round.endBlock) });
    await env.checkpoint?.();
    await env.DB.prepare(
      "INSERT INTO settlement_jobs(round,prices,gasWei) VALUES(?,?,?)",
    )
      .bind(
        round.id,
        json(prices),
        settlementGasReference(block.baseFeePerGas).toString(),
      )
      .run();
    job = {
      round: round.id,
      prices: json(prices),
      gasWei: settlementGasReference(block.baseFeePerGas).toString(),
      walletCursor: "",
      data: null,
      writeOffset: 0,
    };
  }
  if (!job.data) {
    const previous = await env.DB.prepare(
      "SELECT id,endBlock,data FROM rounds WHERE id<? ORDER BY id DESC LIMIT 1",
    )
      .bind(round.id)
      .first<{ id: number; endBlock: number; data: string }>();
    const previousRound = previous ? reviveRound(previous.data) : null;
    const prices = Object.fromEntries(
      Object.entries(JSON.parse(job.prices)).map(([token, value]) => [
        token,
        BigInt(String(value)),
      ]),
    );
    const candidates = (
      await env.DB.prepare(
        "SELECT wallet FROM (SELECT wallet FROM current_balances UNION SELECT wallet FROM carryover) WHERE wallet>? ORDER BY wallet LIMIT ?",
      )
        .bind(job.walletCursor, walletLimit)
        .all<{ wallet: Address }>()
    ).results;
    const excluded = excludedAddresses(tokens);
    for (let offset = 0; offset < candidates.length; offset += 50) {
      await env.checkpoint?.();
      const group = candidates.slice(offset, offset + 50),
        wallets = group.map((row) => row.wallet);
      const placeholders = wallets.map(() => "?").join(",");
      const opening = previousRound
        ? (
            await env.DB.prepare(
              "SELECT wallet,token,balanceWei FROM round_balances WHERE round=? AND wallet IN (" +
                placeholders +
                ")",
            )
              .bind(previousRound.id, ...wallets)
              .all<{ wallet: string; token: string; balanceWei: string }>()
          ).results
        : [];
      const actual = (
        await all<Record<string, unknown>>(
          env.DB,
          "SELECT token,wallet,block,logIndex,ts,delta FROM balance_events WHERE wallet IN (" +
            placeholders +
            ") AND block>? AND block<=? ORDER BY block,logIndex",
          [...wallets, previousRound?.endBlock ?? -1, round.endBlock],
          50000,
        )
      ).map((row) => ({
        ...row,
        delta: BigInt(String(row.delta)),
      })) as BalanceEvent[];
      const old = (
        await env.DB.prepare(
          "SELECT wallet,streak FROM round_weights WHERE round=? AND wallet IN (" +
            placeholders +
            ")",
        )
          .bind(previousRound?.id ?? 0, ...wallets)
          .all<{ wallet: string; streak: number }>()
      ).results;
      const histories = new Map(
        wallets.map((wallet) => [wallet, [] as BalanceEvent[]]),
      );
      for (const row of opening)
        histories.get(row.wallet as Address)!.push({
          token: row.token,
          wallet: row.wallet as Address,
          block: previousRound!.endBlock,
          logIndex: -1,
          ts: previousRound!.endTs,
          delta: BigInt(row.balanceWei),
        });
      for (const event of actual) histories.get(event.wallet)!.push(event);
      // RPC concurrency is bounded; one failed archive read leaves this group uncommitted.
      for (let start = 0; start < wallets.length; start += 6) {
        await env.checkpoint?.();
        const reads = await Promise.allSettled(
          wallets.slice(start, start + 6).map(async (wallet) => {
            if (excluded.has(wallet)) return;
            const code = await rpc.getCode({
              address: wallet,
              blockNumber: BigInt(round.endBlock),
            });
            if (code && code !== "0x") excluded.add(wallet);
          }),
        );
        const failure = reads.find((read) => read.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      const weightRows: unknown[][] = [],
        balanceRows: unknown[][] = [];
      for (const wallet of wallets) {
        const events = histories.get(wallet)!;
        const result = weights(round, events, roundTokens, prices, excluded, {
          [wallet]: old.find((row) => row.wallet === wallet)?.streak ?? 0,
        });
        const balances = new Map<string, bigint>();
        for (const event of events)
          balances.set(
            event.token,
            (balances.get(event.token) ?? 0n) + event.delta,
          );
        for (const amount of balances.values())
          if (amount < 0n) throw Error("Incomplete settlement balances");
        weightRows.push([
          round.id,
          wallet,
          String(result.family[wallet] ?? 0n),
          String(result.chick[wallet] ?? 0n),
          result.streaks[wallet] ?? 0,
        ]);
        for (const [token, amount] of balances)
          balanceRows.push([round.id, token, wallet, amount.toString()]);
      }
      const writes = [
        ...insertRows(
          env.DB,
          "round_weights",
          ["round", "wallet", "familyWei", "chickWei", "streak"],
          weightRows,
        ),
        ...insertRows(
          env.DB,
          "round_balances",
          ["round", "token", "wallet", "balanceWei"],
          balanceRows,
        ),
        env.DB.prepare(
          "UPDATE settlement_jobs SET walletCursor=? WHERE round=?",
        ).bind(wallets.at(-1), round.id),
      ];
      await env.checkpoint?.();
      await env.DB.batch(writes);
    }
    if (candidates.length === walletLimit)
      return { pending: true, processed: candidates.length };
    const computed = {
      family: {} as Record<string, bigint>,
      chick: {} as Record<string, bigint>,
      streaks: {} as Record<string, number>,
    };
    let weightCursor = "";
    for (;;) {
      await env.checkpoint?.();
      const rows = (
        await env.DB.prepare(
          "SELECT wallet,familyWei,chickWei,streak FROM round_weights WHERE round=? AND wallet>? ORDER BY wallet LIMIT 1000",
        )
          .bind(round.id, weightCursor)
          .all<{
            wallet: string;
            familyWei: string;
            chickWei: string;
            streak: number;
          }>()
      ).results;
      for (const row of rows) {
        computed.family[row.wallet] = BigInt(row.familyWei);
        computed.chick[row.wallet] = BigInt(row.chickWei);
        computed.streaks[row.wallet] = row.streak;
      }
      if (rows.length < 1000) break;
      weightCursor = rows.at(-1)!.wallet;
    }
    const carry: Carry[] = [];
    let carryCursor: [string, number, string] = ["", 0, ""];
    for (;;) {
      await env.checkpoint?.();
      const rows = (
        await env.DB.prepare(
          "SELECT wallet,round,category,amountWei FROM carryover WHERE (wallet,round,category)>(?,?,?) ORDER BY wallet,round,category LIMIT 1000",
        )
          .bind(...carryCursor)
          .all<{
            wallet: Address;
            round: number;
            category: "family" | "chick";
            amountWei: string;
          }>()
      ).results;
      for (const row of rows)
        carry.push({ ...row, amountWei: BigInt(row.amountWei) });
      if (rows.length < 1000) break;
      const last = rows.at(-1)!;
      carryCursor = [last.wallet, last.round, last.category];
    }
    const manifest = buildManifest(
      round,
      computed,
      carry,
      BigInt(job.gasWei),
      hatches.some((hatch) => hatch.round === round.id) ? 1 : 0,
      roundTokens,
    );
    job.data = json(await stageManifest(env.DB, manifest, env.checkpoint));
    await env.checkpoint?.();
    await env.DB.prepare("UPDATE settlement_jobs SET data=? WHERE round=?")
      .bind(job.data, round.id)
      .run();
  }
  const summary = JSON.parse(job.data) as ManifestSummary;
  const manifest = (await loadManifest(env.DB, round.id, summary))!;
  const totalWrites = manifest.payouts.length + manifest.carry.length;
  const end = Math.min(job.writeOffset + 1000, totalWrites);
  const payouts = manifest.payouts.slice(job.writeOffset, end);
  const carry = manifest.carry.slice(
    Math.max(0, job.writeOffset - manifest.payouts.length),
    Math.max(0, end - manifest.payouts.length),
  );
  await env.checkpoint?.();
  await env.DB.batch([
    ...insertRows(
      env.DB,
      "payouts",
      ["round", "wallet", "category", "amountWei", "status"],
      payouts.map((row) => [
        round.id,
        row.wallet,
        row.category,
        row.amountWei,
        "PREPARED",
      ]),
    ),
    ...insertRows(
      env.DB,
      "planned_carry",
      ["settlementRound", "wallet", "round", "category", "amountWei"],
      carry.map((row) => [
        round.id,
        row.wallet,
        row.round,
        row.category,
        row.amountWei,
      ]),
    ),
    env.DB.prepare(
      "UPDATE settlement_jobs SET writeOffset=? WHERE round=?",
    ).bind(end, round.id),
  ]);
  if (end < totalWrites) return { pending: true, processed: 0 };
  await env.checkpoint?.();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO manifests(round,hash,data) VALUES(?,?,?)").bind(
      round.id,
      manifest.hash,
      job.data,
    ),
    env.DB.prepare("DELETE FROM carryover"),
    env.DB.prepare(
      "INSERT INTO carryover(wallet,round,category,amountWei) SELECT wallet,round,category,amountWei FROM planned_carry WHERE settlementRound=?",
    ).bind(round.id),
    env.DB.prepare("DELETE FROM planned_carry WHERE settlementRound=?").bind(
      round.id,
    ),
    env.DB.prepare(
      "UPDATE payouts SET status='PUBLISHED' WHERE round=? AND status='PREPARED'",
    ).bind(round.id),
    env.DB.prepare("UPDATE rounds SET status='PUBLISHED' WHERE id=?").bind(
      round.id,
    ),
    env.DB.prepare("DELETE FROM settlement_jobs WHERE round=?").bind(round.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO wallet_dirty(wallet) SELECT wallet FROM round_weights WHERE round=?",
    ).bind(round.id),
    queuePublication(
      env.DB,
      "payouts/" + round.id + ".json",
      manifestReference(summary),
    ),
  ]);
  return { pending: true, processed: 0, finalized: round.id };
}
