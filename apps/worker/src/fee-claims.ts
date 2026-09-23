import { parseEventLogs, type Address, type Hex } from "viem";
import { config, json, type Token } from "../../../packages/core/src/index";
import {
  bounded,
  curveAbi,
  escrowAbi,
  hookAbi,
} from "../../../packages/core/src/chain";
import {
  applyFeeEvent,
  collectedFeeBounds,
  openingFeeLedger,
  type FeeLedger,
} from "../../../packages/core/src/fee-accounting";
import type { Env } from "./index";
import type { Rpc } from "./indexer";
import {
  insertRows,
  meta,
  metaStatement,
  putMeta,
  statements,
} from "./storage";

type FeeEvent = {
  id: string;
  block: number;
  logIndex: number;
  tx: Hex;
  kind: "project" | "other" | "claim" | "direct";
  token: string | null;
  amount: bigint;
};
type Checkpoint = {
  fromBlock: number;
  cursor: number;
  hash: Hex;
  escrow: string;
  recipient: string;
  ledger: FeeLedger;
};
const key = "feeCollection";
const stagedKey = "feeCollectionStaged";
class FeeRangeBudget extends Error {}
const escrow = config.protocol.feeEscrow as Address;
const recipient = config.fees.collectionWallet as Address;
const lower = (value: string) => value.toLowerCase();
const id = (log: { transactionHash: Hex; logIndex: number }) =>
  log.transactionHash + ":" + log.logIndex;

function beginning(tokens: Token[] = []) {
  return Math.min(
    ...Object.values(config.tokenLaunchBlocks),
    ...tokens.map((token) => token.launchBlock),
  );
}
async function savedCheckpoint(db: D1Database): Promise<Checkpoint | null> {
  const saved = await meta(db, key);
  if (!saved) return null;
  const state = JSON.parse(saved) as Checkpoint;
  state.ledger = Object.fromEntries(
    Object.entries(state.ledger).map(([name, value]) => [name, BigInt(value)]),
  ) as FeeLedger;
  if (state.escrow !== lower(escrow) || state.recipient !== lower(recipient))
    throw Error("Fee collection configuration changed; rebuild its ledger");
  return state;
}

/** Match creator credits to a registered curve or pool, not just the shared depositor. */
export function projectCredits(
  receipt: Awaited<ReturnType<Rpc["getTransactionReceipt"]>>,
  tokens: Token[],
) {
  const credits = parseEventLogs({
    abi: escrowAbi,
    eventName: "Credited",
    logs: receipt.logs,
    strict: true,
  })
    .filter((log) => lower(log.address) === lower(escrow))
    .sort((a, b) => a.logIndex - b.logIndex);
  const curves = new Map(
    tokens
      .filter((token) => token.curve)
      .map((token) => [lower(token.curve!), token]),
  );
  const pools = new Map(
    tokens
      .filter((token) => token.poolId)
      .map((token) => [lower(token.poolId!), token]),
  );
  const sweeps = [
    ...parseEventLogs({
      abi: curveAbi,
      eventName: "FeesSwept",
      logs: receipt.logs,
      strict: true,
    })
      .filter((log) => curves.has(lower(log.address)))
      .map((log) => ({
        ...log,
        token: curves.get(lower(log.address)),
        curve: true,
      })),
    ...parseEventLogs({
      abi: hookAbi,
      eventName: "PoolFeesSwept",
      logs: receipt.logs,
      strict: true,
    })
      .filter((log) => lower(log.address) === lower(config.protocol.hook))
      .map((log) => ({
        ...log,
        token: pools.get(lower(log.args.poolId)),
        curve: false,
      })),
  ].sort((a, b) => a.logIndex - b.logIndex);
  const previous = new Map<string, number>();
  const matched = new Map<string, string>();
  const covered = new Set<string>();
  for (const sweep of sweeps) {
    const depositor = lower(sweep.address),
      after = previous.get(depositor) ?? -1;
    previous.set(depositor, sweep.logIndex);
    const candidates = credits.filter(
      (credit) =>
        lower(credit.args.depositor) === depositor &&
        credit.logIndex > after &&
        credit.logIndex < sweep.logIndex,
    );
    // An unrelated ERC-20 pool uses the token ledger, which is excluded here.
    if (!sweep.token && !candidates.length) continue;
    const expected = (
      sweep.curve
        ? [
            { amount: sweep.args.protocolAmount, creator: false },
            { amount: sweep.args.creatorAmount, creator: true },
          ]
        : [
            { amount: sweep.args.creatorAmount, creator: true },
            { amount: sweep.args.protocolAmount, creator: false },
          ]
    ).filter((entry) => entry.amount > 0n);
    if (
      candidates.length !== expected.length ||
      candidates.some((credit, i) => credit.args.amount !== expected[i].amount)
    )
      throw Error("Project fee sweep does not reconcile with escrow credits");
    for (let i = 0; i < candidates.length; i++) {
      covered.add(id(candidates[i]));
      if (
        sweep.token &&
        Number(sweep.blockNumber) >= sweep.token.launchBlock &&
        expected[i].creator &&
        lower(candidates[i].args.recipient) === lower(recipient)
      )
        matched.set(id(candidates[i]), sweep.token.id);
    }
  }
  if (
    credits.some(
      (credit) =>
        (curves.has(lower(credit.args.depositor)) ||
          lower(credit.args.depositor) === lower(config.protocol.hook)) &&
        !covered.has(id(credit)),
    )
  )
    throw Error("Escrow credit is missing its source sweep");
  return matched;
}

