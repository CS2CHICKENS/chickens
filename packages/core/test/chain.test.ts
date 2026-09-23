import test from "node:test";
import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  toEventSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { config, WAD, type Token } from "../src/index";
import {
  client,
  launchInfo,
  creatorAccrual,
  factoryAbi,
  hookAbi,
  readTokenLaunches,
  readTokenTrades,
  tokenSnapshot,
  v4PoolId,
} from "../src/chain";

const address = "0x1111111111111111111111111111111111111111" as Address;
const curve = "0x2222222222222222222222222222222222222222" as Address;
const manager = "0x3333333333333333333333333333333333333333" as Address;
const trader = "0x4444444444444444444444444444444444444444" as Address;
const receiver = "0x5555555555555555555555555555555555555555" as Address;
const router = "0x6666666666666666666666666666666666666666" as Address;
const id = v4PoolId(address, zeroAddress, 0, 200);
const token: Token = {
  id: "catalana",
  address,
  curve,
  pool: curve,
  family: "catalana",
  role: "default",
  isToken0: false,
  launchBlock: 1,
};
type FixtureLog = {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  logIndex: number;
  transactionHash: Hex;
};
function log(
  eventName: string,
  args: Record<string, unknown>,
  index: number,
): FixtureLog {
  return {
    eventName,
    args,
    blockNumber: 2n,
    logIndex: index,
    transactionHash: ("0x" + "7".repeat(64)) as Hex,
  };
}
function fixture(
  curveLogs: FixtureLog[] = [],
  poolLogs: FixtureLog[] = [],
  hookLogs: FixtureLog[] = [],
  options: {
    phase?: number;
    buyback?: boolean;
    pendingFee?: bigint;
    historicalCreator?: boolean;
  } = {},
) {
  const requests: {
    address: string;
    args?: Record<string, unknown>;
    fromBlock: bigint;
    toBlock: bigint;
    topics?: readonly unknown[];
  }[] = [];
  const transactions: Hex[] = [];
  const rpc = {
    async getTransaction(request: { hash: Hex }) {
      transactions.push(request.hash);
      return { from: trader };
    },
    async request(request: {
      method: string;
      params: [
        {
          address: string;
          topics: readonly unknown[];
          fromBlock: Hex;
          toBlock: Hex;
        },
      ];
    }) {
      assert.equal(request.method, "eth_getLogs");
      const query = request.params[0];
      const fromBlock = BigInt(query.fromBlock),
        toBlock = BigInt(query.toBlock);
      requests.push({ ...query, fromBlock, toBlock });
      assert(toBlock - fromBlock < 100n);
      return hookLogs
        .filter(
          (row) => row.blockNumber >= fromBlock && row.blockNumber <= toBlock,
        )
        .map((row) => {
          const event = hookAbi.find(
            (item) => item.type === "event" && item.name === row.eventName,
          );
          assert(event?.type === "event");
          const inputs = event.inputs.filter(
            (input) => !("indexed" in input && input.indexed),
          );
          return {
            address: config.protocol.hook,
            blockHash: "0x" + "8".repeat(64),
            blockNumber: toHex(row.blockNumber),
            transactionHash: row.transactionHash,
            transactionIndex: "0x0",
            logIndex: toHex(row.logIndex),
            removed: false,
            topics: encodeEventTopics({
              abi: [event],
              eventName: event.name,
              args: row.args as never,
            }),
            data: encodeAbiParameters(
              inputs,
              inputs.map((input) => row.args[input.name]) as never,
            ),
          };
        });
    },
    async readContract(request: {
      functionName: string;
      address: string;
      blockNumber?: bigint;
    }) {
      switch (request.functionName) {
        case "getLaunchedToken":
          return {
            token: address,
            curve,
            deployer: config.wallets.creator,
            creatorFeeRecipient:
              options.historicalCreator && request.blockNumber !== undefined
                ? config.wallets.creator
                : config.fees.collectionWallet,
            pairToken: zeroAddress,
            graduationThreshold: 100n * WAD,
            poolFee: 0,
            tickSpacing: 200,
            creatorTaxBps: 100,
            buybackEnabled: options.buyback ?? false,
            phase: options.phase ?? 0,
            sweptQuote: 0n,
            sweptTokens: 0n,
            sweptAt: 0n,
            exists: true,
          };
        case "getLaunchFeePolicy":
          return {
            protocolFeeRecipient: manager,
            protocolFeeShareBps: 3000,
            buybackBurnBps: 5000,
            hookFeeBps: 100,
            maxInternalPriceImpactBps: 300,
          };
        case "poolManager":
          return manager;
        case "quoteFeeBalance":
          return options.pendingFee ?? 0n;
        case "pendingFees":
          return options.pendingFee ?? 0n;
        case "pendingCreatorTax":
        case "creatorTaxBalance":
          return 0n;
        case "totalSupply":
          return 1000000000n * WAD;
        case "trackedQuote":
          return 10n * WAD;
        case "getReserves":
          return [100n * WAD, 1000000n * WAD];
        case "extsload":
          return ("0x" +
            ((1n << 200n) + (2n << 96n)).toString(16).padStart(64, "0")) as Hex;
        default:
          throw Error("Unexpected fixture read: " + request.functionName);
      }
    },
    async getContractEvents(request: {
      address: string;
      args?: Record<string, unknown>;
      fromBlock: bigint;
      toBlock: bigint;
    }) {
      requests.push(request);
      assert(request.toBlock - request.fromBlock < 100n);
      const rows =
        request.address === curve
          ? curveLogs
          : request.address === manager
            ? poolLogs
            : request.address === config.protocol.hook
              ? hookLogs
              : [];
      return rows.filter(
        (row) =>
          row.blockNumber >= request.fromBlock &&
          row.blockNumber <= request.toBlock,
      );
    },
  } as unknown as ReturnType<typeof client>;
  return { rpc, requests, transactions };
}

