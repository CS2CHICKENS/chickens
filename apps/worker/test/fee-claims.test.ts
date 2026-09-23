import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbi,
  type Address,
  type Hex,
  type Log,
} from "viem";
import { config, type Token } from "../../../packages/core/src/index";
import {
  applyFeeEvent,
  collectedFeeBounds,
  openingFeeLedger,
} from "../../../packages/core/src/fee-accounting";
import {
  advanceFeeClaims,
  feeCollectionState,
  projectCredits,
} from "../src/fee-claims";
import { fixture, hash, mockRpc } from "./fixture";
import type { Rpc } from "../src/indexer";

const start = Math.min(...Object.values(config.tokenLaunchBlocks));
const collection = config.fees.collectionWallet as Address;
const escrow = config.protocol.feeEscrow as Address;
const curve = "0x1111111111111111111111111111111111111111" as Address;
const other = "0x2222222222222222222222222222222222222222" as Address;
const tx = hash(71);
const token: Token = {
  id: "egg",
  address: config.tokens[0].address as Address,
  role: "egg",
  pool: curve,
  curve,
  isToken0: false,
  launchBlock: start,
};
const creditAbi = parseAbi([
  "event Credited(address indexed recipient,address indexed depositor,uint256 amount)",
]);
const sweepAbi = parseAbi([
  "event FeesSwept(uint256 protocolAmount,uint256 buybackAmount,uint256 creatorAmount)",
]);
const poolSweepAbi = parseAbi([
  "event PoolFeesSwept(bytes32 indexed poolId,uint256 protocolAmount,uint256 buybackAmount,uint256 creatorAmount,uint256 tokensLocked)",
]);

function raw(
  address: Address,
  topics: ReturnType<typeof encodeEventTopics>,
  values: bigint[],
  index: number,
): Log {
  return {
    address,
    topics: [...topics] as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      values.map(() => ({ type: "uint256" })),
      values,
    ),
    blockNumber: BigInt(start),
    blockHash: hash(start),
    transactionHash: tx,
    transactionIndex: 0,
    logIndex: index,
    removed: false,
  };
}
function credit(
  depositor: Address,
  recipient: Address,
  amount: bigint,
  index: number,
) {
  return raw(
    escrow,
    encodeEventTopics({
      abi: creditAbi,
      eventName: "Credited",
      args: { recipient, depositor },
    }),
    [amount],
    index,
  );
}
function receipt(logs: Log[]) {
  return {
    logs,
    status: "success",
    blockNumber: BigInt(start),
    blockHash: hash(start),
    transactionHash: tx,
  } as Awaited<ReturnType<Rpc["getTransactionReceipt"]>>;
}

test("mixed escrow partial claims retain tight bounds and a full withdrawal resolves them", () => {
  for (let project = 0n; project <= 8n; project++) {
    for (let unrelated = 0n; unrelated <= 8n; unrelated++) {
      for (let claim = 0n; claim <= project + unrelated; claim++) {
        let ledger = openingFeeLedger(unrelated);
        ledger = applyFeeEvent(ledger, "project", project);
        ledger = applyFeeEvent(ledger, "claim", claim);
        const possible = [];
        for (let paid = 0n; paid <= project; paid++)
          if (paid <= claim && claim - paid <= unrelated) possible.push(paid);
        assert.deepEqual(collectedFeeBounds(ledger), {
          lower: possible[0],
          upper: possible.at(-1),
        });
        ledger = applyFeeEvent(ledger, "direct", 7n);
        ledger = applyFeeEvent(ledger, "claim", ledger.balance);
        assert.deepEqual(collectedFeeBounds(ledger), {
          lower: project + 7n,
          upper: project + 7n,
        });
      }
    }
  }
  assert.throws(
    () => applyFeeEvent(openingFeeLedger(0n), "claim", 1n),
    /exceeds/,
  );
});

test("receipt attribution separates creator, protocol, unrelated pools and token credits", () => {
  const pool = hash(44),
    unknownPool = hash(45);
  const poolToken = { ...token, id: "chick", curve: undefined, poolId: pool };
  const hook = config.protocol.hook as Address;
  const logs = [
    credit(curve, collection, 30n, 0),
    credit(curve, collection, 100n, 1),
    raw(
      curve,
      encodeEventTopics({ abi: sweepAbi, eventName: "FeesSwept" }),
      [30n, 0n, 100n],
      2,
    ),
    credit(hook, collection, 900n, 3),
    raw(
      hook,
      encodeEventTopics({
        abi: poolSweepAbi,
        eventName: "PoolFeesSwept",
        args: { poolId: unknownPool },
      }),
      [0n, 0n, 900n, 0n],
      4,
    ),
    credit(hook, collection, 70n, 5),
    credit(hook, collection, 30n, 6),
    raw(
      hook,
      encodeEventTopics({
        abi: poolSweepAbi,
        eventName: "PoolFeesSwept",
        args: { poolId: pool },
      }),
      [30n, 0n, 70n, 0n],
      7,
    ),
  ];
  assert.deepEqual(
    [...projectCredits(receipt(logs), [token, poolToken])],
    [
      [tx + ":1", "egg"],
      [tx + ":5", "chick"],
    ],
  );
  const invalid = [...logs];
  invalid[1] = credit(curve, collection, 99n, 1);
  assert.throws(
    () => projectCredits(receipt(invalid), [token, poolToken]),
    /reconcile/,
  );
});

