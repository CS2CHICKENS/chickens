import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request } from "node:http";
import { config } from "../../packages/core/src/index";
import {
  OperatorTransactions,
  sameTransaction,
  type Proposal,
} from "../operator-transactions";
import { createOperatorServer } from "../operator";
import type { PreparedRound } from "../operator-plan";
import type { Address, Hex } from "viem";
const address = "0x1111111111111111111111111111111111111111" as Address;
const hash = ("0x" + "1".repeat(64)) as Hex;
const p: Proposal = {
  id: "round-1-batch-0",
  label: "Pay holders",
  from: address,
  to: address,
  data: "0x1234",
  value: "0x64",
  gas: "0x5208",
  maxFeePerGas: "0x1",
  maxPriorityFeePerGas: "0x1",
  nonce: "0x7",
  chainId: "0x1237",
  preparedBlock: 100,
  proof: hash,
};
const tx = {
  from: address,
  to: address,
  input: "0x1234",
  value: 100n,
  nonce: 7,
  chainId: 4663,
};
test("receipt recovery binds every transaction field and never accepts another recipient, amount or network", () => {
  assert.ok(sameTransaction(p, tx));
  for (const change of [
    { to: null },
    { value: 101n },
    { nonce: 8 },
    { chainId: 1 },
    { input: "0x" },
    { from: "0x2222222222222222222222222222222222222222" },
  ])
    assert.equal(sameTransaction(p, { ...tx, ...change }), false);
});
test("confirmed reverts can reset; successful and unknown submissions cannot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chickens-operator-test-"));
  let reverted = true;
  const rpc = {
    getTransaction: async () => tx,
    waitForTransactionReceipt: async () => ({
      status: reverted ? "reverted" : "success",
      transactionHash: hash,
    }),
    getTransactionCount: async () => 8,
  } as unknown as OperatorTransactions["rpc"];
  const service = new OperatorTransactions({ rpc, directory });
  try {
    await service.save({ proposal: p, tx: hash });
    await service.retryFailed(p.id);
    assert.equal(await service.read(p.id), undefined);
    await service.save({ proposal: p, tx: hash });
    reverted = false;
    await assert.rejects(
      service.retryFailed(p.id),
      /Only a confirmed reverted/,
    );
    await assert.rejects(service.cancel(p.id), /unsubmitted/);
    await assert.rejects(service.read("../outside"), /Invalid operation/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("gas requires a top-up above the full community reserve, including future cooks and carry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chickens-operator-test-"));
  let balance = 100n;
  const rpc = {
    getChainId: async () => 4663,
    getTransactionCount: async () => 0,
    getBlock: async () => ({ number: 100n, baseFeePerGas: 0n }),
    call: async () => ({}),
    estimateGas: async () => 1n,
    getBalance: async () => balance,
    getCode: async () => undefined,
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "released"
        ? true
        : functionName === "grossFees"
          ? 200n
          : false,
  } as unknown as OperatorTransactions["rpc"];
  const service = new OperatorTransactions({ rpc, directory });
  service.verifiedContract = async () => address;
  service.prepared = {
    manifest: { round: 1, cook: { egg: "240" } },
    proof: hash,
    manifests: [
      { round: 1, creatorFeesWei: "200", potWei: "100", payouts: [] },
    ],
  } as unknown as PreparedRound;
  try {
    assert.equal(await service.communityReserve(), 100n);
    const input = {
      id: "round-1-cook-egg-0-0-buy",
      label: "Cook",
      from: config.wallets.feed as Address,
      to: address,
      data: "0x" as Hex,
      value: 30n,
      proof: hash,
    };
    await assert.rejects(service.proposal(input), /Top up ETH/);
    balance = 1000100n;
    await service.proposal(input);
    await assert.rejects(
      service.proposal({ ...input, id: "round-1-cook-egg-1-0-buy" }),
      /pending operation/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("local operator rejects foreign origins, host rebinding, missing sessions and oversized requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "chickens-operator-test-"));
  const service = new OperatorTransactions({ directory });
  const port = 18788,
    origin = "http://127.0.0.1:" + port,
    server = createOperatorServer(service, port);
  await new Promise<void>((resolve) =>
    server.listen(port, "127.0.0.1", resolve),
  );
  try {
    const page = await fetch(origin);
    const html = await page.text();
    const token = html.match(
      /name="operator-session" content="([a-f0-9]+)"/,
    )![1];
    assert.match(
      page.headers.get("content-security-policy")!,
      /frame-ancestors 'none'/,
    );
    assert.equal((await fetch(origin + "/api/status")).status, 403);
    assert.equal(
      (
        await fetch(origin + "/api/status", {
          headers: {
            "x-operator-session": token,
            origin: "https://untrusted.example",
          },
        })
      ).status,
      403,
    );
    const rebound = await new Promise<number | undefined>((resolve) => {
      const req = request(
        origin + "/api/status",
        { headers: { "x-operator-session": token, host: "untrusted.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      );
      req.end();
    });
    assert.equal(rebound, 403);
    assert.equal(
      (
        await fetch(origin + "/api/status", {
          headers: { "x-operator-session": token },
        })
      ).status,
      200,
    );
    const headers = {
      "x-operator-session": token,
      origin,
      "content-type": "application/json",
    };
    assert.equal(
      (
        await fetch(origin + "/api/prepare", {
          method: "POST",
          headers,
          body: " ".repeat(8193),
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await fetch(origin + "/api/prepare", {
          method: "POST",
          headers: { ...headers, origin: "https://untrusted.example" },
          body: "{}",
        })
      ).status,
      403,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