test("curve sells use gross quote and partial buys count only actual spent quote", async () => {
  const f = fixture([
    log(
      "CurveSell",
      {
        seller: trader,
        recipient: receiver,
        tokensIn: 5000n,
        quoteOut: 9800n,
        fee: 100n,
        tax: 100n,
      },
      3,
    ),
    log(
      "CurveBuy",
      {
        buyer: trader,
        recipient: receiver,
        quoteIn: 400n,
        tokensOut: 1000n,
        fee: 4n,
        tax: 4n,
      },
      1,
    ),
  ]);
  const rows = await readTokenTrades(f.rpc, [token], 1n, 4n);
  assert.deepEqual(
    rows.map((r) => r.volume),
    [400n, 10000n],
  );
  assert.deepEqual(
    rows.map((r) => r.side),
    ["buy", "sell"],
  );
  assert.equal(rows[0].wallet, receiver);
  assert.equal(rows[1].wallet, trader);
  assert.equal(rows[0].creatorFeeWei, 7n);
  assert.equal(rows[1].creatorFeeWei, 170n);
});

test("curve creator fees follow aggregate sweep rounding and reset after sweep", async () => {
  const buys = [0, 1, 2, 3].map((i) =>
    log(
      "CurveBuy",
      {
        buyer: trader,
        recipient: receiver,
        quoteIn: 101n,
        tokensOut: 1000n,
        fee: 1n,
        tax: 1n,
      },
      i,
    ),
  );
  const f = fixture([
    ...buys,
    log(
      "FeesSwept",
      { protocolAmount: 1n, buybackAmount: 0n, creatorAmount: 7n },
      4,
    ),
    log(
      "CurveBuy",
      {
        buyer: trader,
        recipient: receiver,
        quoteIn: 101n,
        tokensOut: 1000n,
        fee: 1n,
        tax: 1n,
      },
      5,
    ),
  ]);
  const rows = await readTokenTrades(f.rpc, [token], 1n, 4n);
  assert.deepEqual(
    rows.map((r) => r.creatorFeeWei),
    [2n, 2n, 2n, 1n, 2n],
  );
  assert.equal(creatorAccrual(3n, 1n, 1n, 3000), 1n);
});

test("a chunk starting with accrued fees preserves the protocol rounding boundary", async () => {
  const f = fixture(
    [
      log(
        "CurveBuy",
        {
          buyer: trader,
          recipient: receiver,
          quoteIn: 101n,
          tokensOut: 1000n,
          fee: 1n,
          tax: 1n,
        },
        0,
      ),
    ],
    [],
    [],
    { pendingFee: 3n },
  );
  const rows = await readTokenTrades(f.rpc, [token], 2n, 4n);
  assert.equal(rows[0].creatorFeeWei, 1n);
});

