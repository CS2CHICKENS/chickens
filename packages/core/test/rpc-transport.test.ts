import test from "node:test";
import assert from "node:assert/strict";
import { bounded, client } from "../src/chain";
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

test("historical logs and contract state prefer the archive endpoint", async (t) => {
  const requests: { host: string; method: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const calls = Array.isArray(body) ? body : [body];
      const response = calls.map((call: { id: number; method: string }) => {
        if (call.method === "eth_getLogs")
          assert.equal(Array.isArray(body), false);
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
  await rpc.getLogs({ fromBlock: 70332228n, toBlock: 70332327n });
  await rpc.getBalance({
    address: "0x1111111111111111111111111111111111111111",
    blockNumber: 70332228n,
  });
  assert.deepEqual(requests, [
    { host: "robinhood.drpc.org", method: "eth_getLogs" },
    { host: "robinhood.drpc.org", method: "eth_getBalance" },
  ]);
});

test("an explicit backup remains first for logs and historical state", async (t) => {
  const hosts: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      hosts.push(new URL(String(input)).hostname);
      const body = JSON.parse(String(init?.body)),
        calls = Array.isArray(body) ? body : [body];
      const results = calls.map((call: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: call.id,
        result: call.method === "eth_getLogs" ? [] : "0x2a",
      }));
      return new Response(
        JSON.stringify(Array.isArray(body) ? results : results[0]),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  const rpc = client("https://archive.example.invalid");
  await rpc.getLogs({ fromBlock: 1n, toBlock: 100n });
  assert.equal(
    await rpc.getBalance({
      address: "0x1111111111111111111111111111111111111111",
      blockNumber: 1n,
    }),
    42n,
  );
  assert.deepEqual(hosts, [
    "archive.example.invalid",
    "archive.example.invalid",
  ]);
});

test(
  "rate-limited log providers are each tried once without range splitting",
  { timeout: 5000 },
  async (t) => {
    const calls: { host: string; from: string; to: string }[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body));
        assert.equal(Array.isArray(body), false);
        calls.push({
          host: new URL(String(input)).hostname,
          from: body.params[0].fromBlock,
          to: body.params[0].toBlock,
        });
        return new Response(
          JSON.stringify({
            error: { code: 429, message: "Too Many Requests" },
          }),
          {
            status: 429,
            headers: {
              "Content-Type": "application/json",
              "Retry-After": "3600",
            },
          },
        );
      },
    );
    const rpc = client();
    await assert.rejects(
      bounded(1n, 100n, (fromBlock, toBlock) =>
        rpc.getLogs({ fromBlock, toBlock }),
      ),
      /Too Many Requests/,
    );
    assert.deepEqual(
      calls,
      config.rpc.map((url) => ({
        host: new URL(url).hostname,
        from: "0x1",
        to: "0x64",
      })),
    );
  },
);

test(
  "archive failures do not multiply HTTP and fallback retries",
  { timeout: 5000 },
  async (t) => {
    const hosts: string[] = [];
    t.mock.method(
      globalThis,
      "fetch",
      async (input: RequestInfo | URL, init?: RequestInit) => {
        hosts.push(new URL(String(input)).hostname);
        const body = JSON.parse(String(init?.body));
        const calls = Array.isArray(body) ? body : [body];
        const errors = calls.map((call: { id: number }) => ({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: 503, message: "Service unavailable" },
        }));
        return new Response(
          JSON.stringify(Array.isArray(body) ? errors : errors[0]),
          { status: 503, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    await assert.rejects(
      client().getBalance({
        address: "0x1111111111111111111111111111111111111111",
        blockNumber: 1n,
      }),
    );
    assert.deepEqual(
      hosts,
      config.rpc.map((url) => new URL(url).hostname),
    );
  },
);

test("a provider range limit shrinks on that provider and retains the accepted width", async (t) => {
  const calls: { from: number; to: number; host: string }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)),
        range = body.params[0];
      const from = Number(BigInt(range.fromBlock)),
        to = Number(BigInt(range.toBlock));
      calls.push({ from, to, host: new URL(String(input)).hostname });
      const limited = to - from + 1 > 25;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          ...(limited
            ? {
                error: {
                  code: 35,
                  message:
                    "ranges over 25 blocks are not supported on free plan",
                },
              }
            : { result: [] }),
        }),
        {
          status: limited ? 400 : 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  );
  const rpc = client();
  assert.deepEqual(
    await bounded(1n, 100n, (fromBlock, toBlock) =>
      rpc.getLogs({ fromBlock, toBlock }),
    ),
    [],
  );
  assert.deepEqual(
    calls.map(({ from, to }) => [from, to]),
    [
      [1, 100],
      [1, 50],
      [51, 100],
      [1, 25],
      [26, 50],
      [51, 75],
      [76, 100],
    ],
  );
  assert.ok(
    calls.every((call) => call.host === new URL(config.rpc[0]).hostname),
  );
});

