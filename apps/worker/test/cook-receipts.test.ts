import test from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeEventTopics, type Address } from "viem";
import { config, WAD } from "../../../packages/core/src/index";
import { tokenAbi } from "../../../packages/core/src/chain";
import { reportCook } from "../src/cook-receipts";
import { fixture, mockRpc, holder, hash, curve } from "./fixture";
import type { Rpc } from "../src/indexer";

test("cook receipts require a confirmed purchase and matching burn, and reject reuse", async () => {
  const { env, sql } = fixture(),
    { rpc } = mockRpc();
  const original = config.wallets.feed;
  config.wallets.feed = holder;
  const token = config.tokens.find((token) => token.id === "catalana")!,
    buyBlock = config.tokenLaunchBlocks.catalana + 1,
    burnBlock = buyBlock + 1;
  const buyTx = hash(buyBlock),
    burnTx = hash(burnBlock);
  sql
    .prepare(
      "INSERT INTO tokens(address,id,family,role,pool,isToken0,launchBlock) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      token.address,
      token.id,
      "catalana",
      "default",
      curve(token.address),
      0,
      config.tokenLaunchBlocks.catalana,
    );
  sql
    .prepare("INSERT INTO manifests VALUES(1,'manifest',?)")
    .run(
      JSON.stringify({
        endBlock: buyBlock - 1,
        cook: { catalana: WAD.toString() },
      }),
    );
  let burnAmount = 99n * WAD;
  const receipts = new Proxy(rpc, {
    get(target, key) {
      if (key === "getTransactionReceipt")
        return async ({ hash: tx }: { hash: string }) => ({
          status: "success",
          from: holder,
          to: tx === burnTx ? token.address : curve(token.address),
          blockNumber: BigInt(tx === burnTx ? burnBlock : buyBlock),
          transactionIndex: 0,
          logs:
            tx === burnTx
              ? [
                  {
                    address: token.address,
                    topics: encodeEventTopics({
                      abi: tokenAbi,
                      eventName: "Transfer",
                      args: {
                        from: holder,
                        to: config.wallets.burn as Address,
                      },
                    }),
                    data: encodeAbiParameters(
                      [{ type: "uint256" }],
                      [burnAmount],
                    ),
                  },
                ]
              : [
                  {
                    address: token.address,
                    topics: encodeEventTopics({
                      abi: tokenAbi,
                      eventName: "Transfer",
                      args: { from: curve(token.address), to: holder },
                    }),
                    data: encodeAbiParameters(
                      [{ type: "uint256" }],
                      [100n * WAD],
                    ),
                  },
                ],
        });
      return Reflect.get(target, key);
    },
  }) as Rpc;
  try {
    assert.equal(
      (
        await reportCook(
          env,
          { round: 1, token: "catalana", buyTx, burnTx },
          receipts,
        )
      ).status,
      409,
    );
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM cooks").get()!.n, 0);
    burnAmount = 100n * WAD;
    assert.equal(
      (
        await reportCook(
          env,
          { round: 1, token: "catalana", buyTx, burnTx },
          receipts,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await reportCook(
          env,
          { round: 1, token: "catalana", buyTx, burnTx },
          receipts,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await reportCook(
          env,
          { round: 2, token: "catalana", buyTx, burnTx },
          receipts,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await reportCook(
          env,
          {
            round: 2,
            token: "catalana",
            buyTx: "0x" + buyTx.slice(2).toUpperCase(),
            burnTx: "0x" + burnTx.slice(2).toUpperCase(),
          },
          receipts,
        )
      ).status,
      409,
    );
    assert.equal(sql.prepare("SELECT COUNT(*) n FROM cooks").get()!.n, 1);
    assert.equal(
      sql.prepare("SELECT ethIn,tokensBurned FROM cooks").get()!.ethIn,
      WAD.toString(),
    );
  } finally {
    config.wallets.feed = original;
    sql.close();
  }
});