test("V4 sender deltas determine direction and internal sweeps never add race volume", async () => {
  const f = fixture(
    [],
    [
      log("Swap", { id, sender: router, amount0: -10000n, amount1: 5000n }, 1),
      log("Swap", { id, sender: router, amount0: 9000n, amount1: -5000n }, 3),
      log(
        "Swap",
        { id, sender: config.protocol.hook, amount0: 700n, amount1: -100n },
        5,
      ),
    ],
    [],
    { phase: 2 },
  );
  const rows = await readTokenTrades(f.rpc, [token], 1n, 4n);
  assert.deepEqual(
    rows.map((r) => r.side),
    ["buy", "sell"],
  );
  assert.deepEqual(
    rows.map((r) => r.volume),
    [10000n, 9000n],
  );
  assert.equal(
    rows.reduce((sum, r) => sum + r.volume, 0n),
    19000n,
  );
  assert(rows.every((row) => row.wallet === trader && row.payer === trader));
  assert.equal(
    f.transactions.length,
    1,
    "one transaction lookup per hash, with no lookup for the internal swap",
  );
});

test("token-denominated hook fees wait for realization and native credits carry no trading volume", async () => {
  const f = fixture(
    [],
    [],
    [
      log(
        "HookFeeCollected",
        { poolId: id, currency: address, feeAmount: 1000n, taxAmount: 1000n },
        1,
      ),
      log(
        "HookFeeCollected",
        { poolId: id, currency: zeroAddress, feeAmount: 100n, taxAmount: 100n },
        2,
      ),
      log(
        "PoolFeesSwept",
        {
          poolId: id,
          protocolAmount: 35n,
          buybackAmount: 0n,
          creatorAmount: 200n,
          tokensLocked: 0n,
        },
        4,
      ),
    ],
    { phase: 2 },
  );
  const rows = await readTokenTrades(f.rpc, [token], 1n, 4n);
  assert.deepEqual(
    rows.map((r) => r.creatorFeeWei),
    [170n, 30n],
  );
  assert(rows.every((r) => r.kind === "fee-credit" && r.volume === 0n));
  assert(
    f.requests
      .filter((r) => r.address === config.protocol.hook)
      .every(
        (r) =>
          r.topics?.[1] === id &&
          Array.isArray(r.topics[0]) &&
          r.topics[0].length === 5,
      ),
  );
  const hookRequest = f.requests.find(
    (r) => r.address === config.protocol.hook,
  )!;
  assert.deepEqual(
    hookRequest.topics?.[0],
    hookAbi.filter((item) => item.type === "event").map(toEventSelector),
  );
});

test("unsupported fee changes fail closed and no log request exceeds its bound", async () => {
  const changed = fixture([
    log(
      "CreatorFeeRecipientUpdated",
      { previousRecipient: trader, newRecipient: receiver },
      0,
    ),
  ]);
  await assert.rejects(
    readTokenTrades(changed.rpc, [token], 1n, 2n),
    /policy changed/,
  );
  const wide = fixture();
  await readTokenTrades(wide.rpc, [token], 1n, 5000n);
  assert.equal(wide.requests.length, 50);
  assert(
    wide.requests.every((request) => request.address === curve),
    "curve phase must not query nonexistent V4 pools",
  );
  const graduated = fixture([], [], [], { phase: 2 });
  await readTokenTrades(graduated.rpc, [token], 1n, 5000n);
  assert.equal(graduated.requests.length, 150);
  const unsupported = fixture(
    [
      log(
        "CurveBuy",
        {
          buyer: trader,
          recipient: receiver,
          quoteIn: 101n,
          tokensOut: 1000n,
          fee: 1n,
          tax: 1n,
        },
        0,
      ),
    ],
    [],
    [],
    { buyback: true },
  );
  const rows = await readTokenTrades(unsupported.rpc, [token], 1n, 3n);
  assert.equal(rows[0].feeVerified, false);
});

test("curve reserve price and V4 packed slot use the correct quote orientation", async () => {
  const curveQuote = await tokenSnapshot(fixture().rpc, address);
  assert.equal(curveQuote.priceWei, 100000000000000n);
  assert.equal(curveQuote.graduationProgress, 0.1);
  const poolQuote = await tokenSnapshot(
    fixture([], [], [], { phase: 2 }).rpc,
    address,
  );
  assert.equal(poolQuote.priceWei, WAD / 4n);
  assert.equal(poolQuote.graduationProgress, 1);
});