test("bounded logs cover the full requested interval in at most 100-block ranges", async () => {
  const ranges: [bigint, bigint][] = [];
  const blocks = await bounded(1n, 250n, async (from, to) => {
    ranges.push([from, to]);
    return Array.from(
      { length: Number(to - from + 1n) },
      (_, index) => Number(from) + index,
    );
  });
  assert.deepEqual(ranges, [
    [1n, 100n],
    [101n, 200n],
    [201n, 250n],
  ]);
  assert.deepEqual(
    blocks,
    Array.from({ length: 250 }, (_, index) => index + 1),
  );
  const widths: bigint[] = [];
  await bounded(
    1n,
    250n,
    async (from, to) => {
      widths.push(to - from + 1n);
      return [];
    },
    1000n,
  );
  assert.deepEqual(widths, [100n, 100n, 50n]);
});

test("three concurrent ranges concatenate in block order despite reversed completion", async () => {
  const released = new Map<bigint, () => void>(),
    starts: bigint[] = [];
  let active = 0,
    peak = 0;
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const result = bounded(1n, 700n, async (from) => {
    starts.push(from);
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => released.set(from, resolve));
    active--;
    return [from];
  });
  await turn();
  assert.deepEqual(starts, [1n, 101n, 201n]);
  released.get(201n)!();
  released.get(1n)!();
  await turn();
  assert.equal(
    starts.length,
    3,
    "the next wave waits for every in-flight request",
  );
  released.get(101n)!();
  await turn();
  assert.deepEqual(starts, [1n, 101n, 201n, 301n, 401n, 501n]);
  released.get(501n)!();
  released.get(401n)!();
  released.get(301n)!();
  await turn();
  released.get(601n)!();
  assert.deepEqual(await result, [1n, 101n, 201n, 301n, 401n, 501n, 601n]);
  assert.equal(peak, 3);
  assert.equal(active, 0);
});

test("range reduction never skips or repeats successful ranges from the same wave", async () => {
  const accepted: [bigint, bigint][] = [];
  const blocks = await bounded(1n, 400n, async (from, to) => {
    if (from <= 100n && to - from + 1n > 25n)
      throw new Error("Block range limit exceeded");
    accepted.push([from, to]);
    return Array.from(
      { length: Number(to - from + 1n) },
      (_, index) => Number(from) + index,
    );
  });
  assert.deepEqual(
    blocks,
    Array.from({ length: 400 }, (_, index) => index + 1),
  );
  assert.equal(new Set(blocks).size, 400);
  assert.equal(accepted.filter(([from]) => from === 101n).length, 1);
  assert.equal(accepted.filter(([from]) => from === 201n).length, 1);
});

test("a fatal error drains at most three in-flight ranges and never starts another wave", async () => {
  const released: (() => void)[] = [],
    starts: bigint[] = [];
  const limited = Object.assign(new Error("Too Many Requests"), { code: 429 });
  let active = 0,
    peak = 0,
    finished = false;
  const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
  const result = bounded(1n, 1000n, async (from) => {
    starts.push(from);
    active++;
    peak = Math.max(peak, active);
    try {
      if (from === 101n) throw limited;
      await new Promise<void>((resolve) => released.push(resolve));
      return [from];
    } finally {
      active--;
    }
  });
  const rejected = assert
    .rejects(result, (error) => error === limited)
    .then(() => {
      finished = true;
    });
  await turn();
  assert.equal(finished, false);
  assert.deepEqual(starts, [1n, 101n, 201n]);
  released[1]();
  released[0]();
  await rejected;
  assert.equal(active, 0);
  assert.ok(peak <= 3);
  assert.equal(starts.length, 3);
});

test("non-range failures never recursively split or return partial logs", async () => {
  for (const error of [
    new Error("Rate limit exceeded for block range"),
    new Error("HTTP 403 Forbidden"),
    new Error("Network request failed"),
    new Error("Timeout reading historical block range"),
    new Error("Historical state unavailable"),
    new Error("Missing trie node"),
    new Error("Unknown RPC failure"),
    Object.assign(new Error("Block range limit exceeded"), { status: 503 }),
    new Error("RPC failure", {
      cause: Object.assign(new Error("block range exceeded"), { code: 429 }),
    }),
  ]) {
    let calls = 0;
    await assert.rejects(
      bounded(1n, 200n, async () => {
        calls++;
        if (calls === 1) return ["confirmed page"];
        throw error;
      }),
      (actual) => actual === error,
    );
    assert.equal(calls, 2, error.message);
  }
});

test("a rejected single-block range and an invalid maximum cannot loop", async () => {
  let calls = 0;
  await assert.rejects(
    bounded(1n, 1n, async () => {
      calls++;
      throw new Error("Block range limit exceeded");
    }),
    /Block range limit exceeded/,
  );
  assert.equal(calls, 1);
  await assert.rejects(
    bounded(1n, 1n, async () => [], 0n),
    /at least one block/,
  );
});