function collectionRpc() {
  const base = mockRpc(start + 1).rpc;
  const log = (
    eventName: string,
    args: Record<string, unknown>,
    index: number,
    block = start,
  ) => ({
    eventName,
    args,
    address: escrow,
    logIndex: index,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    transactionHash: tx,
  });
  const logs = [
    log(
      "Credited",
      { depositor: curve, recipient: collection, amount: 100n },
      1,
    ),
    log(
      "Credited",
      { depositor: other, recipient: collection, amount: 50n },
      3,
    ),
    log("Claimed", { recipient: collection, amount: 60n }, 4),
    log("Claimed", { recipient: collection, amount: 90n }, 0, start + 1),
  ];
  let mismatch = false,
    reorg = false;
  const rpc = {
    ...base,
    getBlock: async (args: Parameters<Rpc["getBlock"]>[0]) => ({
      ...(await base.getBlock(args)),
        hash: reorg ? hash(999) : hash(Number(args?.blockNumber)),
    }),
    getContractEvents: async ({
      address,
      eventName,
      fromBlock,
      toBlock,
    }: {
      address: Address;
      eventName: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      if (address === escrow)
        return logs.filter(
          (entry) =>
            entry.eventName === eventName &&
            entry.blockNumber >= fromBlock &&
            entry.blockNumber <= toBlock,
        );
      if (
        address === curve &&
        eventName === "FeesRescued" &&
        fromBlock <= BigInt(start) &&
        toBlock >= BigInt(start)
      )
        return [
          log(
            "FeesRescued",
            { creatorRecipient: collection, creatorAmount: 7n },
            5,
          ),
        ];
      return [];
    },
    readContract: async ({ blockNumber }: { blockNumber: bigint }) =>
      mismatch ? 1n : blockNumber === BigInt(start) ? 90n : 0n,
    getTransactionReceipt: async () =>
      receipt([
        credit(curve, other, 30n, 0),
        credit(curve, collection, 100n, 1),
        raw(
          curve,
          encodeEventTopics({ abi: sweepAbi, eventName: "FeesSwept" }),
          [30n, 0n, 100n],
          2,
        ),
      ]),
  } as unknown as Rpc;
  return {
    rpc,
    mismatch: () => {
      mismatch = true;
    },
    reorg: () => {
      reorg = true;
    },
  };
}

test("collection backfill resumes, reconciles manual claims and never substitutes wallet balance", async () => {
  const f = fixture(),
    chain = collectionRpc();
  assert.equal(
    (await feeCollectionState(f.env.DB, start + 1)).collectedWei,
    null,
  );
  assert.deepEqual(
    await advanceFeeClaims(f.env, chain.rpc, [token], start + 1, 1),
    { more: true, cursor: start },
  );
  const partial = await feeCollectionState(f.env.DB, start);
  assert.equal(partial.collectedWei, null);
  assert.equal(partial.collection.status, "ambiguous");
  assert.equal(partial.collection.lowerBoundWei, "17");
  assert.equal(partial.collection.upperBoundWei, "67");
  assert.equal(
    (await feeCollectionState(f.env.DB, start + 1)).collection.status,
    "backfilling",
  );
  assert.deepEqual(
    await advanceFeeClaims(f.env, chain.rpc, [token], start + 1, 1),
    { more: false, cursor: start + 1 },
  );
  const full = await feeCollectionState(f.env.DB, start + 1);
  assert.equal(full.collectedWei, "107");
  assert.equal(full.collection.escrowClaimedWei, "150");
  assert.equal(full.collection.otherCreditsWei, "50");
  await advanceFeeClaims(f.env, chain.rpc, [token], start + 1);
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM fee_collection_events").get()!.n,
    5,
  );
  chain.reorg();
  await assert.rejects(
    () => advanceFeeClaims(f.env, chain.rpc, [token], start + 2),
    /checkpoint changed/,
  );
  f.sql.close();
});

test("interrupted event staging can retry without double counting and missing logs fail closed", async () => {
  const f = fixture(),
    chain = collectionRpc();
  const original = f.env.DB.batch;
  f.env.DB.batch = async (list) => {
    if (
      (await f.env.DB.prepare(
        "SELECT value FROM meta WHERE key='feeCollectionStaged'",
      ).first()) &&
      f.sql.prepare("SELECT count(*) AS n FROM fee_collection_events").get()!.n
    )
      throw Error("Interrupted checkpoint");
    return original(list);
  };
  await assert.rejects(
    () => advanceFeeClaims(f.env, chain.rpc, [token], start),
    /Interrupted/,
  );
  assert.equal((await feeCollectionState(f.env.DB, start)).collectedWei, null);
  f.env.DB.batch = original;
  await advanceFeeClaims(f.env, chain.rpc, [token], start);
  await advanceFeeClaims(f.env, chain.rpc, [token], start + 1);
  assert.equal(
    (await feeCollectionState(f.env.DB, start + 1)).collectedWei,
    "107",
  );
  assert.equal(
    f.sql.prepare("SELECT count(*) AS n FROM fee_collection_events").get()!.n,
    5,
  );
  chain.mismatch();
  await assert.rejects(
    () => advanceFeeClaims(f.env, chain.rpc, [token], start + 2),
    /reconcile/,
  );
  assert.equal(
    (await feeCollectionState(f.env.DB, start + 2)).collectedWei,
    null,
  );
  f.sql.close();
});