async function readFeeEvents(
  rpc: Rpc,
  tokens: Token[],
  from: number,
  to: number,
  checkpoint?: () => Promise<void>,
) {
  const logs = (
    await Promise.all(
      (["Credited", "Claimed"] as const).map((eventName) =>
        bounded(BigInt(from), BigInt(to), (fromBlock, toBlock) =>
          rpc.getContractEvents({
            address: escrow,
            abi: escrowAbi,
            eventName,
            args: { recipient },
            fromBlock,
            toBlock,
            strict: true,
          }),
        ),
      ),
    )
  ).flat();
  const relevant = logs.filter(
    (log) => lower(log.args.recipient) === lower(recipient),
  );
  if (relevant.length > 1000) throw new FeeRangeBudget();
  const curves = new Set(
    tokens.filter((token) => token.curve).map((token) => lower(token.curve!)),
  );
  const candidates = relevant
    .filter((log) => log.eventName === "Credited")
    .filter(
      (log) =>
        curves.has(lower(log.args.depositor)) ||
        lower(log.args.depositor) === lower(config.protocol.hook),
    );
  const matches = new Map<string, string>();
  const transactions = [
    ...new Set(candidates.map((log) => log.transactionHash)),
  ];
  if (transactions.length > 32) throw new FeeRangeBudget();
  for (const tx of transactions) {
    await checkpoint?.();
    const receipt = await rpc.getTransactionReceipt({ hash: tx });
    if (receipt.status !== "success")
      throw Error("Fee credit receipt is not successful");
    for (const log of candidates.filter(
      (entry) => entry.transactionHash === tx,
    )) {
      if (
        receipt.blockHash !== log.blockHash ||
        receipt.blockNumber !== log.blockNumber
      )
        throw Error("Fee credit receipt changed during indexing");
      const decoded = parseEventLogs({
        abi: escrowAbi,
        logs: receipt.logs,
        strict: true,
      }).find(
        (entry) =>
          lower(entry.address) === lower(escrow) &&
          entry.logIndex === log.logIndex,
      );
      if (
        !decoded ||
        decoded.eventName !== "Credited" ||
        decoded.args.amount !== log.args.amount ||
        lower(decoded.args.recipient) !== lower(recipient) ||
        lower(decoded.args.depositor) !== lower(log.args.depositor)
      )
        throw Error("Fee credit receipt does not match its event");
    }
    for (const [event, token] of projectCredits(receipt, tokens))
      matches.set(event, token);
  }
  const result: FeeEvent[] = relevant.map((log) => ({
    id: id(log),
    block: Number(log.blockNumber),
    logIndex: log.logIndex,
    tx: log.transactionHash,
    kind:
      log.eventName === "Claimed"
        ? "claim"
        : matches.has(id(log))
          ? "project"
          : "other",
    token: matches.get(id(log)) ?? null,
    amount: log.args.amount,
  }));
  for (const token of tokens) {
    if (!token.curve || token.launchBlock > to) continue;
    await checkpoint?.();
    const rescues = await bounded(
      BigInt(Math.max(from, token.launchBlock)),
      BigInt(to),
      (fromBlock, toBlock) =>
        rpc.getContractEvents({
          address: token.curve!,
          abi: curveAbi,
          eventName: "FeesRescued",
          fromBlock,
          toBlock,
          strict: true,
        }),
    );
    for (const log of rescues) {
      if (lower(log.args.creatorRecipient) !== lower(recipient)) continue;
      result.push({
        id: id(log),
        block: Number(log.blockNumber),
        logIndex: log.logIndex,
        tx: log.transactionHash,
        kind: "direct",
        token: token.id,
        amount: log.args.creatorAmount,
      });
    }
    if (result.length > 1000) throw new FeeRangeBudget();
  }
  const unique = new Map<string, FeeEvent>();
  for (const event of result) {
    const prior = unique.get(event.id);
    if (prior && json(prior) !== json(event))
      throw Error("Conflicting fee events");
    unique.set(event.id, event);
  }
  return [...unique.values()].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex,
  );
}

