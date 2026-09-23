import { parseEther, type Address } from "viem";
import {
  config,
  roundsReady,
  roundStartBlock,
  gameRoundPolicy,
  type Token,
  type Swap,
  type BalanceEvent,
} from "../packages/core/src/index";
import { client } from "../packages/core/src/chain";
import { derive, matchLaunch, type Block } from "../packages/core/src/engine";
import {
  initialTokens,
  readChunk,
  readLaunches,
  ensureTemporalHeaders,
} from "../apps/worker/src/indexer";
export async function reconstruct() {
  if (!roundsReady())
    throw Error(
      "Complete and validate public configuration before chain reconstruction.",
    );
  const rpc = client(process.env.BACKUP_RPC_URL),
    head = (await rpc.getBlockNumber()) - BigInt(config.confirmations);
  const tokens = await initialTokens(rpc),
    swaps: Swap[] = [],
    events: BalanceEvent[] = [],
    blocks: Block[] = [];
  const launches: Awaited<ReturnType<typeof readLaunches>> = [];
  const chunkSize = 10000n;
  let roundOpeningBlock = config.round.startBlock ?? undefined;
  for (
    let from = BigInt(config.factoryStartBlock);
    from <= head;
    from += chunkSize
  ) {
    const to = from + chunkSize - 1n > head ? head : from + chunkSize - 1n,
      chunk = await readChunk(rpc, tokens, from, to, roundOpeningBlock);
    blocks.push(...chunk.blocks);
    swaps.push(...chunk.swaps);
    events.push(...chunk.balances);
    launches.push(...(await readLaunches(rpc, from, to)));
    let registered = true;
    while (registered) {
      registered = false;
      const exactBlocks = await ensureTemporalHeaders(
        rpc,
        blocks,
        swaps,
        roundStartBlock(),
        parseEther(String(config.round.firstThresholdEth)),
        config.testMode,
        { policy: gameRoundPolicy(tokens, config.testMode) },
      );
      blocks.splice(0, blocks.length, ...exactBlocks);
      const state = derive(
        swaps,
        blocks,
        roundStartBlock(),
        parseEther(String(config.round.firstThresholdEth)),
        config.testMode,
        tokens,
      );
      roundOpeningBlock ??=
        state.rounds[0]?.startBlock ??
        (state.active.startTs ? state.active.startBlock : undefined);
      for (const h of state.hatches)
        h.tokenAddress =
          tokens.find((t) => t.id === h.variant)?.address ?? null;
      for (const launch of [...launches].sort((a, b) => a.block - b.block)) {
        if (
          tokens.some(
            (t) => t.address.toLowerCase() === launch.address.toLowerCase(),
          )
        )
          continue;
        const h = matchLaunch(
          launch.name,
          launch.symbol,
          state.hatches.filter(
            (h) => h.block !== null && h.block <= launch.block,
          ),
          tokens,
        );
        if (!h) continue;
        if (tokens.some((t) => t.id === h.variant))
          throw Error("Variant already registered to another token");
        const token: Token = {
          ...launch,
          id: h.variant!,
          family: h.family,
          role: "variant",
          address: launch.address,
          pool: launch.pool,
          isToken0: launch.isToken0,
          launchBlock: launch.block,
        };
        tokens.push(token);
        h.tokenAddress = token.address;
        for (
          let start = BigInt(launch.block);
          start <= to;
          start += chunkSize
        ) {
          const backfill = await readChunk(
            rpc,
            [token],
            start,
            start + chunkSize - 1n > to ? to : start + chunkSize - 1n,
            roundOpeningBlock,
          );
          swaps.push(...backfill.swaps);
          events.push(...backfill.balances);
          blocks.push(...backfill.blocks);
        }
        registered = true;
        break;
      }
    }
  }
  const result = derive(
    swaps,
    blocks,
    roundStartBlock(),
    parseEther(String(config.round.firstThresholdEth)),
    config.testMode,
    tokens,
  );
  for (const h of result.hatches)
    h.tokenAddress = tokens.find((t) => t.id === h.variant)?.address ?? null;
  return { rpc, tokens, swaps, events, blocks, result };
}
export function roundArg() {
  const i = process.argv.indexOf("--round"),
    round = Number(process.argv[i + 1]);
  if (i < 0 || !Number.isSafeInteger(round) || round < 1)
    throw Error("Usage: --round N");
  return round;
}
