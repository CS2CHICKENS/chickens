import { type Address } from "viem";
import {
  client,
  bounded,
  tokenSnapshot,
  tokenAbi,
  readTokenTrades,
  readTokenLaunches,
} from "../../../packages/core/src/chain";
import {
  config,
  replayRounds,
  gameRoundPolicy,
  type Token,
  type Swap,
  type BalanceEvent,
  type Round,
  type RoundPolicy,
} from "../../../packages/core/src/index";
import {
  deriveHatches,
  type Block,
  type HatchRecord,
} from "../../../packages/core/src/engine";
export type Rpc = ReturnType<typeof client>;
export async function headers(rpc: Rpc, numbers: Iterable<number>) {
  const unique = [...new Set(numbers)].sort((a, b) => a - b),
    blocks: Block[] = [];
  for (let offset = 0; offset < unique.length; offset += 8) {
    blocks.push(
      ...(await Promise.all(
        unique.slice(offset, offset + 8).map(async (number) => {
          const b = await rpc.getBlock({ blockNumber: BigInt(number) });
          return { number, ts: Number(b.timestamp), hash: b.hash };
        }),
      )),
    );
  }
  return blocks;
}
export async function readChunk(
  rpc: Rpc,
  tokens: Token[],
  from: bigint,
  to: bigint,
  roundOpeningBlock?: number,
) {
  if (to < from)
    return {
      blocks: [] as Block[],
      swaps: [] as Swap[],
      balances: [] as (BalanceEvent & { id: string })[],
    };
  const swaps = await readTokenTrades(rpc, tokens, from, to, roundOpeningBlock);
  const balances: (BalanceEvent & { id: string })[] = [];
  for (const t of tokens) {
    const start = from > BigInt(t.launchBlock) ? from : BigInt(t.launchBlock);
    if (start > to) continue;
    const transfers = await bounded(start, to, (fromBlock, toBlock) =>
      rpc.getContractEvents({
        address: t.address,
        abi: tokenAbi,
        eventName: "Transfer",
        fromBlock,
        toBlock,
        strict: true,
      }),
    );
    for (const log of transfers) {
      if (log.args.from.toLowerCase() === log.args.to.toLowerCase()) continue;
      for (const [wallet, delta, label] of [
        [log.args.from, -log.args.value, "from"],
        [log.args.to, log.args.value, "to"],
      ] as const) {
        if (wallet === "0x0000000000000000000000000000000000000000") continue;
        balances.push({
          id: log.transactionHash + ":" + log.logIndex + ":" + label,
          token: t.id,
          wallet: wallet.toLowerCase() as Address,
          block: Number(log.blockNumber),
          logIndex: log.logIndex,
          ts: 0,
          delta,
        });
      }
    }
  }
  const numbers = new Set([Number(from), Number(to)]);
  for (const event of [...swaps, ...balances]) numbers.add(event.block);
  for (const swap of swaps)
    if (swap.block < Number(to)) numbers.add(swap.block + 1);
  const blocks = await headers(rpc, numbers),
    timestamps = new Map(blocks.map((b) => [b.number, b.ts]));
  for (const event of [...swaps, ...balances])
    event.ts = timestamps.get(event.block)!;
  return { blocks, swaps, balances };
}
export async function initialTokens(rpc: Rpc): Promise<Token[]> {
  return Promise.all(
    config.tokens.map(async (t) => {
      const info = await tokenSnapshot(rpc, t.address as Address);
      return {
        id: t.id,
        address: t.address as Address,
        role: t.role,
        family: "family" in t ? t.family : undefined,
        pool: info.pool,
        isToken0: info.isToken0,
        curve: info.curve,
        phase: info.phase,
        poolId: info.poolId,
        launchBlock: Number.isSafeInteger(info.launchBlock)
          ? info.launchBlock!
          : config.factoryStartBlock,
      };
    }),
  );
}
export async function readLaunches(rpc: Rpc, from: bigint, to: bigint) {
  return readTokenLaunches(rpc, from, to);
}
export type TemporalOptions = {
  policy?: Partial<RoundPolicy>;
  priorRounds?: Round[];
  priorHatches?: HatchRecord[];
};
export async function ensureTemporalHeaders(
  rpc: Rpc,
  blocks: Block[],
  swaps: Swap[],
  start: number,
  threshold: bigint,
  testMode = false,
  options: TemporalOptions = {},
): Promise<Block[]> {
  if (!blocks.length) return blocks;
  const map = new Map(blocks.map((b) => [b.number, b])),
    high = Math.max(...map.keys());
  const read = async (number: number) => {
    if (!map.has(number)) map.set(number, (await headers(rpc, [number]))[0]);
    return map.get(number)!;
  };
  const firstAt = async (timestamp: number, lower: number) => {
    if ((await read(high)).ts < timestamp) return null;
    let low = lower,
      hi = high;
    while (low < hi) {
      const mid = Math.floor((low + hi) / 2);
      if ((await read(mid)).ts >= timestamp) hi = mid;
      else low = mid + 1;
    }
    return read(low);
  };
  if (start <= high && !options.policy?.seed?.startTs) await read(start);
  for (let pass = 0; pass < 128; pass++) {
    const count = map.size;
    const state = replayRounds(swaps, [...map.values()], start, {
      firstThreshold: threshold,
      minDuration: testMode ? 5 : config.round.minDurationSec,
      timeout: testMode ? 60 : config.round.timeoutSec,
      earlyThreshold: "first-eligible-swap",
      tieBreak: "ascii",
      ...gameRoundPolicy([], testMode),
      ...options.policy,
    });
    for (const round of state.rounds) {
      if (round.reason === "timeout")
        await firstAt(
          round.startTs + (testMode ? 60 : config.round.timeoutSec),
          round.startBlock,
        );
      if (round.endBlock < high) await read(round.endBlock + 1);
    }
    const hatches = deriveHatches(
      [...(options.priorRounds ?? []), ...state.rounds],
      [...map.values()],
      testMode,
      options.priorHatches,
    );
    for (const hatch of hatches)
      if (
        !options.priorHatches?.some(
          (previous) => previous.round === hatch.round && previous.hash,
        )
      ) {
        const round = [...(options.priorRounds ?? []), ...state.rounds].find(
          (round) => round.id === hatch.round,
        )!;
        await firstAt(hatch.hatchAt, round.endBlock);
      }
    if (map.size === count)
      return [...map.values()].sort((a, b) => a.number - b.number);
  }
  throw Error("Temporal header reconciliation exceeded its work budget");
}