export async function advanceFeeClaims(
  env: Env,
  rpc: Rpc,
  tokens: Token[],
  targetBlock: number,
  maxBlocks = 10000,
): Promise<{ more: boolean; cursor: number }> {
  if (
    !Number.isSafeInteger(targetBlock) ||
    !Number.isSafeInteger(maxBlocks) ||
    maxBlocks < 1
  )
    throw Error("Invalid fee collection range");
  const prior = await savedCheckpoint(env.DB);
  const start = beginning(tokens);
  if (prior && prior.fromBlock !== start)
    throw Error("Fee collection history changed; rebuild its ledger");
  if (
    prior &&
    (await rpc.getBlock({ blockNumber: BigInt(prior.cursor) })).hash !==
      prior.hash
  )
    throw Error("Fee collection checkpoint changed; reconcile the ledger");
  const cursor = prior?.cursor ?? start - 1;
  if (targetBlock <= cursor) return { more: false, cursor };
  const staged = await meta(env.DB, stagedKey);
  const pending = staged
    ? (JSON.parse(staged) as { from: number; to: number; hash: Hex })
    : null;
  if (
    pending &&
    (pending.from !== cursor + 1 ||
      pending.to > targetBlock ||
      (await rpc.getBlock({ blockNumber: BigInt(pending.to) })).hash !==
        pending.hash)
  )
    throw Error("Staged fee collection range changed; reconcile the ledger");
  const from = cursor + 1;
  let to = pending?.to ?? Math.min(targetBlock, cursor + maxBlocks);
  let events: FeeEvent[];
  for (;;) {
    try {
      events = await readFeeEvents(rpc, tokens, from, to, env.checkpoint);
      break;
    } catch (error) {
      if (!(error instanceof FeeRangeBudget)) throw error;
      if (pending || from === to)
        throw Error("One block exceeds the fee collection work budget");
      to = Math.floor((from + to) / 2);
    }
  }
  const block = await rpc.getBlock({ blockNumber: BigInt(to) });
  let ledger =
    prior?.ledger ??
    openingFeeLedger(
      await rpc.readContract({
        address: escrow,
        abi: escrowAbi,
        functionName: "balanceOf",
        args: [recipient],
        blockNumber: BigInt(start - 1),
      }),
    );
  for (const event of events)
    ledger = applyFeeEvent(ledger, event.kind, event.amount);
  const balance = await rpc.readContract({
    address: escrow,
    abi: escrowAbi,
    functionName: "balanceOf",
    args: [recipient],
    blockNumber: BigInt(to),
  });
  if (ledger.balance !== balance)
    throw Error("Fee collection events do not reconcile with escrow balance");
  await env.checkpoint?.();
  await putMeta(env.DB, stagedKey, json({ from, to, hash: block.hash }));
  await statements(
    env.DB,
    insertRows(
      env.DB,
      "fee_collection_events",
      ["id", "block", "logIndex", "tx", "kind", "token", "amountWei"],
      events.map((event) => [
        event.id,
        event.block,
        event.logIndex,
        event.tx,
        event.kind,
        event.token,
        event.amount.toString(),
      ]),
    ),
  );
  await env.checkpoint?.();
  if ((await rpc.getBlock({ blockNumber: BigInt(to) })).hash !== block.hash)
    throw Error("Fee collection block changed before commit");
  const checkpoint: Checkpoint = {
    fromBlock: start,
    cursor: to,
    hash: block.hash,
    escrow: lower(escrow),
    recipient: lower(recipient),
    ledger,
  };
  await env.DB.batch([
    metaStatement(env.DB, key, json(checkpoint)),
    env.DB.prepare("DELETE FROM meta WHERE key=?").bind(stagedKey),
  ]);
  return { more: to < targetBlock, cursor: to };
}

export async function feeCollectionState(db: D1Database, indexedBlock: number) {
  const state = await savedCheckpoint(db);
  const bounds = state ? collectedFeeBounds(state.ledger) : null;
  const covered = state !== null && state.cursor === indexedBlock;
  const exact = bounds !== null && bounds.lower === bounds.upper;
  return {
    collectedWei: covered && exact ? bounds!.lower.toString() : null,
    collection: {
      status: !covered
        ? ("backfilling" as const)
        : exact
          ? ("verified" as const)
          : ("ambiguous" as const),
      fromBlock: state?.fromBlock ?? beginning(),
      throughBlock: state?.cursor ?? null,
      lowerBoundWei: bounds?.lower.toString() ?? null,
      upperBoundWei: bounds?.upper.toString() ?? null,
      escrowClaimedWei: state?.ledger.claimed.toString() ?? null,
      otherCreditsWei: state?.ledger.otherCredit.toString() ?? null,
    },
  };
}
