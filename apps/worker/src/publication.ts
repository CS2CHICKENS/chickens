import { formatEther, type Address } from "viem";
import {
  config,
  json,
  bps,
  BPS,
  replayRounds,
  excludedAddresses,
  type Token,
  type Round,
} from "../../../packages/core/src/index";
import {
  client,
  tokenSnapshot,
  tokenAbi,
  escrowAbi,
} from "../../../packages/core/src/chain";
import {
  emptyState,
  publicStateSchema,
  type PublicState,
} from "../../../packages/core/src/state";
import type { HatchRecord, Block } from "../../../packages/core/src/engine";
import { meta, metadata, putMeta } from "./storage";
import type { Env } from "./index";
import {
  maintainAccounting,
  publishRoundHistory,
  publishWalletHistory,
  roundHistory,
  HISTORY_PAGE_SIZE,
} from "./publication-accounting";
import { feeCollectionState } from "./fee-claims";
import { walletMetrics } from "./wallet-publication";
import { walletRewards } from "./wallet-rewards";
export type ActiveRound = ReturnType<typeof replayRounds>["active"];
export function reviveRound(data: string): Round {
  const round = JSON.parse(data);
  if (round.creatorFeeWei !== undefined)
    round.creatorFeeWei = BigInt(round.creatorFeeWei);
  for (const key of ["pot", "threshold"]) round[key] = BigInt(round[key]);
  for (const key of ["volumes", "familyVolumes"])
    round[key] = Object.fromEntries(
      Object.entries(round[key]).map(([id, value]) => [
        id,
        BigInt(String(value)),
      ]),
    );
  return round;
}
export function reviveActive(data?: string): ActiveRound | null {
  if (!data) return null;
  const active = JSON.parse(data);
  active.threshold = BigInt(active.threshold);
  active.creatorFeeWei = BigInt(active.creatorFeeWei ?? "0");
  for (const key of ["tokens", "families"])
    active[key] = Object.fromEntries(
      Object.entries(active[key]).map(([id, value]) => [
        id,
        BigInt(String(value)),
      ]),
    );
  return active;
}
function egg(hatch: HatchRecord) {
  return {
    round: hatch.round,
    status: hatch.tokenAddress
      ? ("launched" as const)
      : hatch.variant
        ? ("hatched" as const)
        : ("incubating" as const),
    family: hatch.family,
    hatchAt: hatch.hatchAt,
    remaining: hatch.remaining,
    result: hatch.variant
      ? {
          variant: hatch.variant,
          block: hatch.block!,
          hash: hatch.hash!,
          tokenAddress: hatch.tokenAddress ?? "",
        }
      : null,
  };
}
export async function publish(
  env: Env,
  rpc: ReturnType<typeof client>,
  tokens: Token[],
  rounds: Round[],
  hatches: HatchRecord[],
  active: ActiveRound | null,
  indexed: Block,
  safe: Block,
  options: { wallets?: boolean } = {},
) {
  const state: PublicState = structuredClone(emptyState);
  state.mode =
    active && active.startTs
      ? config.testMode
        ? "demo"
        : "live"
      : "monitoring";
  state.updatedAt = Math.floor(Date.now() / 1000);
  state.headBlock = indexed.number;
  state.stale = safe.ts - indexed.ts > 180;
  if (active)
    state.round = {
      id: active.id,
      startBlock: active.startBlock,
      threshold: active.threshold.toString(),
      growthSteps: active.growthSteps,
      progress:
        Number(
          (Object.values(active.families).reduce((a, b) => a + b, 0n) *
            10000n) /
            active.threshold,
        ) / 10000,
      volumeByFamily: JSON.parse(json(active.families)),
      volumeByToken: JSON.parse(json(active.tokens)),
      endsBy:
        active.startTs && (active.id !== 1 || config.round.firstRoundTimeout)
          ? active.startTs + config.round.timeoutSec
          : 0,
      potWei: (
        (active.creatorFeeWei * bps(config.fees.feedShareOfCreatorFee)) /
        BPS
      ).toString(),
    };
  let usd: number | null = null;
  try {
    const result = await fetch(
      "https://coins.llama.fi/prices/current/coingecko:ethereum",
      { signal: AbortSignal.timeout(4000) },
    );
    const data = (await result.json()) as {
        coins: Record<string, { price: number; timestamp: number }>;
      },
      quote = data.coins["coingecko:ethereum"];
    if (quote && Date.now() / 1000 - quote.timestamp < 3600) usd = quote.price;
  } catch {}
  const prices: Record<string, bigint> = {},
    supplies: Record<string, bigint> = {};
  for (const token of tokens) {
    if (token.launchBlock > indexed.number) continue;
    await env.checkpoint?.();
    const quote = await tokenSnapshot(
      rpc,
      token.address,
      BigInt(indexed.number),
    );
    prices[token.id] = quote.priceWei;
    supplies[token.id] = quote.supply;
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM current_balances WHERE token=? AND balanceWei<>'0'",
    )
      .bind(token.id)
      .first<{ n: number }>();
    const price = Number(formatEther(quote.priceWei));
    state.tokens.push({
      id: token.id,
      address: token.address,
      family: token.family,
      priceEth: price,
      priceUsd: usd === null ? null : price * usd,
      marketCapUsd:
        usd === null ? null : price * usd * Number(formatEther(quote.supply)),
      volumeRoundEth: Number(formatEther(active?.tokens[token.id] ?? 0n)),
      holders: count?.n ?? 0,
      graduationProgress: quote.graduationProgress,
    });
  }
  state.incubators = hatches.map(egg);
  const selected =
    [...state.incubators]
      .reverse()
      .find((hatch) => hatch.status === "incubating") ??
    state.incubators.at(-1);
  if (selected) state.incubator = selected;
  const accounting = await maintainAccounting(env);
  if (accounting.more) state.stale = true;
  const generated = await meta(env.DB, "creatorFeesWei"),
    feesVerified = await meta(env.DB, "feesVerified");
  state.feed = {
    ...state.feed,
    balanceWei: config.wallets.feed
      ? (
          await rpc.getBalance({
            address: config.wallets.feed as Address,
            blockNumber: BigInt(indexed.number),
          })
        ).toString()
      : "0",
    owedWei: accounting.owedWei,
    accruingWei: state.round.potWei,
    devWithdrawnWei: accounting.devWei,
    accountingReady: !accounting.more,
    generatedWei:
      feesVerified === "true" && generated !== undefined ? generated : null,
    generatedRoundWei:
      active && feesVerified === "true"
        ? active.creatorFeeWei.toString()
        : null,
    ...(await feeCollectionState(env.DB, indexed.number)),
    claimableWei: (
      await rpc.readContract({
        address: config.protocol.feeEscrow as Address,
        abi: escrowAbi,
        functionName: "balanceOf",
        args: [config.fees.collectionWallet as Address],
        blockNumber: BigInt(indexed.number),
      })
    ).toString(),
    feeAccountingStartBlock: Number(
      (await meta(env.DB, "indexStart")) ?? config.factoryStartBlock,
    ),
    developerSource: config.wallets.split ? "split" : "unavailable",
  };
  const eggToken = tokens.find((token) => token.id === "egg");
  const burned = eggToken
    ? await rpc.readContract({
        address: eggToken.address,
        abi: tokenAbi,
        functionName: "balanceOf",
        args: [config.wallets.burn as Address],
        blockNumber: BigInt(indexed.number),
      })
    : 0n;
  state.kitchen = {
    eggBurnedTotal: burned.toString(),
    supplyLeftWei:
      supplies.egg !== undefined
        ? (supplies.egg > burned ? supplies.egg - burned : 0n).toString()
        : null,
    lastCooks: (
      await env.DB.prepare(
        "SELECT round,token,ethIn,tokensBurned,tx FROM cooks ORDER BY round DESC LIMIT 100",
      ).all<PublicState["kitchen"]["lastCooks"][number]>()
    ).results,
  };
  const swaps = (
    await env.DB.prepare(
      "SELECT ts,wallet,token,side,volume,tx FROM swaps WHERE kind='trade' ORDER BY block DESC,logIndex DESC LIMIT 20",
    ).all<{
      ts: number;
      wallet: string;
      token: string;
      side: "buy" | "sell";
      volume: string;
      tx: string;
    }>()
  ).results;
  state.ticker = swaps.map((swap) => ({
    ts: swap.ts,
    wallet: swap.wallet,
    token: swap.token,
    side: swap.side,
    ethAmount: Number(formatEther(BigInt(swap.volume))),
    tx: swap.tx,
  }));
  const latest =
    (
      await env.DB.prepare("SELECT MAX(id) AS id FROM rounds").first<{
        id: number | null;
      }>()
    )?.id ?? 0;
  const recent = await roundHistory(
    env,
    Math.max(1, latest - HISTORY_PAGE_SIZE + 1),
    latest,
  );
  if (accounting.more)
    for (const row of recent) {
      row.accountingVerified = false;
      row.settlementStatus = "pending";
    }
  state.history = {
    rounds: recent,
    pages: {
      pageSize: HISTORY_PAGE_SIZE,
      totalPages: Math.ceil(latest / HISTORY_PAGE_SIZE),
      basePath: "history/rounds/",
    },
    wins: Object.fromEntries(
      (
        await env.DB.prepare("SELECT family,wins FROM history_wins").all<{
          family: string;
          wins: number;
        }>()
      ).results.map((row) => [row.family, row.wins]),
    ),
    hatches: hatches
      .filter((h) => h.variant)
      .map((h) => ({
        round: h.round,
        family: h.family,
        variant: h.variant!,
        block: h.block!,
        hash: h.hash!,
        tokenAddress: h.tokenAddress,
      })),
  };
  await env.checkpoint?.();
  await env.DATA.put(
    "state.json",
    json(publicStateSchema.parse(state)),
    metadata,
  );
  await putMeta(env.DB, "lastPublished", String(state.updatedAt));
  await publishRoundHistory(env);
  await publishWalletHistory(env);
  if (options.wallets !== false)
    await publishWallets(
      env,
      rpc,
      tokens,
      prices,
      active,
      indexed,
      state.updatedAt,
    );
}
export async function publishWallets(
  env: Env,
  rpc: ReturnType<typeof client>,
  tokens: Token[],
  prices: Record<string, bigint>,
  active: ActiveRound | null,
  indexed: Block,
  updatedAt: number,
  options: { limit?: number } = {},
) {
  const limit = Math.max(1, Math.min(options.limit ?? 50, 50));
  const dirty = (
    await env.DB.prepare(
      "SELECT wallet FROM wallet_dirty ORDER BY wallet LIMIT ?",
    )
      .bind(Math.max(1, Math.floor(limit / 2)))
      .all<{ wallet: Address }>()
  ).results;
  const after = (await meta(env.DB, "walletRefreshCursor")) ?? "";
  const refresh = (
    await env.DB.prepare(
      "SELECT DISTINCT wallet FROM current_balances WHERE wallet>? ORDER BY wallet LIMIT ?",
    )
      .bind(after, limit - dirty.length)
      .all<{ wallet: Address }>()
  ).results;
  const wallets = [
    ...new Map([...dirty, ...refresh].map((row) => [row.wallet, row])).values(),
  ];
  const publishWallet = async ({ wallet }: { wallet: Address }) => {
    await env.checkpoint?.();
    const result = await walletMetrics(
      env,
      wallet,
      tokens,
      prices,
      active,
      indexed,
      updatedAt,
    );
    if (!result) return [];
    const { snapshot, metrics } = result;
    const excluded = excludedAddresses(snapshot.tokens);
    let eligibility = !excluded.has(wallet.toLowerCase());
    if (eligibility) {
      const code = await rpc.getCode({
        address: wallet,
        blockNumber: BigInt(snapshot.indexed.number),
      });
      eligibility = !code || code === "0x";
    }
    if (!eligibility) {
      metrics.chickWeightWei = "0";
      metrics.roundWeight = Object.fromEntries(
        Object.keys(metrics.roundWeight).map((family) => [family, "0"]),
      );
    }
    const carryover = (
      await env.DB.prepare(
        "SELECT round,category,amountWei FROM carryover WHERE wallet=? ORDER BY round",
      )
        .bind(wallet)
        .all()
    ).results;
    const received = (
      await env.DB.prepare(
        "SELECT round,category,amountWei,tx FROM payouts WHERE wallet=? AND status='DISTRIBUTED' ORDER BY round DESC,category LIMIT 101",
      )
        .bind(wallet)
        .all()
    ).results;
    const historyReady = !(await env.DB.prepare(
      "SELECT page FROM wallet_history_dirty WHERE wallet=? LIMIT 1",
    )
      .bind(wallet)
      .first());
    const rewards = await walletRewards(env, wallet);
    await env.checkpoint?.();
    await env.DATA.put(
      "wallets/" + wallet.toLowerCase() + ".json",
      json({
        address: wallet,
        updatedAt: snapshot.updatedAt,
        headBlock: snapshot.indexed.number,
        round: snapshot.round,
        eligibility,
        ...metrics,
        carryover,
        pendingRewards: rewards.pending,
        received: received.slice(0, 100),
        receivedHasMore: received.length > 100,
        receivedPages: {
          pageSize: HISTORY_PAGE_SIZE,
          totalPages: Math.ceil(
            Number(received[0]?.round ?? 0) / HISTORY_PAGE_SIZE,
          ),
          basePath: `wallets/${wallet.toLowerCase()}/received/`,
          ready: historyReady,
        },
      }),
      metadata,
    );
    return [
      ...rewards.writes,
      env.DB.prepare("DELETE FROM wallet_metric_jobs WHERE wallet=?").bind(
        wallet,
      ),
      snapshot.indexed.number === indexed.number && !rewards.more
        ? env.DB.prepare("DELETE FROM wallet_dirty WHERE wallet=?").bind(wallet)
        : env.DB.prepare(
            "INSERT OR IGNORE INTO wallet_dirty(wallet) VALUES(?)",
          ).bind(wallet),
    ];
  };
  for (let offset = 0; offset < wallets.length; offset += 5) {
    const results = await Promise.allSettled(
      wallets.slice(offset, offset + 5).map(publishWallet),
    );
    const writes = results.flatMap((result) =>
      result.status === "fulfilled" ? result.value : [],
    );
    if (writes.length) {
      await env.checkpoint?.();
      await env.DB.batch(writes);
    }
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
  const nextCursor = refresh.at(-1)?.wallet ?? after;
  await putMeta(env.DB, "walletRefreshCursor", nextCursor);
  const moreDirty = !!(await env.DB.prepare(
    "SELECT wallet FROM wallet_dirty LIMIT 1",
  ).first());
  const moreRefresh = !!(await env.DB.prepare(
    "SELECT wallet FROM current_balances WHERE wallet>? LIMIT 1",
  )
    .bind(nextCursor)
    .first());
  return {
    more: moreDirty || moreRefresh,
    nextCursor,
    processed: wallets.length,
    complete: !moreRefresh,
  };
}
