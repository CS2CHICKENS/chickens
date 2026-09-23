import test from "node:test";
import assert from "node:assert/strict";
import { client } from "../src/chain";
import { config } from "../src/index";

test("concurrent historical reads respect public RPC batch limits", async (t) => {
  const batches: number[] = [];
  const hosts: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      hosts.push(new URL(String(input)).hostname);
      const body = JSON.parse(String(init?.body));
      const calls = Array.isArray(body) ? body : [body];
      batches.push(calls.length);
      assert.ok(calls.length <= 3, "Provider refuses larger batches");
      const response = calls.map(
        (call: { id: number; method: string; params: unknown[] }) => {
          assert.equal(call.method, "eth_getBalance");
          assert.equal(call.params[1], "0x4315653");
          return { jsonrpc: "2.0", id: call.id, result: "0x2a" };
        },
      );
      return new Response(
        JSON.stringify(Array.isArray(body) ? response : response[0]),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  const rpc = client();
  const balances = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      rpc.getBalance({
        address: ("0x" +
          (index + 1).toString(16).padStart(40, "0")) as `0x${string}`,
        blockNumber: 70342227n,
      }),
    ),
  );
  assert.deepEqual(balances, Array(10).fill(42n));
  assert.equal(
    batches.reduce((sum, size) => sum + size, 0),
    10,
  );
  assert.ok(hosts.every((host) => host === new URL(config.rpc[0]).hostname));
});

test("historical logs prefer the native endpoint while contract state uses archive", async (t) => {
  const requests: { host: string; method: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const calls = Array.isArray(body) ? body : [body];
      const response = calls.map((call: { id: number; method: string }) => {
        requests.push({
          host: new URL(String(input)).hostname,
          method: call.method,
        });
        return {
          jsonrpc: "2.0",
          id: call.id,
          result: call.method === "eth_getLogs" ? [] : "0x2a",
        };
      });
      return new Response(
        JSON.stringify(Array.isArray(body) ? response : response[0]),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const rpc = client();
  await rpc.getLogs({ fromBlock: 70332228n, toBlock: 70334227n });
  await rpc.getBalance({
    address: "0x1111111111111111111111111111111111111111",
    blockNumber: 70332228n,
  });
  assert.deepEqual(requests, [
    { host: "rpc.mainnet.chain.robinhood.com", method: "eth_getLogs" },
    { host: "robinhood.drpc.org", method: "eth_getBalance" },
  ]);
});
