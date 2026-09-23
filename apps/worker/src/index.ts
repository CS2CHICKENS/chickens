import {
  parseAbi,
  parseEther,
  keccak256,
  stringToHex,
  type Address,
} from "viem";
import {
  config,
  roundsReady,
  roundStartBlock,
  gameRoundPolicy,
  json,
  replayRounds,
  creatorFees,
  type Token,
  type Swap,
  type BalanceEvent,
  type RoundPolicy,
} from "../../../packages/core/src/index";
import { client } from "../../../packages/core/src/chain";
import {
  deriveHatches,
  matchLaunch,
  type Block,
  type HatchRecord,
} from "../../../packages/core/src/engine";
import {
  headers,
  initialTokens,
  readChunk,
  readLaunches,
  ensureTemporalHeaders,
  type Rpc,
} from "./indexer";
import {
  all,
  meta,
  putMeta,
  metaStatement,
  statements,
  insertRows,
  alert,
  applyBalances,
  flushPublications,
} from "./storage";
import {
  publish,
  reviveRound,
  reviveActive,
  type ActiveRound,
} from "./publication";
import { finalizePending } from "./finalize";
import { handleAdmin } from "./admin";
import { withLedgerLease } from "./lease";
import { scheduleWork, consumeWork, type WorkMessage } from "./work-queue";
import { executeBackground } from "./background";
export interface Env {
  DB: D1Database;
  DATA: R2Bucket;
  ADMIN_SECRET?: string;
  BACKUP_RPC_URL?: string;
  ENVIRONMENT: string;
  WORK?: Queue<WorkMessage>;
  checkpoint?: () => Promise<void>;
}
export type TickOptions = { rpc?: Rpc; maxBlocks?: number; queued?: boolean };
export async function storedTokens(env: Env): Promise<Token[]> {
  return (
    await all<Record<string, unknown>>(
      env.DB,
      "SELECT * FROM tokens ORDER BY launchBlock,id",
    )
  ).map((row) => ({
    ...row,
    isToken0: !!row.isToken0,
    family: row.family || undefined,
    curve: row.curve || undefined,
    phase: row.phase ?? undefined,
    poolId: row.poolId || undefined,
  })) as Token[];
}
function tokenInsert(env: Env, token: Token) {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO tokens(address,id,family,role,pool,isToken0,launchBlock,curve,phase,poolId) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).bind(
    token.address,
    token.id,
    token.family ?? null,
    token.role,
    token.pool,
    +token.isToken0,
    token.launchBlock,
    token.curve ?? null,
    token.phase ?? null,
    token.poolId ?? null,
  );
}
export async function storedHatches(env: Env) {
  return (
    await all<Omit<HatchRecord, "remaining"> & { remaining: string }>(
      env.DB,
      "SELECT * FROM hatches ORDER BY round",
    )
  ).map((row) => ({
    ...row,
    remaining: JSON.parse(row.remaining) as string[],
  }));
}
export async function tick(env: Env, options: TickOptions = {}) {
  return withLedgerLease(
    env,
    async (env) => {
      const checkpoint = env.checkpoint!;
      if ((await meta(env.DB, "paused")) === "true") return;
      const rpc = options.rpc ?? client(env.BACKUP_RPC_URL),
        head = await rpc.getBlockNumber();
      if (head < BigInt(config.confirmations)) return;
      const safeNumber = Number(head - BigInt(config.confirmations));
      let tokens = await storedTokens(env);
      if (!tokens.length) {
        tokens = await initialTokens(rpc);
        await checkpoint();
        await statements(
          env.DB,
          tokens.map((token) => tokenInsert(env, token)),
        );
      }
      const indexStart = Math.min(
        config.factoryStartBlock,
        ...tokens.map((token) => token.launchBlock),
      );
      if ((await meta(env.DB, "indexStart")) === undefined)
        await putMeta(env.DB, "indexStart", String(indexStart));
      let cursor = Number((await meta(env.DB, "cursor")) ?? indexStart - 1);
      const staged = await meta(env.DB, "stagedRange");
      if (staged) {
        const pending = JSON.parse(staged) as { to: number; hash: string };
        if (
          (await rpc.getBlock({ blockNumber: BigInt(pending.to) })).hash !==
          pending.hash
        ) {
          await putMeta(env.DB, "paused", "true");
          await alert(
            env,
            "staged-reorg",
            "Staged block changed; rebuild the paused ledger before resuming.",
          );
          return;
        }
      }
      if (cursor >= indexStart) {
        const saved = await env.DB.prepare(
          "SELECT hash FROM blocks WHERE number=?",
        )
          .bind(cursor)
          .first<{ hash: string }>();
        if (
          saved &&
          (await rpc.getBlock({ blockNumber: BigInt(cursor) })).hash !==
            saved.hash
        ) {
          await putMeta(env.DB, "paused", "true");
          await alert(
            env,
            "reorg-" + cursor,
            "Confirmed block changed; engine paused for re-index.",
          );
          return;
        }
      }
      await checkpoint();
      if (!(await applyBalances(env.DB, 40, checkpoint))) return true;
      const previousRounds = (
        await all<{ data: string }>(
          env.DB,
          "SELECT data FROM rounds WHERE id IN (SELECT round FROM hatches) OR id=(SELECT MAX(id) FROM rounds) OR id=(SELECT MIN(id) FROM rounds) ORDER BY id",
        )
      ).map((row) => reviveRound(row.data));
      const previousHatches = await storedHatches(env);
      let active = reviveActive(await meta(env.DB, "active"));
      let enabled = roundsReady();
      if (enabled) {
        const fingerprint = keccak256(
          stringToHex(
            json({
              round: config.round,
              testMode: config.testMode,
              fees: config.fees,
              split: config.split,
              payouts: config.payouts,
              families: config.families,
            }),
          ),
        );
        const saved = await meta(env.DB, "rulesFingerprint");
        if (saved && saved !== fingerprint) {
          await putMeta(env.DB, "paused", "true");
          await alert(
            env,
            "rules-changed",
            "Round rules changed after indexing began; reconcile the paused ledger before resuming.",
          );
          return;
        }
        if (!saved) await putMeta(env.DB, "rulesFingerprint", fingerprint);
      }
      if (
        enabled &&
        !active &&
        !previousRounds.length &&
        roundStartBlock() <= cursor
      ) {
        enabled = false;
        await alert(
          env,
          "round-start-passed",
          "Round start was already indexed. Announce a future start or rebuild the paused ledger before activation.",
        );
      }
      if (enabled && !active)
        active = {
          id: (previousRounds.at(-1)?.id ?? 0) + 1,
          startBlock: previousRounds.at(-1)
            ? previousRounds.at(-1)!.endBlock + 1
            : roundStartBlock(),
          startTs: 0,
          threshold: parseEther(String(config.round.firstThresholdEth)),
          tokens: {},
          families: {},
          creatorFeeWei: 0n,
          growthSteps: 0,
        };
      let to = staged
        ? (JSON.parse(staged) as { to: number }).to
        : Math.min(cursor + (options.maxBlocks ?? 10000), safeNumber);
      const from = cursor + 1;
      let completed = previousRounds,
        hatches = previousHatches;
      if (to >= from) {
        const roundOpeningBlock =
          previousRounds[0]?.startBlock ??
          (active?.id === 1 && active.startTs ? active.startBlock : undefined);
        let chunk = await readChunk(
          rpc,
          tokens,
          BigInt(from),
          BigInt(to),
          roundOpeningBlock,
        );
        while (!staged && chunk.swaps.length + chunk.balances.length > 1800) {
          if (from === to)
            throw Error("One block exceeds the indexing work budget");
          to = Math.floor((from + to) / 2);
          chunk = await readChunk(
            rpc,
            tokens,
            BigInt(from),
            BigInt(to),
            roundOpeningBlock,
          );
        }
        const launches = await readLaunches(rpc, BigInt(from), BigInt(to));
        const policy: Partial<RoundPolicy> = active
          ? {
              firstRoundId: active.id,
              seed: {
                startTs: active.startTs,
                tokens: active.tokens,
                families: active.families,
                creatorFeeWei: active.creatorFeeWei,
              },
            }
          : {};
        let newRounds: ReturnType<typeof replayRounds>["rounds"] = [],
          nextActive = active;
        const replay = async () => {
          if (!enabled || !active || active.startBlock > to) return;
          Object.assign(policy, gameRoundPolicy(tokens, config.testMode));
          chunk.blocks = await ensureTemporalHeaders(
            rpc,
            chunk.blocks,
            chunk.swaps,
            active.startBlock,
            parseEther(String(config.round.firstThresholdEth)),
            config.testMode,
            {
              policy,
              priorRounds: previousRounds,
              priorHatches: previousHatches,
            },
          );
          const result = replayRounds(
            chunk.swaps,
            chunk.blocks,
            active.startBlock,
            {
              firstThreshold: parseEther(
                String(config.round.firstThresholdEth),
              ),
              minDuration: config.testMode ? 5 : config.round.minDurationSec,
              timeout: config.testMode ? 60 : config.round.timeoutSec,
              earlyThreshold: "first-eligible-swap",
              tieBreak: "ascii",
              ...policy,
            },
          );
          newRounds = result.rounds;
          nextActive = result.active;
          hatches = deriveHatches(
            [...previousRounds, ...newRounds],
            chunk.blocks,
            config.testMode,
            previousHatches,
          );
          for (const token of tokens.filter(
            (token) => token.role === "variant",
          )) {
            const hatch = hatches.find(
              (hatch) =>
                hatch.variant === token.id &&
                hatch.block !== null &&
                hatch.block <= token.launchBlock,
            );
            if (hatch) hatch.tokenAddress = token.address;
          }
        };
        await replay();
        for (
          let pass = 0;
          pass <=
          config.families.reduce(
            (sum, family) => sum + family.variants.length,
            0,
          );
          pass++
        ) {
          let added = false;
          for (const launch of launches) {
            if (
              tokens.some(
                (token) =>
                  token.address.toLowerCase() === launch.address.toLowerCase(),
              )
            )
              continue;
            const hatch = matchLaunch(
              launch.name,
              launch.symbol,
              hatches.filter(
                (hatch) => hatch.block !== null && hatch.block <= launch.block,
              ),
              tokens,
            );
            if (!hatch) continue;
            const token: Token = {
              ...launch,
              id: hatch.variant!,
              family: hatch.family,
              role: "variant",
              launchBlock: launch.block,
            };
            const extra = await readChunk(
              rpc,
              [token],
              BigInt(launch.block),
              BigInt(to),
              roundOpeningBlock ??
                newRounds[0]?.startBlock ??
                (nextActive?.startTs ? nextActive.startBlock : undefined),
            );
            const byNumber = new Map(
              [...chunk.blocks, ...extra.blocks].map((block) => [
                block.number,
                block,
              ]),
            );
            chunk.blocks = [...byNumber.values()];
            chunk.swaps.push(...extra.swaps);
            chunk.balances.push(...extra.balances);
            tokens.push(token);
            hatch.tokenAddress = token.address;
            added = true;
            break;
          }
          if (!added) break;
          await replay();
        }
        for (const launch of launches)
          if (
            !tokens.some(
              (token) =>
                token.address.toLowerCase() === launch.address.toLowerCase(),
            )
          )
            await alert(
              env,
              "launch-" + launch.address,
              "Unmatched creator launch: " + launch.address,
            );
        const writes: D1PreparedStatement[] = tokens.map((token) =>
          tokenInsert(env, token),
        );
        writes.push(
          ...insertRows(
            env.DB,
            "blocks",
            ["number", "ts", "hash"],
            chunk.blocks.map((block) => [block.number, block.ts, block.hash]),
          ),
        );
        writes.push(
          ...insertRows(
            env.DB,
            "swaps",
            [
              "id",
              "token",
              "family",
              "block",
              "logIndex",
              "ts",
              "volume",
              "side",
              "wallet",
              "tx",
              "creatorFeeWei",
              "feeVerified",
              "kind",
            ],
            chunk.swaps.map((swap) => [
              swap.tx + ":" + swap.logIndex,
              swap.token,
              swap.family ?? null,
              swap.block,
              swap.logIndex,
              swap.ts,
              swap.volume.toString(),
              swap.side,
              swap.wallet,
              swap.tx,
              swap.creatorFeeWei?.toString() ?? null,
              swap.feeVerified ? 1 : 0,
              swap.kind ?? "trade",
            ]),
          ),
        );
        writes.push(
          ...insertRows(
            env.DB,
            "balance_events",
            ["id", "token", "wallet", "block", "logIndex", "ts", "delta"],
            chunk.balances.map((event) => [
              event.id,
              event.token,
              event.wallet,
              event.block,
              event.logIndex,
              event.ts,
              event.delta.toString(),
            ]),
          ),
        );
        for (const launch of launches)
          writes.push(
            env.DB.prepare(
              "INSERT OR IGNORE INTO launches(address,block,name,symbol,pool,isToken0) VALUES(?,?,?,?,?,?)",
            ).bind(
              launch.address,
              launch.block,
              launch.name,
              launch.symbol,
              launch.pool,
              +launch.isToken0,
            ),
          );
        if (config.wallets.split) {
          const logs = await rpc.getLogs({
            address: config.wallets.split as Address,
            event: parseAbi([
              "event Released(uint256 devAmount,uint256 feedAmount)",
            ])[0],
            fromBlock: BigInt(from),
            toBlock: BigInt(to),
            strict: true,
          });
          for (const log of logs)
            writes.push(
              env.DB.prepare(
                "INSERT OR IGNORE INTO split_releases(id,block,devWei,feedWei) VALUES(?,?,?,?)",
              ).bind(
                log.transactionHash + ":" + log.logIndex,
                Number(log.blockNumber),
                log.args.devAmount.toString(),
                log.args.feedAmount.toString(),
              ),
            );
        }
        await checkpoint();
        await putMeta(
          env.DB,
          "stagedRange",
          json({
            from,
            to,
            hash: chunk.blocks.find((block) => block.number === to)!.hash,
          }),
        );
        await statements(env.DB, writes);
        if (!(await applyBalances(env.DB, 40, checkpoint))) return true;
        const commit: D1PreparedStatement[] = [];
        for (const round of newRounds) {
          commit.push(
            env.DB.prepare(
              "INSERT INTO rounds(id,startBlock,endBlock,threshold,winner,status,pot,endReason,data) VALUES(?,?,?,?,?,'PENDING',?,?,?)",
            ).bind(
              round.id,
              round.startBlock,
              round.endBlock,
              round.threshold.toString(),
              round.winner,
              round.pot.toString(),
              round.reason,
              json(round),
            ),
          );
        }
        for (const hatch of hatches) {
          commit.push(
            env.DB.prepare(
              "INSERT INTO hatches(round,family,hatchAt,block,hash,variant,tokenAddress,remaining) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(round) DO UPDATE SET block = excluded.block, hash = excluded.hash, variant = excluded.variant, tokenAddress = excluded.tokenAddress, remaining = excluded.remaining",
            ).bind(
              hatch.round,
              hatch.family,
              hatch.hatchAt,
              hatch.block,
              hatch.hash,
              hatch.variant,
              hatch.tokenAddress,
              json(hatch.remaining),
            ),
          );
        }
        const fees =
          BigInt((await meta(env.DB, "creatorFeesWei")) ?? "0") +
          creatorFees(chunk.swaps);
        const verified =
          (await meta(env.DB, "feesVerified")) !== "false" &&
          chunk.swaps.every((swap) => swap.feeVerified);
        commit.push(
          metaStatement(env.DB, "cursor", String(to)),
          metaStatement(env.DB, "creatorFeesWei", fees.toString()),
          metaStatement(env.DB, "feesVerified", String(verified)),
        );
        commit.push(env.DB.prepare("DELETE FROM meta WHERE key='stagedRange'"));
        if (nextActive)
          commit.push(metaStatement(env.DB, "active", json(nextActive)));
        await checkpoint();
        await env.DB.batch(commit);
        cursor = to;
        active = nextActive;
        completed = [...previousRounds, ...newRounds];
      }
      if (cursor < indexStart) return;
      const [indexed, safe] = await headers(rpc, [cursor, safeNumber]);
      if (env.WORK) {
        for (const kind of [
          "publication",
          "fees",
          "settlement",
          "wallets",
        ] as const)
          await scheduleWork(env, kind);
      } else {
        await publish(
          env,
          rpc,
          tokens,
          completed,
          hatches,
          enabled ? active : null,
          indexed,
          safe ?? indexed,
        );
        try {
          if (enabled) await finalizePending(env, rpc, tokens, hatches, 20);
          await flushPublications(env);
        } catch {
          await alert(
            env,
            "settlement-pending",
            "Settlement verification is incomplete; round publication continues.",
          );
        }
      }
      await putMeta(
        env.DB,
        "lastSuccess",
        String(Math.floor(Date.now() / 1000)),
      );
      return cursor < safeNumber;
    },
    options.queued ?? false,
  );
}

export default {
  async scheduled(
    _event: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    ctx.waitUntil(
      (async () => {
        try {
          if (env.WORK) await scheduleWork(env, "index");
          else await tick(env);
        } catch {
          await alert(
            env,
            "tick-failed",
            "Indexer failed; last verified state retained.",
          );
        }
      })(),
    );
  },
  async queue(batch: MessageBatch<WorkMessage>, env: Env) {
    await consumeWork(batch, env, (kind) => executeBackground(env, kind));
  },
  fetch: handleAdmin,
} satisfies ExportedHandler<Env, WorkMessage>;
