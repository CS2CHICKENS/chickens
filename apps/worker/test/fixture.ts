import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { config, WAD } from "../../../packages/core/src/index";
import type { Env } from "../src/index";
import type { Rpc } from "../src/indexer";
import type { Address, Hex } from "viem";
export const holder = "0x1111111111111111111111111111111111111111" as Address;
export const hash = (number: number) =>
  ("0x" + number.toString(16).padStart(64, "0")) as Hex;
export const curve = (address: string) =>
  ("0x" + (BigInt(address) ^ 1n).toString(16).padStart(40, "0")) as Address;
export function fixture() {
  const sql = new DatabaseSync(":memory:");
  for (const file of readdirSync("apps/worker/migrations")
    .filter((name) => name.endsWith(".sql"))
    .sort())
    sql.exec(readFileSync("apps/worker/migrations/" + file, "utf8"));
  const counts = { sql: 0, puts: 0 };
  function statement(query: string, args: unknown[] = []): unknown {
    return {
      bind: (...values: unknown[]) => statement(query, values),
      first: async () => {
        counts.sql++;
        return sql.prepare(query).get(...(args as never[])) ?? null;
      },
      all: async () => {
        counts.sql++;
        return {
          results: sql.prepare(query).all(...(args as never[])),
          success: true,
        };
      },
      run: async () => {
        counts.sql++;
        return {
          success: true,
          meta: sql.prepare(query).run(...(args as never[])),
        };
      },
    };
  }
  const db = {
    prepare: statement,
    batch: async (list: { run: () => Promise<unknown> }[]) => {
      sql.exec("BEGIN");
      try {
        const result = [];
        for (const entry of list) result.push(await entry.run());
        sql.exec("COMMIT");
        return result;
      } catch (error) {
        sql.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as D1Database;
  const objects = new Map<string, string>();
  const env = {
    DB: db,
    DATA: {
      put: async (key: string, value: string) => {
        counts.puts++;
        objects.set(key, value);
      },
      delete: async (keys: string | string[]) => {
        for (const key of Array.isArray(keys) ? keys : [keys])
          objects.delete(key);
      },
    },
    ADMIN_SECRET: "local-fixture-only",
    ENVIRONMENT: "test",
  } as unknown as Env;
  return { env, sql, objects, counts };
}
export function mockRpc(head = config.factoryStartBlock + 10000) {
  const counts = { blocks: 0, calls: 0 };
  const launchBlocks = config.tokenLaunchBlocks as Record<string, number>;
  const at = (address: string) =>
    config.tokens.find(
      (token) => token.address.toLowerCase() === address.toLowerCase(),
    );
  const byCurve = (address: string) =>
    config.tokens.find(
      (token) => curve(token.address).toLowerCase() === address.toLowerCase(),
    );
  const rpc = {
    getBlockNumber: async () => BigInt(head + config.confirmations),
    getBlock: async ({
      blockNumber = BigInt(head),
    }: { blockNumber?: bigint } = {}) => {
      counts.blocks++;
      return {
        number: blockNumber,
        timestamp: BigInt(
          1000000 +
            Math.floor(
              Number(blockNumber - BigInt(config.factoryStartBlock)) / 10,
            ),
        ),
        hash: hash(Number(blockNumber)),
        baseFeePerGas: 1000n,
      };
    },
    getCode: async () => undefined,
    getBalance: async () => 0n,
    getLogs: async () => [],
    getContractEvents: async ({
      address,
      eventName,
      fromBlock,
      toBlock,
    }: {
      address: string;
      eventName?: string;
      fromBlock: bigint;
      toBlock: bigint;
    }) => {
      counts.calls++;
      const token = at(address),
        curved = byCurve(address);
      if (eventName === "Transfer" && token) {
        const block = launchBlocks[token.id];
        return BigInt(block) >= fromBlock && BigInt(block) <= toBlock
          ? [
              {
                args: {
                  from: "0x0000000000000000000000000000000000000000",
                  to: holder,
                  value: 100n * WAD,
                },
                blockNumber: BigInt(block),
                logIndex: 0,
                transactionHash: hash(block),
              },
            ]
          : [];
      }
      if (curved && curved.id === "catalana" && !eventName) {
        const block = launchBlocks.catalana + 1;
        return BigInt(block) >= fromBlock && BigInt(block) <= toBlock
          ? [
              {
                eventName: "CurveBuy",
                args: {
                  buyer: holder,
                  recipient: holder,
                  quoteIn: WAD,
                  tokensOut: 100n * WAD,
                  fee: WAD / 100n,
                  tax: WAD / 100n,
                },
                blockNumber: BigInt(block),
                logIndex: 1,
                transactionHash: hash(block),
              },
            ]
          : [];
      }
      return [];
    },
    readContract: async ({
      address,
      functionName,
      args,
    }: {
      address: string;
      functionName: string;
      args?: unknown[];
    }) => {
      counts.calls++;
      if (functionName === "getLaunchedToken") {
        const token = at(String(args![0]));
        return {
          exists: true,
          token: args![0],
          curve: curve(String(args![0])),
          deployer: config.wallets.creator,
          creatorFeeRecipient: config.fees.collectionWallet,
          pairToken: "0x0000000000000000000000000000000000000000",
          graduationThreshold: (42n * WAD) / 10n,
          poolFee: 0,
          tickSpacing: 200,
          creatorTaxBps: 100,
          buybackEnabled: false,
          phase: 0,
          sweptQuote: 0n,
          sweptTokens: 0n,
          sweptAt: 0n,
        };
      }
      if (functionName === "getLaunchFeePolicy")
        return {
          protocolFeeRecipient: holder,
          protocolFeeShareBps: 3000,
          buybackBurnBps: 5000,
          hookFeeBps: 100,
          maxInternalPriceImpactBps: 300,
        };
      if (functionName === "poolManager") return config.protocol.poolManager;
      if (functionName === "totalSupply") return 1000000000n * WAD;
      if (functionName === "getReserves") return [4n * WAD, 1000000000n * WAD];
      if (functionName === "trackedQuote") return WAD;
      if (
        [
          "quoteFeeBalance",
          "creatorTaxBalance",
          "balanceOf",
          "pendingFees",
          "pendingCreatorTax",
        ].includes(functionName)
      )
        return 0n;
      if (functionName === "feeBps") return 100n;
      if (functionName === "name") return at(address)?.id ?? "";
      if (functionName === "symbol") return at(address)?.symbol ?? "";
      throw Error("Unexpected fixture contract read: " + functionName);
    },
  } as unknown as Rpc;
  return { rpc, counts };
}
