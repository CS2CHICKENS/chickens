import { json, type Token } from "../../../packages/core/src/index";
import {
  appendWalletEvents,
  streamedWalletRound,
  type WalletMoments,
} from "../../../packages/core/src/wallet-stream";
import type { Block } from "../../../packages/core/src/engine";
import type { ActiveRound } from "./publication";
import type { Env } from "./index";

type Snapshot = {
  indexed: Block;
  updatedAt: number;
  round?: number;
  startBlock: number;
  startTs: number;
  tokens: Token[];
  prices: Record<string, string>;
  held: { token: string; balanceWei: string }[];
  previousStreak: number;
  moments: WalletMoments;
  cursor: { block: number; logIndex: number; id: string };
};

export async function walletMetrics(
  env: Env,
  wallet: string,
  tokens: Token[],
  prices: Record<string, bigint>,
  active: ActiveRound | null,
  indexed: Block,
  updatedAt: number,
) {
  const stored = await env.DB.prepare(
    "SELECT data FROM wallet_metric_jobs WHERE wallet=?",
  )
    .bind(wallet)
    .first<{ data: string }>();
  let snapshot: Snapshot;
  if (stored) {
    snapshot = JSON.parse(stored.data);
    for (const moment of Object.values(snapshot.moments)) {
      moment.delta = BigInt(moment.delta);
      moment.weighted = BigInt(moment.weighted);
      moment.minimum = BigInt(moment.minimum);
    }
  } else {
    const held = (
      await env.DB.prepare(
        "SELECT token,balanceWei FROM current_balances WHERE wallet=?",
      )
        .bind(wallet)
        .all<{ token: string; balanceWei: string }>()
    ).results;
    const previous = await env.DB.prepare(
      "SELECT streak FROM round_weights WHERE wallet=? AND round<? ORDER BY round DESC LIMIT 1",
    )
      .bind(wallet, active?.id ?? Number.MAX_SAFE_INTEGER)
      .first<{ streak: number }>();
    snapshot = {
      indexed,
      updatedAt,
      round: active?.id,
      startBlock: active?.startBlock ?? indexed.number,
      startTs: active?.startTs ?? 0,
      tokens: tokens.filter((token) => token.launchBlock <= indexed.number),
      prices: Object.fromEntries(
        Object.entries(prices).map(([id, price]) => [id, price.toString()]),
      ),
      held,
      previousStreak: previous?.streak ?? 0,
      moments: {},
      cursor: {
        block: (active?.startBlock ?? indexed.number) - 1,
        logIndex: -1,
        id: "",
      },
    };
  }
  let complete = !snapshot.startTs || snapshot.indexed.ts <= snapshot.startTs;
  for (let page = 0; page < 2 && !complete; page++) {
    await env.checkpoint?.();
    const events = (
      await env.DB.prepare(
        "SELECT id,token,block,logIndex,ts,delta FROM balance_events WHERE wallet=? AND block>=? AND block<=? AND (block,logIndex,id)>(?,?,?) ORDER BY block,logIndex,id LIMIT 1000",
      )
        .bind(
          wallet,
          snapshot.startBlock,
          snapshot.indexed.number,
          snapshot.cursor.block,
          snapshot.cursor.logIndex,
          snapshot.cursor.id,
        )
        .all<{
          id: string;
          token: string;
          block: number;
          logIndex: number;
          ts: number;
          delta: string;
        }>()
    ).results;
    appendWalletEvents(
      snapshot.moments,
      events.map((event) => ({ ...event, delta: BigInt(event.delta) })),
      snapshot.startTs,
      snapshot.indexed.ts,
    );
    if (events.length) {
      const last = events.at(-1)!;
      snapshot.cursor = {
        block: last.block,
        logIndex: last.logIndex,
        id: last.id,
      };
    }
    complete = events.length < 1000;
  }
  if (!complete) {
    await env.checkpoint?.();
    await env.DB.prepare(
      "INSERT INTO wallet_metric_jobs(wallet,data) VALUES(?,?) ON CONFLICT(wallet) DO UPDATE SET data=excluded.data",
    )
      .bind(wallet, json(snapshot))
      .run();
    return null;
  }
  return {
    snapshot,
    metrics: streamedWalletRound(
      snapshot.held,
      snapshot.tokens,
      Object.fromEntries(
        Object.entries(snapshot.prices).map(([id, price]) => [
          id,
          BigInt(price),
        ]),
      ),
      snapshot.startTs,
      snapshot.indexed.ts,
      snapshot.moments,
      snapshot.previousStreak,
    ),
  };
}