test("unrelated creator launches are ignored before protocol configuration reads", async () => {
  const readNames: string[] = [];
  const rpc = {
    getContractEvents: async () => [
      log("TokenLaunched", { token: address }, 0),
    ],
    readContract: async ({ functionName }: { functionName: string }) => {
      readNames.push(functionName);
      if (functionName === "name") return "Unrelated token";
      if (functionName === "symbol") return "OTHER";
      throw Error("Unrelated launch uses an unsupported pair or fee recipient");
    },
  } as unknown as ReturnType<typeof client>;
  assert.deepEqual(await readTokenLaunches(rpc, 1n, 4n), []);
  assert.deepEqual(readNames.sort(), ["name", "symbol"]);
});

test("recognized variant and configured base launches still reject unsupported configuration", async () => {
  const variant = Object.entries(config.variantMeta)[0];
  for (const launchAddress of [address, config.tokens[0].address]) {
    const base = fixture().rpc;
    let inspected = false;
    const rpc = {
      ...base,
      getContractEvents: async () => [
        log("TokenLaunched", { token: launchAddress }, 0),
      ],
      readContract: async (request: {
        functionName: string;
        address: Address;
      }) => {
        if (request.functionName === "name")
          return launchAddress === address
            ? variant[1].displayName
            : "Configured base";
        if (request.functionName === "symbol")
          return launchAddress === address ? variant[0].toUpperCase() : "BASE";
        if (request.functionName === "getLaunchedToken") {
          inspected = true;
          const launch = await base.readContract({
            address: config.factory as Address,
            abi: factoryAbi,
            functionName: "getLaunchedToken",
            args: [launchAddress as Address],
          });
          return { ...launch, pairToken: receiver };
        }
        throw Error("Unexpected fixture read");
      },
    } as unknown as ReturnType<typeof client>;
    await assert.rejects(
      readTokenLaunches(rpc, 1n, 4n),
      /Unsupported token launch/,
    );
    assert.equal(inspected, true);
  }
});

test("historical creator destination is readable only before round activation", async () => {
  const saved = config.round.startBlock;
  try {
    config.round.startBlock = 3;
    const { rpc } = fixture([], [], [], { historicalCreator: true });
    const quote = await tokenSnapshot(rpc, address, 2n);
    assert.equal(quote.creatorFeeRecipient, config.wallets.creator);
    assert.equal(quote.feeVerified, false);
    await assert.rejects(launchInfo(rpc, address, 3n), /recipient changed/);
  } finally {
    config.round.startBlock = saved;
  }
});

test("prelaunch recipient setup never attributes old creator fees to collection", async () => {
  const saved = config.round.startBlock;
  try {
    config.round.startBlock = 3;
    const trade = (index: number) =>
      log(
        "CurveBuy",
        {
          buyer: trader,
          recipient: receiver,
          quoteIn: 102n,
          tokensOut: 1000n,
          fee: 1n,
          tax: 1n,
        },
        index,
      );
    const changed = log(
      "CreatorFeeRecipientUpdated",
      {
        previousRecipient: config.wallets.creator,
        newRecipient: config.fees.collectionWallet,
      },
      2,
    );
    const swept = log(
      "FeesSwept",
      { protocolAmount: 0n, buybackAmount: 0n, creatorAmount: 2n },
      1,
    );
    const { rpc } = fixture([trade(0), swept, changed, trade(3)], [], [], {
      historicalCreator: true,
    });
    const rows = await readTokenTrades(rpc, [token], 1n, 2n);
    assert.deepEqual(
      rows.map((row) => row.creatorFeeWei),
      [0n, 2n],
    );
    assert.ok(rows.every((row) => row.feeVerified));
    const pending = fixture([trade(0), changed], [], [], {
      historicalCreator: true,
    });
    await assert.rejects(
      readTokenTrades(pending.rpc, [token], 1n, 2n),
      /reconciliation/,
    );
    config.round.startBlock = 2;
    const active = fixture([changed], [], [], { historicalCreator: true });
    await assert.rejects(
      readTokenTrades(active.rpc, [token], 1n, 2n),
      /reconciliation/,
    );
    config.round.startBlock = null;
    await assert.rejects(
      readTokenTrades(active.rpc, [token], 1n, 2n, 1),
      /reconciliation/,
    );
    const automatic = fixture([changed, trade(3)], [], [], {
      historicalCreator: true,
    });
    await assert.rejects(
      readTokenTrades(
        automatic.rpc,
        [{ ...token, family: "catalana" }],
        1n,
        2n,
      ),
      /during active rounds/,
    );
  } finally {
    config.round.startBlock = saved;
  }
});
